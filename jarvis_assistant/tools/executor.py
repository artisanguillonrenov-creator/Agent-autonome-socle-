"""Exécution sécurisée d'outils/actions système pour Jarvis.

Règles de sécurité:
- Toute lecture/écriture/création de fichier est confinée au répertoire
  `sandbox/` (résolu en chemin absolu, avec vérification anti path-traversal).
- Toute action jugée destructive (écraser un fichier existant, le supprimer,
  ouvrir une application, exécuter une commande) exige un consentement
  explicite de l'utilisateur avant exécution, via `consent_callback`.
- `web_search` n'exécute qu'une requête HTTP en lecture, sans clé API requise
  (DuckDuckGo), avec un fournisseur payant optionnel si configuré.
"""

from __future__ import annotations

import logging
import platform
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger("jarvis.tools.executor")

ConsentCallback = Callable[[str], bool]


def _default_consent_callback(action_description: str) -> bool:
    """Demande la confirmation dans le terminal. À remplacer par une UI/voix."""
    answer = input(f"[Jarvis] Confirmation requise - {action_description} (o/n) : ")
    return answer.strip().lower() in {"o", "oui", "y", "yes"}


@dataclass
class ToolResult:
    success: bool
    output: str
    error: Optional[str] = None


class SandboxViolationError(Exception):
    """Levée quand une opération fichier tente de sortir du sandbox."""


class PermissionDeniedError(Exception):
    """Levée quand l'utilisateur refuse une action destructive."""


class ToolExecutor:
    """Exécuteur d'outils sandboxé, avec permission explicite pour le destructif."""

    #: Liste blanche des applications ouvrables par nom logique -> commande réelle.
    #: Évite d'exécuter une chaîne arbitraire fournie par un LLM.
    ALLOWED_APPS: dict[str, dict[str, str]] = {
        "navigateur": {"Linux": "xdg-open about:blank", "Darwin": "open -a Safari", "Windows": "start msedge"},
        "terminal": {"Linux": "x-terminal-emulator", "Darwin": "open -a Terminal", "Windows": "start cmd"},
        "explorateur_fichiers": {"Linux": "xdg-open .", "Darwin": "open .", "Windows": "explorer ."},
    }

    def __init__(
        self,
        sandbox_dir: str | Path = "./sandbox",
        consent_callback: Optional[ConsentCallback] = None,
    ) -> None:
        self.sandbox_dir = Path(sandbox_dir).resolve()
        self.sandbox_dir.mkdir(parents=True, exist_ok=True)
        self.consent_callback = consent_callback or _default_consent_callback

    # ------------------------------------------------------------------
    # Garde-fou anti path-traversal
    # ------------------------------------------------------------------
    def _resolve_in_sandbox(self, relative_path: str) -> Path:
        candidate = (self.sandbox_dir / relative_path).resolve()
        if self.sandbox_dir not in candidate.parents and candidate != self.sandbox_dir:
            raise SandboxViolationError(
                f"Chemin '{relative_path}' résolu hors du sandbox ({candidate}). Action refusée."
            )
        return candidate

    def _request_consent(self, action_description: str) -> None:
        if not self.consent_callback(action_description):
            raise PermissionDeniedError(f"Action refusée par l'utilisateur: {action_description}")

    # ------------------------------------------------------------------
    # Fichiers (lecture: libre : écriture/suppression: consentement requis)
    # ------------------------------------------------------------------
    def read_file(self, relative_path: str) -> ToolResult:
        try:
            path = self._resolve_in_sandbox(relative_path)
            if not path.is_file():
                return ToolResult(False, "", f"Fichier introuvable: {relative_path}")
            return ToolResult(True, path.read_text(encoding="utf-8"))
        except (SandboxViolationError, OSError) as exc:
            return ToolResult(False, "", str(exc))

    def list_files(self, relative_path: str = ".") -> ToolResult:
        try:
            path = self._resolve_in_sandbox(relative_path)
            if not path.is_dir():
                return ToolResult(False, "", f"Répertoire introuvable: {relative_path}")
            entries = sorted(p.name for p in path.iterdir())
            return ToolResult(True, "\n".join(entries))
        except (SandboxViolationError, OSError) as exc:
            return ToolResult(False, "", str(exc))

    def write_file(self, relative_path: str, content: str, overwrite: bool = False) -> ToolResult:
        try:
            path = self._resolve_in_sandbox(relative_path)
            exists = path.exists()
            if exists and not overwrite:
                return ToolResult(False, "", f"'{relative_path}' existe déjà (overwrite=False)")
            if exists:
                self._request_consent(f"écraser le fichier existant '{relative_path}'")
            else:
                self._request_consent(f"créer le fichier '{relative_path}'")

            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            return ToolResult(True, f"Fichier écrit: {relative_path}")
        except PermissionDeniedError as exc:
            return ToolResult(False, "", str(exc))
        except (SandboxViolationError, OSError) as exc:
            return ToolResult(False, "", str(exc))

    def create_file(self, relative_path: str, content: str = "") -> ToolResult:
        return self.write_file(relative_path, content, overwrite=False)

    def delete_file(self, relative_path: str) -> ToolResult:
        try:
            path = self._resolve_in_sandbox(relative_path)
            if not path.is_file():
                return ToolResult(False, "", f"Fichier introuvable: {relative_path}")
            self._request_consent(f"SUPPRIMER définitivement le fichier '{relative_path}'")
            path.unlink()
            return ToolResult(True, f"Fichier supprimé: {relative_path}")
        except PermissionDeniedError as exc:
            return ToolResult(False, "", str(exc))
        except (SandboxViolationError, OSError) as exc:
            return ToolResult(False, "", str(exc))

    # ------------------------------------------------------------------
    # Applications système (liste blanche + consentement)
    # ------------------------------------------------------------------
    def open_app(self, app_name: str) -> ToolResult:
        app_key = app_name.strip().lower()
        if app_key not in self.ALLOWED_APPS:
            allowed = ", ".join(self.ALLOWED_APPS)
            return ToolResult(False, "", f"Application '{app_name}' non autorisée. Choix possibles: {allowed}")

        os_name = platform.system()
        command = self.ALLOWED_APPS[app_key].get(os_name)
        if not command:
            return ToolResult(False, "", f"Application '{app_name}' non supportée sur {os_name}")

        try:
            self._request_consent(f"ouvrir l'application '{app_name}'")
            subprocess.Popen(command.split(), start_new_session=True)  # noqa: S603 - commande whitelistée
            return ToolResult(True, f"Application '{app_name}' lancée")
        except PermissionDeniedError as exc:
            return ToolResult(False, "", str(exc))
        except OSError as exc:
            return ToolResult(False, "", f"Échec du lancement: {exc}")

    # ------------------------------------------------------------------
    # Recherche web (lecture seule, sans clé API par défaut)
    # ------------------------------------------------------------------
    def web_search(self, query: str, max_results: int = 5) -> ToolResult:
        import requests

        try:
            response = requests.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
                timeout=10,
            )
            response.raise_for_status()
            data = response.json()

            lines: list[str] = []
            if data.get("AbstractText"):
                lines.append(data["AbstractText"])
            for topic in data.get("RelatedTopics", [])[:max_results]:
                text = topic.get("Text") if isinstance(topic, dict) else None
                if text:
                    lines.append(text)

            if not lines:
                return ToolResult(True, "Aucun résultat pertinent trouvé.")
            return ToolResult(True, "\n".join(lines[:max_results]))
        except requests.RequestException as exc:
            return ToolResult(False, "", f"Recherche web indisponible: {exc}")

    # ------------------------------------------------------------------
    # Dispatcher générique utilisé par Jarvis.process()
    # ------------------------------------------------------------------
    def execute(self, tool_name: str, **kwargs) -> ToolResult:
        dispatch = {
            "open_app": self.open_app,
            "read_file": self.read_file,
            "write_file": self.write_file,
            "create_file": self.create_file,
            "delete_file": self.delete_file,
            "list_files": self.list_files,
            "web_search": self.web_search,
        }
        handler = dispatch.get(tool_name)
        if handler is None:
            return ToolResult(False, "", f"Outil inconnu: {tool_name}")
        try:
            return handler(**kwargs)
        except TypeError as exc:
            return ToolResult(False, "", f"Arguments invalides pour '{tool_name}': {exc}")
