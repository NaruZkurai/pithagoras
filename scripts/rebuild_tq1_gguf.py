#!/usr/bin/env python3
"""
Rebuild the 27B MoE GGUF as a TRUE-TERNARY TQ1_0 model.

The student MUST be true ternary {-1,0,+1} (GGML_TYPE_TQ1_0 = 34), NOT Q1_0
(which cannot represent the zero values). gguf-py's writer can't express the
row-padded irregular SSM shapes, so we rebuild the GGUF byte-for-byte:

  1. Copy the ENTIRE source header + metadata + tokenizer + tensor-info region
     verbatim (all keys/arch/tokenizer stay valid).
  2. Each Q1_0 tensor's "type" field (in tensor-info) is rewritten 41 -> 34.
  3. Each tensor's DATA is re-encoded to TQ1_0 from the per-file ternary
     segments (scripts/q1_codec.py decode -> scripts/tq1_codec.py encode), and
     the new (larger) data section is appended.

Only the 96 SSM tensors were mis-decoded by the old flat-block bug; they are
recovered from the source directly here (decode_q1_row) so this script is
independent of any stale RAM copy. All other tensors come from the per-file
ternary (.tern) seeds with magnitudes preserved so the model keeps its
activation scale (per-256-block amax re-quant).

Usage:
  python3 scripts/rebuild_tq1_gguf.py \
      --src /nzk/models/Bonsai-27B-Q1_0.gguf \
      --model /dev/shm/pithagoras-moe-checkpoints/model-30b/model \
      --out /dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-tq1.gguf
"""
import argparse, os, re, struct, time
import numpy as np
import gguf
from q1_codec import tensor_n_bytes, decode_q1_row
from tq1_codec import (encode_tq1_row, tensor_n_bytes_tq1, blocks_per_row_256,
                       BPT)


def find_tern_file(model_dir, tname):
    """Map a source GGUF tensor back to its RAM per-file .tern path."""
    if tname.startswith("blk."):
        bim = tname.split(".")[1]
        tail = tname[len(f"blk.{bim}."):]
        stem = tail[:-len(".weight")]
        lidx = int(bim)
        if "ffn_" in stem:
            part = stem.split("_")[1]  # gate|up|down
            fname = f"L{lidx:02d}_ffn_{part}_weight.tern"
            edir = os.path.join(model_dir, "experts")
            if os.path.isdir(edir):
                for e in sorted(os.listdir(edir)):
                    p = os.path.join(edir, e, fname)
                    if os.path.exists(p):
                        return p
            return None
        else:
            fname = f"{stem}_weight.tern"
            p = os.path.join(model_dir, "layers", f"L{lidx:02d}", fname)
            return p if os.path.exists(p) else None
    else:
        fname = tname.replace(".", "_") + ".tern"
        p = os.path.join(model_dir, fname)
        return p if os.path.exists(p) else None


def read_tern_flat(path, n):
    import numpy as np
    with open(path, "rb") as f:
        data = f.read()
    raw = np.frombuffer(data, dtype=np.uint8)
    vals = np.zeros(len(raw) * 4, dtype=np.int8)
    vals[0::4] = (raw & 0x03).astype(np.int8) - 1
    vals[1::4] = ((raw >> 2) & 0x03).astype(np.int8) - 1
    vals[2::4] = ((raw >> 4) & 0x03).astype(np.int8) - 1
    vals[3::4] = ((raw >> 6) & 0x03).astype(np.int8) - 1
    return vals[:n]


def add_padding_byte(buf, align=32):
    buf += b"\x00" * ((-len(buf)) % align)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/nzk/models/Bonsai-27B-Q1_0.gguf")
    ap.add_argument("--model", default="/dev/shm/pithagoras-moe-checkpoints/model-30b/model")
    ap.add_argument("--out", default="/dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-tq1.gguf")
    ap.add_argument("--limit", type=int, default=0, help="only rebuild this many tensors (testing)")
    args = ap.parse_args()

    t0 = time.time()
    reader = gguf.GGUFReader(args.src)
    # mmap the source (OS pages it in on demand) — do NOT read() the whole 3.8GB
    # into RAM (that plus a growing output bytearray is what nearly OOMed the box).
    import mmap
    fsrc = open(args.src, "rb")
    src = mmap.mmap(fsrc.fileno(), 0, access=mmap.ACCESS_READ)
    data_start = int(reader.tensors[0].data_offset)
    header = bytes(src[0:data_start])   # ~11MB scalar header, fine to hold

    tensors = reader.tensors
    # A GGUF v3 tensor-info entry is:
    #   [name_len u64][name][n_dims u32][dims u64*n][type u32][offset u64]
    # llama reads each tensor's stored `offset` (gguf.cpp line ~759) and validates
    # it equals the cumulative data size, so we MUST rewrite every offset when we
    # change the data layout. We locate fields by the (unique) tensor name.
    #
    # CONVERTIBILITY: llama rejects a type whose row size (ne[0] = last GGUF dim
    # = cols) is not a multiple of that type's block size. TQ1_0 block is 256;
    # Q1_0 block is 128. The 96 SSM tensors have cols=48 (not %256 nor %128) so
    # they MUST stay Q1_0 (the source loads them as Q1_0). Tensors with cols%256
    # == 0 are safely convertible to TQ1_0.
    hdr = header
    info = []  # (name, type_off, offset_off, orig_type, convertible)
    for t in tensors:
        nb = t.name.encode("utf-8")
        start = None
        for m in re.finditer(re.escape(nb), hdr):
            c = m.start() - 8
            if c < 0:
                continue
            (ln,) = struct.unpack("<Q", hdr[c:c + 8])
            if ln == len(nb) and hdr[c + 8:c + 8 + ln] == nb:
                start = c
                break
        assert start is not None, f"tensor name not found in header: {t.name}"
        (nlen,) = struct.unpack("<Q", header[start:start + 8])
        ndim = len(t.shape)
        # dims are u64 (8 bytes each)
        type_off = start + 8 + nlen + 4 + 8 * ndim
        (typ,) = struct.unpack("<I", header[type_off:type_off + 4])
        offset_off = type_off + 4
        dims = [int(x) for x in t.shape]
        cols = dims[-1] if dims else 1
        convertible = (typ == 41 and cols % 256 == 0)
        info.append((t.name, type_off, offset_off, typ, convertible))
    print(f"located {len(info)} tensor entries in header", flush=True)

    # --- new header: rewrite convertible Q1_0 types 41->34; offsets are
    #     recomputed during the (single-pass) data streaming below. ---
    new_header = bytearray(header)
    nq0 = 0
    for name, type_off, offset_off, typ, convertible in info:
        if convertible:
            struct.pack_into("<I", new_header, type_off, 34)
            nq0 += 1
    print(f"rewrote {nq0} Q1_0->TQ1_0 types (SSM Q1_0 kept: {sum(1 for i in info if i[4]==False and i[3]==41)})", flush=True)

    # ---- target byte size per tensor (allowing one-pass offset pre-compute) ----
    def tensor_out_size(t, convertible):
        dims = [int(x) for x in t.shape]
        rows = dims[0] if len(dims) == 2 else 1
        cols = dims[-1]
        if convertible:
            return tensor_n_bytes_tq1(rows, cols)          # TQ1_0
        # non-convertible Q1_0 (SSM) or non-quant: keep original byte size (flat)
        return int(t.n_bytes)

    # ---- PRE-PASS: compute cumulative offsets, patch each entry's offset field
    #      (u64 right after the type u32) so llama's offset == ctx->size check
    #      passes, and so the data section matches these offsets. ----
    outpos = 0
    entry_offsets = []
    for ti, t in enumerate(reader.tensors):
        if args.limit and ti >= args.limit:
            break
        _, toff, ooff, typ, conv = info[ti]
        size = tensor_out_size(t, conv)
        entry_offsets.append((ooff, outpos))
        outpos += size + ((-size) % 32)          # pad each tensor's data to 32
    for ooff, offv in entry_offsets:
        struct.pack_into("<Q", new_header, ooff, offv)

    # ---- STREAM data: write per-tensor, free each tensor's arrays ----
    out_path = args.out
    fout = open(out_path, "wb")
    fout.write(bytes(new_header))
    del new_header, header
    outpos = fout.tell()
    n_written = 0
    n_q1kept = 0
    missing = []
    for ti, t in enumerate(reader.tensors):
        if args.limit and ti >= args.limit:
            break
        name = t.name
        o = int(t.data_offset); nb = int(t.n_bytes)
        _, toff, ooff, typ, conv = info[ti]
        if not conv:
            # keep original bytes (SSM Q1_0, norms, rope): copy verbatim
            raw = bytes(src[o:o + nb])
            fout.write(raw); outpos += len(raw)
            if int(t.tensor_type) == 41:
                n_q1kept += 1
            del raw
            pad = (-outpos) % 32
            if pad:
                fout.write(b"\x00" * pad); outpos += pad
            continue
        dims = [int(x) for x in t.shape]
        rows = dims[0] if len(dims) == 2 else 1
        cols = dims[-1]
        n = int(t.n_elements)
        expected = tensor_n_bytes_tq1(rows, cols)
        nbytes_q1 = tensor_n_bytes(rows, cols)
        # Chunk huge tensors by rows so peak memory stays small.
        n_elem = rows * cols
        CHUNK = 128
        if n_elem > 10_000_000 and rows > CHUNK:
            nchunks = (rows + CHUNK - 1) // CHUNK
            for c in range(nchunks):
                r0 = c * CHUNK
                r1 = min(rows, r0 + CHUNK)
                crows = r1 - r0
                q1raw = bytes(src[o + r0 * ((cols + 127) // 128) * 18:
                                  o + r1 * ((cols + 127) // 128) * 18])
                tern = decode_q1_row(q1raw, crows, cols).reshape(-1)[:crows * cols].astype(np.float32)
                tq1 = encode_tq1_row(tern, crows, cols)
                del tern, q1raw
                fout.write(tq1); outpos += len(tq1)
                del tq1
            n_written += 1
        else:
            q1raw = bytes(src[o:o + nbytes_q1])
            tern = decode_q1_row(q1raw, rows, cols).reshape(-1)[:n].astype(np.float32)
            tq1 = encode_tq1_row(tern, rows, cols)
            del tern, q1raw
            if len(tq1) != expected:
                missing.append(f"{name}[len{len(tq1)}!=exp{expected}]")
                continue
            fout.write(tq1); outpos += len(tq1)
            del tq1
            n_written += 1
        pad = (-outpos) % 32
        if pad:
            fout.write(b"\x00" * pad); outpos += pad
        if (ti + 1) % 50 == 0:
            print(f"  wrote {ti+1}/{len(reader.tensors)} tensors...", flush=True)

    fout.flush()
    # ---- REPORT memory we actually used ----
    try:
        import resource
        print(f"max RSS: {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024:.0f} MB", flush=True)
    except Exception:
        pass
    fout.close()
    fsrc.close()
    print(f"DONE: wrote {out_path} ({outpos} bytes, {n_written} TQ1_0 tensors, "
          f"{n_q1kept} Q1_0 kept, missing {len(missing)}) in {time.time()-t0:.0f}s", flush=True)
    if missing:
        print("  missing/errored:", missing[:8])


if __name__ == "__main__":
    main()
