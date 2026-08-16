# Pithagoras — Roadmap

The full goal of this project, kept current. If a phase's "live status" no
longer matches the code, update this file — it is the single source of truth for
where this is heading.

## The mission

**Grow the 500 MB true-ternary model toward 30B — in full true-ternary
formatting — by distilling it from the real 27B teacher, and prove progress by
comparing its values (KV / top-k) against the 27B.**

- The seed: `Bonsai-4B-Q1_0.gguf` — a **true ternary** model. Its weights are
  literally `{-1, 0, +1}` (Q1_0 GGUF). This is the whole point: we are not
  growing an FP16 model. We grow capacity while staying ternary.
- The teacher: the **real 27B** (`Bonsai-27B-Q1_0.gguf`, local `:41001`, also
  on the remote box `192.168.2.64:6464`). Its output values are the benchmark.
- The proof: a **KV / top-k comparison** against the 27B, using **expanded
  tokens + token chunk compression as new tokens** (each compressed token's
  value = the sum of its constituent tokens `n1+n2+n3...`). The compressed
  stream's **effective top-k spread must equal the main model's** — but only
  if the number of raw tokens generated equals the sum of the per-chunk token
  counts (`N == sum n_j`). That invariant is the gate.
- The end state: a model that reaches ~30B effective capability **in true
  ternary values**, measurably approaching the 27B teacher's behavior.

## Landing pads / scripts (already built, verified working)

| Piece | Where | What it does |
|---|---|---|
| Teacher data collection | `scripts/augment-500mb.mjs --collect` | Runs the REAL 27B on repo source patterns, captures its output token sequences → `data/augment/train.jsonl` |
| Ternary grow | `scripts/augment-500mb.mjs --grow` | `llama-finetune` (direct-token fork via `scripts/train-6gb.sh`) on the Q1_0 ternary model, output stays true-ternary `{-1,0,+1}` |
| Compare (text) | `scripts/augment-500mb.mjs --compare` | Held-out prompts through the 500MB and real 27B → `output/compare.json` |
| KV / top-k chunk-compress compare | `scripts/compare-topk.mjs` | Per-model per-position TOP-K via `/v1/completions?logprobs`; token chunks folded into sum-valued new tokens; effective top-k spread vs the larger model, gated on `N == sum n_j` → `output/topk-compare.json` |
| Finetune wrapper | `scripts/train-6gb.sh` | Caps model-layer RAM at 6 GiB (`ulimit -v`), GPU offload via `-ngl`/`-fit` |
| Harness | `server/scripts/run-upgrade-agent.mjs` | The self-augmentation loop; routes the executor to the 500MB 4B, commits verified (NET-POSITIVE) edits |

## Hardware constraint (drives every choice)

- CPU: AMD Ryzen 5 5600G
- GPU: RTX 3060 12 GB initially; this box also has an RTX 4070 Ti SUPER
  (~4.9 GB free after the 27B Q1_0 and 4B are resident)
- There is **no headroom to serve and run heavy gradient training at the same
  time**. So: **data-first, grow-later**, and keep the direct-token fork's
  training inside the 6 GiB cap.

## Roadmap phases

### Phase 0 — Foundation (done)
Portal, session executor (host + container), channel packages, model_servers
registry, pi SDK integration (v0.82.1), model picker, stop button, empty-
response handling, inspect_request tool.

### Phase 1 — Self-augmentation pipeline (done, in place)
The harness collects 27B teacher values, grows the 500MB ternary model, and
compares against the 27B. Scripts above are verified; the mission items below
drive them to completion.

### Phase 2 — Grow the 500MB → 30B in true ternary (current focus)
- [ ] Run the ternary finetune (`--grow`) for real and **verify the output
      stays Q1_0** (weights `{-1,0,+1}`), not silently FP16.
- [ ] Compound grow iterations: chain teacher-collect → grow → compare so the
      grown model's KV / top-k spread climbs toward the 27B's.
- [ ] Verify ternary value integrity on the grown GGUF each iteration.
- [ ] Route the harness + portal to the grown model once parity crosses a bar.

### Phase 3 — KV / top-k parity as the eval gate (current focus)
- [ ] Use `compare-topk.mjs` (effective top-k on compressed sum-tokens, gated
      on `N == sum n_j`) as the promotion criterion, not just text overlap.
- [ ] Add per-position KV-cache comparison signal (logits/top-k are the proxy;
      expose raw KV if the fork surfaces it).
- [ ] Track `parity vs 27B` across grow iterations in a ledger; stop when it
      plateaus or "reaches the main".

### Phase 4 — Broader project (from the earlier `docs/self-training.md`)
- Fleet routing across a few specialized 4B models.
- Trajectory dataset builder → LoRA/DPO when the GPU is idle.
- Channel + extension polish.

## Execution state / live notes

- Executor model: the 27B Q1_0 **degenerates** on real agent turns (emits only
  an EOS token — `content:[] output:2`; its template forces a `<think>` it
  can't fill). The 500MB 4B Q1_0 *does* follow instructions, so the harness
  runs it with `--reasoning off` at the server + a compact project brief.
- Growth direction keeps the model **true ternary**: never FP16. The direct-
  token fork's `llama-finetune` operates on the Q1_0 model; compounding runs
  grow semantic capacity toward 30B in ternary values.
- All generated/derived artifacts (`output/`, `data/augment/`, grown `.gguf`s)
  are gitignored; landing-pad scripts are committed.

## Run the mission today
```sh
# 1. Collect 27B teacher values + compare text-out
node scripts/augment-500mb.mjs --collect --compare

# 2. KV / top-k chunk-compression parity vs the 27B
node scripts/compare-topk.mjs --tokens 18 --chunk 3

# 3. Grow the ternary model (finetune, keeps {-1,0,+1})
node scripts/augment-500mb.mjs --grow

# 4. Self-augmentation loop (relaunch after a stop)
SKIP_IMAGE_REBUILD=1 node server/scripts/run-upgrade-agent.mjs
```
