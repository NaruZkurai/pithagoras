#!/usr/bin/env bash
# Serve a local GGUF model for the pi harness (OpenAI-compatible endpoint).
#
# IMPORTANT: use ./gitrepos/llama-direct-token-input (the repo's own llama.cpp
# fork) as the serving runtime — NOT the turboquant/caveman fork (which injects
# logit biases) and not a plain stock llama-server. The built binary is:
#   ./gitrepos/llama-direct-token-input/build/bin/llama-server
#
# Configure via environment variables (or edit the defaults below):
#   LLAMA_BIN  path to llama-server            (default: ./gitrepos/llama-direct-token-input/build/bin/llama-server)
#   MODEL      path to your .gguf              (default: ./models/model.gguf)
#   ALIAS      model id the server exposes     (default: gemma-4)
#   PORT       listen port                     (default: 41001)
#
# Tuning notes: offload the weights to the GPU (-ngl 99) and keep the KV cache
# on CPU (--no-kv-offload) so a large model fits in VRAM shared with a desktop.
set -euo pipefail
cd "$(dirname "$0")/.."

LLAMA_BIN="${LLAMA_BIN:-$PWD/gitrepos/llama-direct-token-input/build/bin/llama-server}"
MODEL="${MODEL:-$PWD/models/model.gguf}"
ALIAS="${ALIAS:-gemma-4}"
PORT="${PORT:-41001}"

if [ ! -x "$LLAMA_BIN" ]; then
  echo "llama-server not found (LLAMA_BIN=${LLAMA_BIN}). Use ./gitrepos/llama-direct-token-input/build/bin/llama-server." >&2
  exit 1
fi
if [ ! -f "$MODEL" ]; then
  echo "model not found (MODEL=${MODEL}). Set MODEL to your .gguf file." >&2
  exit 1
fi

exec "$LLAMA_BIN" \
  -m "$MODEL" \
  --alias "$ALIAS" \
  --jinja \
  -ngl 99 \
  --no-kv-offload \
  -c 65536 \
  --parallel 2 \
  ${REASONING_FLAG:---reasoning off} \
  --host 127.0.0.1 \
  --port "$PORT"
