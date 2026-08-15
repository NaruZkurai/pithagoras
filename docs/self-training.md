# Self-Training the 4B Fleet — Roadmap & Architecture

Goal: Pithagoras runs a **fleet of ~1 GB 4B models** that get progressively
better at the work they actually do, by learning from the trajectories the
portal already records — without wrecking the machine that serves them.

Hardware reality (constraint that drives every choice):

- CPU: AMD Ryzen 5 5600G
- GPU: RTX 3060 12 GB, ~4.4 GB VRAM free for extra models (main model takes the
  rest on a separate server). A handful of 4B Q4 models (~1 GB each) fit
  simultaneously, but there is **no headroom to run a gradient-training job at
  the same time as serving**.

So the plan is **data-first, train-later**: collect and curate high-quality
agent trajectories now, use cheap "prompt/context/harness refinement" to improve
behavior immediately (runs on CPU, negligible cost), and only later bolt on real
gradient fine-tuning (LoRA/DPO) when the fleet is idle. This mirrors how
[prime-agent](../gitrepos/prime-agent) itself is built — the Continuous
Harness + refinement loop *is* the self-improvement mechanism; gradient training
is a separate, optional layer.

---

## Phase 0 — Track the useful upstream (done)

`prime-agent` is vendored as a git submodule (`gitrepos/prime-agent`). The files
we're learning from / using are mirrored into `vendor/prime-agent/` by
`scripts/sync-prime-agent.sh`, with our edits tracked in
`vendor/prime-agent/PATCHES.md`.

Key upstream files we lean on:

| File (vendored) | What it gives us |
| --- | --- |
| `harness.py` | Versioned memory/skill state store with mtime re-sync (multi-writer safe) |
| `refinement.ts` | LLM "refine" pass → evidence-backed memory edits + rollback |
| `autonomous.ts` | Auto-continue with quality gates + anti-loop worktree snapshot |
| `goals.ts` | Persistent goals + token budgets |
| `state-snapshot.ts` | Snapshot/restore of in-kernel Python state |
| `edit-diff.ts` | Fuzzy edit tool (normalizes quotes/dashes/spaces) |
| `file-mutation-queue.ts` | Per-file serialize edits (no interleaved corruption) |

---

## Phase 1 — Data collection (self-train *through* the loop)

The portal already stores everything: `events`, `ccvs` (callable chat
variables), and per-session pi JSONL. Phase 1 turns that into a curated dataset
and closes the feedback loop **without any gradient training**.

- **Tool-stats collector** (see `server/scripts/tool-stats.mjs`): mine the
  session DB to measure, per tool, the failure/success modes — the same idea as
  prime-agent's `edit-tool-stats.mjs`. It produces numbers we can act on:
  which tool calls fail (`file_not_found`, `not_found_exact_text`,
  `multiple_occurrences`, …), how much wrapper noise models add (`inflation`),
  which commands are re-run and fail repeatedly.
- **Trajectory dataset builder** (`server/scripts/build-dataset.mjs`): turn
  completed (successful) multi-turn runs into training-ready JSONL pairs —
  `user / assistant / toolResult` with the reasoning, tool calls, and final
  verdict. This is the raw material for LoRA later.
- **Refinement feedback**: on the *behavior* side, feed the tool-stats into the
  harness refinement so the agent's heuristics (which tool, when, what path,
  how to phrase an edit) update without a model rebuild. This is the cheap
  self-improvement that pays off immediately.

## Phase 2 — Fleet routing

- Maintain a small set of 4B models, each specialized by *task type* (research,
  code-edit, chat, tool-heavy). Route a session to the best-fit model by its
  goal — prime-agent's `findRlmModelMatches` (exact → prefix → partial) is the
  reference here.
- Each model gets its own isolated workspace/session so its trajectories and
  stats are attributable to *that* model. Per-model success metrics drive Phase
  3's tuning decisions.

> **Live status (2026-08-14):** the base-model fleet is already running on
> **192.168.2.64** — the 27B (`bonsai-api.service`, :6464, 126k) plus five plain
> 4B instances (`bonsai-4b-fleet.service`, :6465-6469, 4k each) as cheap
> base-model subagents. Any agent contacts them over OpenAI-compatible HTTP
> (no auth key) and can use either as a new base. All six are registered in the
> portal's `model_servers` table (4B fleet as `bonsai-4b-f1..f5`, `enabled=0`
> so the portal doesn't spawn them — systemd owns them on the box). The full
> registry lives in the gitignored `data/agent-home/base-models.md`, referenced
> from MEMORY.md. The server's VRAM is ~full (~11.7/12 GB), so keep the 4B
> fleet at 4k and no addon files.

## Phase 3 — Gradient fine-tuning (optional, when idle)

Only when a model has enough curated positive trajectories and the GPU is idle:

1. Build a **preference dataset** from Phase 1: (prompt, chosen trajectory,
   rejected variant) using the recorded tool stats + outcomes as the reward
   signal (fewer failing tool calls, lower inflation ratio, task completed).
2. **LoRA/DPO** fine-tune the 4B model on that dataset. The whole weight delta
   is a LoRA adapter (~tens of MB), swapped in/out at serve time — we never
   touch the base GGUF.
3. **Eval gate**: run the fine-tuned adapter against a held-out eval set +
   the live tool-stats regression before promoting it into the routing pool.

Candidate frameworks: **unsLoth** (fast, low VRAM, 3060-friendly) or
**Llama-Factory** (SFT + DPO in one tool). Both output LoRA adapters usable with
llama.cpp's `.gguf` LoRA support.

---

## The llama-direct-token-input fork

`github.com/NaruZkurai/llama-direct-token-input` is our own llama.cpp fork,
independent of mainline. The working assumption for the self-training angle:

> The fork makes models emit tokens / actions **directly** (no fragile text
> parsing), which is exactly what makes clean, attributable action traces and
> RL-style training tractable — the model's token stream IS the action log.

Integration points in Pithagoras:

- `server/src/model-server.ts` + `model_servers.runtime` (new column) — each
  model server now carries a `runtime` of `stock` (llama-server), `rs`
  (llama-rs), or `direct-token` (our fork). When `runtime='direct-token'`, set
  `bin` to the fork binary and `buildArgs` passes a `--direct-token-input`
  marker (tweak the flag name once the fork's CLI is confirmed). So a 4B can
  run under the direct-token runtime while the main Bonsai model stays stock.
  Configure via `POST /api/models/servers` with `{ runtime: "direct-token",
  bin: "/path/to/llama-server-direct-token", model: "<4b.gguf>", ... }`.
- The direct-token response surfaces as tool-call content we already record
  (`tool_execution_*` events + CCVs), so the trajectory collector needs no
  special-casing — the fork's output becomes the training data.
- Confirm the fork's exact API (request/response shape, endpoint) before wiring:
  clone it, build, and note the `/v1/chat/completions` (or custom) contract in
  this doc.

## Fork build status (2026-08-14) — working, GPU + CPU

Built successfully with CUDA on this machine (RTX 4070 Ti SUPER, sm_89, CUDA
13.3) plus the CPU backend (so one binary runs on GPU *and* CPU):

```sh
cd gitrepos/llama-direct-token-input
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF
cmake --build build --config Release --target llama-server llama-tokens llama-finetune tcomp -j "$(nproc)"
```

Artifacts in `gitrepos/llama-direct-token-input/build/bin/`: `llama-server`,
`llama-tokens` (raw token-ID input), `llama-finetune` (training), plus
`build/tools/tcomp/libtcomp.a` (ternary compression/training layer). Verified
`llama-tokens --list-devices` shows `CUDA0: RTX 4070 Ti SUPER`.

**6 GB VRAM training cap** — no `--gpu-mem` flag in this fork, so cap by layers
+ fit target. `scripts/train-6gb.sh` wraps it:

```sh
# GPU, capped at 6 GiB VRAM (fit target 6144 MiB):
./scripts/train-6gb.sh llama-finetune -m <model.gguf> --gpu <train args...>
# CPU fallback (no CUDA needed):
./scripts/train-6gb.sh llama-finetune -m <model.gguf> --cpu <train args...>
```

Environment overrides: `NGL_LIMIT` (default 999), `FIT_TARGET` MiB (default
6144), `BIN_DIR`, `MODEL_DIR` (default /nzk/models).

> Important correction: this fork's "training" is the **ternary compression
> autoencoder** (`tcomp`), NOT the LoRA/DPO route for improving 4B behavior.
> GigaToken is a ~1000x tokenizer speedup (real win). The raw direct-token input
> is a CLI feature (`llama-tokens`); the server's `tokenize_mixed` already
> accepts raw token ints over HTTP (basically standard llama.cpp). So the
> `runtime="direct-token"` seam in `model-server.ts` currently toggles nothing
> unique server-side yet — schedule a raw-token input endpoint if we want it.

## Priority order (recommended execution)

1. Tool-stats collector + a first pass over existing sessions (cheap, no
   training, immediately useful).  ← **done**
2. Trajectory dataset builder (ready for LoRA later).
3. Fleet routing across a few 4B models.
4. Fork-binary integration into `model-server.ts`.  ← **build done; wiring next**
5. LoRA/DPO / tcomp when a model has enough data + idle GPU.
