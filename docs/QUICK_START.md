# Josi CE quick start

This installs the Community Preview from published images. It does not clone
the repository or build anything locally.

## Before you start

- A 64-bit Linux host (`amd64` or `arm64`)
- Docker Engine and Docker Compose v2
- At least 5 GB free disk and 2 GB RAM
- Optional: a DNS name pointing at the host, with ports 80 and 443 open

## Install

Create a dedicated directory and run the temporary installer:

```bash
mkdir -p ~/josi-ce && cd ~/josi-ce
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:0.1.1
```

The installer writes the release files, generates owner-only secrets, starts
the stack, and exits. It does not leave a Docker-socket controller running.

The same image is also published on GHCR as
`ghcr.io/vaxman14/josi-ce-installer:0.1.1`.

For Docker Desktop on macOS, replace the socket source with
`$HOME/.docker/run/docker.sock`. macOS is suitable for evaluation, not a
supported production server.

## Open Josi

The default local address is <http://localhost>. For public HTTPS, edit `.env`:

```dotenv
JOSI_DOMAIN=josi.example.com
JOSI_APP_URL=https://josi.example.com
```

Then apply it:

```bash
docker compose up -d
docker compose ps
curl -fsS "${JOSI_APP_URL:-http://localhost}/health"
```

The first person through setup becomes the super admin. Back up
`secrets/master.key` somewhere outside this server immediately; a database
backup cannot restore encrypted credentials without it.

## Useful commands

```bash
docker compose ps
docker compose logs -f web
docker compose restart web
docker compose down
```

`docker compose down` keeps data. `docker compose down -v` destroys it.

For DNS, reverse proxies, LAN-only use, optional OCR/ClamAV, backups, restores,
and troubleshooting, read [INSTALLATION.md](INSTALLATION.md).
