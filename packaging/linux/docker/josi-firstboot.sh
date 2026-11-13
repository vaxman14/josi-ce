#!/bin/bash
# Runs at every start of the Josi container: configures and starts Josi with
# the package's own installer command, then prints the setup address on the
# container's console (docker logs). Safe to repeat: it repairs and keeps data.
#
# Environment (docker run -e):
#   JOSI_HOST_ADDRESS  the address people use to reach this machine (default: the container's address)
#   JOSI_HOST_PORT     the port published for 8080 (default 8080)
#   JOSI_PUBLIC_URL    the https address people use when Josi is published through
#                      a tunnel or a reverse proxy that ends TLS, for example
#                      https://josi.example.com. Links, sign-in cookies and the
#                      setup link then use it, and JOSI_HOST_ADDRESS is not used.
#   JOSI_PC_CONTROL    1 (default) or 0: let Josi control the container as user josi
#   JOSI_BROWSER       1 (default) or 0: Josi's own browser on a hidden screen
set -uo pipefail
# `docker logs` shows the console, and a container has one only when it was
# started with a terminal (docker run -t, or `tty: true` in Compose). Without
# one, systemd has nowhere to print and writing to /dev/console would only make
# an ordinary file nobody reads. Everything below is in the journal either way:
#   docker exec <name> journalctl -u josi-firstboot -o cat
if [ -c /dev/console ]; then exec > >(tee /dev/console) 2>&1; fi

# systemd does not pass `docker run -e` on to its services; the container's
# first process (PID 1) still holds them.
while IFS= read -r -d '' pair; do
  case $pair in JOSI_HOST_ADDRESS=* | JOSI_HOST_PORT=* | JOSI_PUBLIC_URL=* | JOSI_PC_CONTROL=* | JOSI_BROWSER=*) export "$pair" ;; esac
done < /proc/1/environ

address=${JOSI_HOST_ADDRESS:-$(ip -4 -o addr show scope global | awk '{split($4, a, "/"); print a[1]; exit}')}
port=${JOSI_HOST_PORT:-8080}
public=${JOSI_PUBLIC_URL:-}
public=${public%/}
if [ -n "$public" ]; then
  # Behind a tunnel or proxy: Josi still listens on plain 8080 inside, and
  # treats the https name as its one address.
  args=(--address-mode proxy --public-url "$public" --port 8080)
  open=$public
else
  args=(--address-mode lan --lan-address "$address" --port 8080)
  open="http://${address}:${port}"
fi
if [ "${JOSI_PC_CONTROL:-1}" = 1 ]; then
  args+=(--pc-control-user josi)
  if [ "${JOSI_BROWSER:-1}" = 1 ]; then args+=(--browser); else args+=(--no-browser); fi
else
  args+=(--no-pc-control)
fi

echo "Josi is starting (this takes about a minute)…"
url=$(/usr/bin/josi-ce-server-install "${args[@]}" 2>/tmp/josi-firstboot.err) || {
  echo "Josi did not start:"; tail -n 20 /tmp/josi-firstboot.err; exit 1
}
# The installer prints the machine's own address; people reach it on the published one.
fragment=${url#*#}
if [ "$fragment" != "$url" ]; then
  echo "Open this to set Josi up (works once, for 10 minutes): ${open}/setup#${fragment}"
else
  echo "Josi is running. Open it at: ${open}/"
fi
