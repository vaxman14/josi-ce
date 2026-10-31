#!/bin/sh
# One-command installer for Josi CE Server on x86_64 Linux.
# Run from a normal login account; this script asks for sudo once and leaves the
# private browser setup address in the terminal.
#
# This file is a template: scripts/linux/build-headless-installer.py fills in
# the version, the release address and the package hashes of one built release.
set -eu

VERSION=@VERSION@
BASE_URL=@BASE_URL@

fail() {
  printf 'Josi installer: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail 'Linux is required'
[ "$(uname -m)" = x86_64 ] || fail 'this release supports x86_64 only'

interactive_uid=$(id -u)
[ "$interactive_uid" -ge 1000 ] || fail 'run this command from your normal login account, not a root shell'

for command_name in curl mktemp sha256sum sudo; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/josi-ce-server-install.XXXXXX")
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM

if command -v pacman >/dev/null 2>&1; then
  package=@ARCH_PACKAGE@
  expected=@ARCH_SHA256@
  install_package() { sudo pacman -U --noconfirm -- "$work/$package"; }
elif command -v apt-get >/dev/null 2>&1; then
  package=@DEBIAN_PACKAGE@
  expected=@DEBIAN_SHA256@
  install_package() {
    sudo apt-get update -qq
    sudo apt-get install -y "$work/$package"
  }
elif command -v dnf >/dev/null 2>&1; then
  package=@RPM_PACKAGE@
  expected=@RPM_SHA256@
  install_package() { sudo dnf install -y "$work/$package"; }
elif command -v yum >/dev/null 2>&1; then
  package=@RPM_PACKAGE@
  expected=@RPM_SHA256@
  install_package() { sudo yum install -y "$work/$package"; }
else
  fail 'supported package manager not found (pacman, apt-get, dnf, or yum)'
fi

printf 'Installing Josi CE Server %s. This can take several minutes.\n' "$VERSION"
if ! sudo -n true 2>/dev/null; then
  sudo -v
fi
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  --output "$work/$package" "$BASE_URL/$package"
actual=$(sha256sum "$work/$package")
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail 'downloaded package did not match this installer release'

install_package
sudo /usr/bin/josi-ce-server-install --interactive-uid "$interactive_uid"
