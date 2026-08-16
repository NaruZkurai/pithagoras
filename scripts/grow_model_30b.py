#!/usr/bin/env python3
"""
Fast, COMPACT TERNARY export of the 27B MoE (qwen35) — the "30B model" source.

USER wants: fast + ternary + compressed-token input. This does NOT rebuild a
bloated float32 GGUF (too big / slow). Instead it:
  1. Reads the 27B MoE (Bonsai-27B-Q1_0.gguf, n_vocab 248320 — the teacher/MoE
     token space).
  2. Vectorized-decodes every Q1_0 weight to strict ternary {-1,0,+1} using the
     SHARED row-major codec (scripts/q1_codec.py).
  3. Packs 2-bit (4 values/byte) so the ~30B model stays compact (fast to
     write, fast to load).
  4. Emits model/*.tern + tensors.json + meta.json (same shape as
     export_ternary_model.py, but for the 27B MoE in the 248320 vocab).
  5. Records the compressed-token input scheme (footprint = sum of token ids)
     in meta so the harness's direct/compressed token input can ingest it.

Because every source weight is already 1-bit Q1_0, the ternary values ARE the
model (no lossy re-quant) and the export is a pure fast sign-copy.

MUST stay in sync with patch_gguf_ternary.py (both use q1_codec.py) so the
round-trip is byte-identical for EVERY tensor shape — including irregular
col sizes (e.g. ssm_alpha [5120,48]) where the old flat-block decode scrambled
the weights and collapsed the model to '/'.

Usage:
  python3 scripts/grow_model_30b.py                # -> 30b/ternary-30b/<ts>/
  python3 scripts/grow_model_30b.py --out DIR
"""
import argparse, json, os, time
import numpy as np
from q1_codec import (Q1_0_NBLOCK, Q1_0_BYTES_PER_BLOCK, tensor_n_bytes,
                      decode_q1_row, pack_tern_2bit)

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(PROJECT, "config", "moe-config.json")


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def pack_ternary(flat: np.ndarray, outfile, n: int):
    """2-bit packed ternary: -1->0, 0->1, +1->2 (4 values/byte). Returns bytes count."""
    out = pack_tern_2bit(flat, n)
    outfile.write(out)
    outfile.close()
    return n, len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    cfg = load_config()
    m = cfg.get("model", {})
    base = m.get("tokenizer_from") or m.get("base_gguf") or "/nzk/models/Bonsai-27B-Q1_0.gguf"
    if not os.path.exists(base):
        base = "/nzk/models/Bonsai-27B-Q1_0.gguf"
    n_vocab = int(m.get("tokenizer_n_vocab") or m.get("n_vocab") or 248320)

    out_root = args.out or os.path.join(PROJECT, "config", "moe", "model", "30b", "ternary-30b")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(out_root, f"ternary-{stamp}")
    model_dir = os.path.join(out_dir, "model")
    layers_dir = os.path.join(model_dir, "layers")
    experts_dir = os.path.join(model_dir, "experts")
    os.makedirs(layers_dir, exist_ok=True)
    os.makedirs(experts_dir, exist_ok=True)

    import gguf
    reader = gguf.GGUFReader(base)
    print(f"base: {os.path.basename(base)}  | tensors: {len(reader.tensors)}  | n_vocab: {n_vocab}", flush=True)

    # The config's moe.experts drives which experts exist and how they mutate.
    expert_gates = {}
    for nm, spec in cfg.get("moe", {}).get("experts", {}).items():
        idx = int("".join(c for c in nm if c.isdigit()) or 0)
        expert_gates[nm] = {"idx": idx, "noise": spec.get("noise", 0.1), "role": spec.get("role", "mutation")}

    total_params = 0
    total_bytes = 0
    tensor_index = []
    sample_pool = set()
    started = time.time()

    def write_tern(file_path, vals, shape):
        """Write one tensor's ternary values (2-bit packed) to its own file and
        return (n_params, n_bytes)."""
        nonlocal total_params, total_bytes
        n = int(vals.size)
        nparams, nbytes = pack_ternary(vals, open(file_path, "wb"), n)
        total_params += nparams
        total_bytes += nbytes
        tensor_index.append({
            "name": os.path.relpath(file_path, out_dir), "shape": [int(x) for x in shape],
            "n_elements": n, "bytes": nbytes, "n_blocks": (n + 31) // 32,
        })
        return nparams, nbytes

    def ternarize_tensor(t):
        # Q1_0 is ROW-MAJOR with per-row padding to a multiple of 128. The real
        # byte length is rows*ceil(cols/128)*18 — NOT ceil(n/128)*18. Using the
        # wrong (flat) length reads past this tensor into the next one and
        # scrambles every weight (the '/'-only collapse bug).
        rows = int(t.shape[0]) if len(t.shape) >= 2 else 1
        cols = int(t.shape[-1])
        nbytes = tensor_n_bytes(rows, cols)
        raw = bytes(np.ascontiguousarray(reader.data[int(t.data_offset): int(t.data_offset) + nbytes]))
        n = int(t.n_elements)
        vals = decode_q1_row(raw, rows, cols)
        return vals.reshape(-1)[:n]
        sample_pool.update(int(x) for x in vals.flat[:2000])
        return vals

    # -- global tensors (embedding / output / norms) -> model/ root --
    for t in reader.tensors:
        if t.name.startswith("blk."):
            continue
        if int(t.tensor_type) != 41:
            continue
        nm = t.name.replace("/", "_").replace("blk.", "b_").replace(".", "_")
        write_tern(os.path.join(model_dir, f"{nm}.tern"), ternarize_tensor(t), t.shape)

    # -- per-LAYER tensors -> model/layers/L<NN>/ -- each layer its own file.
    #    FFN (gate/up/down) are stored in the per-EXPERT files below (authoritative
    #    per-piece storage) so weights aren't duplicated; each layer dir therefore
    #    holds its dense attention + SSM + norms, and a manifest pointing at the
    #    expert FFN files.
    layer_files = {}
    for t in reader.tensors:
        if not t.name.startswith("blk."):
            continue
        bim = t.name.split(".")[1]
        lidx = int(bim)
        if int(t.tensor_type) != 41:
            continue
        if "ffn" in t.name:      # FFN lives in the expert files; don't duplicate
            continue
        ld = os.path.join(layers_dir, f"L{lidx:02d}")
        os.makedirs(ld, exist_ok=True)
        tail = t.name[len(f"blk.{bim}."):].replace(".", "_")
        vals = ternarize_tensor(t)
        write_tern(os.path.join(ld, f"{tail}.tern"), vals, t.shape)
        layer_files.setdefault(lidx, [])
        layer_files[lidx].append(tail)

    # -- per-EXPERT files: partition each layer's FFN weights across the
    #    configured experts (E1..EN) so each expert is its own swappable file. --
    #    We map the FFN up/gate/down subtensors of each layer round-robin onto
    #    the expert set, giving each expert a distinct slice it can be grown or
    #    replaced without touching the others (resizable by adding/removing files).
    expert_names = sorted(expert_gates, key=lambda x: expert_gates[x]["idx"])
    if expert_names:
        per_layer = [t for t in reader.tensors if t.name.startswith("blk.") and int(t.tensor_type) == 41]
        # collect ffn-related tensor names per layer
        ffn_names = sorted({t.name.split(".")[-1] for t in per_layer if "ffn" in t.name})
        for t in per_layer:
            if "ffn" not in t.name:
                continue
            bim = t.name.split(".")[1]
            lidx = int(bim)
            tail = t.name[len(f"blk.{bim}."):].replace(".", "_")
            # assign this ffn subtensor to one expert (rotate by layer+sub)
            ename = expert_names[(lidx + ffn_names.index(t.name.split(".")[-1])) % len(expert_names)]
            ed = os.path.join(experts_dir, ename)
            os.makedirs(ed, exist_ok=True)
            vals = ternarize_tensor(t)
            write_tern(os.path.join(ed, f"L{lidx:02d}_{tail}.tern"), vals, t.shape)

    # write a per-file index + per-layer/expert manifest
    with open(os.path.join(model_dir, "layers.manifest.json"), "w") as f:
        json.dump({"layers": {str(k): {"dir": f"L{k:02d}", "tensors": layer_files.get(k)} for k in sorted(layer_files)},
                   "note": "FFN (gate/up/down) live in model/experts/* (authoritative); each layer is resized by adding/removing L<NN> dirs"},
                  f, indent=2)
    with open(os.path.join(experts_dir, "experts.manifest.json"), "w") as f:
        json.dump({"experts": expert_names,
                   "note": "each expert dir holds its own ternary FFN files; add/remove a dir to resize"},
                  f, indent=2)

    total_b = total_params / 1e9
    comp = cfg.get("scoring", {}).get("value_generation", {})
    sentinel = comp.get("compressed_token_sentinel", 999993)
    meta = {
        "format": "ternary-model-30b-files",
        "base": base,
        "base_arch": "qwen35", "n_vocab": n_vocab,
        "param_count": total_params,
        "param_count_billions": round(total_b, 3),
        "true_ternary": True,
        "native_ternary": True,
        "ternary_formula": "1-bit Q1_0 -> strict ternary {-1,0,+1} (bit?+1:-1, 0 where scale=0)",
        "ternary_encoding": "2-bit packed {-1,0,+1}: 0=-1,1=0,2=+1 (4 values/byte)",
        "layout": {
            "model/": "global tensors (embedding, output, norms) — one .tern per tensor",
            "model/layers/L00..L63/": "each LAYER is its own directory of .tern files; grow/shrink by adding/removing a layer dir",
            "model/experts/E01..EN/": "each EXPERT is its own directory of ternary FFN files; grow/shrink by adding/removing an expert dir",
            "resizable": "layers and experts are individually swappable files (matches the per-expert checkpoint diff machinery)",
        },
        "tensors": len(tensor_index), "total_bytes": total_bytes,
        "export_seconds": round(time.time() - started, 1),
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "verified_ternary_values": sorted(sample_pool),
        "compressed_token_input": {
            "how": "direct token ids; a compressed token's VALUE = sum of its constituent token ids (footprint)",
            "sentinel": sentinel,
            "per_step": int(cfg.get("sampling", {}).get("per_step") or 5),
        },
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    with open(os.path.join(out_dir, "tensors.json"), "w") as f:
        json.dump(tensor_index, f, indent=2)

    print(f"\nDONE: {total_b:.3f}B params, {total_bytes/1e6:.1f}MB, {time.time()-started:.0f}s")
    print(f"  verified ternary values: {sorted(sample_pool)}")
    print(f"  n_vocab: {n_vocab} (teacher 27B MoE token space)")
    print(f"  native ternary per-layer/per-expert file layout -> {out_dir}")


if __name__ == "__main__":
    main()
