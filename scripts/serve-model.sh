#!/usr/bin/env bash
# Serve a local GGUF model for the pi harness (OpenAI-compatible endpoint).
#
# IMPORTANT: use a CLEAN, stock llama.cpp build (>= build 9973). Do NOT use a
# build from the turboquant/caveman fork: it injects a terse "caveman" persona
# and logit biases that break OpenAI function/tool calling (verified: the model
# never emits `tool_calls`). The clean build does tool calls fine.
#
# Configure via environment variables (or edit the defaults below):
#   LLAMA_BIN  path to llama-server            (default: llama-server on PATH)
#   MODEL      path to your .gguf              (default: ./models/model.gguf)
#   ALIAS      model id the server exposes     (default: gemma-4)
#   PORT       listen port                     (default: 8080)
#
# Tuning notes: offload the weights to the GPU (-ngl 99) and keep the KV cache
# on CPU (--no-kv-offload) so a large model fits in VRAM shared with a desktop.
set -euo pipefail

LLAMA_BIN="${LLAMA_BIN:-llama-server}"
MODEL="${MODEL:-$PWD/models/model.gguf}"
ALIAS="${ALIAS:-gemma-4}"
PORT="${PORT:-8080}"

if ! command -v "$LLAMA_BIN" >/dev/null 2>&1; then
  echo "llama-server not found (LLAMA_BIN=${LLAMA_BIN}). Set LLAMA_BIN to a clean llama.cpp build." >&2
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
  --reasoning off \
  --host 127.0.0.1 \
  --port "$PORT"
