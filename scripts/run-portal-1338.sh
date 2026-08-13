#!/usr/bin/env bash
# Run a SECOND, independent Pithagoras portal instance on port 1338.
#
# A genuine duplicate: its own PORT, DATA_DIR, sessions, workspaces, agent home
# and channels live under ./data-1338 so the primary (4100, ./data) never
# shares a DB or session state with it. They DO share the model servers (port
# 41001 etc.) — only one process may own llama.cpp, so this instance reuses the
# primary's running model server rather than launching a second one.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export PORT="${PORT_1338:-1338}"
export DATA_DIR="${DATA_DIR_1338:-$PWD/data-1338}"
export SESSION_DIR="${SESSION_DIR_1338:-$DATA_DIR/sessions}"
export WORKSPACE_ROOT="${WORKSPACE_ROOT_1338:-$DATA_DIR/workspaces}"
export AGENT_HOME="${AGENT_HOME_1338:-$DATA_DIR/agent-home}"
export CHANNELS_DIR="${CHANNELS_DIR_1338:-$DATA_DIR/channels}"
export BIN_DIR="${BIN_DIR_1338:-$PWD/data/bin}"
export PORTAL_PASSWORD="${PORTAL_PASSWORD:-deathlover}"
export PORTAL_SECRET="${PORTAL_SECRET:-1338-secret-portal}"
export PI_PROVIDER="${PI_PROVIDER:-local}"
export PI_MODEL="${PI_MODEL:-gemma-4}"
export LLAMA_BASE_URL="${LLAMA_BASE_URL:-http://127.0.0.1:41001}"
export LLAMA_RANK_BASE_URL="${LLAMA_RANK_BASE_URL:-http://127.0.0.1:41002}"
export PI_RANK_MODEL="${PI_RANK_MODEL:-bonsai-1.7b}"
export LAZY_MODELS="${LAZY_MODELS:-1}"
export LAZY_IDLE_MS="${LAZY_IDLE_MS:-900000}"
export PATH="$PWD/node_modules/.bin:$PATH"

mkdir -p "$DATA_DIR" "$SESSION_DIR" "$WORKSPACE_ROOT" "$AGENT_HOME" "$CHANNELS_DIR" "$BIN_DIR"
echo "pithagoras-1338: http://localhost:${PORT}  (model ${PI_PROVIDER}/${PI_MODEL})"
exec node server/dist/index.js
