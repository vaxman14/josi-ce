#!/bin/zsh
set -euo pipefail
base=/Volumes/JosiOS/JosiDrive/services/neighbor-voice
exec "$base/.venv/bin/python" "$base/server.py" \
  --bind 10.10.1.30 \
  --port 3911 \
  --reference "$base/reference.wav" \
  --token-file "$base/token" \
  --cache /Volumes/JosiOS/JosiDrive/caches/huggingface
