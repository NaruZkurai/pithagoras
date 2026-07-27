# pi portal

A web front end for the [pi coding agent](https://github.com/earendil-works/pi), built to be
left alone: **give it a task, close the browser, come back later and read what it did.**

Runs are owned by the server, not by your tab. Every event pi emits is appended to a log, so
reconnecting replays exactly what you missed and then continues live.

## Quick start

```bash
cp .env.example .env      # set PORTAL_PASSWORD and your provider key
docker compose up -d --build
```

Then open `http://<host>:4100`.

## How it works

```
Browser ──SSE (replay + tail)──▶ portal ──JSONL over stdio──▶ pi --mode rpc
                                    │
                                    └─▶ SQLite: sessions + full event log
```

The browser never drives the agent. Submitting a prompt returns as soon as pi *accepts* it;
the run continues server-side. The client reconnects with the last event id it saw
(`?since=`), so nothing is lost and nothing is duplicated.

## Execution modes

| `EXECUTOR` | What it does |
|---|---|
| `host` (default) | pi runs inside the portal container, working directly on the repos mounted at `/projects`. Fast, real git, full access to those directories. |
| `container` | Each task gets its own container with only its project mounted, dropped capabilities, `no-new-privileges`, and memory/CPU/PID caps. Needs the Docker socket mount. |

pi has **no approval prompts** — by design it runs with the permissions of its process
("real isolation needs to come from the OS or a container boundary"). That is what makes
unattended runs possible, and also why `PORTAL_PASSWORD` is required and why the portal
should stay on Tailscale/LAN rather than the public internet.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORTAL_PASSWORD` | — | **Required.** Shared password for the UI. |
| `PORTAL_SECRET` | random | HMAC key for the auth cookie. Set it so logins survive restarts. |
| `PROJECTS_DIR` | `/root/repos` | Host directory holding the repos pi may work on. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_PROVIDER` / `PI_MODEL` | `openrouter` / `anthropic/claude-sonnet-5` | Passed through to pi. |
| `OPENROUTER_API_KEY` etc. | — | Provider credentials, forwarded to pi. |
| `TASK_MEMORY_MB` / `TASK_CPUS` / `TASK_PIDS_LIMIT` | `2048` / `2` / `512` | Per-task caps in `container` mode. |

## Sessions

Each task is a session with its own pi conversation, project, and status. The sidebar shows
them all with a live status dot: running, idle, error, or **interrupted** — meaning the
server restarted while that task was mid-run. Sessions are marked interrupted rather than
left spinning forever; sending another message resumes the conversation.

## Limitations

- A task does not survive a **portal restart**, only a browser disconnect. pi persists its
  own session files, so the conversation is intact and can be continued, but the in-flight
  run stops.
- Two tasks pointed at the same directory in `host` mode will edit the same working tree.
  Use `container` mode or separate checkouts if you want to run those in parallel.
