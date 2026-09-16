"""Mémoire long terme de Jarvis, basée sur ChromaDB (vectorielle, persistante).

Chaque souvenir est stocké comme un triplet (entity, attribute, value) avec
des métadonnées libres (source, timestamp, importance...). La recherche se
fait par similarité sémantique via `recall(query)`.

Une routine `auto_summary` condense les souvenirs bruts en résumés toutes les
N jours (7 par défaut) pour limiter la croissance de la mémoire et garder un
contexte exploitable en un seul rappel.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:
    import chromadb
    from chromadb.config import Settings as ChromaSettings
except ImportError as exc:  # pragma: no cover - dépendance optionnelle au moment de l'import
    raise ImportError(
        "chromadb est requis pour la mémoire long terme. "
        "Installez-le avec: pip install chromadb"
    ) from exc

logger = logging.getLogger("jarvis.memory.long_term")

_COLLECTION_NAME = "jarvis_memory"
_SYSTEM_ENTITY = "__system__"
_SUMMARY_ATTRIBUTE = "last_auto_summary_at"


@dataclass
class MemoryRecord:
    """Représentation typée d'un souvenir retourné par `recall`."""

    id: str
    entity: str
    attribute: str
    value: str
    metadata: dict[str, Any] = field(default_factory=dict)
    distance: Optional[float] = None

    @property
    def as_text(self) -> str:
        return f"{self.entity}.{self.attribute} = {self.value}"


class LongTermMemory:
    """Mémoire vectorielle persistante pour Jarvis.

    Exemple:
        memory = LongTermMemory(persist_directory="./data/chroma")
        memory.remember("utilisateur", "prénom", "Alex")
        resultats = memory.recall("comment s'appelle l'utilisateur ?")
    """

    def __init__(
        self,
        persist_directory: str | Path = "./data/chroma",
        collection_name: str = _COLLECTION_NAME,
        auto_summary_interval_days: float = 7.0,
    ) -> None:
        self.persist_directory = Path(persist_directory)
        self.persist_directory.mkdir(parents=True, exist_ok=True)
        self.auto_summary_interval = timedelta(days=auto_summary_interval_days)

        self._client = chromadb.PersistentClient(
            path=str(self.persist_directory),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        # La fonction d'embedding par défaut de ChromaDB (ONNX MiniLM) tourne
        # entièrement en local, sans clé API ni appel réseau.
        self._collection = self._client.get_or_create_collection(name=collection_name)

        self._scheduler_thread: Optional[threading.Thread] = None
        self._scheduler_stop = threading.Event()

    # ------------------------------------------------------------------
    # Écriture
    # ------------------------------------------------------------------
    def remember(
        self,
        entity: str,
        attribute: str,
        value: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> str:
        """Enregistre ou met à jour un souvenir (entity, attribute, value).

        Retourne l'identifiant du souvenir créé.
        """
        if not entity or not attribute:
            raise ValueError("entity et attribute sont obligatoires")

        record_id = str(uuid.uuid4())
        full_metadata: dict[str, Any] = {
            "entity": entity,
            "attribute": attribute,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if metadata:
            # On aplati les métadonnées non scalaires en JSON pour rester
            # compatible avec les contraintes de ChromaDB (str/int/float/bool).
            for key, val in metadata.items():
                full_metadata[key] = val if isinstance(val, (str, int, float, bool)) else json.dumps(val)

        document = f"{entity} | {attribute} | {value}"
        self._collection.add(
            ids=[record_id],
            documents=[document],
            metadatas=[full_metadata],
        )
        logger.debug("Souvenir enregistré: %s", document)
        return record_id

    def forget(self, entity: Optional[str] = None, attribute: Optional[str] = None) -> int:
        """Supprime les souvenirs correspondant au filtre entity/attribute.

        Retourne le nombre de souvenirs supprimés.
        """
        where: dict[str, Any] = {}
        if entity:
            where["entity"] = entity
        if attribute:
            where["attribute"] = attribute
        if not where:
            raise ValueError("Précisez au moins entity ou attribute pour éviter un oubli total accidentel")

        matches = self._collection.get(where=where)
        ids = matches.get("ids", [])
        if ids:
            self._collection.delete(ids=ids)
        return len(ids)

    # ------------------------------------------------------------------
    # Lecture
    # ------------------------------------------------------------------
    def recall(
        self,
        query: str,
        n_results: int = 5,
        entity_filter: Optional[str] = None,
    ) -> list[MemoryRecord]:
        """Recherche les souvenirs les plus pertinents pour `query`."""
        where = {"entity": entity_filter} if entity_filter else None
        results = self._collection.query(
            query_texts=[query],
            n_results=n_results,
            where=where,
        )

        records: list[MemoryRecord] = []
        ids = results.get("ids", [[]])[0]
        documents = results.get("documents", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]
        distances = results.get("distances", [[]])[0] if results.get("distances") else [None] * len(ids)

        for rid, doc, meta, dist in zip(ids, documents, metadatas, distances):
            entity, attribute, value = _split_document(doc, meta)
            records.append(
                MemoryRecord(
                    id=rid,
                    entity=entity,
                    attribute=attribute,
                    value=value,
                    metadata=meta or {},
                    distance=dist,
                )
            )
        return records

    def recall_context(self, query: str, n_results: int = 5) -> str:
        """Retourne un bloc de texte prêt à injecter dans un prompt LLM."""
        records = self.recall(query, n_results=n_results)
        if not records:
            return ""
        return "\n".join(f"- {r.as_text}" for r in records)

    # ------------------------------------------------------------------
    # Résumé automatique (toutes les N jours)
    # ------------------------------------------------------------------
    def _last_summary_at(self) -> Optional[datetime]:
        matches = self._collection.get(where={"entity": _SYSTEM_ENTITY, "attribute": _SUMMARY_ATTRIBUTE})
        documents = matches.get("documents") or []
        if not documents:
            return None
        try:
            _, _, value = documents[-1].split(" | ", 2)
            return datetime.fromisoformat(value)
        except (ValueError, IndexError):
            return None

    def should_run_auto_summary(self) -> bool:
        last_run = self._last_summary_at()
        if last_run is None:
            return True
        return datetime.now(timezone.utc) - last_run >= self.auto_summary_interval

    def auto_summary(self, summarizer_fn: Optional[Callable[[list[MemoryRecord]], str]] = None) -> Optional[str]:
        """Condense les souvenirs récents en un résumé, si l'intervalle est écoulé.

        `summarizer_fn` reçoit la liste des souvenirs bruts et doit renvoyer un
        texte de résumé (par ex. un appel à un LLM). Sans fonction fournie, un
        résumé extractif simple (regroupement par entité) est utilisé, ce qui
        garde le mécanisme fonctionnel hors-ligne.
        """
        if not self.should_run_auto_summary():
            return None

        since = self._last_summary_at() or (datetime.now(timezone.utc) - timedelta(days=3650))
        raw = self._collection.get(where={"entity": {"$ne": _SYSTEM_ENTITY}})
        documents = raw.get("documents") or []
        metadatas = raw.get("metadatas") or []
        ids = raw.get("ids") or []

        recent: list[MemoryRecord] = []
        for rid, doc, meta in zip(ids, documents, metadatas):
            created_at = meta.get("created_at")
            if created_at:
                try:
                    if datetime.fromisoformat(created_at) < since:
                        continue
                except ValueError:
                    pass
            entity, attribute, value = _split_document(doc, meta)
            recent.append(MemoryRecord(id=rid, entity=entity, attribute=attribute, value=value, metadata=meta))

        if not recent:
            summary_text = "Aucune nouvelle information marquante cette semaine."
        elif summarizer_fn is not None:
            summary_text = summarizer_fn(recent)
        else:
            summary_text = _default_extractive_summary(recent)

        self.remember(
            entity=_SYSTEM_ENTITY,
            attribute="summary",
            value=summary_text,
            metadata={"kind": "auto_summary", "covered_records": len(recent)},
        )
        self.remember(
            entity=_SYSTEM_ENTITY,
            attribute=_SUMMARY_ATTRIBUTE,
            value=datetime.now(timezone.utc).isoformat(),
        )
        logger.info("Résumé automatique généré (%d souvenirs condensés)", len(recent))
        return summary_text

    def start_auto_summary_scheduler(
        self,
        check_interval_seconds: float = 3600.0,
        summarizer_fn: Optional[Callable[[list[MemoryRecord]], str]] = None,
    ) -> None:
        """Lance un thread d'arrière-plan qui vérifie périodiquement s'il faut résumer.

        Le thread ne fait aucune I/O réseau : il ne fait qu'appeler `auto_summary`,
        qui décide lui-même si l'intervalle de 7 jours est écoulé.
        """
        if self._scheduler_thread is not None:
            return

        def _loop() -> None:
            while not self._scheduler_stop.wait(check_interval_seconds):
                try:
                    self.auto_summary(summarizer_fn=summarizer_fn)
                except Exception:  # noqa: BLE001 - un échec de résumé ne doit jamais planter Jarvis
                    logger.exception("Échec du résumé automatique périodique")

        self._scheduler_stop.clear()
        self._scheduler_thread = threading.Thread(target=_loop, name="jarvis-auto-summary", daemon=True)
        self._scheduler_thread.start()

    def stop_auto_summary_scheduler(self) -> None:
        if self._scheduler_thread is None:
            return
        self._scheduler_stop.set()
        self._scheduler_thread.join(timeout=5)
        self._scheduler_thread = None

    def close(self) -> None:
        self.stop_auto_summary_scheduler()


def _split_document(document: str, metadata: Optional[dict[str, Any]]) -> tuple[str, str, str]:
    """Reconstruit (entity, attribute, value) depuis le document ou les métadonnées."""
    if metadata and "entity" in metadata and "attribute" in metadata:
        parts = document.split(" | ", 2)
        value = parts[2] if len(parts) == 3 else document
        return str(metadata["entity"]), str(metadata["attribute"]), value
    parts = document.split(" | ", 2)
    if len(parts) == 3:
        return parts[0], parts[1], parts[2]
    return "inconnu", "inconnu", document


def _default_extractive_summary(records: list[MemoryRecord]) -> str:
    """Résumé simple sans LLM: regroupe les souvenirs par entité."""
    by_entity: dict[str, list[str]] = {}
    for record in records:
        by_entity.setdefault(record.entity, []).append(f"{record.attribute}={record.value}")

    lines = [f"Résumé automatique du {datetime.now(timezone.utc).date().isoformat()}:"]
    for entity, attrs in by_entity.items():
        lines.append(f"- {entity}: " + ", ".join(attrs))
    return "\n".join(lines)
