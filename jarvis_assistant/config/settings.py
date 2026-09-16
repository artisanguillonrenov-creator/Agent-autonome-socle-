"""Chargement centralisé des clés API et paramètres de Jarvis.

Les valeurs sont lues depuis les variables d'environnement (et un fichier
`.env` si `python-dotenv` est installé et qu'un `.env` est présent à la
racine du projet). Aucune clé API n'a de valeur par défaut en dur dans le
code: tout secret manquant reste simplement vide, et les fonctionnalités
cloud correspondantes restent désactivées (priorité au offline).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass  # python-dotenv est optionnel: on retombe sur les vraies variables d'environnement


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "oui", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value else default


@dataclass
class Settings:
    """Paramètres et clés API de Jarvis, centralisés en un seul objet."""

    # --- Clés API cloud (fallback uniquement) ---
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    groq_api_key: str = field(default_factory=lambda: os.getenv("GROQ_API_KEY", ""))
    porcupine_access_key: str = field(default_factory=lambda: os.getenv("PORCUPINE_ACCESS_KEY", ""))

    # --- Confidentialité / comportement offline-first ---
    allow_cloud_fallback: bool = field(default_factory=lambda: _env_bool("JARVIS_ALLOW_CLOUD_FALLBACK", False))

    # --- Mémoire ---
    chroma_persist_dir: str = field(default_factory=lambda: os.getenv("JARVIS_CHROMA_DIR", "./data/chroma"))
    auto_summary_interval_days: float = field(default_factory=lambda: _env_float("JARVIS_SUMMARY_DAYS", 7.0))

    # --- Voix ---
    wake_word: str = field(default_factory=lambda: os.getenv("JARVIS_WAKE_WORD", "jarvis"))
    vosk_model_path: str = field(default_factory=lambda: os.getenv("VOSK_MODEL_PATH", ""))
    whisper_model_size: str = field(default_factory=lambda: os.getenv("JARVIS_WHISPER_MODEL", "base"))
    tts_rate: int = field(default_factory=lambda: int(os.getenv("JARVIS_TTS_RATE", "180")))
    language: str = field(default_factory=lambda: os.getenv("JARVIS_LANGUAGE", "fr"))
    push_to_talk_only: bool = field(default_factory=lambda: _env_bool("JARVIS_PUSH_TO_TALK_ONLY", True))

    # --- Outils / sandbox ---
    sandbox_dir: str = field(default_factory=lambda: os.getenv("JARVIS_SANDBOX_DIR", "./sandbox"))

    # --- Divers ---
    log_level: str = field(default_factory=lambda: os.getenv("JARVIS_LOG_LEVEL", "INFO"))

    def project_root(self) -> Path:
        return Path(__file__).resolve().parent.parent


_settings_singleton: Settings | None = None


def get_settings() -> Settings:
    """Retourne l'instance unique des réglages (chargée une seule fois)."""
    global _settings_singleton
    if _settings_singleton is None:
        _settings_singleton = Settings()
    return _settings_singleton
