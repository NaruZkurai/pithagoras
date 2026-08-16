# Pithagoras — Autonomous Checklist

Working checklist while the owner is away. Two lists:
- **To-do (must / committed)**: concrete next actions toward the mission.
- **Beneficial (worth it)**: improvements that increase the chance of landing
  verified work, without being required.

Legend: `[ ]` open, `[x]` done, keep this file updated as work proceeds.

---

## Mission recap (from `roadmap.md`)

Grow the 500MB true-ternary model toward 30B in **full true-ternary
formatting** (`{-1,0,+1}`), distilled from the real 27B teacher, proven by
**KV / top-k comparison with expanded tokens + token chunk compression** (each
compressed token's value = sum n1+n2+n3; effective top-k must equal the main
only if `N == sum n_j`).

---

## TO-DO (must / advancing the mission)

### M1 — Run the ternary grow for real
- [x] `node scripts/augment-500mb.mjs --grow` wired: feeds plain-text train.txt
      to `llama-finetune`, bounded context so it fits the 6 GiB cap, CPU mode
      (GPU OOMs — `cudaMalloc failed` offloading the f32 KV).
- [~] **BLOCKED (fork training bug)**: `llama-finetune` aborts (SIGABRT) in
      `ggml_build_backward_expand`:
      `ggml.c:7309 GGML_ASSERT(!node->view_src || op == CPY|VIEW|RESHAPE|PERMUTE|TRANSPOSE)`
      — the Q1_0/ternary model uses a tensor op whose gradient the fork's
      backward pass doesn't support. This is a **C++/ggml-level limitation of
      the direct-token fork**, NOT fixable from the harness/script layer.
      Retry with `-b 64 -ub 32 -c 512 -lr 1e-5` confirmed the same abort.
- [ ] To unblock: patch the fork's ggml backward pass to support the op (or
      raise it upstream), or find a quant/layer config the backward graph
      accepts. Until then, `--grow` cannot produce a grown GGUF.
- [ ] Verify the grown GGUF **stays true-ternary Q1_0** once grow is unblocked.

### M2 — Compare grown vs 27B, KV / top-k
- [ ] `node scripts/compare-topk.mjs --tokens N --chunk S` against the grown
      model (use `GROWN_MODEL`/`SMALL_URL` pointing at the grown server).
- [ ] Record `mean_token_agreement` and `effective_topk_parity_gated` vs the
      27B in `output/grow-ledger.jsonl` (append per iteration).
- [ ] Use top-k parity as the **promotion criterion**, not text overlap.

### M3 — Compound grow iterations
- [ ] Chain collect → grow → compare repeatedly, appending to the ledger.
- [ ] Confirm parity climbs toward ~1.0 as iterations compound.
- [ ] Stop growing when parity plateaus or reaches the 27B's spread.

### M4 — Keep the harness healthy
- [ ] Ensure the executor routes reliably and commits NET-POSITIVE work.
- [ ] If the harness's executor (500MB 4B) breaks builds, keep the gate
      rejecting it and let the loop retry; do not disable the gate.
- [ ] Relaunch the harness (`SKIP_IMAGE_REBUILD=1 node
      server/scripts/run-upgrade-agent.mjs`) and let it run; check the log
      periodically for NET-POSITIVE.

### M5 — Documentation / state
- [ ] Keep `roadmap.md` and this checklist current with live results.
- [ ] Update `docs/self-training.md` so it no longer contradicts the mission
      (it still describes the old 4B-fleet plan).

---

## BENEFICIAL (should improve outcomes / speed / robustness)

### B1 — Reduce empty-responses / executor quality
- [ ] Empirically confirm the 500MB 4B's `--reasoning off` server stays up and
      returns content on real agent turns across iterations.
- [ ] If parity stays low, consider a slightly larger-but-still-ternary
      executor (e.g. the heretic-ja Q1_0 27B, ~4.7GB) as an alternative that
      follows instructions — but only if it fits VRAM (~4.9GB free).

### B2 — Hardening the compare metric
- [ ] Add a **KV-cache proximity** measure (beyond logits/top-k) if the fork
      exposes KV; log as a secondary signal.
- [ ] Add an `--agree` corpus of more held-out prompts so parity is less noisy.
- [ ] Make `compare-topk.mjs` accept prompt files and per-model token counts so
      "expanded tokens" can be compared fairly at different output lengths.

### B3 — Grow correctness
- [ ] Confirm the direct-token fork's `llama-finetune` is the ternary
      autoencoder (`tcomp`) path, not plain LoRA, and document the exact
      `--grow` flags that keep ternary output.
- [ ] Add a `--check-ternary` mode that loads the grown GGUF and asserts every
      weight is in `{-1,0,+1}`.

### B4 — Machine safety
- [ ] Keep the 6 GiB RAM cap (`scripts/train-6gb.sh`) intact; never run a grow
      without it.
- [ ] Watch VRAM: 27B + 4B are resident; a grow spikes memory. Prefer running
      grow when serving is idle (the harness loop already gap-sleeps).

### B5 — Output/attributability
- [ ] Ensure grown `.gguf` and `output/` stay gitignored (they are); commit
      only scripts and docs.
- [ ] Log every grow iteration's parity into a committed-able ledger so the
      owner can read progress on return.

---

## STOP / status marker

Set this when pausing:
```
LAST_ACTION (date):
LAST_PARITY_STATE:
HARNESS_RUNNING (pid):
```

---

## How to resume autonomously

1. Read this checklist → do the highest open `M` item first.
2. After each meaningful step, update the checklist (`[x]`) and commit scripts
   / docs that are meant to be kept.
3. Keep the harness running and the workspace clean (commit NET-POSITIVE,
   revert build-breaks).
4. Do not run OS/package-manager updaters, do not bump deps, do not touch
   `/nzk/models` originals, do not disable the build gate.
