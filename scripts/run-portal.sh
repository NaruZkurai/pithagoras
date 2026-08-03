#!/usr/bin/env bash
# Run the Pithagoras portal on the host (Node >= 22.19; tested on Node 26).
#
# Reads .env (PORTAL_PASSWORD etc.) then applies host-run defaults so pi talks
# to the local llama.cpp model server on 127.0.0.1:8080.
#
# Requires: npm install (done), npm run build (done), and the model server
# running (see serve-model.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env if present (gitignored). set -a exports the variables.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export PORT="${PORT:-4100}"
export DATA_DIR="${DATA_DIR:-$PWD/data}"
export SESSION_DIR="${SESSION_DIR:-$PWD/data/sessions}"
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$PWD/data/workspaces}"
export AGENT_HOME="${AGENT_HOME:-$PWD/data/agent-home}"
export CHANNELS_DIR="${CHANNELS_DIR:-$PWD/data/channels}"
export PI_PROVIDER="${PI_PROVIDER:-local}"
export PI_MODEL="${PI_MODEL:-gemma-4}"
export LLAMA_BASE_URL="${LLAMA_BASE_URL:-http://127.0.0.1:8080}"
# npm puts the pi CLI shim (and friends) here; make them visible to the portal
# so extension listing etc. can find them.
export PATH="$PWD/node_modules/.bin:$PATH"
# Dedicated tiny model for ranking candidate skills (see serve-rank-model.sh).
export LLAMA_RANK_BASE_URL="${LLAMA_RANK_BASE_URL:-http://127.0.0.1:8081}"
export PI_RANK_MODEL="${PI_RANK_MODEL:-bonsai-1.7b}"
# How many form-fill scores per candidate, averaged (the tiny model is noisy;
# it's fast enough that a few extra scores cost little).
export PI_RANK_REPS="${PI_RANK_REPS:-6}"
export PORTAL_SECRET="${PORTAL_SECRET:-$(openssl rand -hex 32)}"

: "${PORTAL_PASSWORD:?set PORTAL_PASSWORD in .env}"
export PORTAL_PASSWORD

echo "portal: http://localhost:${PORT}  (model ${PI_PROVIDER}/${PI_MODEL})"
mkdir -p "$DATA_DIR" "$SESSION_DIR" "$WORKSPACE_ROOT" "$AGENT_HOME" "$CHANNELS_DIR"
exec node server/dist/index.js
