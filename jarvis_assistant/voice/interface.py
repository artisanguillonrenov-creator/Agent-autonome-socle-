"""Interface vocale de Jarvis: wake-word offline, STT offline, TTS offline,
avec fallback cloud optionnel (Groq / OpenAI) pour une meilleure qualité.

Principes de confidentialité:
- Aucune écoute permanente par défaut: le micro n'est activé que pour la
  détection du mot-clé ("Jarvis") ou en mode push-to-talk.
- Le fallback cloud n'est utilisé que si explicitement autorisé dans les
  réglages (`settings.allow_cloud_fallback`) ET si le traitement offline a
  échoué ou est indisponible.

Toutes les dépendances lourdes (vosk, faster_whisper, pyttsx3, sounddevice,
pvporcupine) sont importées de façon paresseuse et protégée: le module reste
important même si une bibliothèque optionnelle n'est pas installée, pour ne
pas bloquer le reste de Jarvis (mode texte uniquement).
"""

from __future__ import annotations

import io
import logging
import tempfile
import wave
from pathlib import Path
from typing import Optional

logger = logging.getLogger("jarvis.voice.interface")

SAMPLE_RATE = 16_000
CHANNELS = 1


class VoiceInterface:
    """Point d'entrée unique pour l'écoute et la synthèse vocale de Jarvis."""

    def __init__(self, settings) -> None:  # noqa: ANN001 - évite l'import circulaire avec config.settings
        self.settings = settings
        self.wake_word = settings.wake_word.lower()

        self._whisper_model = None  # chargé à la demande (faster-whisper)
        self._tts_engine = None  # chargé à la demande (pyttsx3)
        self._vosk_model = None  # chargé à la demande (vosk, pour le wake-word)

    # ------------------------------------------------------------------
    # Enregistrement audio (micro -> tampon WAV)
    # ------------------------------------------------------------------
    def _record_audio(self, duration_seconds: float) -> bytes:
        """Enregistre `duration_seconds` depuis le micro et retourne un WAV en mémoire."""
        try:
            import numpy as np
            import sounddevice as sd
        except ImportError as exc:
            raise RuntimeError(
                "sounddevice/numpy requis pour l'enregistrement audio. "
                "Installez-les avec: pip install sounddevice numpy"
            ) from exc

        logger.info("Enregistrement audio (%.1fs)...", duration_seconds)
        frames = sd.rec(
            int(duration_seconds * SAMPLE_RATE),
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
        )
        sd.wait()
        return _pcm_to_wav_bytes(frames.tobytes(), SAMPLE_RATE, CHANNELS)

    # ------------------------------------------------------------------
    # Wake-word offline (Vosk par défaut, Porcupine si configuré)
    # ------------------------------------------------------------------
    def wait_for_wake_word(self, timeout_seconds: Optional[float] = None) -> bool:
        """Bloque jusqu'à détection du mot-clé de réveil, ou jusqu'au timeout.

        Utilise Vosk (spotting de mot-clé sur un petit modèle local) par
        défaut. Si `settings.porcupine_access_key` est renseigné et que la
        bibliothèque `pvporcupine` est installée, Porcupine est utilisé à la
        place (plus précis, licence Picovoice requise).
        """
        if self.settings.porcupine_access_key:
            try:
                return self._wait_for_wake_word_porcupine(timeout_seconds)
            except ImportError:
                logger.warning("pvporcupine indisponible, repli sur Vosk pour le wake-word")
        return self._wait_for_wake_word_vosk(timeout_seconds)

    def _wait_for_wake_word_porcupine(self, timeout_seconds: Optional[float]) -> bool:
        import time

        import pvporcupine
        import sounddevice as sd

        porcupine = pvporcupine.create(
            access_key=self.settings.porcupine_access_key,
            keywords=["jarvis"],
        )
        started_at = time.monotonic()
        try:
            with sd.InputStream(
                samplerate=porcupine.sample_rate,
                channels=1,
                dtype="int16",
                blocksize=porcupine.frame_length,
            ) as stream:
                while True:
                    if timeout_seconds and (time.monotonic() - started_at) > timeout_seconds:
                        return False
                    pcm, _ = stream.read(porcupine.frame_length)
                    keyword_index = porcupine.process(pcm.flatten())
                    if keyword_index >= 0:
                        logger.info("Wake-word détecté (Porcupine)")
                        return True
        finally:
            porcupine.delete()

    def _load_vosk_model(self):
        if self._vosk_model is not None:
            return self._vosk_model
        import vosk

        model_path = self.settings.vosk_model_path
        if not model_path or not Path(model_path).exists():
            raise RuntimeError(
                "Modèle Vosk introuvable. Téléchargez un petit modèle FR/EN sur "
                "https://alphacephei.com/vosk/models et renseignez VOSK_MODEL_PATH."
            )
        vosk.SetLogLevel(-1)
        self._vosk_model = vosk.Model(model_path)
        return self._vosk_model

    def _wait_for_wake_word_vosk(self, timeout_seconds: Optional[float]) -> bool:
        import json as _json
        import time

        import sounddevice as sd
        import vosk

        model = self._load_vosk_model()
        recognizer = vosk.KaldiRecognizer(model, SAMPLE_RATE)
        started_at = time.monotonic()

        with sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            blocksize=8000,
            dtype="int16",
            channels=CHANNELS,
        ) as stream:
            while True:
                if timeout_seconds and (time.monotonic() - started_at) > timeout_seconds:
                    return False
                data, _ = stream.read(4000)
                if recognizer.AcceptWaveform(bytes(data)):
                    text = _json.loads(recognizer.Result()).get("text", "")
                else:
                    text = _json.loads(recognizer.PartialResult()).get("partial", "")
                if self.wake_word in text.lower():
                    logger.info("Wake-word détecté (Vosk): %r", text)
                    return True

    # ------------------------------------------------------------------
    # Push-to-talk (alternative sans écoute continue)
    # ------------------------------------------------------------------
    def push_to_talk(self, duration_seconds: float = 5.0) -> str:
        """Enregistre une commande pendant `duration_seconds` puis la transcrit.

        Mode recommandé pour la confidentialité: aucune écoute avant l'appel
        explicite de cette méthode (typiquement déclenché par une touche).
        """
        audio_wav = self._record_audio(duration_seconds)
        return self.transcribe(audio_wav)

    # ------------------------------------------------------------------
    # Reconnaissance vocale (STT): faster-whisper offline, fallback cloud
    # ------------------------------------------------------------------
    def _load_whisper_model(self):
        if self._whisper_model is not None:
            return self._whisper_model
        from faster_whisper import WhisperModel

        logger.info("Chargement du modèle faster-whisper '%s'...", self.settings.whisper_model_size)
        self._whisper_model = WhisperModel(
            self.settings.whisper_model_size,
            device="cpu",
            compute_type="int8",
        )
        return self._whisper_model

    def transcribe(self, audio_wav: bytes) -> str:
        """Transcrit un WAV en texte. Priorité au offline (faster-whisper)."""
        try:
            return self._transcribe_offline(audio_wav)
        except Exception as exc:  # noqa: BLE001 - on veut pouvoir retomber sur le cloud
            logger.warning("STT offline indisponible (%s)", exc)
            if self.settings.allow_cloud_fallback:
                return self._transcribe_cloud(audio_wav)
            raise

    def _transcribe_offline(self, audio_wav: bytes) -> str:
        model = self._load_whisper_model()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
            tmp.write(audio_wav)
            tmp.flush()
            segments, _info = model.transcribe(tmp.name, language=self.settings.language)
            text = " ".join(segment.text.strip() for segment in segments)
        logger.info("Transcription offline: %r", text)
        return text.strip()

    def _transcribe_cloud(self, audio_wav: bytes) -> str:
        """Fallback cloud via l'API Groq (Whisper) ou OpenAI, selon la clé disponible."""
        import requests

        if self.settings.groq_api_key:
            response = requests.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.settings.groq_api_key}"},
                files={"file": ("audio.wav", audio_wav, "audio/wav")},
                data={"model": "whisper-large-v3"},
                timeout=30,
            )
        elif self.settings.openai_api_key:
            response = requests.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
                files={"file": ("audio.wav", audio_wav, "audio/wav")},
                data={"model": "whisper-1"},
                timeout=30,
            )
        else:
            raise RuntimeError("Aucune clé API cloud configurée (GROQ_API_KEY ou OPENAI_API_KEY)")

        response.raise_for_status()
        text = response.json().get("text", "").strip()
        logger.info("Transcription cloud (fallback): %r", text)
        return text

    # ------------------------------------------------------------------
    # Synthèse vocale (TTS): pyttsx3 offline, fallback cloud
    # ------------------------------------------------------------------
    def _load_tts_engine(self):
        if self._tts_engine is not None:
            return self._tts_engine
        import pyttsx3

        engine = pyttsx3.init()
        engine.setProperty("rate", self.settings.tts_rate)
        self._tts_engine = engine
        return engine

    def speak(self, text: str) -> None:
        """Prononce `text`. Priorité au offline (pyttsx3), fallback cloud sinon."""
        if not text:
            return
        try:
            engine = self._load_tts_engine()
            engine.say(text)
            engine.runAndWait()
        except Exception as exc:  # noqa: BLE001
            logger.warning("TTS offline indisponible (%s)", exc)
            if self.settings.allow_cloud_fallback:
                self._speak_cloud(text)
            else:
                logger.error("Impossible de vocaliser la réponse (aucun fallback autorisé)")

    def _speak_cloud(self, text: str) -> None:
        """Fallback TTS cloud (OpenAI) — nécessite un lecteur audio local pour jouer le flux."""
        import requests

        if not self.settings.openai_api_key:
            logger.error("Aucune clé OpenAI configurée pour le TTS cloud, réponse non vocalisée")
            return

        response = requests.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
            json={"model": "tts-1", "voice": "alloy", "input": text},
            timeout=30,
        )
        response.raise_for_status()
        self._play_audio_bytes(response.content)

    @staticmethod
    def _play_audio_bytes(audio_bytes: bytes) -> None:
        try:
            import simpleaudio as sa

            wave_obj = sa.WaveObject.from_wave_file(io.BytesIO(audio_bytes))
            wave_obj.play().wait_done()
        except ImportError:
            logger.warning(
                "simpleaudio non installé: impossible de jouer l'audio TTS cloud. "
                "Installez-le avec: pip install simpleaudio"
            )


def _pcm_to_wav_bytes(pcm_data: bytes, sample_rate: int, channels: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)  # int16
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_data)
    return buffer.getvalue()
