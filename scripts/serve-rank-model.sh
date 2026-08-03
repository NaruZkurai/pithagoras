#!/usr/bin/env bash
# Serve the DEDICATED tiny ranking model for the skill library.
#
# A separate llama server so scoring a skill's value (fill-in-the-form, scored
# 0-100) never steals context or tokens from the main agent, and the main model
# never has to judge candidates in its own conversation.
#
# Runs the PrismML llama.cpp fork — the runtime the Bonsai ternary GGUFs
# (group-128 Q2_0) are built for; mainline llama-server refuses them. Built
# CPU-only (build-cpu) so the ranker costs zero VRAM next to VRChat/WiVRn.
#
# Configure via environment variables (or edit the defaults below):
#   LLAMA_BIN  path to llama-server     (default: PrismML fork, CPU build)
#   MODEL      path to your .gguf       (default: Ternary-Bonsai-1.7B-Q2_0.gguf)
#   ALIAS      model id it exposes      (default: bonsai-1.7b)
#   PORT       listen port              (default: 8081)
#   CTX        context size             (default: 2048 — plenty for one skill)
#   NGL        layers on GPU            (default: 0 = CPU-only)
#   THREADS    CPU threads              (default: 12)
#   PARALLEL   concurrent slots         (default: 3 — scores can run together)
set -euo pipefail

cd "$(dirname "$0")/.."

LLAMA_BIN="${LLAMA_BIN:-/nzk/git/llama.cpp-prism/build-cpu/bin/llama-server}"
MODEL="${MODEL:-/nzk/models/Ternary-Bonsai-1.7B-Q2_0.gguf}"
ALIAS="${ALIAS:-bonsai-1.7b}"
PORT="${PORT:-8081}"
CTX="${CTX:-2048}"
NGL="${NGL:-0}"
THREADS="${THREADS:-12}"
PARALLEL="${PARALLEL:-3}"

if [ ! -x "$LLAMA_BIN" ]; then
  echo "llama-server not found (LLAMA_BIN=${LLAMA_BIN})." >&2
  exit 1
fi
if [ ! -f "$MODEL" ]; then
  echo "ranking model not found (MODEL=${MODEL}). Set MODEL to your .gguf file." >&2
  exit 1
fi

echo "ranking model server: ${ALIAS} on :${PORT}  (${MODEL})  ngl=${NGL}"
exec "$LLAMA_BIN" \
  -m "$MODEL" \
  --alias "$ALIAS" \
  -ngl "$NGL" \
  -c "$CTX" \
  -t "$THREADS" \
  --parallel "$PARALLEL" \
  --host 127.0.0.1 \
  --port "$PORT"
