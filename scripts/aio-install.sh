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
#     ghcr.io/vaxman14/josi-ce-installer:0.1.6
#
# Docker Desktop for Mac exposes its socket at ~/.docker/run/docker.sock. Mount
# that source to the same /var/run/docker.sock destination shown above.
set -euo pipefail

readonly ASSETS=/opt/josi-ce-release
readonly VERSION="${JOSI_VERSION:-0.1.0}"
readonly INSTALL_UID="$(stat -c '%u' "$PWD")"
readonly INSTALL_GID="$(stat -c '%g' "$PWD")"
readonly APP_GID=1000
readonly DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
readonly INSTALLER_IMAGE="${JOSI_INSTALLER_IMAGE:-ghcr.io/vaxman14/josi-ce-installer:${VERSION}}"

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
  local source="$1" target="$2" mode="$3" policy="${4:-replace}"
  if [[ -e "$target" && "$policy" == preserve ]]; then
    say "leaving operator-managed $target unchanged"
    return 0
  fi
  if [[ -e "$target" ]] && ! cmp -s "$source" "$target"; then
    cp -p "$target" "${target}.pre-${VERSION}"
    chown "$INSTALL_UID:$INSTALL_GID" "${target}.pre-${VERSION}"
    say "backed up previous $target to ${target}.pre-${VERSION}"
  fi
  cp "$source" "$target"
  chmod "$mode" "$target"
  chown "$INSTALL_UID:$INSTALL_GID" "$target"
  say "installed $target"
}

install_asset "$ASSETS/docker-compose.yml" docker-compose.yml 0644
install_asset "$ASSETS/Caddyfile" Caddyfile 0644 preserve
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
  chown "$INSTALL_UID:$INSTALL_GID" .env
  say "created .env pinned to JOSI_TAG=${VERSION}"
else
  cp -p .env ".env.pre-${VERSION}"
  if grep -q '^JOSI_TAG=' .env; then
    sed -i.bak "s/^JOSI_TAG=.*/JOSI_TAG=${VERSION}/" .env
  else
    printf '\nJOSI_TAG=%s\n' "$VERSION" >> .env
  fi
  rm -f .env.bak
  chmod 0600 .env
  chown "$INSTALL_UID:$INSTALL_GID" .env ".env.pre-${VERSION}"
  say "updated existing .env to JOSI_TAG=${VERSION} (backup: .env.pre-${VERSION})"
fi

JOSI_COMPOSE_SECRETS=1 bash ./install.sh
chown -R "$INSTALL_UID:$INSTALL_GID" secrets

if [[ "${JOSI_PREPARE_ONLY:-0}" == "1" ]]; then
  say ''
  say 'Josi CE release files and secrets are ready.'
  say 'JOSI_PREPARE_ONLY=1 was set, so no services were started.'
  say 'Import docker-compose.yml into your platform UI, using this directory as the stack path.'
  exit 0
fi

# Keep Docker authority out of the Josi application. This narrow helper owns
# the optional Voice Box lifecycle and exposes only its fixed Unix-socket API.
install -d -m 0700 -o "$INSTALL_UID" -g "$INSTALL_GID" voice-helper-state
install -d -m 0750 -o "$INSTALL_UID" -g "$APP_GID" voice-helper-socket
helper_suffix="$(printf '%s' "$PWD" | openssl dgst -sha256 | awk '{print substr($2,1,12)}')"
helper_name="josi-ce-voice-helper-${helper_suffix}"
docker rm -f "$helper_name" >/dev/null 2>&1 || true
docker run -d --name "$helper_name" --restart unless-stopped \
  --read-only --network none --security-opt no-new-privileges --cap-drop ALL \
  --user "$INSTALL_UID:$INSTALL_GID" --group-add "$DOCKER_GID" --group-add "$APP_GID" \
  --tmpfs /tmp:size=16m,mode=1777 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/voice-helper-state:$PWD/voice-helper-state" \
  -v "$PWD/voice-helper-socket:$PWD/voice-helper-socket" \
  --entrypoint python3 "$INSTALLER_IMAGE" /opt/josi-voice-box/host_helper.py \
  --state "$PWD/voice-helper-state" --socket "$PWD/voice-helper-socket/helper.sock" \
  --runtime-uid "$INSTALL_UID" --runtime-gid "$INSTALL_GID" --socket-gid "$APP_GID" >/dev/null

for _ in $(seq 1 30); do
  [[ -S voice-helper-socket/helper.sock ]] && break
  sleep 1
done
[[ -S voice-helper-socket/helper.sock ]] || fail 'the Voice Box installer helper did not start'

say 'Pulling and starting the isolated Josi CE services...'
docker compose -f "$PWD/docker-compose.yml" --project-directory "$PWD" \
  --project-name josi-ce pull
docker compose -f "$PWD/docker-compose.yml" --project-directory "$PWD" \
  --project-name josi-ce up -d --wait --wait-timeout 300

say ''
say 'Josi CE is running.'
say 'Open the address configured as JOSI_APP_URL in .env.'
say 'The installer container has exited; it is not part of the running stack.'
