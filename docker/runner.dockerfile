# pithagoras-runner — the hardened sandbox each agent runs in.
#
# Built once, then every task session launches a throwaway container from it
# (see ContainerExecutor). The container gets ONLY the session's workspace
# mounted at /workspace and its session dir at /sessions — nothing else is
# reachable, so an agent cannot touch the host or the parent repo.
#
# Hardening beyond the docker run flags (--cap-drop ALL, --security-opt
# no-new-privileges, no network except what the host grants): this image runs
# pi as a NON-ROOT user, so even a compromised agent is just an unprivileged
# uid inside an empty container, with no host mounts.

# pi requires Node >= 22.19
FROM node:22-slim

# git and openssh so pi can work with real repos; ca-certificates for HTTPS.
# curl and wget for install scripts and the /data/bin workflow. uv so the agent
# can run Python tooling (uvx for MCP servers) — static binaries, and uv fetches
# a managed interpreter into HOME on the mounted /sessions volume on first use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl wget \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/

# pi itself. Pinned major so a rebuild does not silently change the agent.
RUN npm install -g @earendil-works/pi-coding-agent@0.82.1

# A non-root user so the container is not root even before the caps are dropped.
RUN useradd --create-home --shell /bin/bash runner

# The portal hands the agent its own HOME inside the session dir; keep the
# default small and owned by the runner regardless.
ENV HOME=/home/runner

WORKDIR /workspace
USER runner

# The portal launches `pi --mode rpc ...` (ContainerExecutor args), so `pi`
# must be on PATH. A default of `pi` is what the executor already runs.
ENTRYPOINT ["pi"]
