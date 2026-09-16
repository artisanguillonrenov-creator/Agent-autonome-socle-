# Jarvis Assistant (Python)

Assistant IA personnel type Jarvis : mémoire vectorielle persistante,
voix offline avec fallback cloud, exécution d'outils sandboxée avec
consentement explicite. Sous-projet Python autonome, indépendant du socle
TypeScript (`src/`) présent à la racine du dépôt.

## Structure

```
jarvis_assistant/
├── core/jarvis.py        # Classe Jarvis (orchestrateur : process())
├── memory/long_term.py   # Mémoire vectorielle persistante (ChromaDB)
├── voice/interface.py    # Wake-word, STT, TTS (offline + fallback cloud)
├── tools/executor.py     # Outils sandboxés (fichiers, apps, recherche web)
├── config/settings.py    # Chargement des clés API / paramètres
├── sandbox/              # Seul répertoire où Jarvis peut lire/écrire/créer
├── data/chroma/          # Base ChromaDB persistante (créée au premier run)
├── main.py               # CLI (mode texte ou vocal push-to-talk)
├── requirements.txt
└── .env.example
```

## Installation

```bash
cd jarvis_assistant
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # puis éditez .env si besoin (tout est optionnel)
```

### Dépendances voix (optionnelles selon l'usage)

- **STT offline** : `faster-whisper` télécharge automatiquement son modèle
  (`base` par défaut, réglable via `JARVIS_WHISPER_MODEL`) au premier usage.
- **Wake-word offline (Vosk, par défaut)** : téléchargez un petit modèle sur
  https://alphacephei.com/vosk/models, décompressez-le, et renseignez
  `VOSK_MODEL_PATH` dans `.env`.
- **Wake-word Porcupine (optionnel, plus précis)** : nécessite un compte
  Picovoice gratuit et `PORCUPINE_ACCESS_KEY` dans `.env`, puis
  `pip install pvporcupine` (décommentez la ligne dans `requirements.txt`).
- **TTS offline** : `pyttsx3` utilise les voix déjà installées sur l'OS
  (SAPI5 sous Windows, NSSpeechSynthesizer sous macOS, espeak sous Linux —
  `sudo apt install espeak` si besoin).

Sans aucune de ces dépendances installées, Jarvis reste utilisable en
**mode texte** (`python main.py`).

## Lancer Jarvis

```bash
python main.py            # mode texte (REPL)
python main.py --voice    # mode vocal push-to-talk (Entrée pour parler)
```

## Confidentialité et sécurité

- **Aucune écoute permanente** : le micro n'est activé que pour la détection
  du mot-clé "Jarvis" ou explicitement en mode push-to-talk.
- **Priorité au offline** : mémoire, STT, TTS et décision tournent en local
  par défaut. Le fallback cloud (Groq/OpenAI) est désactivé par défaut
  (`JARVIS_ALLOW_CLOUD_FALLBACK=false`) et n'est utilisé que si vous
  l'activez explicitement ET que le traitement offline échoue.
- **Sandbox de fichiers** : toute lecture/écriture/création de fichier est
  confinée à `jarvis_assistant/sandbox/` ; toute tentative de sortir de ce
  répertoire est rejetée.
- **Consentement explicite** : écraser un fichier, le supprimer, ou ouvrir
  une application déclenche une confirmation (`o/n`) avant exécution.

## Mémoire long terme

```python
from memory.long_term import LongTermMemory

memory = LongTermMemory(persist_directory="./data/chroma")
memory.remember("utilisateur", "langage_préféré", "Python")
resultats = memory.recall("quel langage l'utilisateur préfère-t-il ?")
memory.auto_summary()  # condense automatiquement si 7 jours sont écoulés
```

## Étendre les outils

Ajoutez une méthode à `ToolExecutor` (`tools/executor.py`) puis enregistrez-la
dans le dictionnaire `dispatch` de `ToolExecutor.execute()`, et ajoutez la
règle de routage correspondante dans `Jarvis._route_to_tool()`
(`core/jarvis.py`).
