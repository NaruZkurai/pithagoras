#!/usr/bin/env bash
# Run the Pithagoras portal on the host (Node >= 22.19; tested on Node 26).
#
# Reads .env (PORTAL_PASSWORD etc.) then applies host-run defaults so pi talks
# to the local llama.cpp model server on 127.0.0.1:41001.
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
export LLAMA_BASE_URL="${LLAMA_BASE_URL:-http://127.0.0.1:41001}"
# Where the portal keeps CLIs it wants on pi's PATH. The upstream image uses
# /data/bin; on the host that is not writable, so use a dir under the repo.
export BIN_DIR="${BIN_DIR:-$PWD/data/bin}"
mkdir -p "$BIN_DIR"
# npm puts the pi CLI shim (and friends) here; make them visible to the portal
# so extension listing etc. can find them.
export PATH="$PWD/node_modules/.bin:$PATH"
# Dedicated tiny model for ranking candidate skills (see serve-rank-model.sh).
export LLAMA_RANK_BASE_URL="${LLAMA_RANK_BASE_URL:-http://127.0.0.1:41002}"
export PI_RANK_MODEL="${PI_RANK_MODEL:-bonsai-1.7b}"
# How many form-fill scores per candidate, averaged (the tiny model is noisy;
# it's fast enough that a few extra scores cost little).
export PI_RANK_REPS="${PI_RANK_REPS:-6}"
# Power saving: with LAZY_MODELS=1 (default) no llama.cpp model is pinned at
# boot — servers start on demand (first session/rank) and stop after
# LAZY_IDLE_MS of inactivity (default 15 min). Set LAZY_MODELS=0 for always-on.
export LAZY_MODELS="${LAZY_MODELS:-1}"
export LAZY_IDLE_MS="${LAZY_IDLE_MS:-900000}"
export PORTAL_SECRET="${PORTAL_SECRET:-$(openssl rand -hex 32)}"

: "${PORTAL_PASSWORD:?set PORTAL_PASSWORD in .env}"
export PORTAL_PASSWORD

echo "portal: http://localhost:${PORT}  (model ${PI_PROVIDER}/${PI_MODEL})"
mkdir -p "$DATA_DIR" "$SESSION_DIR" "$WORKSPACE_ROOT" "$AGENT_HOME" "$CHANNELS_DIR"
exec node server/dist/index.js
