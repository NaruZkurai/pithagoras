#!/usr/bin/env bash
# train-6gb.sh — run a llama-direct-token-input binary capped at ~6 GB VRAM.
#
# The CUDA build targets the RTX 4070 (sm_89). There is no --gpu-mem flag in
# this fork, so the way to keep training/inference inside ~6 GB of VRAM is to
# bound GPU offload with -ngl (and -fit clamps to available device memory).
# -ngl 0 = fully on CPU, so the same binary works on GPU and on machines with
# no (or busy) CUDA.
#
# Usage:
#   ./scripts/train-6gb.sh llama-finetune -m model.gguf --gpus 1  ... (GPU)
#   ./scripts/train-6gb.sh llama-finetune -m model.gguf --cpu       ... (CPU)
#
# BIN_DIR points at the fork's build/bin. Set MODEL_DIR for models.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK="$ROOT/gitrepos/llama-direct-token-input"
BIN_DIR="${BIN_DIR:-$FORK/build/bin}"
MODEL_DIR="${MODEL_DIR:-/nzk/models}"

cmd="${1:-}"
if [[ -z "$cmd" || ! -f "$BIN_DIR/$cmd" ]]; then
  echo "usage: $0 <llama-binary> [--gpu|--cpu] [args...]" >&2
  echo "  binaries: llama-server llama-tokens llama-finetune llama-bench" >&2
  exit 1
fi
shift

mode="${1:-}"
if [[ "$mode" == "--gpu" ]]; then
  shift
  # Offload all layers but cap device memory at 6 GiB (--fit-target is in MiB).
  # --fit clamps the context/size so the model+KV stays under the target.
  NGL_LIMIT="${NGL_LIMIT:-999}"
  FIT_TARGET="${FIT_TARGET:-6144}"
  EXTRA=(-ngl "$NGL_LIMIT" -fit on -fitt "$FIT_TARGET")
elif [[ "$mode" == "--cpu" ]]; then
  shift
  EXTRA=(-ngl 0)
else
  EXTRA=()
fi

echo "==> $BIN_DIR/$cmd ${EXTRA[*]} $*"
exec "$BIN_DIR/$cmd" "${EXTRA[@]}" "$@"
