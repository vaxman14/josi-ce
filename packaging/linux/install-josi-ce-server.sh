#!/bin/sh
# One-command headless installer for Josi CE Server on x86_64 Linux.
# Run from a normal login account; this script requests sudo once and leaves the
# final private browser setup URL in the terminal.
set -eu

VERSION=0.1.78-linux.16
BASE_URL=https://github.com/vaxman14/josi-ce/releases/download/v0.1.78-linux.16

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
  package=josi-ce-server-setup-0.1.78_linux.16-1-x86_64.pkg.tar.zst
  expected=6548b09f15711d401b17a8f8e3f86997aa38d6f444c41537cc37a64d5d8312d3
  install_package() { sudo pacman -U --noconfirm -- "$work/$package"; }
elif command -v apt-get >/dev/null 2>&1; then
  package=josi-ce-server-setup_0.1.78-linux.16_amd64.deb
  expected=ef4d4d618592fe650227cf32edd2223c2cf1cfdba46adac38159a6ede6da701d
  install_package() {
    sudo apt-get update -qq
    sudo apt-get install -y "$work/$package"
  }
elif command -v dnf >/dev/null 2>&1; then
  package=josi-ce-server-setup-0.1.78-linux.16.x86_64.rpm
  expected=17e42ff467c7d4cfff1cf1b845847134f8d8fa02a169afab6b8f404f15b2277b
  install_package() { sudo dnf install -y "$work/$package"; }
elif command -v yum >/dev/null 2>&1; then
  package=josi-ce-server-setup-0.1.78-linux.16.x86_64.rpm
  expected=17e42ff467c7d4cfff1cf1b845847134f8d8fa02a169afab6b8f404f15b2277b
  install_package() { sudo yum install -y "$work/$package"; }
else
  fail 'supported package manager not found (pacman, apt-get, dnf, or yum)'
fi

printf 'Installing Josi CE Server %s. This can take several minutes.\n' "$VERSION"
sudo -v
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  --output "$work/$package" "$BASE_URL/$package"
actual=$(sha256sum "$work/$package")
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail 'downloaded package did not match this installer release'

install_package
sudo /usr/bin/josi-ce-server-install --interactive-uid "$interactive_uid"
