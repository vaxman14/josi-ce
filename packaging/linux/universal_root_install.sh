#!/bin/sh
set -eu
umask 077

family=${1-}
package=${2-}
uid=${3-}
expected=${4-}

case "$uid" in ''|*[!0-9]*) echo 'Invalid interactive user' >&2; exit 2;; esac
[ "$uid" -ge 1000 ] || { echo 'A normal desktop user is required' >&2; exit 2; }
[ -f "$package" ] && [ ! -L "$package" ] || { echo 'Installer package is not a regular file' >&2; exit 2; }
case "$expected" in *[!0-9a-f]*|'') echo 'Invalid package checksum' >&2; exit 2;; esac
[ "${#expected}" -eq 64 ] || { echo 'Invalid package checksum' >&2; exit 2; }

case "$family" in
  arch) filename=package.pkg.tar.zst ;;
  debian) filename=package.deb ;;
  rpm) filename=package.rpm ;;
  *) echo 'Unsupported package family' >&2; exit 2 ;;
esac

temporary=$(mktemp -d /var/tmp/josi-ce-installer.XXXXXX)
root_package="$temporary/$filename"
trap 'rm -f -- "$root_package"; rmdir -- "$temporary"' EXIT HUP INT TERM
cp -- "$package" "$root_package"
actual=$(sha256sum -- "$root_package" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'Package checksum changed before installation' >&2; exit 3; }

case "$family" in
  arch) pacman -U --noconfirm "$root_package" ;;
  debian) apt-get install -y "$root_package" ;;
  rpm)
    if command -v dnf >/dev/null 2>&1; then dnf install -y "$root_package"
    else yum install -y "$root_package"
    fi ;;
esac

set +e
/usr/bin/josi-ce-server-install --interactive-uid "$uid"
status=$?
set -e
exit "$status"
