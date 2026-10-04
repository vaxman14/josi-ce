# Josi CE quick start

Install and open Docker first, then paste the command for your computer.

## Mac

```bash
JOSI_HOST_IP="$(ipconfig getifaddr "$(route -n get default | awk '/interface:/{print $2;exit}')")" && \
test -n "$JOSI_HOST_IP" && \
mkdir -p "$HOME/josi-ce" && cd "$HOME/josi-ce" && \
docker run --rm -e JOSI_INSTALLER_HOSTNAME="$JOSI_HOST_IP" -p 8080:8080 \
  -v "$HOME/.docker/run/docker.sock:/var/run/docker.sock" \
  -v "$PWD:$PWD" -w "$PWD" \
  docker.io/romanvaxman/josi-ce-installer:latest
```

## Linux

```bash
JOSI_HOST_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')" && \
test -n "$JOSI_HOST_IP" && \
mkdir -p "$HOME/josi-ce" && cd "$HOME/josi-ce" && \
docker run --rm -e JOSI_INSTALLER_HOSTNAME="$JOSI_HOST_IP" -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  docker.io/romanvaxman/josi-ce-installer:latest
```

Open the one private setup link printed in Terminal and finish in the browser.
The link connects automatically. Choose the address or domain there, save the
recovery key when Josi shows it, then select **Open Josi**.

No repository clone, source build, `.env` editing, or Josi CLI is required.

See [the installation guide](INSTALLATION.md) for access choices and
troubleshooting.
