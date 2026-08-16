#!/usr/bin/env python3
"""
Shared, CORRECT Q1_0 codec for the llama-direct-token-input fork.

This fork redefines Q1_0 to:
    struct block_q1_0 { ggml_half d; uint8_t qs[16]; }  // 2B fp16 scale + 16B bitfield
    QK1_0 == 128 weights/block, 18 bytes/block.

CRITICAL layout fact (the bug that made the 30B collapse to '/'):
   A [rows, cols] Q1_0 tensor is stored ROW-MAJOR, and EACH ROW is padded to a
   multiple of 128. So:
       blocks_per_row = ceil(cols / 128)
       total_blocks   = rows * blocks_per_row
       total_bytes    = total_blocks * 18
   You CANNOT flatten the whole tensor into ceil(n/128) blocks — that only works
   when cols is a multiple of 128. For tensors like ssm_alpha/ssm_beta with
   shape [5120, 48] (cols=48), flat decoding reads the WRONG byte offsets and
   scrambles every value beyond the first row-pad, which breaks the model's
   logits (the '/'-only collapse).

Both grow_model_30b.py (export) and patch_gguf_ternary.py (re-encode) MUST use
these exact functions so the round-trip is byte-identical for every shape.

Effective sign convention (must match on both sides):
   bit == 1  -> weight +1
   bit == 0  -> weight -1
   (0-valued weights come only from scale==0 blocks, handled separately.)
"""
import math
import numpy as np

Q1_0_NBLOCK = 128
Q1_0_BYTES_PER_BLOCK = 18
Q1_0_QSBYTES = Q1_0_NBLOCK // 8  # 16


def blocks_per_row(cols: int) -> int:
    return (cols + Q1_0_NBLOCK - 1) // Q1_0_NBLOCK


def tensor_n_bytes(rows: int, cols: int) -> int:
    """Total Q1_0 byte length of a [rows, cols] tensor (row-padded)."""
    return rows * blocks_per_row(cols) * Q1_0_BYTES_PER_BLOCK


def fp16_to_float(h: int) -> float:
    s = (h >> 15) & 1
    e = (h >> 10) & 0x1F
    m = h & 0x3FF
    if e == 0:
        val = math.ldexp(m, -24)
    elif e == 31:
        val = float("inf") if m == 0 else float("nan")
    else:
        val = math.ldexp(m + 1024, e - 25)
    return -val if s else val


def decode_q1_row(raw: bytes, rows: int, cols: int) -> np.ndarray:
    """Decode a row-major Q1_0 tensor to strict ternary {-1,0,+1}, shape [rows, cols].

    raw must be EXACTLY tensor_n_bytes(rows, cols) bytes.
    """
    raw_arr = np.frombuffer(raw, dtype=np.uint8)
    bpr = blocks_per_row(cols)
    # each row is bpr blocks; each block is [scale2][bitfield16]
    rows_arr = raw_arr.reshape(rows, bpr, Q1_0_BYTES_PER_BLOCK)
    scales = rows_arr[:, :, 0] | (rows_arr[:, :, 1].astype(np.uint16) << 8)  # [rows,bpr]
    qs = np.ascontiguousarray(rows_arr[:, :, 2:])                            # [rows,bpr,16]
    bits = np.unpackbits(qs, bitorder="little").reshape(rows, bpr, Q1_0_NBLOCK)
    out = np.where(bits == 1, 1, -1).astype(np.int8)
    # zero out where fp16 scale == 0
    zero = (scales == 0).reshape(rows, bpr, 1)
    out = np.where(zero, 0, out)
    return out[:, :, :cols].reshape(rows, cols)


def encode_q1_row(flat_tern: np.ndarray, rows: int, cols: int, src_scale_bytes: bytes = None) -> bytes:
    """Re-encode a flat ternary value array ([rows*cols]) into row-major Q1_0 bytes
    of exactly tensor_n_bytes(rows, cols) bytes.

    Each block KEEPS the matching source fp16 scale from src_scale_bytes
    (row-major, same layout) so the model's magnitude structure survives.
    """
    flat = np.clip(np.asarray(flat_tern).astype(np.int8), -1, 1)
    bpr = blocks_per_row(cols)
    padded = np.zeros((rows, bpr * Q1_0_NBLOCK), dtype=np.int8)
    padded[:, :cols] = flat.reshape(rows, cols)
    bits = (padded >= 0).astype(np.uint8)          # +1/0 -> bit1, -1 -> bit0
    packed = np.packbits(bits, bitorder="little").reshape(rows, bpr, Q1_0_NBLOCK // 8)

    out = bytearray()
    nbytes = tensor_n_bytes(rows, cols)
    if src_scale_bytes is not None:
        # src_scale_bytes is row-major [rows, bpr, 18]; scale is first 2 bytes of each block
        sb = np.frombuffer(src_scale_bytes, dtype=np.uint8).reshape(rows, bpr, Q1_0_BYTES_PER_BLOCK)
        scales = sb[:, :, :2]
    else:
        scales = np.full((rows, bpr, 2), 0x3C, dtype=np.uint8)  # 1.0 as fp16 (0x3C00)
        scales[:, :, 1] = 0x00
    # build per row: for each block: [scale2][16 bits]
    for r in range(rows):
        for b in range(bpr):
            out += scales[r, b].tobytes()
            out += packed[r, b].tobytes()
    return bytes(out)


def pack_tern_2bit(flat: np.ndarray, n: int) -> bytes:
    """Pack a flat ternary array to 2-bit codes (0=-1,1=0,2=+1), 4 values/byte."""
    codes = (np.asarray(flat).astype(np.int8) + 1).astype(np.uint8)
    pad = (-n) % 4
    if pad:
        codes = np.concatenate([codes, np.zeros(pad, dtype=np.uint8)])
    pods = codes.reshape(-1, 4)
    out = (pods[:, 0] | (pods[:, 1] << 2) | (pods[:, 2] << 4) | (pods[:, 3] << 6)).astype(np.uint8)
    return out.tobytes()


def unpack_tern_2bit(data: bytes, n: int) -> np.ndarray:
    """Inverse of pack_tern_2bit: bytes -> flat ternary {-1,0,+1} of length n."""
    raw = np.frombuffer(data, dtype=np.uint8)
    vals = np.zeros(len(raw) * 4, dtype=np.int8)
    vals[0::4] = (raw & 0x03).astype(np.int8) - 1
    vals[1::4] = ((raw >> 2) & 0x03).astype(np.int8) - 1
    vals[2::4] = ((raw >> 4) & 0x03).astype(np.int8) - 1
    vals[3::4] = ((raw >> 6) & 0x03).astype(np.int8) - 1
    return vals[:n]
