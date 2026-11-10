#!/bin/bash
# Remove the Josi server from this computer.
#
#   sudo josi-uninstall           stop Josi and remove the program; keep the data
#   sudo josi-uninstall --purge   also delete /var/lib/josi, /etc/josi and Josi's accounts
#
# Without --purge, running the install command again brings Josi back with its
# accounts, chats and settings.
set -uo pipefail

purge=0
case "${1:-}" in
  '') ;;
  --purge) purge=1 ;;
  *) echo 'usage: sudo josi-uninstall [--purge]' >&2; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || { echo 'josi-uninstall: run it as root (with sudo, or from a root shell)' >&2; exit 1; }

export PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8
root=/var/lib/josi
roles='database voice voice-control web worker proxy'
children=$(for role in $roles; do printf 'josi-ce-%s.service ' "$role"; done)

systemctl disable --now josi-update.path josi-update.timer >/dev/null 2>&1
systemctl stop josi-update.service josi-update-check.service >/dev/null 2>&1
systemctl disable josi.service $children >/dev/null 2>&1

# PC control: the executor runs as a person's own account, so it goes in
# either case; the install command sets it up again when it is chosen.
systemctl disable --now josi-browser.service josi-pc.service >/dev/null 2>&1
rm -f /etc/systemd/system/josi-browser.service /etc/systemd/system/josi-pc.service
if [ -f /etc/apparmor.d/josi-chrome ]; then apparmor_parser -R /etc/apparmor.d/josi-chrome >/dev/null 2>&1 || true; rm -f /etc/apparmor.d/josi-chrome; fi
rmdir /etc/systemd/system/josi.service.wants 2>/dev/null
# Its browser native-messaging host: the wrapper and each browser's manifest.
rm -f /usr/lib/josi/josi-browser-host /etc/opt/chrome/native-messaging-hosts/com.heyjosi.browser.json \
  /etc/chromium/native-messaging-hosts/com.heyjosi.browser.json /etc/opt/edge/native-messaging-hosts/com.heyjosi.browser.json \
  /usr/lib/mozilla/native-messaging-hosts/com.heyjosi.browser.json

# The lifecycle's own uninstall stops the services and moves their unit files
# aside with a record, so the next install recognises them as Josi's.
version=$(python3 -I -c 'import json;print(json.load(open("/var/lib/josi/data/config/runtime.json"))["version"])' 2>/dev/null || true)
kept=0
if [ -n "$version" ] && [ -x "$root/versions/$version/python/bin/python3.12" ]; then
  if "$root/versions/$version/python/bin/python3.12" -I -B "$root/versions/$version/app/native/maintenance.py" uninstall >/dev/null 2>&1; then
    kept=1
  fi
fi
systemctl stop josi.service $children >/dev/null 2>&1
rm -f /etc/systemd/system/josi.service /etc/systemd/system/josi-update.path /etc/systemd/system/josi-update.service \
  /etc/systemd/system/josi-update-check.service /etc/systemd/system/josi-update.timer
if [ "$purge" = 1 ]; then
  for role in $roles; do rm -f "/etc/systemd/system/josi-ce-$role.service"; done
fi
systemctl daemon-reload
# The web unit names josi-pc too; the install command creates it again.
groupdel josi-pc >/dev/null 2>&1

if command -v pacman >/dev/null 2>&1; then
  pacman -Q josi >/dev/null 2>&1 && pacman -R --noconfirm josi >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  dpkg -s josi >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get remove -y -q josi >/dev/null
fi

if [ "$purge" = 1 ]; then
  rm -rf -- "$root" /etc/josi
  for account in josi-ce-database josi-ce-voice josi-ce-control josi-ce-web josi-ce-worker josi-ce-proxy; do
    userdel "$account" >/dev/null 2>&1
    groupdel "$account" >/dev/null 2>&1
  done
  groupdel josi-ce-app >/dev/null 2>&1
  groupdel josi-ce-voice-shared >/dev/null 2>&1
  # The executor's own state (its key); systemd made it for StateDirectory=.
  rm -rf -- /var/lib/josi-pc /var/lib/private/josi-pc
  echo 'Josi was removed, with its data.'
elif [ "$kept" = 1 ]; then
  echo 'Josi was removed. Its data is kept in /var/lib/josi; run the install command again to bring it back.'
else
  echo 'Josi was removed. Its data folder /var/lib/josi was left as it was.'
fi
