# runner-arch.dockerfile — minimal Arch sandbox each agent runs in.
#
# Compared to the Debian runner (runner.dockerfile), this one is a minimal
# rolling Arch base with:
#   - a dedicated non-root user AND a dedicated $HOME (npm/pip/git caches live
#     per-agent and persist, so builds don't fail on permission/cache errors),
#   - the Pithagoras repo baked into the image at /repo, so every container is
#     "an image of the repo as is" (the agent always has the codebase it works
#     on, independent of host mounts).
#
# Build (from repo root, so the repo source is copied in):
#   docker build -f docker/runner-arch.dockerfile -t pithagoras-runner-arch:latest .
#
# The portal/bash-sandbox launches throwaway containers from this image with
# only the session workspace mounted at /workspace (and its own HOME dir for
# caches). Set PI_IMAGE=pithagoras-runner-arch:latest to use it.

FROM archlinux:latest

# Minimal tools the agent needs: git/openssh for repos, curl/wget for install
# scripts, ca-certificates for HTTPS. nodejs+npm for pi and repo builds.
# --noprogressbar keeps the build log small; -q silences pacman's notice.
RUN pacman -Syuq --noconfirm --noprogressbar \
 && pacman -Sq --noconfirm --noprogressbar \
      nodejs npm git openssh ca-certificates curl wget \
 && rm -rf /var/cache/pacman/pkg/* /var/lib/pacman/sync/*

# Dedicated non-root user with a real home. npm/pip/git write their caches
# here; a per-session HOME can be mounted in at runtime so caches persist per
# agent instead of colliding or hitting permission errors.
RUN useradd --create-home --shell /bin/bash runner
ENV HOME=/home/runner

# The repo, baked in "as is": a snapshot of the Pithagoras sources at build
# time. Every container from this image carries the codebase it is asked to
# work on.
COPY . /repo
WORKDIR /repo
RUN chown -R runner:runner /repo

# pi itself. Pinned major so a rebuild does not silently change the agent.
RUN npm install -g @earendil-works/pi-coding-agent@0.82.1

USER runner
# The bash sandbox runs `bash -lc <cmd>`; the executor runs `pi`. Keep pi on
# PATH and default to it so both entry styles work.
ENTRYPOINT ["pi"]
