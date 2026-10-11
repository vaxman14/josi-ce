#!/bin/sh
# One-command native Linux server installer. An optional first argument overrides
# the release base URL for physical acceptance without publishing the candidate.
set -eu

VERSION=0.1.78-linux.11
DEFAULT_BASE="https://github.com/vaxman14/josi-ce/releases/download/v${VERSION}"
BASE_URL=${1:-$DEFAULT_BASE}

fail() {
  printf 'Josi installer: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail 'Linux is required'
[ "$(uname -m)" = x86_64 ] || fail 'this acceptance build supports x86_64 only'
for command_name in curl awk mktemp sha256sum tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

interactive_uid=$(id -u)
[ "$interactive_uid" -ge 1000 ] || fail 'run this command from your normal user account, not a root shell'

if [ "$(id -u)" -eq 0 ]; then
  elevate=
else
  command -v sudo >/dev/null 2>&1 || fail 'sudo is required'
  elevate=sudo
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/josi-server-install.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM

if command -v pacman >/dev/null 2>&1; then
  package_version=$(printf '%s' "$VERSION" | tr '-' '_')
  package="josi-ce-server-setup-${package_version}-1-x86_64.pkg.tar.zst"
  install_package() { $elevate pacman -U --noconfirm "$work/$package"; }
elif command -v apt-get >/dev/null 2>&1; then
  package="josi-ce-server-setup_${VERSION}_amd64.deb"
  install_package() { $elevate apt-get install -y "$work/$package"; }
elif command -v dnf >/dev/null 2>&1; then
  package="josi-ce-server-setup-${VERSION}.x86_64.rpm"
  install_package() { $elevate dnf install -y "$work/$package"; }
else
  fail 'supported package manager not found (pacman, apt-get, or dnf)'
fi

printf 'Downloading Josi CE Server %s...\n' "$VERSION"
curl -fL --proto '=https,http' --tlsv1.2 -o "$work/SHA256SUMS.txt" "$BASE_URL/SHA256SUMS.txt"
curl -fL --proto '=https,http' --tlsv1.2 -o "$work/$package" "$BASE_URL/$package"
expected=$(awk -v name="$package" 'NF==2 && $2==name && length($1)==64 && $1 !~ /[^0-9a-f]/ {n++; hash=$1} END {if(n==1) print hash}' "$work/SHA256SUMS.txt")
[ -n "$expected" ] || fail 'checksum manifest does not contain exactly one package digest'
actual=$(sha256sum "$work/$package" | awk '{print $1}')
[ "$actual" = "$expected" ] || fail 'package checksum mismatch; nothing was installed'

install_package
$elevate /usr/bin/josi-ce-server-install --interactive-uid "$interactive_uid"
