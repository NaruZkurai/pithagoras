# Local setup (host run, no Docker)

This repo (the **Pithagoras** web UI for the **pi coding agent**) is set up to
run on the host against a local model served by `llama.cpp`.

Status: **verified working** — a session was started through the UI/API, pi
launched with `local/gemma-4`, issued a real `bash` tool call, and
answered from the tool result.

## Components

| Piece | Where |
|---|---|
| Model server | `llama.cpp` (`llama-server`) → `http://127.0.0.1:8080` |
| Model | A local coding `.gguf` (set `MODEL=` in `serve-model.sh`), aliased `gemma-4` |
| Portal (pi harness web UI) | `http://localhost:4100` |
| pi provider config | `~/.pi/agent/models.json` → provider `local` → `http://127.0.0.1:8080/v1` |
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
