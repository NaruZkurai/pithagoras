#!/usr/bin/env python3
"""
Keep a copy of the model SEGMENTS in RAM for faster changes.

The per-layer / per-expert native-ternary model is split into many small
segments (model/layers/L*/ and model/experts/E*/ files). Editing a layer or an
expert only touches its own file — so keeping those segments in RAM (tmpfs,
/dev/shm) makes each swap/change near-instant and avoids hammering disk, while
still allowing infinite writes (tmpfs).

This tool:
  1. Picks the RAM home for segments: /dev/shm/pithagoras-moe-checkpoints/model-30b/
  2. If the segments are NOT already in RAM (e.g. after a reboot wiped tmpfs),
     it (re)exports them from the source 27B MoE directly into RAM by invoking
     scripts/grow_model_30b.py --out <ram-home> (block-128 Q1_0 -> real ternary).
  3. Writes a segments.json manifest (every layer + expert segment file path,
     element count, byte size) so any consumer can locate/load a single segment
     fast and know its exact byte offsets.

Usage:
  python3 scripts/prepare-model-ram.py              # ensure segments in RAM
  python3 scripts/prepare-model-ram.py --force      # delete & re-export into RAM
  python3 scripts/prepare-model-ram.py --status     # just report, don't build
"""
import argparse, json, os, re, shutil, subprocess, sys, time

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAM_ROOT = "/dev/shm/pithagoras-moe-checkpoints/model-30b"
EXPORTER = os.path.join(PROJECT, "scripts", "grow_model_30b.py")
CONFIG = os.path.join(PROJECT, "config", "moe-config.json")


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def segments_present() -> bool:
    """True if the per-file model already exists in RAM with layers + experts."""
    if not os.path.isdir(RAM_ROOT):
        return False
    layers = os.path.join(RAM_ROOT, "model", "layers")
    experts = os.path.join(RAM_ROOT, "model", "experts")
    if not (os.path.isdir(layers) and os.path.isdir(experts)):
        return False
    n_layers = [d for d in os.listdir(layers) if re.fullmatch(r"L\d+", d)]
    n_exp = [d for d in os.listdir(experts) if d]
    return len(n_layers) > 0 and len(n_exp) > 0


def collect_segments(model_dir: str) -> dict:
    """Build a segments.json manifest: every segment file with path, count, bytes."""
    layers_dir = os.path.join(model_dir, "layers")
    experts_dir = os.path.join(model_dir, "experts")
    segments = {"layers": [], "experts": [], "globals": []}
    for ld in sorted(os.listdir(layers_dir)):
        ldp = os.path.join(layers_dir, ld)
        if not os.path.isdir(ldp) or not re.fullmatch(r"L\d+", ld):
            continue
        for f in sorted(os.listdir(ldp)):
            if not f.endswith(".tern"):
                continue
            p = os.path.join(ldp, f)
            segments["layers"].append({"layer": ld, "file": f,
                                       "rel": f"layers/{ld}/{f}",
                                       "bytes": os.path.getsize(p)})
    for ed in sorted(os.listdir(experts_dir), key=lambda x: int(re.sub(r"\D", "", x) or 0)):
        edp = os.path.join(experts_dir, ed)
        if not os.path.isdir(edp):
            continue
        for f in sorted(os.listdir(edp)):
            if not f.endswith(".tern"):
                continue
            p = os.path.join(edp, f)
            segments["experts"].append({"expert": ed, "file": f,
                                        "rel": f"experts/{ed}/{f}",
                                        "bytes": os.path.getsize(p)})
    for f in sorted(os.listdir(model_dir)):
        if f.endswith(".tern"):
            p = os.path.join(model_dir, f)
            segments["globals"].append({"file": f, "rel": f, "bytes": os.path.getsize(p)})
    return segments


def summarize(seg: dict) -> str:
    total = sum(v["bytes"] for k in ("layers", "experts", "globals") for v in seg[k])
    nseg = len(seg["layers"]) + len(seg["experts"]) + len(seg["globals"])
    nlay = len({v["layer"] for v in seg["layers"]})
    nexp = len({v["expert"] for v in seg["experts"]})
    return f"{nseg} segment files | {nlay} layers | {nexp} experts | {total/1e6:.0f}MB"


def write_manifest(segments: dict):
    with open(os.path.join(RAM_ROOT, "segments.json"), "w") as f:
        json.dump(segments, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="wipe & rebuild RAM segments")
    ap.add_argument("--status", action="store_true", help="only report, don't build")
    args = ap.parse_args()

    # Persistent on-disk mirror (survives reboot) so a reboot only COPIES into
    # RAM instead of re-exporting the ~27B from source (slow).
    DISK_ROOT = os.path.join(PROJECT, "config", "moe", "model", "30b", "segments-disk")
    DISK_MODEL = os.path.join(DISK_ROOT, "model")

    print(f"RAM segments home: {RAM_ROOT}")
    if args.status or (segments_present() and not args.force):
        if segments_present():
            print("segments present in RAM.")
            seg = collect_segments(os.path.join(RAM_ROOT, "model"))
            print("  " + summarize(seg))
            write_manifest(seg)
            # (idempotent) persist a disk mirror too
            if os.path.isdir(RAM_ROOT):
                if os.path.isdir(DISK_MODEL):
                    shutil.rmtree(DISK_MODEL)
                shutil.copytree(os.path.join(RAM_ROOT, "model"), DISK_MODEL)
                print(f"  mirrored to disk: {DISK_MODEL}")
            return
        if args.status:
            print("segments NOT in RAM (reboot wiped tmpfs). Run without --status to build.")
            return

    os.makedirs(RAM_ROOT, exist_ok=True)

    # 1) source for segments: prefer an existing persistent disk copy (fast), else export.
    if os.path.isdir(DISK_MODEL) and len(os.listdir(os.path.join(DISK_MODEL, "layers"))) > 0:
        print(f"copying segments from persistent disk mirror -> RAM ({DISK_MODEL})")
        t0 = time.time()
        for root, dirs, files in os.walk(DISK_MODEL):
            rel = os.path.relpath(root, DISK_MODEL)
            dest = os.path.join(RAM_ROOT, "model", rel)
            os.makedirs(dest, exist_ok=True)
            for f in files:
                shutil.copy2(os.path.join(root, f), os.path.join(dest, f))
        print(f"  copied in {time.time()-t0:.0f}s")
        seg = collect_segments(os.path.join(RAM_ROOT, "model"))
        write_manifest(seg)
        print("  " + summarize(seg))
        return

    # 2) no disk mirror: export from the source 27B MoE into RAM (and mirror to disk).
    print("exporting segments into RAM from source 27B MoE (block-128 -> real ternary)...")
    t0 = time.time()
    r = subprocess.run([sys.executable, EXPORTER, "--out", RAM_ROOT], cwd=PROJECT)
    if r.returncode != 0:
        print("export FAILED (see above). RAM segments not ready.")
        sys.exit(1)
    newest = max((os.path.join(RAM_ROOT, d) for d in os.listdir(RAM_ROOT)
                  if d.startswith("ternary-") and os.path.isdir(os.path.join(RAM_ROOT, d))),
                 key=os.path.getmtime, default=None)
    if newest is None:
        print("no ternary-<ts> dir produced; segments missing."); sys.exit(1)
    print(f"exported to {newest} in {time.time()-t0:.0f}s")
    seg = collect_segments(os.path.join(newest, "model"))
    # flatten the timestamped dir into RAM_ROOT/model for a stable path
    for root, dirs, files in os.walk(os.path.join(newest, "model")):
        rel = os.path.relpath(root, os.path.join(newest, "model"))
        dest = os.path.join(RAM_ROOT, "model", rel)
        os.makedirs(dest, exist_ok=True)
        for f in files:
            shutil.copy2(os.path.join(root, f), os.path.join(dest, f))
    seg = collect_segments(os.path.join(RAM_ROOT, "model"))
    write_manifest(seg)
    print("Wrote segments.json manifest.")
    print("  " + summarize(seg))
    # persist disk mirror
    if os.path.isdir(DISK_MODEL):
        shutil.rmtree(DISK_MODEL)
    shutil.copytree(os.path.join(RAM_ROOT, "model"), DISK_MODEL)
    print(f"  mirrored to disk: {DISK_MODEL}")


if __name__ == "__main__":
    main()
