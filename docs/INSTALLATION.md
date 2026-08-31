# Josi CE installation and operations manual

This manual describes how to install the Josi CE Community Preview from this
repository. It is intentionally explicit. Commands are written for a Linux
server unless a section says otherwise.

> **Release warning**
>
> Josi CE 0.1 is still under construction. Phase 9 is incomplete and Phases
> 10 through 12 are not implemented at the time this paragraph was written.
> In particular, the product does not yet provide its promised backup,
> restore, update, rollback, diagnostics, or identity/memory workflows. Do not
> treat this preview as production-ready merely because the containers start.

## 1. What the standard installation creates

The default Compose deployment creates five service roles:

| Service | Purpose | Host exposure |
|---|---|---|
| `db` | PostgreSQL 16 database | None |
| `migrate` | Applies database migrations, then exits | None |
| `web` | API and browser application | Through Caddy only |
| `worker` | Background jobs | None |
| `caddy` | HTTP/HTTPS reverse proxy and certificate renewal | Ports 80 and 443 |

Two optional services are disabled unless explicitly selected:

| Service | Compose profile | Purpose |
|---|---|---|
| `ocr` | `ocr` | Optical character recognition |
| `clamav` | `clamav` | Malware scanning |

The database is attached only to the private `data` network. Caddy is attached
only to the `edge` network. The worker is not reachable through the proxy.

## 2. Supported deployment shapes

Choose one deployment shape before changing configuration.

### 2.1 Public HTTPS with bundled Caddy

Use this for the usual single-server installation. You need a public DNS name,
inbound TCP ports 80 and 443, and no other process already using those ports.
Caddy obtains and renews the TLS certificate.

### 2.2 Existing reverse proxy

Use this when nginx, Traefik, HAProxy, a load balancer, or another Caddy instance
already terminates HTTPS. Josi publishes its web service on a configurable host
port. Your proxy forwards HTTPS traffic to that port.

### 2.3 Local HTTP evaluation

Use this only on a trusted machine or trusted LAN for evaluation. Secure
cookies must be disabled for plain HTTP. Never expose this mode to the public
Internet.

## 3. Host requirements

### 3.1 Operating system and architecture

Use a 64-bit Linux host supported by Docker Engine. The application image is
intended for `linux/amd64` and `linux/arm64`.

Do not use a 32-bit operating system. Raspberry Pi installations require a
64-bit OS. Josi does not publish capacity claims yet; workload, connector use,
and local inference change resource requirements substantially.

### 3.2 Required software

Install:

- Git
- Docker Engine
- Docker Compose v2, invoked as `docker compose`
- OpenSSL, or a readable `/dev/urandom`
- `curl` for host-side verification

Confirm each dependency:

```bash
git --version
docker version
docker compose version
openssl version
curl --version
```

`docker-compose` with a hyphen is the retired Compose v1 client. This manual
uses Compose v2.

### 3.3 Docker access

Run Docker as root, or configure the installation account to access the Docker
daemon. Membership in the `docker` group is effectively root-level access to
the host. Treat it accordingly.

Verify access:

```bash
docker run --rm hello-world
```

### 3.4 Network requirements

For bundled Caddy:

- Create an `A` record pointing the chosen hostname to the server's public IPv4
  address.
- Create an `AAAA` record only if IPv6 actually reaches the server.
- Forward TCP 80 and 443 through the router or firewall.
- Permit outbound DNS and HTTPS so Caddy can reach the ACME certificate
  authority and Josi can reach configured providers.

Check DNS from a machine outside the server's LAN:

```bash
dig +short A josi.example.com
dig +short AAAA josi.example.com
```

Replace `josi.example.com` everywhere in this manual with the real hostname.

If an incorrect `AAAA` record exists, some clients and certificate validation
requests may use broken IPv6 even while IPv4 works. Remove the record or fix
IPv6 routing.

## 4. Obtain the source

Choose a permanent directory. Do not run a long-lived installation from a
Downloads folder.

```bash
sudo mkdir -p /opt/josi-ce
sudo chown "$(id -u):$(id -g)" /opt/josi-ce
git clone <REPOSITORY-URL> /opt/josi-ce
cd /opt/josi-ce
```

Until the repository is public, replace `<REPOSITORY-URL>` with the private
clone URL available to the operator. Do not put access tokens directly in the
command or shell history.

Confirm the checkout and inspect its state:

```bash
git remote -v
git status --short --branch
git log -1 --oneline
```

For a release, check out its signed or documented release tag instead of an
arbitrary moving branch:

```bash
git fetch --tags
git checkout <RELEASE-TAG>
```

## 5. Read the configuration before starting

The repository includes these deployment files:

- `docker-compose.yml`: default stack and optional profiles
- `docker-compose.noproxy.yml`: publishes the web service for an existing proxy
- `Caddyfile`: bundled reverse proxy configuration
- `.env.example`: non-secret operator settings
- `scripts/install.sh`: generates the master key and database password

Validate the Compose model before creating anything:

```bash
docker compose config --quiet
```

This command expands configuration but does not start containers.

## 6. Configure `.env`

Copy the example and restrict its permissions:

```bash
cp .env.example .env
chmod 600 .env
```

The current `.env` contains no secrets, but restrictive permissions prevent a
future operator-added value from becoming broadly readable.

Edit it with your preferred editor:

```bash
nano .env
```

### 6.1 Domain and application URL

Public HTTPS example:

```dotenv
JOSI_DOMAIN=josi.example.com
JOSI_APP_URL=https://josi.example.com
JOSI_COOKIE_SECURE=true
JOSI_HTTP_PORT=80
JOSI_HTTPS_PORT=443
```

`JOSI_DOMAIN` is the hostname Caddy serves. Do not include `https://`, a path,
or a trailing slash.

`JOSI_APP_URL` is the browser-facing origin. Include the scheme. Do not add a
trailing slash. OAuth redirect URLs and security checks depend on this value
being the actual external URL.

`JOSI_COOKIE_SECURE=true` is required for HTTPS. A browser refuses to send a
Secure cookie over plain HTTP.

Local HTTP evaluation example:

```dotenv
JOSI_DOMAIN=localhost
JOSI_APP_URL=http://localhost
JOSI_COOKIE_SECURE=false
JOSI_HTTP_PORT=80
JOSI_HTTPS_PORT=443
```

Do not use `JOSI_COOKIE_SECURE=false` on a public deployment.

### 6.2 Host ports

`JOSI_HTTP_PORT` maps the host's chosen port to Caddy port 80.
`JOSI_HTTPS_PORT` maps the host's chosen port to Caddy port 443.

The normal public values are 80 and 443. Changing them means users must include
the nonstandard port in the URL unless another device forwards standard ports.

Check for conflicts before starting:

```bash
sudo ss -lntp | grep -E ':(80|443)[[:space:]]' || true
```

### 6.3 Database names

Defaults:

```dotenv
POSTGRES_DB=josi
POSTGRES_USER=josi
```

These values are identifiers, not passwords. Changing either after the database
volume has been initialized does not rename the existing database or user. Set
them once before first start and leave them stable.

### 6.4 Application image

Defaults:

```dotenv
JOSI_IMAGE=josi-ce
JOSI_TAG=local
```

The current Compose file builds from the local checkout and tags the resulting
image `josi-ce:local`. A future published release may provide a registry image
and immutable version tag. Do not use a floating `latest` tag for a controlled
deployment.

### 6.5 Optional-service limits

Defaults:

```dotenv
JOSI_OCR_CPUS=1.0
JOSI_OCR_MEMORY=512m
JOSI_CLAMAV_MEMORY=1500m
```

These are container ceilings. OCR and ClamAV do not start merely because the
values exist. Their Compose profiles must also be selected.

ClamAV needs substantial memory while loading and updating signatures. Do not
enable it on a constrained host without observing memory pressure.

## 7. Generate installation secrets

Run:

```bash
./scripts/install.sh
```

The script creates:

- `secrets/master.key`: encrypts stored provider, OAuth, and mail credentials
- `secrets/db_password`: authenticates the application to PostgreSQL

The directory is mode `0700`; each file is mode `0600`. Values are deliberately
not printed.

Verify without changing anything:

```bash
./scripts/install.sh --check
```

The installer is idempotent: rerunning it leaves existing secret files alone.
It never rotates the master key.

### 7.1 Master-key warning

The master key is not stored in PostgreSQL. That protects credentials if a
database dump is stolen, but it creates an operational obligation:

**Losing `secrets/master.key` makes encrypted credentials permanently
unreadable.** A database backup alone is insufficient.

Before continuing, copy the master key to encrypted storage on a different
device. Example using removable media already mounted at `/mnt/secure-backup`:

```bash
install -m 600 secrets/master.key /mnt/secure-backup/josi-master.key
```

Do not email the key, paste it into chat, store it in Git, or include it in a
normal unencrypted cloud folder. Record which installation it belongs to.

Check that Git ignores the generated directory:

```bash
git check-ignore -v secrets/master.key secrets/db_password
```

## 8. Build and start the default stack

Review the resolved configuration. This output should contain file paths but
must not contain the secret values:

```bash
docker compose config
```

Build the application image:

```bash
docker compose build --pull
```

Start in detached mode:

```bash
docker compose up -d
```

Watch startup:

```bash
docker compose ps
docker compose logs -f --tail=200
```

Press `Ctrl+C` to stop following logs. This does not stop the containers.

Expected state:

- `db`, `web`, `worker`, and `caddy` are running.
- `migrate` exited with code 0 after applying migrations.
- `ocr` and `clamav` do not exist unless their profiles were enabled.

Inspect a failed service without restarting the whole stack:

```bash
docker compose logs --tail=300 <SERVICE>
docker compose ps -a
```

Replace `<SERVICE>` with `db`, `migrate`, `web`, `worker`, or `caddy`.

## 9. Verify the installation

### 9.1 Container health

```bash
docker compose ps
```

Do not equate "running" with "ready." The health and readiness endpoints test
different layers.

### 9.2 Liveness

For public HTTPS:

```bash
curl -fsS https://josi.example.com/health
```

For localhost evaluation:

```bash
curl -fsS http://localhost/health
```

Liveness means the API process answers.

### 9.3 Readiness

```bash
curl -fsS https://josi.example.com/ready
```

Readiness additionally checks the database, migrations, and master-key
availability. A live but unready service should not receive normal traffic.

### 9.4 TLS and redirects

```bash
curl -I http://josi.example.com
curl -I https://josi.example.com
openssl s_client -connect josi.example.com:443 -servername josi.example.com </dev/null
```

If certificate issuance fails, check DNS, inbound ports, Caddy logs, router
port forwarding, firewall policy, and incorrect IPv6 records.

### 9.5 Optional services remain absent

```bash
docker compose ps --all
docker ps --format '{{.Names}}' | grep -E '(ocr|clamav)' && echo unexpected || echo absent
```

## 10. Complete the setup wizard

Open `JOSI_APP_URL` in a browser. A fresh installation exposes the setup wizard
and refuses normal application routes until setup completes.

The wizard covers:

1. Host checks
2. Super-admin account
3. Domain and HTTPS review
4. LLM provider
5. System and Josi mail profiles
6. Optional Google and Microsoft connector clients
7. Security and privacy choices
8. Explicit telemetry choice
9. Review and completion

Setup is single-use. After completion, setup routes return 404 and cannot be
used to create another super administrator.

Record recovery information in the organization's password manager. Do not put
provider keys, OAuth secrets, SMTP passwords, or recovery material in this
repository.

## 11. Enable optional OCR and ClamAV profiles

Profiles may be combined.

OCR only:

```bash
docker compose --profile ocr up -d
```

ClamAV only:

```bash
docker compose --profile clamav up -d
```

Both:

```bash
docker compose --profile ocr --profile clamav up -d
```

Verify:

```bash
docker compose --profile ocr --profile clamav ps
docker compose logs --tail=200 ocr clamav
```

ClamAV's first signature load can take several minutes. Its healthcheck allows
a five-minute start period.

To stop and remove an optional service while leaving the core running:

```bash
docker compose stop ocr
docker compose rm -f ocr
```

Use `clamav` in place of `ocr` for the malware scanner. Removing the ClamAV
container does not remove the named signature volume unless you deliberately
remove volumes.

> **Current implementation limitation:** Phase 9 does not yet wire the real
> OCR, ClamAV, parser, filesystem-watcher, or cloud-sync machinery into a
> complete document pipeline. Enabling a container does not make the unfinished
> feature production-ready.

## 12. Use an existing reverse proxy

Create `.env` with the real public URL and a local published port:

```dotenv
JOSI_DOMAIN=josi.example.com
JOSI_APP_URL=https://josi.example.com
JOSI_COOKIE_SECURE=true
JOSI_WEB_PORT=8080
```

Start with the override and scale bundled Caddy to zero:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.noproxy.yml \
  up -d --scale caddy=0
```

Josi is then available to the host proxy at `http://127.0.0.1:8080` if Docker
binds to loopback. The current override publishes on all host interfaces. If
the machine is not protected by a firewall, tighten the port mapping in a local
override:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:${JOSI_WEB_PORT:-8080}:8080"
```

Save that as `docker-compose.local.yml` and include it last:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.noproxy.yml \
  -f docker-compose.local.yml \
  up -d --scale caddy=0
```

The external proxy must:

- Terminate HTTPS with a valid certificate.
- Preserve the original `Host` header.
- Forward `X-Forwarded-For`.
- Forward `X-Forwarded-Proto: https`.
- Support normal long-lived HTTP responses used by the application.
- Apply sensible request-size and timeout limits without truncating supported
  application traffic.

Minimal nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

After proxy changes, verify `/health`, `/ready`, login, logout, and a browser
refresh on an authenticated route.

## 13. Firewall guidance

Bundled Caddy normally needs only:

- TCP 22 from trusted administration addresses, if SSH is used
- TCP 80 from the Internet
- TCP 443 from the Internet

Do not expose PostgreSQL. The Compose file publishes no database port.

Example UFW policy, only after confirming SSH access and adjusting the SSH rule
for the actual environment:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Firewall changes can lock you out. Keep an existing SSH session open and test a
second session before closing the first.

## 14. Normal operations

Show status:

```bash
docker compose ps
```

Follow all logs:

```bash
docker compose logs -f --tail=200
```

Follow one service:

```bash
docker compose logs -f --tail=200 web
```

Restart one service:

```bash
docker compose restart web
```

Stop without deleting containers or volumes:

```bash
docker compose stop
```

Start stopped containers:

```bash
docker compose start
```

Recreate containers from the current configuration:

```bash
docker compose up -d
```

### 14.1 Commands that are intentionally not routine

`docker compose down` removes containers and networks but preserves named
volumes unless `--volumes` is supplied.

**Never run `docker compose down --volumes` as an ordinary troubleshooting
step.** It deletes the PostgreSQL data volume and other named volumes.

Do not delete `secrets/master.key`. Do not regenerate it to fix a startup
problem. A replacement key cannot decrypt existing credentials.

## 15. Backup and restore status

Josi's required encrypted, restorable backup workflow belongs to Phase 10 and
is not yet implemented. Therefore this preview cannot honestly provide the
promised supported backup and restore commands.

Before storing important data, wait for Phase 10 and its destructive
backup-wipe-restore acceptance test to pass. A manual PostgreSQL dump is not a
substitute for that complete workflow because it may omit application files,
history copies, configuration, and the separately held master key.

At minimum, any future complete backup set must preserve:

- PostgreSQL data
- The exact `secrets/master.key`
- Application configuration
- Uploads and recovery/history data when those features exist
- A record of the Josi release being restored

The master key must be protected separately from the database backup. Restore
must fail safely when the wrong key is supplied.

## 16. Upgrade and rollback status

The required one-click update, pre-update backup, health check, and automatic
rollback belong to Phase 10 and are not yet implemented.

Do not improvise an in-place production upgrade of this preview. Pulling new
source and running `docker compose up -d --build` can apply irreversible
database migrations. Without a verified pre-update backup and rollback path,
that is not an acceptable production procedure.

A supported release procedure will be documented here only after the automated
backup/restore and failed-update rollback tests exist and pass.

## 17. Troubleshooting

### 17.1 Compose cannot read a secret file

Symptoms include `secrets/master.key not found` or `secrets/db_password not
found`.

```bash
./scripts/install.sh --check
ls -ld secrets
ls -l secrets/master.key secrets/db_password
```

Run commands from the repository root. Do not solve permission errors by making
the secrets world-readable.

### 17.2 Database is unhealthy

```bash
docker compose ps db
docker compose logs --tail=300 db
docker inspect --format '{{json .State.Health}}' josi-ce-db-1
```

Container names can vary with the Compose project name. Use `docker compose ps
-q db` when scripting:

```bash
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q db)"
```

Common causes are disk exhaustion, filesystem permission problems, corrupt
storage, and changing database identifiers after initialization.

### 17.3 Migrator exited nonzero

```bash
docker compose ps -a migrate
docker compose logs --tail=500 migrate
```

Do not repeatedly delete the database volume. Preserve the evidence, identify
the failing migration, and use the release's documented recovery path.

### 17.4 Web is running but `/ready` fails

```bash
docker compose logs --tail=300 web
curl -i http://127.0.0.1/ready
./scripts/install.sh --check
```

Readiness distinguishes database, migrations, and master-key failures. Fix the
reported dependency instead of masking the check.

### 17.5 Login works locally but fails through a proxy

Confirm:

- `JOSI_APP_URL` exactly matches the browser's HTTPS origin.
- `JOSI_COOKIE_SECURE=true` for HTTPS.
- The proxy sends `X-Forwarded-Proto: https`.
- The browser is not being redirected between different hostnames.
- System time is correct.

For plain HTTP evaluation only, set `JOSI_COOKIE_SECURE=false`, recreate the web
container, and clear cookies for the host.

### 17.6 Caddy restarts or cannot issue a certificate

```bash
docker compose ps caddy
docker compose logs --tail=500 caddy
dig +short A josi.example.com
dig +short AAAA josi.example.com
```

Check that ports 80 and 443 reach this server, that another service is not
already bound to them, and that DNS does not contain a stale address.

`JOSI_ACME_EMAIL` in `.env` is currently informational. The supplied Caddyfile
does not interpolate it because an empty `email` directive makes Caddy fail to
parse. Certificate issuance works without an ACME contact address.

### 17.7 Port already in use

```bash
sudo ss -lntp | grep -E ':(80|443|8080)[[:space:]]'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Stop the conflicting service, choose different host ports, or use the existing
reverse-proxy deployment shape.

### 17.8 Docker build fails

```bash
docker compose build --pull --no-cache
docker system df
df -h
df -i
```

Capture the first real compiler or package error, not only the final nonzero
exit line. Do not run broad Docker prune commands on a shared host without
reviewing what they will delete.

### 17.9 Host is out of disk space

Inspect before removing anything:

```bash
df -h
docker system df -v
docker volume ls
docker image ls
```

Do not delete a volume merely because its name looks old. Confirm ownership and
take a restorable backup first.

### 17.10 Host architecture mismatch

```bash
uname -m
docker info --format '{{.Architecture}}'
docker image inspect "${JOSI_IMAGE:-josi-ce}:${JOSI_TAG:-local}" --format '{{.Architecture}}'
```

Use a 64-bit `amd64` or `arm64` OS and matching image.

### 17.11 ClamAV remains unhealthy

```bash
docker compose --profile clamav ps clamav
docker compose --profile clamav logs --tail=500 clamav
docker stats --no-stream
```

Allow time for initial signature loading and verify the host has enough memory.
An out-of-memory kill appears in container state and host kernel logs.

## 18. Security checklist

Before considering an installation reachable by other people, confirm:

- [ ] The checkout is an intended release, not an arbitrary dirty branch.
- [ ] `scripts/scan-secrets.sh` passes.
- [ ] `scripts/install.sh --check` passes.
- [ ] The master key has an encrypted off-host copy.
- [ ] `.env` contains the correct public origin.
- [ ] HTTPS works with a valid certificate.
- [ ] Secure cookies remain enabled for HTTPS.
- [ ] PostgreSQL is not published to the host or Internet.
- [ ] Host security updates are enabled and current.
- [ ] SSH uses strong authentication and limited network exposure.
- [ ] Optional OCR and ClamAV services are enabled only when supported and
      resourced.
- [ ] Provider, OAuth, and SMTP credentials belong to the operator.
- [ ] External LLM processing is disclosed to users.
- [ ] Telemetry was explicitly chosen rather than assumed.
- [ ] `/health` and `/ready` are monitored.
- [ ] Phase 10 backup and restore acceptance has passed before important data is
      entrusted to the system.
- [ ] Phase 11 threat-model and release gates have passed before public launch.

## 19. Collecting useful support information

The redacted diagnostics bundle is a Phase 10 feature and does not yet exist.
Until it does, inspect logs locally and redact them before sharing. Never send:

- `secrets/master.key`
- `secrets/db_password`
- Provider API keys
- OAuth client secrets or access/refresh tokens
- SMTP passwords
- Message, document, contact, calendar, or prompt content

Safe first-line metadata usually includes the Josi commit or release, host OS,
CPU architecture, Docker versions, Compose service state, the failing endpoint,
and the exact error after secrets and user content are removed.

```bash
git rev-parse HEAD
uname -a
docker version
docker compose version
docker compose ps -a
```

## 20. Uninstallation

There is no supported uninstall-and-preserve-data wizard yet.

Stopping the installation is reversible:

```bash
docker compose stop
```

Removing containers and networks while retaining named volumes:

```bash
docker compose down
```

Deleting named volumes or the installation directory destroys data. Before any
permanent removal, create and verify a complete backup when Phase 10 tooling is
available, and separately preserve the master key. This manual deliberately
does not provide a one-line destructive wipe command.

