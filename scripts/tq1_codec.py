#!/usr/bin/env python3
"""
True-ternary TQ1_0 codec for llama-direct-token-input (native ternary).

The student model MUST be TRUE ternary {-1,0,+1} (GGML_TYPE_TQ1_0 = 34), NOT
Q1_0 (which can only hold {+1,-1} and destroys the zero values). Q1_0 re-encoding
is fundamentally wrong for this model — TQ1_0 is the real native format.

STRUCTURE (from ggml-common.h / ggml-quants.c, QK_K = 256):
    struct block_tq1_0 {
        uint8_t qs[48];   // 240 elements, 5 per byte (base-3: 3^5=243<256)
        uint8_t qh[4];    // 16 elements, 4 per byte (base-3)
        ggml_half d;      // fp16 scale (amax of the 256 weights)
    };                    // 54 bytes / 256 weights = 1.6875 bpw

PAYLOAD LAYOUT inside qs[48] (matches quantize_row_tq1_0_ref EXACTLY):
   - bytes 0..31  (32 bytes): elements 0..159, byte m packs trits {m, m+32, m+64,
       m+96, m+128} for m in 0..31 (5 values strided 32).
   - bytes 32..47 (16 bytes): elements 160..239, byte (32+m) packs trits
       {m, m+16, m+32, m+48, m+64} for m in 0..15 (5 values strided 16).

qh[4]: 16 elements 240..255, byte j packs trits {j, j+4, j+8, j+12} for j in 0..3
   (4 values strided 4), PLUS the C quant shifts-in a leading trit (q *= 3)
   before the 256-mapping for the qh section.

TRIT ENCODING per byte: 5 ternary vals vi∈{-1,0,1} -> ci=vi+1∈{0,1,2}; base-3:
   raw = ((c0*3 + c1)*3 + c2)*3 + c3)*3 + c4  = c0*81 + c1*27 + c2*9 + c3*3 + c4
   stored byte = ((raw*256 + 242) // 243)     # scaled ceil-ish into 0..255
DECODE (from dequant): value_i = (((byte * pow3) * 3) >> 8) - 1  where
   pow3 = 3^(i). i.e. xi = ((byte * 3^i * 3) >> 8); val = xi - 1.

For qh (4 trits): quant does raw=(c0*3+c1)*3+c2)*3+c3 then q*=3 (one more trit=0)
   then same 256-mapping. Decode reads 4 positions with pow3={1,3,9,27} plus the
   implicit leading 0 trit (the *3 in dequant comes from the byte side).
"""
import struct
import numpy as np

QK_TQ1 = 256
QS_BYTES = 48
QH_BYTES = 4
D_BYTES = 2
BPT = QS_BYTES + QH_BYTES + D_BYTES      # 54 bytes per 256 block
POW3 = (1, 3, 9, 27, 81, 243)


def blocks_per_row_256(cols: int) -> int:
    return (cols + QK_TQ1 - 1) // QK_TQ1


def tensor_n_bytes_tq1(rows: int, cols: int) -> int:
    return rows * blocks_per_row_256(cols) * BPT


def _encode_byte(trits5) -> int:
    """trits5: 5 codes ci∈{0,1,2} (already +1). -> stored byte."""
    raw = ((((trits5[0] * 3 + trits5[1]) * 3 + trits5[2]) * 3 + trits5[3]) * 3 + trits5[4])
    return (raw * 256 + 242) // 243


def _decode_trit(byte: int, idx: int) -> int:
    """Decode trit idx (0..4) of a stored byte -> {-1,0,1}.

    Mirrors C dequantize_row_tq1_0 EXACTLY:
        uint8_t q = x.qs[...] * pow3[idx];   // uint8_t -> wraps mod 256
        int16_t xi = ((uint16_t) q * 3) >> 8;
    """
    q = (byte * POW3[idx]) & 0xFF        # uint8_t wraparound
    return ((q * 3) >> 8) - 1


def _pack5(vals_rows, base, stride, count, shift3=False):
    """Vectorized base-3 pack of 5 trit-codes per byte.

    vals_rows: (N, 256) code array (0/1/2). For byte index m (0..count-1),
    packs codes at positions {m + s*stride} for s in 0..4 (most-significant s=0).
    If shift3, multiply raw by 3 (qh leading-trit shift).
    Returns uint8 array (N, count).
    """
    out = np.zeros((vals_rows.shape[0], count), dtype=np.uint32)
    for m in range(count):
        raw = vals_rows[:, base + m + 0 * stride].astype(np.uint32) * 81
        raw += vals_rows[:, base + m + 1 * stride].astype(np.uint32) * 27
        raw += vals_rows[:, base + m + 2 * stride].astype(np.uint32) * 9
        raw += vals_rows[:, base + m + 3 * stride].astype(np.uint32) * 3
        raw += vals_rows[:, base + m + 4 * stride].astype(np.uint32)
        if shift3:
            raw *= 3
        out[:, m] = (raw * 256 + 242) // 243
    return out.astype(np.uint8)


def _pack4qh(vals_rows, base, count):
    """Vectorized base-3 pack of 4 trit-codes per byte (qh: 16 elems, 4/byte).

    byte j packs codes at {base+j, base+j+4, base+j+8, base+j+12} (s=0..3 most
    significant), then multiplies raw by 3 (the C leading-trit shift).
    """
    out = np.zeros((vals_rows.shape[0], count), dtype=np.uint32)
    for j in range(count):
        raw = vals_rows[:, base + j + 0 * 4].astype(np.uint32) * 27
        raw += vals_rows[:, base + j + 1 * 4].astype(np.uint32) * 9
        raw += vals_rows[:, base + j + 2 * 4].astype(np.uint32) * 3
        raw += vals_rows[:, base + j + 3 * 4].astype(np.uint32)
        raw *= 3
        out[:, j] = (raw * 256 + 242) // 243
    return out.astype(np.uint8)


def encode_tq1_row(tern: np.ndarray, rows: int, cols: int, scale_bytes: bytes = None) -> bytes:
    """Encode a flat float/trit array [rows*cols] into TQ1_0 row-major bytes.

    Vectorized (numpy) mirror of quantize_row_tq1_0_ref. Each 256-weight block
    computes d = amax(|values|) as fp16 and maps each value to a trit code
    ci = round(v/d)+1 in {0,1,2}. Output is row-major [rows, ceil(cols/256)*54].
    """
    flat = np.asarray(tern, dtype=np.float32).reshape(rows, cols)
    bpr = blocks_per_row_256(cols)
    padded_cols = bpr * QK_TQ1
    padded = np.zeros((rows, padded_cols), dtype=np.float32)
    padded[:, :cols] = flat
    blocks = padded.reshape(rows * bpr, QK_TQ1)          # (rows*bpr, 256)
    amax = np.max(np.abs(blocks), axis=1)                 # (rows*bpr,)
    id_ = np.where(amax != 0, 1.0 / np.where(amax != 0, amax, 1.0), 0.0)
    vals = (np.rint(blocks * id_[:, None]).astype(np.int32) + 1)   # codes 0/1/2

    qs = np.zeros((rows * bpr, QS_BYTES), dtype=np.uint8)
    # qs-main: 32 bytes, byte m packs {m, m+32, m+64, m+96, m+128}
    qs[:, 0:32] = _pack5(vals, 0, 32, 32)
    # qs-tail: 16 bytes, byte m packs {160+m, 160+m+16, ...}
    qs[:, 32:48] = _pack5(vals, 160, 16, 16)
    # qh: 4 bytes, byte j packs {240+j, 240+j+4, 240+j+8, 240+j+12}, then *3
    qh = _pack4qh(vals, 240, 4)

    # assemble per block: qs(48) + qh(4) + d(f16)
    d16 = amax.astype(np.float16)
    nblk = rows * bpr
    out = bytearray()
    for i in range(nblk):
        out += qs[i].tobytes()
        out += qh[i].tobytes()
        out += d16[i].tobytes()
    return bytes(out)


def decode_tq1_row(raw: bytes, rows: int, cols: int) -> np.ndarray:
    """Decode TQ1_0 row-major bytes into float matrix [rows, cols].

    Emission order matches dequantize_row_tq1_0 EXACTLY (outer loop = trit
    position, inner loop = byte index):
      qs-main: elem e in 0..159 = trit(e//32) of byte(e%32)
      qs-tail: elem e in 160..239 = trit((e-160)//16) of byte(32+(e-160)%16)
      qh:      elem e in 240..255 = trit((e-240)//4) of byte(qh[(e-240)%4])
    """
    bpr = blocks_per_row_256(cols)
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(rows, bpr, BPT)
    out = np.zeros((rows, cols), dtype=np.float32)
    for r in range(rows):
        for b in range(bpr):
            blk = arr[r, b]
            d = struct.unpack("<e", blk[QS_BYTES + QH_BYTES:QS_BYTES + QH_BYTES + D_BYTES].tobytes())[0]
            qs = blk[0:QS_BYTES]
            qh = blk[QS_BYTES:QS_BYTES + QH_BYTES]
            vals = []
            # qs-main: 160 elements
            for n in range(5):
                for m in range(32):
                    vals.append(_decode_trit(int(qs[m]), n) * d)
            # qs-tail: 80 elements
            for n in range(5):
                for m in range(16):
                    vals.append(_decode_trit(int(qs[32 + m]), n) * d)
            # qh: 16 elements
            for n in range(4):
                for j in range(QH_BYTES):
                    vals.append(_decode_trit(int(qh[j]), n) * d)
            bcol = b * QK_TQ1
            take = min(QK_TQ1, cols - bcol)
            out[r, bcol:bcol + take] = vals[:take]
    return out
