#!/bin/bash
# One-command installer for the Josi server on Linux:
#
#   curl -fsSL https://<install host>/linux | sudo bash
#
# It finds the distribution (pacman or apt), installs what Josi needs, checks
# the package's SHA-256 against this script, installs the package, starts
# josi.service and prints one line: the address to open in a browser. Run it
# again at any time: it repairs or updates the install and prints a fresh
# address. Everything after that happens in the browser.
#
# This file is a template: scripts/linux/build-headless-installer.py fills in
# the version, the download address and the package hashes of one release.
set -euo pipefail

VERSION=@VERSION@
BASE_URL=@BASE_URL@
# family processor file sha256, one package per line; "-" marks one not built.
PACKAGES='@PACKAGES@'

log=/var/log/josi-install.log
fail() {
  printf 'Josi installer: %s\n' "$*" >&2
  [ -s "$log" ] && printf 'Details: %s\n' "$log" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail 'Linux is required'
[ "$(id -u)" = 0 ] || fail 'run it with sudo: curl -fsSL <address>/linux | sudo bash'
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail 'systemd is required'

case "$(uname -m)" in
  x86_64|amd64) processor=x86_64 ;;
  aarch64|arm64) processor=aarch64 ;;
  *) fail "this processor ($(uname -m)) is not supported" ;;
esac

if command -v pacman >/dev/null 2>&1; then
  family=arch
elif command -v apt-get >/dev/null 2>&1; then
  family=debian
else
  fail 'this installer supports Arch (pacman) and Debian or Ubuntu (apt)'
fi

line=$(printf '%s\n' "$PACKAGES" | awk -v f="$family" -v p="$processor" '$1 == f && $2 == p { print; exit }')
package=$(printf '%s' "$line" | awk '{ print $3 }')
expected=$(printf '%s' "$line" | awk '{ print $4 }')
[ -n "$package" ] && [ "$package" != - ] || fail "no Josi $VERSION package is built for $family on $processor yet"

: > "$log"; chmod 600 "$log"
exec 3>>"$log"
step() { printf '\n== %s\n' "$*" >&3; }

step "Josi $VERSION for $family $processor"
if [ "$family" = arch ]; then
  step 'Dependencies'
  missing=$(pacman -T curl python rsync acl iproute2 || true)
  if [ -n "$missing" ]; then
    # shellcheck disable=SC2086
    pacman -Sy --needed --noconfirm $missing >&3 2>&1 || fail 'pacman could not install the dependencies'
  fi
else
  export DEBIAN_FRONTEND=noninteractive
  step 'Dependencies'
  apt-get update -q >&3 2>&1 || fail 'apt-get update failed'
  apt-get install -y -q ca-certificates curl python3 rsync acl iproute2 >&3 2>&1 || fail 'apt could not install the dependencies'
fi

work=$(mktemp -d /var/tmp/josi-install.XXXXXX)
chmod 755 "$work"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM

step "Download $BASE_URL/$package"
proto='=https'
case "$BASE_URL" in http://*) proto='=http,https' ;; esac
curl --fail --location --silent --show-error --proto "$proto" --retry 3 \
  --output "$work/$package" "$BASE_URL/$package" 2>&3 || fail "could not download $package"
actual=$(sha256sum "$work/$package"); actual=${actual%% *}
[ "$actual" = "$expected" ] || fail 'the downloaded package did not match this installer; nothing was installed'

step 'Package'
if [ "$family" = arch ]; then
  pacman -U --noconfirm "$work/$package" >&3 2>&1 || fail 'pacman could not install the Josi package'
else
  apt-get install -y -q "$work/$package" >&3 2>&1 || fail 'apt could not install the Josi package'
fi

step 'Service'
url=$(/usr/bin/josi-ce-server-install 2>&3) || fail 'Josi did not start'
printf '%s\n' "$url"
