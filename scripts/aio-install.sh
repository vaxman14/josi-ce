#!/usr/bin/env bash
# Josi CE browser-first AIO installer controller.
#
# The current directory MUST be bind-mounted at the same absolute path inside
# this container. Compose sends absolute bind paths to the host daemon; using a
# different container-only path would make ./secrets invisible to that daemon.
#
# Example (from an empty directory):
#   # Linux
#   docker run --rm \
#     -p 8080:8080 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "$PWD:$PWD" -w "$PWD" \
#     romanvaxman/josi-ce-installer:latest
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
readonly INSTALLER_IMAGE="${JOSI_INSTALLER_IMAGE:-docker.io/romanvaxman/josi-ce-installer:${VERSION}}"
readonly INSTALLER_PORT="${JOSI_INSTALLER_PORT:-8080}"

say()  { printf '%s\n' "$*"; }
detail() { [[ "${JOSI_INSTALLER_VERBOSE:-0}" == "1" ]] && say "$*" || true; }
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

say "Preparing Josi CE ${VERSION} browser setup..."

EXISTING_INSTALL=0
[[ -f .env || -d secrets ]] && EXISTING_INSTALL=1

install_asset() {
  local source="$1" target="$2" mode="$3" policy="${4:-replace}"
  if [[ -e "$target" && "$policy" == preserve ]]; then
    detail "leaving operator-managed $target unchanged"
    return 0
  fi
  if [[ -e "$target" ]] && ! cmp -s "$source" "$target"; then
    cp -p "$target" "${target}.pre-${VERSION}"
    chown "$INSTALL_UID:$INSTALL_GID" "${target}.pre-${VERSION}"
    detail "backed up previous $target to ${target}.pre-${VERSION}"
  fi
  cp "$source" "$target"
  chmod "$mode" "$target"
  chown "$INSTALL_UID:$INSTALL_GID" "$target"
  detail "installed $target"
}

install_asset "$ASSETS/docker-compose.yml" docker-compose.yml 0644
install_asset "$ASSETS/docker-compose.noproxy.yml" docker-compose.noproxy.yml 0644
install_asset "$ASSETS/Caddyfile" Caddyfile 0644 preserve
install_asset "$ASSETS/.env.example" .env.example 0644
install_asset "$ASSETS/install.sh" install.sh 0755
install_asset "$ASSETS/preflight.sh" preflight.sh 0755
install_asset "$ASSETS/josi" josi 0755
install_asset "$ASSETS/reset-password.sh" reset-password.sh 0755

if [[ ! -e .env ]]; then
  cp .env.example .env
  # The source checkout defaults to `local`; a published installation must be
  # pinned to the release that shipped this installer.
  sed -i.bak "s/^JOSI_TAG=.*/JOSI_TAG=${VERSION}/" .env
  rm -f .env.bak
  chmod 0600 .env
  chown "$INSTALL_UID:$INSTALL_GID" .env
  detail "created internal configuration pinned to JOSI_TAG=${VERSION}"
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
  detail "updated internal configuration to JOSI_TAG=${VERSION} (backup: .env.pre-${VERSION})"
fi

# The browser installer owns the user-facing recovery and network flow. The
# lower-level secret generator remains useful to operators, but its shell
# instructions must never leak into the normal one-command setup path.
JOSI_COMPOSE_SECRETS=1 bash ./install.sh >/dev/null
chown -R "$INSTALL_UID:$INSTALL_GID" secrets

if [[ "${JOSI_PREPARE_ONLY:-0}" == "1" ]]; then
  say ''
  say 'Josi CE release files and secrets are ready.'
  say 'JOSI_PREPARE_ONLY=1 was set, so no services were started.'
  say 'Import docker-compose.yml into your platform UI, using this directory as the stack path.'
  exit 0
fi

install -d -m 0700 -o "$INSTALL_UID" -g "$INSTALL_GID" installer-state
if [[ ! -f installer-state/bootstrap-token ]]; then
  umask 077
  openssl rand -hex 16 > installer-state/bootstrap-token
  chown "$INSTALL_UID:$INSTALL_GID" installer-state/bootstrap-token
fi
daemon_os="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)"
if [[ -n "${JOSI_INSTALLER_HOSTNAME:-}" ]]; then
  setup_host="$JOSI_INSTALLER_HOSTNAME"
  python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.argv[1]); assert a.version == 4 and a.is_private and not a.is_loopback and not a.is_link_local' "$setup_host" \
    || fail 'JOSI_INSTALLER_HOSTNAME must be this computer\'s private LAN IPv4 address'
elif [[ "$daemon_os" == *"Docker Desktop"* ]]; then
  # Docker Desktop's host-network route reports the hidden Linux VM gateway
  # (for example 192.168.65.3). The published port is actually on this Mac or
  # Windows computer, so localhost is the only useful browser handoff.
  setup_host=localhost
else
  setup_host="$({ docker run --rm --network host alpine:3.22 sh -c 'ip -4 route get 1.1.1.1 2>/dev/null' || true; } | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')"
  [[ -n "$setup_host" ]] || setup_host=localhost
fi

# The setup certificate remains intentionally local and self-signed, but its
# subjectAltName must still match the address printed below. Regenerate it on
# each temporary installer run because DHCP may have changed the host address.
installer_san='DNS:localhost'
[[ "$setup_host" == localhost ]] || installer_san+=",IP:${setup_host}"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -subj '/CN=Josi Local Installer' -addext "subjectAltName=${installer_san}" \
  -keyout installer-state/tls.key -out installer-state/tls.crt >/dev/null 2>&1
chown "$INSTALL_UID:$INSTALL_GID" installer-state/tls.key installer-state/tls.crt

setup_token="$(tr -d '\r\n' < installer-state/bootstrap-token)"
say ''
say "Open Josi Setup: https://${setup_host}:${INSTALLER_PORT}/#setup=${setup_token}"
say 'Keep this window open. Everything else, including domain and recovery-key setup, happens in the browser.'
say 'Your browser will warn about the temporary self-signed local certificate.'

export JOSI_INSTALL_ROOT="$PWD" JOSI_INSTALL_UID="$INSTALL_UID" JOSI_INSTALL_GID="$INSTALL_GID"
export JOSI_APP_GID="$APP_GID" JOSI_DOCKER_GID="$DOCKER_GID" JOSI_INSTALLER_IMAGE="$INSTALLER_IMAGE"
export JOSI_EXISTING_INSTALL="$EXISTING_INSTALL"
exec python3 /opt/josi-installer/controller.py
