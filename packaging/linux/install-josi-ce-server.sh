#!/bin/sh
# One-command headless installer for Josi CE Server on x86_64 Linux.
# Run from a normal login account; this script requests sudo once and leaves the
# final private browser setup URL in the terminal.
set -eu

VERSION=0.1.78-linux.19
BASE_URL=https://github.com/vaxman14/josi-ce/releases/download/v0.1.78-linux.19

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
  package=josi-ce-server-setup-0.1.78_linux.19-1-x86_64.pkg.tar.zst
  expected=dafa13226317d1a5e9a5eacd730c551aa3d5a1ab45d468d856eb8a5e9a7608a8
  install_package() { sudo pacman -U --noconfirm -- "$work/$package"; }
elif command -v apt-get >/dev/null 2>&1; then
  package=josi-ce-server-setup_0.1.78-linux.19_amd64.deb
  expected=2c34b1b20fadaf11ac0a5d30d921685b1e004f5adc090f1e7567763a340276fb
  install_package() {
    sudo apt-get update -qq
    sudo apt-get install -y "$work/$package"
  }
elif command -v dnf >/dev/null 2>&1; then
  package=josi-ce-server-setup-0.1.78-linux.19.x86_64.rpm
  expected=13866bae833f562452ae8c78f8d09274559f4b98a2828810dcb391c7be6c855b
  install_package() { sudo dnf install -y "$work/$package"; }
elif command -v yum >/dev/null 2>&1; then
  package=josi-ce-server-setup-0.1.78-linux.19.x86_64.rpm
  expected=13866bae833f562452ae8c78f8d09274559f4b98a2828810dcb391c7be6c855b
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
