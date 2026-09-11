#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS_DIR="$ROOT_DIR/android/app/src/main/assets/voice"
MODEL_NAME="vits-piper-fr_FR-siwis-medium"
MODEL_DIR="$ASSETS_DIR/$MODEL_NAME"
MODEL_FILE="$MODEL_DIR/fr_FR-siwis-medium.onnx"
TOKENS_FILE="$MODEL_DIR/tokens.txt"
DATA_DIR="$MODEL_DIR/espeak-ng-data"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL_NAME}.tar.bz2"
ARCHIVE="${RUNNER_TEMP:-/tmp}/${MODEL_NAME}.tar.bz2"

if [[ -s "$MODEL_FILE" && -s "$TOKENS_FILE" && -d "$DATA_DIR" ]]; then
  echo "SIWIS voice assets already present."
  exit 0
fi

mkdir -p "$ASSETS_DIR"
rm -rf "$MODEL_DIR"

echo "Downloading integrated Jarvis voice: $MODEL_NAME"
curl --fail --location --retry 4 --retry-delay 2 --connect-timeout 20 \
  --output "$ARCHIVE" "$URL"

echo "Extracting SIWIS voice into Android assets..."
tar -xjf "$ARCHIVE" -C "$ASSETS_DIR"
rm -f "$ARCHIVE"

[[ -s "$MODEL_FILE" ]] || { echo "Missing SIWIS ONNX model after extraction" >&2; exit 1; }
[[ -s "$TOKENS_FILE" ]] || { echo "Missing SIWIS tokens.txt after extraction" >&2; exit 1; }
[[ -d "$DATA_DIR" ]] || { echo "Missing SIWIS espeak-ng-data after extraction" >&2; exit 1; }

MODEL_BYTES=$(wc -c < "$MODEL_FILE")
if (( MODEL_BYTES < 60000000 )); then
  echo "SIWIS model is unexpectedly small: ${MODEL_BYTES} bytes" >&2
  exit 1
fi

echo "SIWIS voice ready (${MODEL_BYTES} bytes model)."
