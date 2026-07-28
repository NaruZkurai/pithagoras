# Deploying

Pithagoras ships as a container. It expects to run somewhere private — there is
a single password and no per-user separation, so put it behind Tailscale or a
VPN rather than on a public address.

## Docker Compose

```bash
git clone https://github.com/thecodacus/Pithagoras.git
cd Pithagoras
```

Create a `.env` next to `docker-compose.yml`:

```bash
PORTAL_PASSWORD=something-long
PORTAL_SECRET=$(openssl rand -hex 32)
WORKSPACES_DIR=/root/repos
```

`PORTAL_SECRET` signs the login cookie. Leave it out and logins are invalidated
on every restart, which is exactly the annoyance you would expect.

Then:

```bash
docker compose up -d --build
```

The portal listens on `:4100`. Compose uses `network_mode: host`, so it binds
that port directly on the host — which is also what lets pi reach a llama-server
running on the same machine at `localhost`.

## Updating

```bash
git pull && docker compose up -d --build
```

Your data lives on the `portal-data` volume, not in the image. Sessions,
transcripts, installed pi packages and installed channel packages all survive a
rebuild.

## Volumes

| Path | Holds |
| --- | --- |
| `/data` | Everything stateful — see below |
| `/workspaces` | The directories pi works in, mounted from `WORKSPACES_DIR` |
| `/var/run/docker.sock` | Only needed when `EXECUTOR=container` |

Inside `/data`:

| Path | Holds |
| --- | --- |
| `/data/portal.db` | Sessions, event log, channels, settings |
| `/data/sessions/<id>` | Per-session working area |
| `/data/home` | `HOME` for pi — `~/.pi/agent`, its settings and packages |
| `/data/channels` | Installed third-party channel packages |
| `/data/agent-home` | The agent's fixed working directory |

`HOME` deliberately points at the volume. Otherwise every image rebuild would
silently wipe the pi packages you installed.

## Environment

Everything here is optional except the password.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Required. The single login password. |
| `PORTAL_SECRET` | random | Signs the session cookie. Set it to survive restarts. |
| `PORT` | `4100` | Port to listen on. |
| `EXECUTOR` | `host` | `host` or `container` — see [Architecture](/reference/architecture#executors). |
| `WORKSPACE_ROOT` | `/workspaces` | Where workspaces live inside the container. |
| `CHANNELS_DIR` | `/data/channels` | Where third-party channel packages install. |
| `AGENT_HOME` | `/data/agent-home` | The agent session's working directory. |
| `PI_PROVIDER` | — | Overrides pi's `defaultProvider`. |
| `PI_MODEL` | — | Overrides pi's `defaultModel`. |
| `PI_THINKING_LEVEL` | — | Overrides pi's `defaultThinkingLevel`. |

The three `PI_*` variables are **overrides, not defaults**. Leave them empty and
pi's own `settings.json` decides — see
[the resolution order](/guide/settings#where-a-model-comes-from). They are empty
in the compose file for exactly that reason.

Provider credentials (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, and anything
else pi understands) pass straight through to pi.

## Portainer

`docker-compose.portainer.yml` pulls a prebuilt image from GHCR instead of
building locally. Point a Portainer stack at it and set the same environment
variables.

## Running from source

Node 22.19 or newer — pi requires it.

```bash
npm install
npm run dev:server   # API on :4100
npm run dev:web      # Vite dev server, proxying to it
```

And the docs site you are reading:

```bash
npm run docs
```
