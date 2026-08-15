#!/usr/bin/env bash
# run-portal-proxy.sh — expose the real portal (4100) on the internet port.
#
# The ONLY real Pithagoras portal is the one serving on 4100 (run-portal.sh).
# Port 1338 exists solely as the internet-accessible path to it — it is NOT a
# second portal. This script runs a raw TCP forward from 0.0.0.0:1338 to
# 127.0.0.1:4100 with socat.
#
# A TCP-level forward (rather than an HTTP reverse proxy) is used on purpose:
# the portal's chat streams over SSE and long-lived HTTP connections, and
# WebSocket upgrades must travel on the SAME socket. socat just copies bytes, so
# every protocol — SSE, WebSocket, plain JSON — passes through transparently
# with no re-termination, no buffering surprises, and no cookie/Host rewriting.
#
# Because this reaches the one real portal, all sessions and their persistent
# sandbox containers are owned by that single instance — no split-brain between
# two portal processes with separate data dirs.
#
# Usage (systemd user unit, see ~/.config/systemd/user/pithagoras-1338.service):
#   systemctl --user start pithagoras-1338
set -euo pipefail

: "${PORT_1338:=1338}"     # internet-facing listen port
: "${REAL_PORTAL_HOST:=127.0.0.1}"  # the real portal listens on loopback
: "${REAL_PORTAL_PORT:=4100}"

echo "pithagoras-proxy: 0.0.0.0:${PORT_1338} -> ${REAL_PORTAL_HOST}:${REAL_PORTAL_PORT}"
exec socat TCP-LISTEN:${PORT_1338},fork,reuseaddr,keepalive TCP:${REAL_PORTAL_HOST}:${REAL_PORTAL_PORT}
