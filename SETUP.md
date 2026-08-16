# Local setup (host run, no Docker)

This repo (the **Pithagoras** web UI for the **pi coding agent**) is set up to
run on the host against a local model served by `llama.cpp`.

Status: **verified working** — a session was started through the UI/API, pi
launched with `local/gemma-4`, issued a real `bash` tool call, and
answered from the tool result.

## Components

| Piece | Where |
|---|---|
| Model server | `llama.cpp` (`llama-server`) → `http://127.0.0.1:41001` |
| Model | A local coding `.gguf` (set `MODEL=` in `serve-model.sh`), aliased `gemma-4` |
| Portal (pi harness web UI) | `http://localhost:4100` |
| pi provider config | `~/.pi/agent/models.json` → provider `local` → `http://127.0.0.1:41001/v1` |
| Portal env | `.env` (`PI_PROVIDER=local`, `PI_MODEL=gemma-4`) |
| Runtime data | `./data/` (sessions, db, workspaces, agent home, channels) — gitignored |

## Start

```bash
# 1. Model server (GPU via Vulkan, KV cache on CPU)
./scripts/serve-model.sh

# 2. Portal (sources .env; needs PORTAL_PASSWORD)
./scripts/run-portal.sh
```

Open http://localhost:4100 and log in with `PORTAL_PASSWORD` (currently
`change-me` — change it in `.env`).

## Install / rebuild (for reference)

```bash
npm install            # approve install-scripts for better-sqlite3/esbuild/protobufjs
npm run build          # tsc (server) + vite (web)
```

`better-sqlite3` was bumped from `^11.7.0` to `^13.0.2` because 11.x does not
compile on the installed Node 26 (its V8 API calls were removed). Node >= 22.19
is required (pi's minimum).

## About the "sonic-coder" model file

`sonic-coder_Qwen3.6-35B-A3B-DFlash.safetensors` (737 MB) is **not** a standalone
language model. It is the `DFlashDraftModel` — a block-diffusion
speculative-decoding **draft** model for `Qwen/Qwen3.6-35B-A3B`
(385 M params, custom `DFlashDraftModel` architecture, no tokenizer of its own).
Its HuggingFace card says so explicitly, and llama.cpp cannot load the
architecture. It only runs in SGLang paired with the full 35B target model on a
Blackwell-class GPU. It cannot power pi.

The actual Rust-coding model downloaded at the same time was a GGUF, and that is
what this setup serves instead — point `serve-model.sh`'s `MODEL=` at any `.gguf`.

## ⚠️ Use a CLEAN llama.cpp build, not the turboquant build

A `llama-server` built from the **turboquant/caveman** fork is the kind to
avoid. It injects a "CAVEMAN DIRECTIVE" system prompt + logit biases on every
request, which **breaks OpenAI function/tool calling** (verified: the model never
emits `tool_calls`, even forced; `tool_choice` also expects a string there).
pi needs tool calling to function.

Use a **clean, stock llama.cpp build** (>= build 9973, no caveman strings). It
does tool calling correctly. On a GPU shared with a desktop session, offload the
weights to the GPU (`-ngl 99`) and keep the KV cache on CPU (`--no-kv-offload`)
so a large model fits in VRAM.

Measured with a 12B IQ4_XS model: ~21 tok/s generation, 2 slots × 32K context.

## Swapping the model

- Put a `.gguf` somewhere and point `MODEL=` in `scripts/serve-model.sh` at it.
- Adjust `ALIAS=` to the model id you want, and set the same id in
  `~/.pi/agent/models.json` and `.env` (`PI_PROVIDER` / `PI_MODEL`).
- Restart the model server and the portal (sessions keep their own model choice
  once set; new sessions use the portal defaults).

## Notes / limitations

- The portal and model server run as foreground processes; run them in a
  terminal or wrap in a systemd user unit (`scripts/*.sh` are written to be
  directly usable as `ExecStart`).
- `PORTAL_PASSWORD=change-me` is a placeholder — set a real one.
- Workspaces live in `./data/workspaces`; sessions store pi's own
  `*.jsonl` conversation files under `./data/sessions`.

## Live 30B-from-27B-MoE training stack (active work)

This repo is also the home of the MoE **teacher-live** self-training harness,
which grows the 27B MoE teacher into a 30B native-ternary student. When that
work is running, the model ports above are serving the training pair, not the
portal's coding model. Current wiring (see `config/moe-config.json`):

| Role | Server | Model | Port | Notes |
|---|---|---|---|---|
| Teacher | `gitrepos/llama-direct-token-input/build/bin/llama-server` | `Bonsai-27B-Q1_0.gguf` | 41001 | `-ngl 99` GPU, `-c 126000`, n_vocab 248320 |
| Student | same fork bin | TQ1_0 `bonsai-30b-tq1.gguf` (native ternary, no MTP) or `...-mtp.gguf` | 6466 | `-ngl 0` CPU (TQ1_0 has no CUDA kernel) |
| Harness UI | `node scripts/teacher-live.mjs` | — | 4199 | live JSON/SSE state |
| Portal | `server/dist/index.js` | — | 4100 | web UI |

**Launch the training stack:**

```bash
# 1. Teacher 27B (direct-token fork so /tokenize + raw-id completions work)
gitrepos/llama-direct-token-input/build/bin/llama-server \
  -m /nzk/models/Bonsai-27B-Q1_0.gguf -c 126000 -ngl 99 -t 4 \
  --parallel 1 --no-kv-offload --alias bonsai-27b --host 127.0.0.1 --port 41001

# 2. Student 30B TQ1_0 (built by scripts/rebuild_tq1_gguf.py + add_mtp_header.py)
gitrepos/llama-direct-token-input/build/bin/llama-server \
  -m /dev/shm/pithagoras-moe-checkpoints/model-30b/bonsai-30b-tq1.gguf \
  --alias bonsai-30b-tq1 -c 16384 -ngl 0 -t 8 --parallel 1 --no-kv-offload --port 6466

# 3. Harness (live UI on :4199)
STUDENT_URL=http://127.0.0.1:6466 STUDENT_N_VOCAB=248320 \
  node scripts/teacher-live.mjs      # UI at http://127.0.0.1:4199/
```

**Post-reboot restore** (`/dev/shm` is tmpfs and is wiped on reboot):

```bash
python3 scripts/prepare-model-ram.py     # re-export per-layer/expert .tern RAM segments
# then re-launch the three processes above; teacher log → /tmp/teacher-27b.log
```

Key invariants recorded in the harness:

- The direct-token fork **redefines Q1_0 to 128 weights/block (18 bytes/block)**;
  TQ1_0 (GGML type 34) is true base-3 ternary, 54 bytes/256-block. Use
  `scripts/tq1_codec.py` / `scripts/rebuild_tq1_gguf.py`, never the older
  flat-block Q1_0 path (it scrambles SSM tensors).
- `STUDENT_N_VOCAB` must equal `248320` so teacher+student share the token space;
  the student on :6465 (4B, 151669) is legacy and wrong for the 30B goal.
- Checkpoints write to `/dev/shm/pithagoras-moe-checkpoints` (RAM disk) via
  `model.save_dir` in `moe-config.json`; per-expert diffs, not full weights.
