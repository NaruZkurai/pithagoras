#!/usr/bin/env python3
"""
Reassemble the per-file native-ternary model (model/layers/L*/ + model/experts/*)
back into a RUNNABLE qwen35 GGUF so the existing llama-server can serve it
(and pi can register it as a provider). This is the "use it" step: llama.cpp
cannot load the .tern file layout directly, but it CAN load a GGUF.

What it does:
  1. Reads the SOURCE 27B GGUF for arch metadata + the F16/F32 norm / small
     tensors (attn_norm, post_attention_norm, ssm_norm, ssm_conv1d, ssm_dt.bias,
     ssm_a, output_norm) — these were excluded from the per-file ternary export.
  2. Reads each per-file .tern (2-bit packed ternary {-1,0,+1}).
  3. Re-encodes weights as Q1_0 (the 1-bit format the qwen35 reader needs) and
     writes a complete GGUF with identical tensor order + metadata.

Mapping per-file path -> GGUF tensor name:
  model/token_embd_weight.tern            -> token_embd.weight
  model/output_weight.tern                -> output.weight
  model/layers/L{N}/(attn_gate|attn_qkv|ssm_alpha|ssm_beta|ssm_out)_weight.tern
                                          -> blk.{N}.{x}.weight
  model/experts/E{K}/L{N}_ffn_{up|gate|down}_weight.tern
                                          -> blk.{N}.ffn_{up|gate|down}.weight
  (F16 norms come from the source GGUF verbatim)

Usage:
  python3 scripts/reassemble_gguf.py \
      --model /dev/shm/.../ternary-30b-files/model \
      --src /nzk/models/Bonsai-27B-Q1_0.gguf \
      --out config/moe/model/30b/bonsai-30b-files.gguf
"""
import argparse, json, math, os, time
import numpy as np
import gguf
from gguf import GGMLQuantizationType, GGUFValueType


def _native(x):
    """Coerce numpy scalar/array element to a native python type for struct.pack."""
    if isinstance(x, np.generic):
        return x.item()
    if isinstance(x, (np.ndarray,)):
        return x.item() if x.size == 1 else int(x)
    if isinstance(x, (list, tuple)):
        return [_native(i) for i in x]
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return x


def _bytes_of(p):
    return bytes(np.ascontiguousarray(p)) if hasattr(p, "itemsize") else bytes(p)


def _str_parts(f):
    out = []
    for p in f.parts:
        out.append(_bytes_of(p).decode(errors="replace"))
    return out


def _num_parts(f, np_dtype):
    """Read array parts as native ints/floats robustly (first element per part)."""
    out = []
    for p in f.parts:
        b = _bytes_of(p)
        if len(b) >= np.dtype(np_dtype).itemsize:
            out.append(int(np.frombuffer(b[:np.dtype(np_dtype).itemsize], dtype=np_dtype)[0]))
        else:
            out.append(0)
    return out


def copy_metadata(w, reader):
    """Copy metadata from the source reader so the output GGUF has every
    hyperparameter llama.cpp's qwen35 loader needs (e.g.
    qwen35.attention.layer_norm_rms_epsilon) plus the full tokenizer.

    Scalars/strings are copied generically via add_key_value (safe). Tokenizer
    ARRAY fields use the writer's tested dedicated methods (token list / types /
    merges) instead of raw array packing, which was fragile with this gguf-py.
    """
    for key, f in reader.fields.items():
        ft = f.types[0]
        if key == "tokenizer.ggml.tokens":
            w.add_token_list(_str_parts(f))
        elif key == "tokenizer.ggml.merges":
            w.add_token_merges(_str_parts(f))
        elif key == "tokenizer.ggml.token_type":
            w.add_token_types(_num_parts(f, np.int32))
        elif key in ("tokenizer.ggml.token_type_count", "tokenizer.ggml.pre"):
            continue  # set via dedicated methods below
        elif ft == GGUFValueType.ARRAY:
            # generic arrays we don't special-case: skip (none for qwen35 hyperparams)
            continue
        elif ft == GGUFValueType.STRING:
            b = _bytes_of(f.parts[-1])
            w.add_key_value(key, b.decode(errors="replace"), GGUFValueType.STRING)
        else:
            v = _native(_part_scalar(f.parts[-1]))
            w.add_key_value(key, v, ft)
    # ensure a tokenizer model + pre (from dedicated methods, defaults safe)
    if "tokenizer.ggml.model" not in reader.fields:
        w.add_tokenizer_model("llama")


def _part_scalar(p):
    """Decode a single GGUF value part into a native python scalar/str/bytes."""
    try:
        v = p.tolist()
    except Exception:
        return bytes(p) if isinstance(p, (memoryview, np.ndarray)) else p
    if isinstance(v, (list, np.ndarray)):
        return v[-1] if len(v) else 0
    return v

# This fork redefines Q1_0 to 128 weights/block: block_q1_0 { fp16 d; u8 qs[16] }
# = 18 bytes per 128 weights (QK1_0==128). Must match the encoder/decode below.
Q1_0_NBLOCK = 128
Q1_0_BYTES_PER_BLOCK = 18

LAYER_NON_FFN = {
    "attn_gate", "attn_qkv", "ssm_alpha", "ssm_beta", "ssm_out",
}
FFN_PARTS = {"up", "gate", "down"}


def unpack_tern(flat: np.ndarray, n: int) -> np.ndarray:
    """Decode 2-bit packed {-1,0,+1} back to {-1,0,+1}."""
    codes = flat.astype(np.uint8)
    out = codes.astype(np.int8) - 1  # 0->-1, 1->0, 2->+1
    return out[:n]


def read_tern_file(path, n):
    with open(path, "rb") as f:
        raw = np.frombuffer(f.read(), dtype=np.uint8)
    # 2-bit packed: 4 values/byte
    vals = np.zeros(len(raw) * 4, dtype=np.int8)
    vals[0::4] = (raw & 0x03).astype(np.int8) - 1
    vals[1::4] = ((raw >> 2) & 0x03).astype(np.int8) - 1
    vals[2::4] = ((raw >> 4) & 0x03).astype(np.int8) - 1
    vals[3::4] = ((raw >> 6) & 0x03).astype(np.int8) - 1
    return vals[:n]


def encode_q1_0(vals: np.ndarray, shape) -> bytes:
    """Encode ternary values back to Q1_0 block bytes ROW-MAJOR (18B per 128
    weights). GGUF Q1_0 pads EACH ROW's length up to a multiple of the 128-block,
    so a [R, C] tensor needs R * ceil(C/128)*18 bytes — NOT ceil(R*C/128)*18.
    Bit convention of this fork: bit==1 -> +1, bit==0 -> -1; per-block fp16
    scale 1.0."""
    shape = list(shape or [1, vals.size])
    if len(shape) == 1:
        rows = 1
        cols = int(shape[0])
    else:
        rows = int(shape[0])
        cols = 1
        for s in shape[1:]:
            cols *= int(s)
    flat = np.clip(vals.astype(np.int8), -1, 1)
    flat = flat.reshape(rows, cols) if rows * cols == flat.size else flat.reshape(rows, -1)
    blocks_per_row = (cols + Q1_0_NBLOCK - 1) // Q1_0_NBLOCK
    nblock = rows * blocks_per_row
    # pad each row to a 128-multiple
    padded = np.zeros((rows, blocks_per_row * Q1_0_NBLOCK), dtype=np.int8)
    padded[:, :cols] = flat
    bits = (padded >= 0).reshape(rows * blocks_per_row, Q1_0_NBLOCK).astype(np.uint8)
    packed = np.packbits(bits, bitorder="little")
    s16 = 0x3C00  # 1.0 in fp16
    qb = Q1_0_NBLOCK // 8  # 16 bytes bitfield per block
    out = bytearray()
    for b in range(nblock):
        out += s16.to_bytes(2, "little")
        out += packed[b * qb:(b + 1) * qb].tobytes()
    return bytes(out)


def layer_tensors_from_files(model_dir, src_reader):
    """Build ordered list of (gguf_name, shape, ternary_values_or_None).
    F16 tensors keep None and are pulled from src_reader by name."""
    tensors = []  # (name, shape, file_path_or_None)
    layer_lookup = {}
    by_name = {t.name: t for t in src_reader.tensors}
    # global
    for gname in ("output.weight", "token_embd.weight"):
        gt = by_name.get(gname)
        fname = gname.replace(".", "_") + ".tern"  # token_embd.weight -> token_embd_weight.tern
        gshape = [int(x) for x in gt.shape] if gt is not None else None
        tensors.append((gname, gshape, os.path.join(model_dir, fname)))
    # layers
    for t in src_reader.tensors:
        if not t.name.startswith("blk."):
            continue
        bim = t.name.split(".")[1]
        n = int(t.n_elements)
        shape = [int(x) for x in t.shape]
        if int(t.tensor_type) != 41:
            # F16/F32 norm -> copy verbatim from source
            tensors.append((t.name, shape, None))
            continue
        # Q1_0 weight
        tail = t.name[len(f"blk.{bim}."):]  # e.g. "attn_qkv.weight" / "ffn_gate.weight"
        stem = tail[:-len(".weight")]
        if "ffn_" in stem:  # stored under experts
            part = stem.split("_")[1]  # up|gate|down
            fname = f"L{int(bim):02d}_ffn_{part}_weight.tern"
            # find the expert dir that holds it
            path = None
            edir = os.path.join(model_dir, "experts")
            if os.path.isdir(edir):
                for e in sorted(os.listdir(edir)):
                    p = os.path.join(edir, e, fname)
                    if os.path.exists(p):
                        path = p
                        break
            tensors.append((t.name, shape, path))
        else:
            fname = f"{stem}_weight.tern"
            path = os.path.join(model_dir, "layers", f"L{int(bim):02d}", fname)
            tensors.append((t.name, shape, path if os.path.exists(path) else None))
    return tensors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--src", default="/nzk/models/Bonsai-27B-Q1_0.gguf")
    ap.add_argument("--out", default="/dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-files.gguf")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = args.src
    n_vocab = 248320
    reader = gguf.GGUFReader(src)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    def fval(name, default=None):
        f = reader.fields.get(name)
        if f is None:
            return default
        try:
            v = f.parts[-1].tolist()
        except Exception:
            return default
        # scalars come back as 1-element lists; unwrap for cleanliness
        return v[0] if isinstance(v, list) and len(v) == 1 else v
    arch = "qwen35"
    block_count = int(fval("qwen35.block_count", 64))
    embd = int(fval("qwen35.embedding_length", 5120))
    ffn = int(fval("qwen35.feed_forward_length", 17408))

    tensors = layer_tensors_from_files(args.model, reader)
    n_written = 0
    missing = []

    w = gguf.GGUFWriter(args.out, arch)
    # Copy ALL source metadata generically (hyperparams, tokenizer, booleans) —
    # this is what makes the qwen35 GGUF loadable (the handpicked subset before
    # was missing e.g. qwen35.attention.layer_norm_rms_epsilon -> load failed).
    copy_metadata(w, reader)

    counter = 0
    started = time.time()
    # build a name lookup (this gguf-py has no tensors_by_name)
    by_name = {t.name: t for t in reader.tensors}
    for name, shape, fpath in tensors:
        if fpath is None:
            # F16/F32 norm from source
            t = by_name.get(name)
            if t is None:
                missing.append(name)
                continue
            arr = t.data
            a = np.frombuffer(bytes(np.ascontiguousarray(arr)), dtype=np.float32)
            w.add_tensor(name, a)
            counter += 1
            continue
        # Q1_0 ternary from per-file: re-encode as REAL Q1_0 bytes and register
        # as a quantized tensor (raw_dtype=Q1_0) so the GGUF stays compact
        # (~0.75 bit/weight), NOT a float32 dump.
        n = 1
        for s in shape:
            n *= s
        vals = read_tern_file(fpath, n)
        q1 = encode_q1_0(vals, shape)
        # gguf-py expects the tensor shaped as the BYTE-SHAPE when raw_dtype is
        # given (its quant_shape_from_byte_shape assumes last dim in type units).
        # logical [R, C] -> byte shape [R, ceil(C/128)*18] (Q1_0: 128 wts / 18B).
        rows = shape[0] if len(shape) == 2 else (n // shape[-1])
        cols = shape[-1]
        byte_last = (cols + Q1_0_NBLOCK - 1) // Q1_0_NBLOCK * Q1_0_BYTES_PER_BLOCK
        byt = np.frombuffer(q1, dtype=np.uint8).reshape(rows, byte_last)
        # raw_shape MUST be the BYTE-shape (byt.shape): add_tensor_info runs
        # quant_shape_from_byte_shape on it, converting [rows, byte_last]
        # -> logical [rows, byte_last//18*128 = cols]. Passing the logical shape
        # here raised "bytes per row (248320) not a multiple of Q1_0 type size".
        w.add_tensor(
            name,
            byt,
            raw_shape=byt.shape,
            raw_dtype=GGMLQuantizationType.Q1_0,
        )
        counter += 1

    w.add_author("pithagoras")
    w.add_name("bonsai-30b-files-reassembled")
    w.add_quantization_version(2)
    if not args.dry_run:
        w.write_header_to_file()
        w.write_kv_data_to_file()
        w.write_tensors_to_file()
        w.close()
    print(f"wrote {args.out}")
    print(f"  tensors: {counter} (+ missing {missing})")
    print(f"  arch: {arch} blocks {block_count} embd {embd} ffn {ffn} n_vocab {n_vocab}")
    print(f"  {time.time()-started:.0f}s")
    # note: values written as float32 for guaranteed load; ternaries preserved mathematically
    mt = os.path.splitext(args.out)[0] + ".meta.json"
    with open(mt, "w") as f:
        json.dump({"format": "reassembled-gguf", "src": src, "arch": arch,
                   "n_vocab": n_vocab, "tensors": counter, "missing": missing,
                   "note": "weights written as REAL Q1_0 quantized tensors (raw_dtype=Q1_0) from the native-ternary per-file model; norms written as float32",
                   "true_ternary": True, "quant": "Q1_0 (ternary {-1,0,+1})",
                   "built_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, f, indent=2)
    print("meta:", mt)


if __name__ == "__main__":
    main()
