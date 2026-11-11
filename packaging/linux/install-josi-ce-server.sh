#!/bin/sh
# One-command installer for Josi CE Server on x86_64 and arm64 Linux
# (arm64 covers the Raspberry Pi 4 and 5 with a 64-bit system).
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
case "$(uname -m)" in
  x86_64|amd64) machine=x86_64 ;;
  aarch64|arm64) machine=aarch64 ;;
  *) fail 'this release supports x86_64 and arm64 (aarch64) machines only' ;;
esac
# A Raspberry Pi can run a 64-bit kernel under a 32-bit system; the packages
# need the system itself to be 64-bit.
[ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 64 ] || fail 'a 64-bit system is required (on a Raspberry Pi, install the 64-bit Raspberry Pi OS)'

interactive_uid=$(id -u)
[ "$interactive_uid" -ge 1000 ] || fail 'run this command from your normal login account, not a root shell'

for command_name in curl mktemp sha256sum sudo; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/josi-ce-server-install.XXXXXX")
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM

if command -v pacman >/dev/null 2>&1; then
  family=arch
  install_package() { sudo pacman -U --noconfirm -- "$work/$package"; }
elif command -v apt-get >/dev/null 2>&1; then
  family=debian
  install_package() {
    sudo apt-get update -qq
    sudo apt-get install -y "$work/$package"
  }
elif command -v dnf >/dev/null 2>&1; then
  family=rpm
  install_package() { sudo dnf install -y "$work/$package"; }
elif command -v yum >/dev/null 2>&1; then
  family=rpm
  install_package() { sudo yum install -y "$work/$package"; }
else
  fail 'supported package manager not found (pacman, apt-get, dnf, or yum)'
fi

# One package per distribution family and architecture. An architecture this
# release was not built for has no name here.
case "$family-$machine" in
  arch-x86_64) package=@ARCH_X86_64_PACKAGE@; expected=@ARCH_X86_64_SHA256@ ;;
  debian-x86_64) package=@DEBIAN_X86_64_PACKAGE@; expected=@DEBIAN_X86_64_SHA256@ ;;
  rpm-x86_64) package=@RPM_X86_64_PACKAGE@; expected=@RPM_X86_64_SHA256@ ;;
  arch-aarch64) package=@ARCH_AARCH64_PACKAGE@; expected=@ARCH_AARCH64_SHA256@ ;;
  debian-aarch64) package=@DEBIAN_AARCH64_PACKAGE@; expected=@DEBIAN_AARCH64_SHA256@ ;;
  rpm-aarch64) package=@RPM_AARCH64_PACKAGE@; expected=@RPM_AARCH64_SHA256@ ;;
esac
[ -n "$package" ] || fail "Josi CE $VERSION has no package for $machine machines"

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
