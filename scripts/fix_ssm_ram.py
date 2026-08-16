#!/usr/bin/env python3
"""
Repair the 96 corrupted SSM per-file ternary segments IN PLACE (RAM-first).

The old flat-block decode in grow_model_30b.py mis-decoded any Q1_0 tensor whose
col count is NOT a multiple of 128. All 96 such tensors are the per-layer
ssm_alpha / ssm_beta weights (shape [5120, 48]). Only those are wrong — every
other .tern file (cols % 128 == 0) decoded fine.

This script walks the source 27B GGUF, re-decodes ONLY the bad tensors with the
correct row-major codec (scripts/q1_codec.py), and rewrites their .tern files
in place at:
   RAM:  /dev/shm/pithagoras-moe-checkpoints/model-30b/model/
   disk: config/moe/model/30b/segments-disk/model/          (mirror, survives reboot)

It does NOT touch the ~400 good tensors, so it's seconds — no full 26.9B re-export.

Usage:
  python3 scripts/fix_ssm_ram.py [--dry-run]
"""
import argparse, os, sys
import numpy as np
import gguf
from q1_codec import tensor_n_bytes, decode_q1_row, pack_tern_2bit

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = "/nzk/models/Bonsai-27B-Q1_0.gguf"
RAM_DIR = "/dev/shm/pithagoras-moe-checkpoints/model-30b/model"
DISK_DIR = os.path.join(PROJECT, "config", "moe", "model", "30b", "segments-disk", "model")


def is_bad(t):
    if int(t.tensor_type) != 41 or len(t.shape) < 2:
        return False
    cols = int(t.shape[-1]); rows = int(t.shape[0]); n = int(t.n_elements)
    return rows * ((cols + 127) // 128) != (n + 127) // 128


def tern_rel_path(tname):
    """Mirror find_tern_file from patch_gguf_ternary.py: layers/L{NN}/{tail}.tern"""
    if tname.startswith("blk."):
        bim = tname.split(".")[1]
        lidx = int(bim)
        tail = tname[len(f"blk.{bim}."):].replace(".", "_")
        return os.path.join("layers", f"L{lidx:02d}", f"{tail}.tern")
    return f"{tname.replace('.', '_')}.tern"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    reader = gguf.GGUFReader(SRC)
    bad = [t for t in reader.tensors if is_bad(t)]
    print(f"bad tensors to repair: {len(bad)} (expected 96 = ssm_alpha/ssm_beta)")
    fixed = 0; missing = []
    for t in bad:
        rows = int(t.shape[0]); cols = int(t.shape[-1]); n = int(t.n_elements)
        nbytes = tensor_n_bytes(rows, cols)
        raw = bytes(np.ascontiguousarray(reader.data[int(t.data_offset): int(t.data_offset) + nbytes]))
        vals = decode_q1_row(raw, rows, cols).reshape(-1)[:n]
        packed = pack_tern_2bit(vals, n)
        rel = tern_rel_path(t.name)
        written = []
        for d in (RAM_DIR, DISK_DIR):
            p = os.path.join(d, rel)
            if os.path.exists(p):
                if not args.dry_run:
                    with open(p, "wb") as f:
                        f.write(packed)
                written.append(p)
            else:
                missing.append(p)
        fixed += 1
        if fixed % 16 == 0:
            print(f"  fixed {fixed}/{len(bad)} ...")
    print(f"DONE: repaired {fixed} SSM segments ({'dry-run' if args.dry_run else 'written to RAM+disk'})")
    if missing:
        print(f"WARNING: {len(missing)} expected paths missing:")
        for m in missing[:8]:
            print("  " + m)


if __name__ == "__main__":
    main()
