#!/usr/bin/env bash
# NOTE: DEPRECATED — do not run a second portal.
#
# Port 1338 is NOT a separate portal. It is the internet-accessible port that
# reaches the one real portal on 4100 (see run-portal-proxy.sh and the systemd
# unit ~/.config/systemd/user/pithagoras-1338.service, which runs the socat
# forward). This file previously started a second, independent portal with its
# own data-1338 dir — that split-brain setup is retired because it created
# duplicate sessions/containers. Kept only as a reference in git history.
set -euo pipefail
echo "run-portal-1338.sh is deprecated: 1338 is the internet port that forwards to the real portal on 4100 (socat proxy)."
echo "The systemd unit pithagoras-1338.service runs scripts/run-portal-proxy.sh instead."
exit 1

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
# Same sandbox image the primary uses: the minimal Arch runner. Without this
# this instance falls back to the Debian default image.
export PI_IMAGE="${PI_IMAGE:-pithagoras-runner-arch:latest}"
export PATH="$PWD/node_modules/.bin:$PATH"

mkdir -p "$DATA_DIR" "$SESSION_DIR" "$WORKSPACE_ROOT" "$AGENT_HOME" "$CHANNELS_DIR" "$BIN_DIR"
echo "pithagoras-1338: http://localhost:${PORT}  (model ${PI_PROVIDER}/${PI_MODEL})"
exec node server/dist/index.js
