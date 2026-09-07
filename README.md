<p align="center">
  <img src="docs-site/brand/josi-mark.png" alt="Josi" width="128">
</p>

<h1 align="center">Josi CE</h1>

<p align="center"><strong>Your assistant. Your server. Your data.</strong></p>

<p align="center">
  A self-hosted AI executive assistant for one private workspace—your people,
  your credentials, and your infrastructure.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-24324a"></a>
  <a href="https://github.com/vaxman14/josi-ce/actions/workflows/release.yml"><img alt="Release workflow" src="https://github.com/vaxman14/josi-ce/actions/workflows/release.yml/badge.svg"></a>
  <a href="https://hub.docker.com/r/romanvaxman/josi-ce"><img alt="Docker Hub" src="https://img.shields.io/badge/Docker%20Hub-amd64%20%7C%20arm64-2496ed?logo=docker&logoColor=white"></a>
  <img alt="Community Preview" src="https://img.shields.io/badge/status-Community%20Preview-f59e0b">
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="https://heyjosi.com/ce/help/">Help docs</a> ·
  <a href="docs/INSTALLATION.md">Installation guide</a> ·
  <a href="docs/THREAT_MODEL.md">Security model</a> ·
  <a href="SUPPORT.md">Support policy</a>
</p>

Created and published by **SOCAL RECEPTIONIST LLC**.

> ### Community Preview
>
> 0.1 is usable but early. It is published so that real usage can show which
> workflows matter. It is not a mature production product, and it carries **no
> support entitlement, no guaranteed response and no SLA**.

---

## Why Josi

- **Self-hosted:** your workspace runs on infrastructure you control.
- **Bring your own providers:** OpenAI, Anthropic, xAI, local models, and
  OpenAI-compatible endpoints.
- **Actually useful:** web app, documents, mail, storage, connectors, Telegram,
  backup and restore—not merely a chat box in a Docker container.
- **Multi-user by design:** private per-user connections and content inside one
  shared workspace.
- **No seat cap:** capacity is determined by your hardware, not a pricing page.
- **Auditable:** AGPL source, published threat model, reproducible images, and
  test evidence for claims made here.

## Quick start

Requires Docker Engine with Compose v2 on a 64-bit `amd64` or `arm64` host.

```bash
mkdir -p ~/josi-ce && cd ~/josi-ce
docker run --rm \
  -e JOSI_APP_URL=http://localhost \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  romanvaxman/josi-ce-installer:0.1.2
```

Open <http://localhost>. The first person through setup becomes the super
admin. **Immediately back up `secrets/master.key` somewhere off the host.**

The installer is temporary: it generates owner-only secrets, starts the normal
isolated Compose services, and exits. No privileged controller remains.

The default output shows only installation milestones. Add `--verbose` after
the image name to stream the underlying Docker output. For public HTTPS, also
pass `-e JOSI_DOMAIN=josi.example.com` and set `JOSI_APP_URL` to the matching
`https://` origin.

Prefer GHCR? Use `ghcr.io/vaxman14/josi-ce-installer:0.1.2`. On macOS with
Docker Desktop, follow the socket instructions in the
[quick-start guide](docs/QUICK_START.md).

## Proven in the Community Preview

| Release gate | Result |
|---|---|
| Architectures | Published `linux/amd64` and `linux/arm64` images |
| Clean installation | Fresh published-image install, migrations, health and UI verified |
| Isolation | 69/69 live multi-user isolation checks passed |
| Test suite | 2,197 tests passed at release cut |
| Dependency audit | Zero known npm vulnerabilities at release cut |
| Supply chain | Versioned images with provenance attestations |

These are release-cut results, not an evergreen guarantee. The detailed
evidence and limitations remain in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

## Project status

**Josi CE 0.1 is a Community Preview.** Setup, isolation, the assistant, the web
app, connectors, mail, documents and storage, and backup and restore are
implemented. Published amd64 and arm64 images have passed clean-install and
live multi-user isolation tests. Each phase carries evidence recording what is
proven and what is not.

| Document | What it is |
|---|---|
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Phases, acceptance criteria and risks |
| [`docs/DECISION_TRACEABILITY.md`](docs/DECISION_TRACEABILITY.md) | Every product decision, linked to its implementation or marked deferred |
| [`docs/TELEGRAM.md`](docs/TELEGRAM.md) | Reaching Josi from Telegram with your own bot |
| [`docs/PWA.md`](docs/PWA.md) | Installing Josi on a phone or desktop, and exactly what is cached |
| [`docs/SUBSCRIPTION_AUTH.md`](docs/SUBSCRIPTION_AUTH.md) | Using a ChatGPT plan instead of an API key, why Claude cannot be used, and the edition boundary |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Clean-install acceptance: what has actually been run, on what hardware |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Every threat with its control and the test that would fail without it |

Phase progress is tracked in the implementation plan. Nothing here is presented
as working before it is.

## What Josi CE is

- **One workspace per installation**, with as many users as your hardware can
  carry. No seat cap.
- **Your credentials.** You bring your own LLM provider, your own Google and
  Microsoft OAuth applications, your own SMTP. Nothing belonging to SOCAL
  RECEPTIONIST LLC ships in this repository.
- **Private by default.** A user's connected accounts, mapped folders and
  operational email threads are theirs. Workspace membership does not grant
  access to a colleague's content, and neither does being the super admin.
- **Policy, not surveillance.** The super admin decides what capabilities exist
  and can switch them off. That is a different thing from being able to read
  people's mail, and Josi CE treats it as a different thing.

## What Josi CE is not

- One workspace per installation. Multi-tenant hosting is not supported by the
  current architecture; the AGPL does not prohibit operating the software as a
  network service.
- **Rebranding and independent services.** You may maintain and offer a
  rebranded fork under the applicable license. SOCAL RECEPTIONIST LLC provides
  no support or assurances for that offering unless separately agreed in
  writing. See [`TRADEMARK.md`](TRADEMARK.md).
- Not an enterprise product. The initial market is SMB.
- No voice or SMS receptionist in 0.1.
- No audio/video transcription or media indexing in 0.1.
- No plugin sideloading or marketplace in 0.1.
- Native companion apps are **Coming soon** — there is no download to offer
  yet. Josi does install to a home screen as a Progressive Web App, and can be
  reached from Telegram; see below.

## Getting to Josi from a phone

Two ways, both shipped:

- **Install it.** Josi is a Progressive Web App. Safari → Share → Add to Home
  Screen on iOS; an install prompt on Android and desktop Chrome. It stores the
  app bundle on the device and **no data at all** — offline shows a page that
  says it is offline, because a service-worker cache outlives signing out.
  See [`docs/PWA.md`](docs/PWA.md).
- **Message it on Telegram.** Using **your own bot**, created in BotFather.
  There is no Josi-operated relay and nowhere to configure one. Each person
  links their own account with a single-use code; an administrator can revoke a
  link and cannot read a word of it. See [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## Requirements

- Docker and Docker Compose
- PostgreSQL (bundled in the compose file)
- A domain name, if you want the bundled automatic HTTPS
- An LLM provider: OpenAI, Anthropic, xAI, or any OpenAI-compatible endpoint
  such as Ollama, vLLM, LM Studio or LocalAI.

  Alternatively, on a Community Edition installation, **your own ChatGPT plan**
  through OpenAI's own Codex CLI running on the same machine. Josi never sees,
  stores or forwards your login. It is per installation rather than per person,
  shares your own Codex usage limits, reports no cost, and cannot call tools —
  so Josi can talk but cannot act on that path. A **Claude subscription cannot**
  be used: Anthropic's policy does not permit it outside Claude Code and
  Claude.ai. Both positions, with sources, are in
  [`docs/SUBSCRIPTION_AUTH.md`](docs/SUBSCRIPTION_AUTH.md).

`linux/amd64` and `linux/arm64` images are published. Low-power ARM64 devices are
supported within realistic limits.

> **No capacity numbers are published yet.** Concurrency and performance depend
> on your hardware, database, connector load and whether inference is local or
> remote. Real figures will be published only after representative hardware has
> actually been benchmarked — not estimated.

## Installation details

For the shortest verified path, see [`docs/QUICK_START.md`](docs/QUICK_START.md).

### One-shot installer (recommended for Community Preview)

Create an empty directory, enter it, and run the installer container. The same
absolute directory is mounted into the container because Docker Compose passes
the secret-file paths to the host daemon. The installer uses the Docker socket
only while it writes the reviewed release files, generates the two local
secrets, pulls the pinned images and starts the normal isolated services. It
then exits; no privileged controller remains running.

```bash
mkdir josi-ce && cd josi-ce
# Linux:
docker run --rm \
  -e JOSI_APP_URL=http://localhost \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  ghcr.io/vaxman14/josi-ce-installer:0.1.2
```

On macOS with Docker Desktop, use its user socket instead:

```bash
docker run --rm \
  -e JOSI_APP_URL=http://localhost \
  -v "$HOME/.docker/run/docker.sock:/var/run/docker.sock" \
  -v "$PWD:$PWD" -w "$PWD" \
  ghcr.io/vaxman14/josi-ce-installer:0.1.2
```

Review `.env` before exposing the installation publicly. Set `JOSI_DOMAIN` and
`JOSI_APP_URL`, then run `docker compose up -d` to apply those changes.

The socket mount is root-equivalent access to the Docker host. It is acceptable
for this one-shot installer only because the published image is inspectable,
version-pinned, and exits after Compose starts. Do not run it as a permanent
service and do not give the socket to the Josi application containers.

### Manual installation

The complete operator guide is in
[`docs/INSTALLATION.md`](docs/INSTALLATION.md). It covers prerequisites, DNS,
every supplied environment setting, secret generation, bundled Caddy, an
existing reverse proxy, optional OCR and ClamAV profiles, verification,
operations, security, and troubleshooting. Where a workflow is not implemented
it says so explicitly rather than inventing commands for features that do not
exist yet.

For a local evaluation after reading the guide:

```bash
cp .env.example .env
./scripts/install.sh
docker compose up -d
```

## Backups and the master key

Runtime credentials — LLM keys, OAuth secrets, SMTP passwords — are encrypted in
PostgreSQL using an installation master key that is stored **outside the
database**, as a Docker secret.

**A database backup alone cannot restore your credentials.** Back up the master
key separately and keep it somewhere you would still have it if the server were
gone.

This is deliberate, and it has been measured rather than assumed. Josi's backup
tooling never puts the key in an archive, so a stolen backup is useless — and
the acceptance test drops the database, restores it, and proves the credentials
decrypt with the key and are unusable without it. The cost of that property is
the warning above: restore your data without the key and your saved provider
keys, connected accounts and mail passwords do not come back.

See [`docs/PHASE_10_EVIDENCE.md`](docs/PHASE_10_EVIDENCE.md) for what was
proven and what was not.

## Running it

Full detail is in [`docs/INSTALLATION.md`](docs/INSTALLATION.md). These are the
four things an operator actually does.

### Fresh install

```bash
git clone https://github.com/vaxman14/josi-ce.git && cd josi-ce
cp .env.example .env          # set JOSI_DOMAIN and JOSI_APP_URL
./scripts/install.sh          # generates the master key and database password
docker compose up -d
```

Then open the domain and complete the setup wizard. The first person through it
becomes the super admin, and setup cannot be run twice.

### Back up

```bash
# Settings → Administration → Backups, or:
POST /api/ops/admin/backups   {"kind":"full","masterKeyConfirmed":true}
```

**Copy the archive off the host, and back up `secrets/master.key` separately.**
The key is never inside a backup — that is what makes a stolen archive useless,
and it is also why an archive restored without the key returns your data but not
your credentials.

### Restore

```bash
POST /api/ops/admin/restore   {"backupId":"<id>","confirm":"restore"}
```

The reply reports `rowsRestored` and `credentialsRecovered` separately, because
they are different facts. If the second is `false`, put the original key back
and the credentials work again.

### Upgrade and roll back

**Josi never updates itself.** There is no setting that enables automatic
updating. When an update is applied it backs up first and refuses to proceed if
that fails, health-checks afterwards, and rolls back on failure keeping the
recorded version at the old one.

> **Not implemented yet:** nothing downloads a release, so there is no
> in-product upgrade. Until there is, take a `full` backup, confirm you hold the
> master key separately, then pull and rebuild — and be prepared to restore,
> because migrations are not reversible.

## Privacy

- Telemetry is **off** unless you affirmatively switch it on during setup. It
  never includes prompts, message contents, contacts, calendars, credentials or
  identifiable business data.
- Enabling an external LLM provider means the data needed for a request leaves
  your server and is processed under that provider's terms. Self-hosting the
  application does not by itself keep everything local.
- **Local-only mode** blocks external LLM providers entirely and shows a
  persistent badge while active.

## Support

Josi CE includes no support entitlement, guaranteed response, or SLA. Read the
[`Community Preview support policy`](SUPPORT.md) before opening a report.

## Licence

Josi CE is released under the GNU Affero General Public License, version 3 or,
at your option, any later version (AGPL-3.0-or-later). See
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE); separately identified third-party
components remain under their own licenses.

The AGPL copyright grant includes Company-owned branding artwork supplied with
the software. Trademark rights in the Josi and Josi CE names and logos are
separate: permission to copy or modify artwork does not grant unrestricted
permission to use it as your brand. See [`TRADEMARK.md`](TRADEMARK.md) for
permitted uses of the names and logos.

You may modify and rebrand the software under its applicable license.
Rebranding does not remove source-sharing or legal-notice obligations. Do not
imply that an independently operated service or modified product is operated,
endorsed, certified, or supported by SOCAL RECEPTIONIST LLC.

Josi CE Community Preview includes no Company support entitlement, guaranteed
response, or SLA unless separately agreed in writing.

## Appliance platforms and launch material

- [`Portainer, Unraid, and TrueNAS SCALE`](docs/APPLIANCE_PLATFORMS.md)
- [`Product Hunt launch kit`](docs/PRODUCT_HUNT.md)

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.
