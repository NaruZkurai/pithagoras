#!/usr/bin/env python3
"""
Add a REAL MTP (Multi-Token-Prediction / NextN) header to the true-ternary 30B.

User: "hay this is a real tq with mtp header". The true-ternary model should be
a real ~30B WITH an MTP header (qwen35 nextn), not a bare re-encode.

RECIPE (from qwen35.cpp + llama-arch.cpp in llama-direct-token-input):
  - qwen35.block_count  : 64 -> 65             (n_layer_all becomes 65)
  - qwen35.nextn_predict_layers : 1             (n_layer stays 64, 1 MTP layer)
  - Append blk.64.* tensors (ternary, TQ1_0-encoded) for the MTP decoder block:
      attn_norm, attn_post_norm, attn_q, attn_k, attn_v, attn_output,
      attn_q_norm, attn_k_norm, ffn_gate, ffn_down, ffn_up,
      nextn.eh_proj ({2*n_embd,n_embd}), nextn.enorm, nextn.hnorm
    (embed_tokens/shared_head_head/shared_head_norm are TENSOR_NOT_REQUIRED -> omit)

We initialize the MTP block from the LAST trunk layer (blk.63) for a real starting
point, and ternarize to {-1,0,+1} before TQ1_0 encoding (same as the trunk).

This is STREAMED + mmap'd (RAM-safe, like rebuild_tq1_gguf.py). The working
bonsai-30b-tq1.gguf is NOT modified; a new bonsai-30b-tq1-mtp.gguf is produced.

Usage:
  python3 scripts/add_mtp_header.py \
      --in  /dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-tq1.gguf \
      --out /dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-tq1-mtp.gguf
"""
import argparse, re, struct, time
import numpy as np
import gguf
from q1_codec import decode_q1_row
from tq1_codec import encode_tq1_row, tensor_n_bytes_tq1

GGUF_MAGIC = b"GGUF"
ALIGN = 32

# GGUFValueType sizes (bytes) for scalar + array-of-scalar; STRING/ARRAY handled here
_SZ = {0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,8:0,10:8,11:8,12:8}  # string=8,array=9 handled


def kv_end_of(data: bytes) -> int:
    """Return absolute offset where the KV section ends (= tensor-info start).

    The first tensor-info entry is `output.weight`. Find its name preceded by a
    valid u64 length in the header — that position IS the tensor-info start.
    This avoids fragile KV-value size parsing (tokenizer string arrays etc.).
    """
    for m in re.finditer(re.escape(b"output.weight"), data):
        c = m.start() - 8
        if c < 0:
            continue
        (ln,) = struct.unpack("<Q", data[c:c + 8])
        if ln == len("output.weight") and data[c + 8:c + 8 + ln] == b"output.weight":
            return c
    raise RuntimeError("could not locate first tensor-info entry (output.weight)")


def find_tensor_fields(hdr: bytes, tensors) -> list:
    """Return per-tensor (type_off, offset_off) via unique-name lookup."""
    out = []
    for t in tensors:
        nb = t.name.encode()
        start = None
        for m in re.finditer(re.escape(nb), hdr):
            c = m.start() - 8
            if c < 0:
                continue
            (ln,) = struct.unpack("<Q", hdr[c:c + 8])
            if ln == len(nb) and hdr[c + 8:c + 8 + ln] == nb:
                start = c; break
        assert start is not None, t.name
        (nlen,) = struct.unpack("<Q", hdr[start:start + 8])
        type_off = start + 8 + nlen + 4 + 8 * len(t.shape)
        out.append((type_off, type_off + 4))
    return out


def tern_from_q1(srcmap, t):
    rows = int(t.shape[0]) if len(t.shape) >= 2 else 1
    cols = int(t.shape[-1])
    n = int(t.n_elements)
    nb = rows * ((cols + 127) // 128) * 18
    raw = bytes(srcmap[int(t.data_offset):int(t.data_offset) + nb])
    return decode_q1_row(raw, rows, cols).reshape(-1)[:n].astype(np.float32), rows, cols


def tern_mask_default(rows, cols):
    """Identity-ish ternary defaults for the NextN eh_proj etc. -1/0/+1."""
    rng = np.random.default_rng(42)
    v = rng.choice([-1, 0, 1], size=rows * cols, p=[0.45, 0.1, 0.45]).astype(np.float32)
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mtp-layers", type=int, default=1)
    args = ap.parse_args()

    t0 = time.time()
    reader = gguf.GGUFReader(args.inp)
    import mmap
    fsrc = open(args.inp, "rb")
    src = mmap.mmap(fsrc.fileno(), 0, access=mmap.ACCESS_READ)
    data_start = int(reader.tensors[0].data_offset)
    hdr = bytes(src[0:data_start])
    tensors = reader.tensors

    kv_end = kv_end_of(hdr)
    n_layer = 64  # current trunk layers in the 30b build
    try:
        bcf = reader.fields.get("qwen35.block_count")
        if bcf is not None and 4 in bcf.parts:
            bc = int(np.frombuffer(bytes(bcf.parts[4].tobytes()), dtype="<u4")[0])
        else:
            bc = n_layer
    except Exception:
        bc = n_layer
    n_layer = bc
    n_mtp = args.mtp_layers

    # ---- build new header: header = KV section (with modified block_count +
    #      added nextn_predict_layers pulled into the KV section) + tensor-info ----
    # 1) The KV section is hdr[:kv_end]. We modify block_count value in place and
    #    APPEND a new KV for nextn_predict_layers right after kv_end (before the
    #    tensor-info section), then pad to ALIGN.
    kv_section = bytearray(hdr[:kv_end])
    # bump block_count value 64 -> n_layer+n_mtp (find its value offset)
    blk_key = b"qwen35.block_count"
    start = None
    for m in re.finditer(re.escape(blk_key), kv_section):
        c = m.start() - 8
        if c < 0:
            continue
        (ln,) = struct.unpack("<Q", kv_section[c:c + 8])
        if ln == len(blk_key):
            start = c; break
    if start is not None:
        # value offset = start + 8 + len(key) + 4 (type u32)
        vpos = start + 8 + len(blk_key) + 4
        old = struct.unpack("<I", kv_section[vpos:vpos + 4])[0]
        new = n_layer + n_mtp
        struct.pack_into("<I", kv_section, vpos, new)
        print(f"block_count {old} -> {new}", flush=True)

    # 2) append new KV: qwen35.nextn_predict_layers (UINT32=4)
    newkey = b"qwen35.nextn_predict_layers"
    kv_section += struct.pack("<Q", len(newkey)) + newkey
    kv_section += struct.pack("<I", 4)                    # UINT32
    kv_section += struct.pack("<I", n_mtp)                # value

    # 3) bump the header's kv_count (u64 at offset 16) so llama knows there is
    #    one more KV and doesn't mistake the appended key for a tensor entry.
    (cur_kv,) = struct.unpack("<Q", bytes(kv_section[16:24]))
    struct.pack_into("<Q", kv_section, 16, cur_kv + 1)
    print(f"kv_count {cur_kv} -> {cur_kv+1}", flush=True)


    # 3) rebuild tensor-info: copy existing entries verbatim (they have the right
    #    structure), then append MTP entries. Recompute offsets.
    # NOTE: the old header has ALIGN padding between the last tensor-info entry
    # and data_start. parser_end_of_tensor_info() walks the existing entries to
    # find the TRUE end (excluding that padding) so we don't copy pad bytes into
    # the middle of our new tensor-info section.
    ti_start = kv_end
    ti_end = data_start
    # forward-walk existing tensor-info entries to find their exact end
    pos = ti_start
    for t in tensors:
        (l,) = struct.unpack("<Q", hdr[pos:pos + 8]); pos += 8
        pos += l
        nd = struct.unpack("<I", hdr[pos:pos + 4])[0]; pos += 4
        pos += 8 * nd
        pos += 4   # type
        pos += 8   # offset
    ti_end = pos
    old_ti = hdr[kv_end:ti_end]

    # New MTP tensors to add. Shapes mirror the LAST trunk layer (blk.63) plus
    # the NextN-specific tensors (from qwen35.cpp create_tensor_qkv / load_block_mtp).
    # blk.63 shapes observed: attn_q[5120,12288], attn_k/v[5120,1024],
    # attn_output[6144,5120], q/k_norm[256], norm[5120], ffn gate/up[5120,17408],
    # ffn_down[17408,5120].
    n_embd = 5120
    n_ff = 17408
    m = {
        "blk.%d.attn_norm.weight" % n_layer: (n_embd,),
        "blk.%d.attn_post_norm.weight" % n_layer: (n_embd,),
        "blk.%d.attn_q.weight" % n_layer: (n_embd, 12288),
        "blk.%d.attn_k.weight" % n_layer: (n_embd, 1024),
        "blk.%d.attn_v.weight" % n_layer: (n_embd, 1024),
        "blk.%d.attn_output.weight" % n_layer: (6144, n_embd),
        "blk.%d.attn_q_norm.weight" % n_layer: (256,),
        "blk.%d.attn_k_norm.weight" % n_layer: (256,),
        "blk.%d.ffn_gate.weight" % n_layer: (n_embd, n_ff),
        "blk.%d.ffn_down.weight" % n_layer: (n_ff, n_embd),
        "blk.%d.ffn_up.weight" % n_layer: (n_embd, n_ff),
        "blk.%d.nextn.eh_proj.weight" % n_layer: (2 * n_embd, n_embd),
        "blk.%d.nextn.enorm.weight" % n_layer: (n_embd,),
        "blk.%d.nextn.hnorm.weight" % n_layer: (n_embd,),
    }

    # ---- assemble final header bytes ----
    new_header = bytearray()
    # KV part is kv_section (padded to align on its own? KV section ends, then
    # tensor-info entries are contiguous, then data is ALIGN-padded).
    new_header += bytes(kv_section)
    # tensor-info: existing entries verbatim
    new_header += old_ti
    # append MTP tensor-info entries (name u64-len+bytes, n_dims u32, dims u64*n, type u32, offset u64)
    mtp_offsets = []          # (name, type(u32), offset_field_pos_in_new_header)
    for nm, shp in m.items():
        encoded = nm.encode()
        new_header += struct.pack("<Q", len(encoded)) + encoded
        n_dims = len(shp)
        new_header += struct.pack("<I", n_dims)
        for d in shp:
            new_header += struct.pack("<Q", d)
        new_header += struct.pack("<I", 34)          # TQ1_0
        offset_field = len(new_header)
        new_header += struct.pack("<Q", 0)           # placeholder offset
        mtp_offsets.append((nm, 34, offset_field))
    # pad header to ALIGN before data
    new_header += b"\x00" * ((-len(new_header)) % ALIGN)

    # ---- compute data layout + write offsets for EXISTING + MTP tensors ----
    # New header layout: [kv_section][old_tensor-info verbatim][MTP tensor-info][pad]
    # old tensor-info began at `kv_end` in the OLD header; it begins at
    # `len(kv_section)` in the NEW header. Get each existing tensor's offset-field
    # absolute position in the NEW header: new_ti_start + (ooff_old - kv_end).
    new_ti_start = len(kv_section)
    existing_off_abs = []
    for i, t in enumerate(tensors):
        _, ooff_old = find_tensor_fields(hdr, [t])[0]
        existing_off_abs.append(new_ti_start + (ooff_old - kv_end))

    import tq1_codec
    def mtp_size(nm):
        shp = m[nm]
        rows = shp[0] if len(shp) == 2 else 1
        cols = shp[-1]
        return tensor_n_bytes_tq1(rows, cols)

    # cumulative data offset starts at 0 (llama's ctx->size is 0-based relative
    # to the data section start; each tensor's stored offset must match it).
    off = 0
    # patch existing offset fields
    for i, t in enumerate(tensors):
        struct.pack_into("<Q", new_header, existing_off_abs[i], off)
        dl = int(t.n_bytes)
        off += dl + ((-dl) % ALIGN)
    # patch MTP offset fields
    for (nm, typ, ofield) in mtp_offsets:
        dl = mtp_size(nm)
        struct.pack_into("<Q", new_header, ofield, off)
        off += dl + ((-dl) % ALIGN)

    # ---- stream data ----
    out_name = args.out
    fout = open(out_name, "wb")
    fout.write(bytes(new_header))
    outpos = fout.tell()
    # copy existing tensor data
    for i, t in enumerate(reader.tensors):
        raw = bytes(src[int(t.data_offset):int(t.data_offset) + int(t.n_bytes)])
        fout.write(raw); outpos += len(raw)
        pad = (-outpos) % ALIGN
        if pad: fout.write(b"\x00" * pad); outpos += pad
    # write MTP tensors (ternary TQ1_0), init from blk.63 where applicable
    import tq1_codec
    # map blk.63 basis tensors (they are TQ1_0 in the source TQ1 model)
    src_tern = {}
    for t in tensors:
        if t.name.startswith("blk.63.") and int(t.tensor_type) == 34:
            src_tern[t.name[len("blk.63."):]] = t
    for (nm, typ, ofield) in mtp_offsets:
        shp = m[nm]
        rows = shp[0] if len(shp) == 2 else 1
        cols = shp[-1]
        n = rows * cols
        key = nm[len("blk.%d." % n_layer):]
        if key in src_tern and len(shp) == 2 and key not in ("nextn.eh_proj.weight",):
            t = src_tern[key]
            tr = int(t.shape[0]); tc = int(t.shape[-1])
            tq_nb = tensor_n_bytes_tq1(tr, tc)
            v = tq1_codec.decode_tq1_row(bytes(src[int(t.data_offset):int(t.data_offset) + tq_nb]), tr, tc).reshape(-1)[:n]
        else:
            if key.endswith("norm.weight"):
                v = np.ones(n, dtype=np.float32)
            elif "eh_proj" in key:
                v = tern_mask_default(cols, rows)
            else:
                v = tern_mask_default(rows, cols)
        tq = encode_tq1_row(v.reshape(-1).astype(np.float32), rows, cols)
        if len(tq) != tensor_n_bytes_tq1(rows, cols):
            raise RuntimeError(f"MTP len mismatch {nm}")
        fout.write(tq); outpos += len(tq)
        pad = (-outpos) % ALIGN
        if pad: fout.write(b"\x00" * pad); outpos += pad
        print(f"  added MTP tensor {nm} ({rows},{cols}) TQ1", flush=True)

    fout.flush()
    fout.close()
    fsrc.close()
    print(f"DONE: {out_name} ({outpos} bytes, {len(tensors)+len(m)} tensors, "
          f"+{len(m)} MTP, n_layer={n_layer}+{n_mtp}) in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
