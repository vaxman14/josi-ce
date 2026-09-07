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
#     -e JOSI_APP_URL=http://localhost \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "$PWD:$PWD" -w "$PWD" \
#     ghcr.io/vaxman14/josi-ce-installer:0.1.2
#
# Docker Desktop for Mac exposes its socket at ~/.docker/run/docker.sock. Mount
# that source to the same /var/run/docker.sock destination shown above.
set -euo pipefail

readonly ASSETS=/opt/josi-ce-release
readonly VERSION="${JOSI_VERSION:-0.1.0}"
readonly INSTALL_UID="$(stat -c '%u' "$PWD")"
readonly INSTALL_GID="$(stat -c '%g' "$PWD")"
readonly LOG_FILE="$PWD/.josi-installer.log"
VERBOSE=0
[[ "${1:-}" == "--verbose" || "${JOSI_VERBOSE:-0}" == "1" ]] && VERBOSE=1

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
step() { printf '✓ %s\n' "$*"; }

run_logged() {
  if [[ "$VERBOSE" -eq 1 ]]; then
    "$@" 2>&1 | tee -a "$LOG_FILE"
  elif ! "$@" >>"$LOG_FILE" 2>&1; then
    printf 'error: installation failed while: %s\n' "$CURRENT_STEP" >&2
    printf 'Details: %s\n' "$LOG_FILE" >&2
    exit 1
  fi
}

set_env_value() {
  local key="$1" value="$2" tmp=".env.tmp.$$"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$key must be a single line"
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    $0 ~ ("^" key "=") { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$tmp"
  mv "$tmp" .env
}

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

: > "$LOG_FILE"
chmod 0600 "$LOG_FILE"
chown "$INSTALL_UID:$INSTALL_GID" "$LOG_FILE"
say "Installing Josi CE ${VERSION}..."

install_asset() {
  local source="$1" target="$2" mode="$3" policy="${4:-replace}"
  if [[ -e "$target" && "$policy" == preserve ]]; then
    if [[ "$VERBOSE" -eq 1 ]]; then say "leaving operator-managed $target unchanged"; fi
    return 0
  fi
  if [[ -e "$target" ]] && ! cmp -s "$source" "$target"; then
    cp -p "$target" "${target}.pre-${VERSION}"
    chown "$INSTALL_UID:$INSTALL_GID" "${target}.pre-${VERSION}"
    if [[ "$VERBOSE" -eq 1 ]]; then say "backed up previous $target to ${target}.pre-${VERSION}"; fi
  fi
  cp "$source" "$target"
  chmod "$mode" "$target"
  chown "$INSTALL_UID:$INSTALL_GID" "$target"
  if [[ "$VERBOSE" -eq 1 ]]; then say "installed $target"; fi
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
  if [[ "$VERBOSE" -eq 1 ]]; then say "created .env pinned to JOSI_TAG=${VERSION}"; fi
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
  if [[ "$VERBOSE" -eq 1 ]]; then say "updated existing .env to JOSI_TAG=${VERSION} (backup: .env.pre-${VERSION})"; fi
fi

if [[ -n "${JOSI_APP_URL:-}" ]]; then
  [[ "$JOSI_APP_URL" == http://* || "$JOSI_APP_URL" == https://* ]] || fail 'JOSI_APP_URL must begin with http:// or https://'
  set_env_value JOSI_APP_URL "$JOSI_APP_URL"
fi
if [[ -n "${JOSI_DOMAIN:-}" ]]; then
  [[ "$JOSI_DOMAIN" != *://* && "$JOSI_DOMAIN" != */* ]] || fail 'JOSI_DOMAIN must be a hostname without a scheme or path'
  set_env_value JOSI_DOMAIN "$JOSI_DOMAIN"
fi
chmod 0600 .env
chown "$INSTALL_UID:$INSTALL_GID" .env
step 'Configuration created'

CURRENT_STEP='generating security keys'
run_logged env JOSI_COMPOSE_SECRETS=1 bash ./install.sh
chown -R "$INSTALL_UID:$INSTALL_GID" secrets
step 'Security keys generated'

if [[ "${JOSI_PREPARE_ONLY:-0}" == "1" ]]; then
  say ''
  say 'Josi CE release files and secrets are ready.'
  say 'JOSI_PREPARE_ONLY=1 was set, so no services were started.'
  say 'Import docker-compose.yml into your platform UI, using this directory as the stack path.'
  exit 0
fi

CURRENT_STEP='downloading services'
run_logged docker compose -f "$PWD/docker-compose.yml" --project-directory "$PWD" \
  --project-name josi-ce pull --quiet
step 'Services downloaded'
CURRENT_STEP='initializing Josi CE'
run_logged docker compose -f "$PWD/docker-compose.yml" --project-directory "$PWD" \
  --project-name josi-ce up -d --wait --wait-timeout 300 --quiet-pull
step 'Database initialized'

EFFECTIVE_APP_URL="$(awk -F= '$1 == "JOSI_APP_URL" { sub(/^[^=]*=/, ""); print; exit }' .env)"
say ''
say '✓ Josi CE is ready'
say "Open: ${EFFECTIVE_APP_URL:-http://localhost}"
say ''
say 'Important: back up secrets/master.key somewhere off this host.'
say "Detailed log: $LOG_FILE"
# The installer container has exited once this entrypoint returns; only the
# unprivileged application stack remains running.
