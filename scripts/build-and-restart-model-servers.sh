#!/usr/bin/env bash
# build-and-restart-model-servers.sh — rebuild and restart the Pithagoras model
# servers on the model box (192.168.2.64).
#
# Runs ON the model box (or wherever the 27B + 4B fleet are served). Brings the
# model services back up after an outage / keeps the llama.cpp binary current:
#   1. Optionally rebuilds llama-server (stock or the direct-token fork),
#   2. Restarts the 27B (bonsai-api, :6464) and the 4B fleet (:6465-6469),
#   3. Waits and health-checks every port before declaring success.
#
# The box can be managed via systemd services OR docker containers. This script
# detects whichever is present and drives it.
#
# Usage (on the box):
#   ./scripts/build-and-restart-model-servers.sh            # restart only
#   ./scripts/build-and-restart-model-servers.sh --rebuild  # rebuild llama-server, then restart
#   ./scripts/build-and-restart-model-servers.sh --check    # only probe /health
# Env overrides (defaults match the current box layout):
#   LLAMA_SRC     llama.cpp source dir          (default: /nzk/git/llama.cpp)
#   LLAMA_BIN     llama-server binary           (default: $LLAMA_SRC/build-cuda/bin/llama-server)
#   MODEL_27B     27B .gguf path                 (default: /mnt/data/sda4/models/Bonsai-27B-Q1_0.gguf)
#   MODEL_4B      4B .gguf path                  (default: /nzk/models/Bonsai-4B-Q1_0.gguf)
#   FLEET_PORT    4B fleet base port             (default: 6465, five instances 6465-6469)
#   CTX_27B       27B context length             (default: 126000)
#   CTX_4B        4B context length per instance (default: 4096)
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-restart}"     # restart | rebuild | check
LLAMA_SRC="${LLAMA_SRC:-/nzk/git/llama.cpp}"
LLAMA_BIN="${LLAMA_BIN:-$LLAMA_SRC/build-cuda/bin/llama-server}"
MODEL_27B="${MODEL_27B:-/mnt/data/sda4/models/Bonsai-27B-Q1_0.gguf}"
MODEL_4B="${MODEL_4B:-/nzk/models/Bonsai-4B-Q1_0.gguf}"
FLEET_PORT="${FLEET_PORT:-6465}"
HOST="${MODEL_HOST:-127.0.0.1}"
PORT_27B="${PORT_27B:-6464}"
CTX_27B="${CTX_27B:-126000}"
CTX_4B="${CTX_4B:-4096}"
PARALLEL_27B="${PARALLEL_27B:-1}"

health() { # host port
  curl -sf -m 6 "http://$1:$2/health" >/dev/null 2>&1
}

wait_up() { # port seconds
  local p="$1" t="$2" i
  for i in $(seq 1 "$t"); do
    health "$HOST" "$p" && { echo "  :$p UP"; return 0; }
    sleep 1
  done
  echo "  :$p still DOWN after ${t}s" >&2
  return 1
}

rebuild() {
  if [ ! -d "$LLAMA_SRC" ]; then
    echo "llama.cpp source not found: $LLAMA_SRC — skipping rebuild."
    return 0
  fi
  echo "==> Rebuilding llama-server from $LLAMA_SRC ..."
  cmake -S "$LLAMA_SRC" -B "$LLAMA_SRC/build-cuda" \
    -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF 2>&1 | tail -3
  cmake --build "$LLAMA_SRC/build-cuda" --target llama-server -j "$(nproc)" 2>&1 | tail -5
  echo "    rebuilt: $LLAMA_BIN"
}

has_services() { systemctl list-units --all 2>/dev/null | grep -q "bonsai"; }
has_containers() { command -v docker >/dev/null 2>&1 && docker ps -a 2>/dev/null | grep -qE "bonsai"; }

restart_service() { # unit
  echo "==> restarting systemd service: $1"
  systemctl restart "$1" || echo "    (no service $1 or needs sudo)"
}

restart_all() {
  echo "=== Restarting 27B (bonsai-api) ==="
  if has_services; then
    restart_service bonsai-api
    restart_service bonsai-4b-fleet
  elif has_containers; then
    echo "==> restarting docker containers ..."
    cids=$(docker ps -aq --filter "name=bonsai")
    [ -n "$cids" ] && docker restart $cids || echo "    no bonsai containers found"
  else
    echo "!! No systemd services or docker containers for bonsai found on this host."
    echo "   Expected bonsai-api (:6464) and bonsai-4b-fleet (:6465-6469)."
  fi
}

check() {
  echo "=== Model server health ==="
  wait_up "$PORT_27B" 5 && echo "  27B OK (:${PORT_27B})" || { echo "  27B DOWN" >&2; }
  for p in $(seq "$FLEET_PORT" $((FLEET_PORT + 4))); do
    wait_up "$p" 5 && echo "  4B fleet OK (:$p)" || echo "  4B fleet :$p DOWN" >&2
  done
}

# ---- run ----
case "$MODE" in
  check) check ;;
  rebuild) rebuild; restart_all; echo "waiting for services to come up..."; sleep 3; check ;;
  restart) restart_all; echo "waiting for services to come up..."; sleep 3; check ;;
  *) echo "usage: $0 [restart|rebuild|check]"; exit 1 ;;
esac

# Final gate: the 27B must answer to consider the box usable.
echo ""
if health "$HOST" "$PORT_27B"; then
  echo "RESULT: model box READY — 27B on :${PORT_27B} is healthy."
else
  echo "RESULT: 27B on :${PORT_27B} is STILL DOWN. Check the box's VRAM/logs." >&2
  exit 1
fi
