"""Point d'entrée CLI de Jarvis.

Mode texte par défaut (aucune dépendance voix requise) :
    python main.py

Mode voix (push-to-talk), nécessite les dépendances voix installées :
    python main.py --voice
"""

from __future__ import annotations

import argparse
import sys

from core.jarvis import Jarvis


def run_text_repl(jarvis: Jarvis) -> None:
    print("Jarvis (mode texte) — tapez 'exit' pour quitter.\n")
    while True:
        try:
            command = input("Vous > ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if command.lower() in {"exit", "quit", "quitte"}:
            break
        response = jarvis.process(command)
        print(f"Jarvis > {response.text}\n")


def run_voice_loop(jarvis: Jarvis) -> None:
    print("Jarvis (mode voix, push-to-talk) — appuyez sur Entrée pour parler, Ctrl+C pour quitter.\n")
    while True:
        try:
            input("Appuyez sur Entrée puis parlez...")
        except (EOFError, KeyboardInterrupt):
            break
        command = jarvis.voice.push_to_talk(duration_seconds=5.0)
        print(f"Vous (transcrit) > {command}")
        response = jarvis.process(command)
        print(f"Jarvis > {response.text}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Assistant IA Jarvis")
    parser.add_argument("--voice", action="store_true", help="Active le mode vocal (push-to-talk)")
    args = parser.parse_args()

    jarvis = Jarvis(enable_voice=args.voice)
    try:
        if args.voice:
            run_voice_loop(jarvis)
        else:
            run_text_repl(jarvis)
    finally:
        jarvis.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
