#!/usr/bin/env bash
#
# sync-prime-agent.sh — pull the prime-agent files we track into vendor/ so we
# can use and modify them inside the Pithagoras harness, while still following
# upstream as the project updates.
#
# prime-agent is a git submodule at gitrepos/prime-agent (pinned to a tag). This
# script copies a curated set of its most useful source files into
# vendor/prime-agent/<same-relative-path> so we own copies we can edit, and
# records the upstream commit they came from.
#
# WORKFLOW after an upstream update:
#   1. cd gitrepos/prime-agent && git fetch && git checkout <new-tag>   (or main)
#   2. cd ../.. && ./scripts/sync-prime-agent.sh
#   3. Re-apply our local patches (see vendor/prime-agent/PATCHES.md) on top of
#      the freshly copied files, if any of them collide.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PA="$ROOT/gitrepos/prime-agent"
SRC="$PA"
DST="$ROOT/vendor/prime-agent"

# Files we track from upstream. Relative to the prime-agent repo root. Add or
# remove paths here and re-run — the script diffs what we keep vs. skip.
FILES=(
  "prime-agent-runtime/src/rlm/harness.py"
  "packages/coding-agent/src/core/refinement/refinement.ts"
  "packages/coding-agent/src/core/autonomous.ts"
  "packages/coding-agent/src/core/goals.ts"
  "packages/coding-agent/src/core/kernel/state-snapshot.ts"
  "packages/coding-agent/src/core/tools/edit-diff.ts"
  "packages/coding-agent/src/core/tools/file-mutation-queue.ts"
)

if [ ! -d "$SRC/.git" ]; then
  echo "error: $SRC is not checked out — run: git submodule update --init --recursive" >&2
  exit 1
fi

# The exact upstream revision we synced from.
PA_COMMIT="$(git -C "$PA" rev-parse HEAD 2>/dev/null || echo unknown)"
PA_DESC="$(git -C "$PA" describe --tags --always 2>/dev/null || echo unknown)"

mkdir -p "$DST"

echo "==> syncing from prime-agent ($PA_DESC, $PA_COMMIT)"
for rel in "${FILES[@]}"; do
  src="$SRC/$rel"
  dst="$DST/$rel"
  if [ ! -f "$src" ]; then
    echo "    SKIP  $rel (missing upstream)"
    continue
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "    copy  $rel"
done

# Record provenance so we can diff our mods against upstream.
cat > "$DST/SYNCED.md" <<EOF
# Synced from prime-agent

- Upstream commit: \`$PA_COMMIT\` ($PA_DESC)
- Synced on: $(date -u +%Y-%m-%dT%H:%M:%SZ) by ./scripts/sync-prime-agent.sh

These are read-mirrors of individual prime-agent files pulled into the
Pithagoras harness so we can use them and patch them locally. Re-run the sync
script after fetching a newer tag to pull upstream changes; re-apply our edits
documented in PATCHES.md if they collide.

Paths listed in scripts/sync-prime-agent.sh (FILES array).
EOF

echo
echo "==> done. Upstream: $PA_DESC"
echo "    synced files -> $DST"
echo "    to diff our copies against upstream: diff -ru <upstream-path> <vendor-path>"
