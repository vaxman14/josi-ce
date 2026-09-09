#!/usr/bin/env bash
# Josi CE one-shot AIO installer.
#
# The current directory MUST be bind-mounted at the same absolute path inside
# this container. Compose sends absolute bind paths to the host daemon; using a
# different container-only path would make ./secrets invisible to that daemon.
#
# Example (from an empty directory):
#   # Linux
#   docker run --rm \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "$PWD:$PWD" -w "$PWD" \
#     ghcr.io/vaxman14/josi-ce-installer:0.1.5
#
# Docker Desktop for Mac exposes its socket at ~/.docker/run/docker.sock. Mount
# that source to the same /var/run/docker.sock destination shown above.
set -euo pipefail

readonly ASSETS=/opt/josi-ce-release
readonly VERSION="${JOSI_VERSION:-0.1.0}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail 'the installer must run as its image default user'
[[ "$PWD" == /* && "$PWD" != / ]] || fail 'run from an absolute, dedicated installation directory'
[[ -S /var/run/docker.sock ]] || fail 'mount the Docker socket at /var/run/docker.sock'
docker info >/dev/null 2>&1 || fail 'the Docker engine is not reachable through the mounted socket'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'

# Refuse a subtly broken mount. The same absolute path must exist on the host,
# which the documented -v "$PWD:$PWD" invocation guarantees. A disposable
# probe asks the host daemon to bind that path and proves it can see this exact
# directory before any installation data is written.
probe=".josi-aio-path-probe-$$"
printf 'josi-aio-path-ok\n' > "$probe"
if ! docker run --rm -v "$PWD:/josi-install:ro" alpine:3.22 \
  test -f "/josi-install/$probe" >/dev/null 2>&1; then
  rm -f "$probe"
  fail 'the working directory is not mounted at the same absolute host path; use -v "$PWD:$PWD" -w "$PWD"'
fi
rm -f "$probe"

say "Josi CE ${VERSION} — one-shot installer"
say "The Docker socket is used only by this temporary installer container."

install_asset() {
  local source="$1" target="$2" mode="$3"
  if [[ -e "$target" ]]; then
    say "leaving existing $target unchanged"
    return 0
  fi
  cp "$source" "$target"
  chmod "$mode" "$target"
  say "installed $target"
}

install_asset "$ASSETS/docker-compose.yml" docker-compose.yml 0644
install_asset "$ASSETS/Caddyfile" Caddyfile 0644
install_asset "$ASSETS/.env.example" .env.example 0644
install_asset "$ASSETS/install.sh" install.sh 0755
install_asset "$ASSETS/preflight.sh" preflight.sh 0755

if [[ ! -e .env ]]; then
  cp .env.example .env
  # The source checkout defaults to `local`; a published installation must be
  # pinned to the release that shipped this installer.
  sed -i.bak "s/^JOSI_TAG=.*/JOSI_TAG=${VERSION}/" .env
  rm -f .env.bak
  chmod 0600 .env
  say "created .env pinned to JOSI_TAG=${VERSION}"
else
  say 'leaving existing .env unchanged'
fi

bash ./install.sh

if [[ "${JOSI_PREPARE_ONLY:-0}" == "1" ]]; then
  say ''
  say 'Josi CE release files and secrets are ready.'
  say 'JOSI_PREPARE_ONLY=1 was set, so no services were started.'
  say 'Import docker-compose.yml into your platform UI, using this directory as the stack path.'
  exit 0
fi

say 'Pulling and starting the isolated Josi CE services...'
docker compose -f "$PWD/docker-compose.yml" --project-directory "$PWD" \
  --project-name josi-ce pull
docker compose -f "$PWD/docker-compose.yml" --project-directory "$PWD" \
  --project-name josi-ce up -d --wait --wait-timeout 300

say ''
say 'Josi CE is running.'
say 'Open the address configured as JOSI_APP_URL in .env.'
say 'The installer container has exited; it is not part of the running stack.'
