#!/usr/bin/env python3
"""
Patch the source 27B qwen35 GGUF's Q1_0 weight bytes with the per-file NATIVE
TERNARY values, producing a runnable GGUF WITHOUT rebuilding metadata.

WHY this instead of reassembling a fresh GGUF:
  Rebuilding metadata by hand was fragile (gguf-py array parsing, missing keys
  like qwen35.attention.layer_norm_rms_epsilon / qwen35.rope.dimension_sections).
  This probe copies the ENTIRE source GGUF (all metadata/tokenizer/hyperparams
  stay byte-identical and valid) and ONLY overwrites each Q1_0 weight tensor's
  bytes with the row-major re-encoded Q1_0 (block=128, preserving each block's
  original fp16 scale) read from the RAM per-file model (model/layers/* + model/
  experts/* .tern), using the SAME shared codec as grow_model_30b.py so the
  round-trip is byte-identical for every shape (including irregular cols like
  the [5120,48] SSM tensors, which the old flat-block encode scrambled into a
  '/'-only collapse).

The result is a loadable GGUF whose weights are the custom native-ternary model.

Usage:
  python3 scripts/patch_gguf_ternary.py \
      --model /dev/shm/pithagoras-moe-checkpoints/model-30b/model \
      --src /nzk/models/Bonsai-27B-Q1_0.gguf \
      --out /dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-patched.gguf
"""
import argparse, json, os, shutil, time
import numpy as np
import gguf
from q1_codec import (Q1_0_NBLOCK, Q1_0_BYTES_PER_BLOCK, tensor_n_bytes,
                      decode_q1_row, encode_q1_row, unpack_tern_2bit)

Q1_0_NBLOCK = Q1_0_NBLOCK
Q1_0_BYTES_PER_BLOCK = Q1_0_BYTES_PER_BLOCK


def read_tern(path, n):
    with open(path, "rb") as f:
        data = f.read()
    return unpack_tern_2bit(data, n)


def find_tern_file(model_dir, tname, reader, tensor):
    """Map a source GGUF tensor back to its RAM per-file .tern path."""
    if tensor.tensor_type != 41:
        return None  # F16/F32 norm stays as-is
    name = tname
    shape = [int(x) for x in tensor.shape]
    cols = shape[-1]
    if name.startswith("blk."):
        bim = name.split(".")[1]
        tail = name[len(f"blk.{bim}."):]
        stem = tail[:-len(".weight")]
        lidx = int(bim)
        if "ffn_" in stem:  # in experts/
            part = stem.split("_")[1]
            fname = f"L{lidx:02d}_ffn_{part}_weight.tern"
            edir = os.path.join(model_dir, "experts")
            for e in sorted(os.listdir(edir)):
                p = os.path.join(edir, e, fname)
                if os.path.exists(p):
                    return p, cols
            return None
        else:
            fname = f"{stem}_weight.tern"
            p = os.path.join(model_dir, "layers", f"L{lidx:02d}", fname)
            return (p, cols) if os.path.exists(p) else None
    else:
        fname = name.replace(".", "_") + ".tern"
        p = os.path.join(model_dir, fname)
        return (p, cols) if os.path.exists(p) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--src", default="/nzk/models/Bonsai-27B-Q1_0.gguf")
    ap.add_argument("--out", default="/dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-patched.gguf")
    args = ap.parse_args()

    # 1) copy source unchanged (keeps all metadata valid)
    print(f"copying {args.src} -> {args.out}")
    t0 = time.time()
    shutil.copyfile(args.src, args.out)
    print(f"  copied in {time.time()-t0:.0f}s")

    reader = gguf.GGUFReader(args.src)

    # 2) map the file offsets of each tensor's data (byte range within the file)
    #    gguf-py: tensor.data_offset is relative to the reader's memory-mapped
    #    data region; the file tensor data begins after the metadata/info blocks.
    #    Absolute file offset = reader.data_start? we derive by comparing to the
    #    memory map base. Simpler: read the tensor's current bytes from the file
    #    at reader.data base + offset.
    import mmap
    fh = open(args.out, "r+b")
    mm = mmap.mmap(fh.fileno(), 0)

    # gguf-py's reader.data is an np.memmap of the WHOLE file, so a tensor's
    # data_offset IS its absolute file offset. No data_start shifting needed.
    n_patched = 0
    missing = []
    for t in reader.tensors:
        if t.tensor_type != 41:
            continue
        loc = find_tern_file(args.model, t.name, reader, t)
        if loc is None:
            missing.append(t.name)
            continue
        fpath, cols = loc
        n = int(t.n_elements)
        rows = int(t.shape[0]) if len(t.shape) == 2 else (n // int(t.shape[-1]))
        cols = int(t.shape[-1])
        expected = tensor_n_bytes(rows, cols)
        vals = read_tern(fpath, n)
        # Extract the ORIGINAL per-block fp16 scales from the source tensor's raw
        # Q1_0 bytes (row-major, same layout the shared codec uses) so the model's
        # magnitude structure survives — this is what makes it generate instead of
        # collapsing to uniform random tokens.
        src_raw = np.ascontiguousarray(reader.data[int(t.data_offset): int(t.data_offset) + expected]).tobytes()
        q1 = encode_q1_row(vals, rows, cols, src_scale_bytes=src_raw)
        # guard: the re-encoded length MUST match the source tensor's byte length
        if len(q1) != expected:
            missing.append(f"{t.name}[len{q1.size}!=exp{expected}]")
            continue
        off = int(t.data_offset)
        mm.seek(off)
        mm.write(q1)
        n_patched += 1
        if n_patched % 100 == 0:
            print(f"  patched {n_patched} tensors...")

    mm.flush()
    mm.close()
    fh.close()
    print(f"DONE: patched {n_patched} Q1_0 tensors, missing {len(missing)}")
    print(f"  out: {args.out}  ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
