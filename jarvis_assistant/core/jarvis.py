"""Classe principale Jarvis: orchestre mémoire, voix et outils.

`Jarvis.process(command)` est le point d'entrée unique:
    1. récupère le contexte pertinent depuis la mémoire long terme,
    2. décide si la commande correspond à un outil connu ou à une réponse
       conversationnelle,
    3. exécute l'outil (avec consentement explicite géré par ToolExecutor)
       ou construit une réponse (offline en priorité, cloud en fallback),
    4. mémorise l'échange (entrée utilisateur + réponse),
    5. retourne la réponse texte (et la vocalise si un moteur voix est actif).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

from config.settings import Settings, get_settings
from memory.long_term import LongTermMemory
from tools.executor import ToolExecutor, ToolResult

logger = logging.getLogger("jarvis.core")


@dataclass
class JarvisResponse:
    text: str
    tool_used: Optional[str] = None
    tool_result: Optional[ToolResult] = None


class Jarvis:
    """Assistant IA modulaire: mémoire persistante + outils sandboxés + voix optionnelle."""

    def __init__(
        self,
        settings: Optional[Settings] = None,
        enable_voice: bool = False,
    ) -> None:
        self.settings = settings or get_settings()
        logging.basicConfig(level=self.settings.log_level)

        self.memory = LongTermMemory(
            persist_directory=self.settings.chroma_persist_dir,
            auto_summary_interval_days=self.settings.auto_summary_interval_days,
        )
        self.tools = ToolExecutor(sandbox_dir=self.settings.sandbox_dir)

        self.voice = None
        if enable_voice:
            # Import paresseux: les dépendances voix sont lourdes et optionnelles.
            from voice.interface import VoiceInterface

            self.voice = VoiceInterface(self.settings)

        # Vérifie/génère le résumé hebdomadaire en arrière-plan (best-effort).
        self.memory.start_auto_summary_scheduler()

    def close(self) -> None:
        self.memory.close()

    # ------------------------------------------------------------------
    # Orchestrateur principal
    # ------------------------------------------------------------------
    def process(self, command: str) -> JarvisResponse:
        """Traite une commande utilisateur de bout en bout."""
        command = command.strip()
        if not command:
            return JarvisResponse(text="Je n'ai rien entendu, pouvez-vous répéter ?")

        context = self.memory.recall_context(command, n_results=5)
        logger.debug("Contexte mémoire rappelé: %s", context)

        tool_name, tool_kwargs = self._route_to_tool(command)

        if tool_name:
            result = self.tools.execute(tool_name, **tool_kwargs)
            response_text = self._format_tool_response(tool_name, result)
            self._remember_interaction(command, response_text, tool_used=tool_name)
            response = JarvisResponse(text=response_text, tool_used=tool_name, tool_result=result)
        else:
            response_text = self._answer_conversationally(command, context)
            self._remember_interaction(command, response_text, tool_used=None)
            response = JarvisResponse(text=response_text)

        if self.voice is not None:
            self.voice.speak(response.text)

        return response

    # ------------------------------------------------------------------
    # Routage commande -> outil (règles simples, extensibles)
    # ------------------------------------------------------------------
    def _route_to_tool(self, command: str) -> tuple[Optional[str], dict]:
        lowered = command.lower()

        match = re.search(r"ouvre(?:\s+l['e]?)?\s+(.+)", lowered)
        if match:
            return "open_app", {"app_name": match.group(1).strip()}

        match = re.search(r"(?:lis|lire)\s+(?:le\s+fichier\s+)?(\S+)", lowered)
        if match:
            return "read_file", {"relative_path": match.group(1).strip()}

        match = re.search(r"liste\s+(?:les\s+)?fichiers(?:\s+(?:de|dans)\s+(\S+))?", lowered)
        if match:
            return "list_files", {"relative_path": match.group(1) or "."}

        match = re.search(r"(?:crée|cree)\s+(?:le\s+fichier\s+)?(\S+)(?:\s+avec\s+(.+))?", lowered)
        if match:
            return "create_file", {"relative_path": match.group(1).strip(), "content": match.group(2) or ""}

        match = re.search(r"(?:écris|ecris)\s+(?:dans\s+)?(\S+)\s*[:\-]\s*(.+)", lowered)
        if match:
            return "write_file", {
                "relative_path": match.group(1).strip(),
                "content": match.group(2).strip(),
                "overwrite": True,
            }

        match = re.search(r"supprime\s+(?:le\s+fichier\s+)?(\S+)", lowered)
        if match:
            return "delete_file", {"relative_path": match.group(1).strip()}

        match = re.search(r"(?:recherche|cherche)(?:\s+sur\s+le\s+web)?\s*[:\-]?\s*(.+)", lowered)
        if match:
            return "web_search", {"query": match.group(1).strip()}

        return None, {}

    def _format_tool_response(self, tool_name: str, result: ToolResult) -> str:
        if result.success:
            return result.output or f"Action '{tool_name}' effectuée avec succès."
        return f"Je n'ai pas pu effectuer cette action ({tool_name}): {result.error}"

    # ------------------------------------------------------------------
    # Réponse conversationnelle (offline par défaut, cloud en fallback)
    # ------------------------------------------------------------------
    def _answer_conversationally(self, command: str, context: str) -> str:
        if self.settings.allow_cloud_fallback and (self.settings.openai_api_key or self.settings.groq_api_key):
            try:
                return self._answer_via_cloud_llm(command, context)
            except Exception as exc:  # noqa: BLE001 - on retombe sur le offline si le cloud échoue
                logger.warning("Fallback LLM cloud indisponible (%s)", exc)

        if context:
            return f"D'après ce que je sais déjà :\n{context}\n\nJe n'ai pas de meilleure réponse hors-ligne pour l'instant."
        return "Je n'ai pas encore d'information sur ce sujet, et le mode hors-ligne ne me permet pas d'en dire plus."

    def _answer_via_cloud_llm(self, command: str, context: str) -> str:
        import requests

        system_prompt = (
            "Tu es Jarvis, un assistant IA personnel concis et utile. "
            "Utilise le contexte mémoire fourni s'il est pertinent."
        )
        user_prompt = f"Contexte mémoire:\n{context}\n\nCommande: {command}" if context else command

        if self.settings.groq_api_key:
            url = "https://api.groq.com/openai/v1/chat/completions"
            headers = {"Authorization": f"Bearer {self.settings.groq_api_key}"}
            model = "llama-3.1-8b-instant"
        else:
            url = "https://api.openai.com/v1/chat/completions"
            headers = {"Authorization": f"Bearer {self.settings.openai_api_key}"}
            model = "gpt-4o-mini"

        response = requests.post(
            url,
            headers=headers,
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=30,
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"].strip()

    # ------------------------------------------------------------------
    # Mémorisation de l'échange
    # ------------------------------------------------------------------
    def _remember_interaction(self, command: str, response_text: str, tool_used: Optional[str]) -> None:
        self.memory.remember(
            entity="utilisateur",
            attribute="commande",
            value=command,
            metadata={"tool_used": tool_used or ""},
        )
        self.memory.remember(
            entity="jarvis",
            attribute="reponse",
            value=response_text,
            metadata={"tool_used": tool_used or ""},
        )
