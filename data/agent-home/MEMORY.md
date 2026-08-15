# MEMORY.md — what you have learned

**This file is your long-term memory and you maintain it.** You are given it at
the start of every conversation, so anything written here you simply know.

Append to it when you learn something worth having next week: a decision and
the reason behind it, a preference you were corrected on, how something is set
up. Write what would not be obvious from the conversation you are in. Do not
record what you could look up, and do not restate what is already here.

Keep it in the sections below. Newest last.

---

## Decisions

_Choices that were made and why, so they are not argued twice._

## Preferences

- Do not spend tool calls discovering your own environment. Your workspace is
  the working directory and is already writable; you have bash plus read /
  write / edit / grep regardless. If a task needs outside data, fetch it and
  reason — do not `pwd`/`find`/`ls` your way to the answer first.
- Never leave a net-negative change. Learned the hard way (2026-08): an agent
  "improving" a project replaced the root `package.json` with a stub, pinned a
  non-existent TypeScript 7, and called it done — a regression, not an
  improvement. Rule: VERIFY before you declare success. Run the typecheck /
  lint / build for anything you touched and show the result. Do not rewrite
  manifests or bump versions you have not confirmed. Undo or fix anything that
  fails. Sweeping unverified changes are worse than no change.
- "Self-upgrade" means improving the CODE, never upgrading the machine or its
  packages. Do not run `pacman -Syu`, `apt`, `dnf`, `yum`, `brew`, `npm
  install`/`ci`/`update`, `pip install`, or any OS/package-manager updater.
  Do not bump dependency versions. My npm packages and environment are already
  correct; improve the application code, not the toolchain.

## Context

_Names, systems, how things are set up. True and not obvious._

- My workspace root is the directory I was started in (shown to me as
  `/workspace` when I run bash). Files I read/write are inside that workspace.
- The portal I run under is Pithagoras, a personal AI assistant. The user
  builds and edits it at `/nzk/git/pithagoras`.
- The user's hardware (for anything deployment / self-hosting related):
  - CPU: AMD Ryzen 5 5600G
  - GPU: RTX 3060 12 GB, about 4.4 GB of VRAM usable for extra models (aside
    from the main one).
  - This is tight: prefer small models and CPU/SSD-friendly approaches when
    integrating GPU-hungry tooling.
- Networking tools (curl / wget / the portal's tools) are available; real
  answers beat invented ones. When asked "what's trending / does X exist",
  query the live API rather than reasoning from memory.
- When writing a report into a task workspace, write it at the workspace root
  — do not nest it one level deep under a directory that repeats the workspace
  name (e.g. avoid `research-s/research-s/...`).

## Base models on 192.168.2.64 (see base-models.md in my home dir)

The box at **192.168.2.64** serves the base models, reachable by any agent over
the standard OpenAI-compatible HTTP API (`/v1/chat/completions`, no auth key).
Use these as a base model — the small ones need **no addon files**.

- **27B main** (bonsai-api.service): `192.168.2.64:6464`
  `Bonsai-27B-Q1_0.gguf`, 126k ctx. Default reasoning model.
- **4B fleet** (bonsai-4b-fleet.service): five plain `Bonsai-4B-Q1_0.gguf` on
  ports **6465-6469**, 4k ctx each. Use them as cheap parallel base-model
  subagents — fan out small tasks/drafts/routing without spending 27B context.
- **VRAM is nearly full on that server** (~11.7 GB of 12 GB used). Keep the 4B
  fleet at 4k ctx, no addon files; CPU offload is very slow and the box runs
  other models, so route to the existing fleet instead of growing resident
  models.
