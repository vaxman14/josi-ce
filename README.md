# Josi CE 0.1 — Community Preview

**Your assistant, on your own server.**

A self-hosted AI executive assistant. One workspace, your people, your server,
your credentials.

Created and published by **SOCAL RECEPTIONIST LLC**.

> ### Community Preview
>
> 0.1 is usable but early. It is published so that real usage can show which
> workflows matter. It is not a mature production product, and it carries **no
> support entitlement, no guaranteed response and no SLA**.

---

## Status

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
| [`docs/DEVELOPER_SERVICE_CONNECTIONS.md`](docs/DEVELOPER_SERVICE_CONNECTIONS.md) | Connecting your own GitHub, Netlify, Vercel or Supabase account |
| [`docs/CUSTOM_API_CONNECTIONS.md`](docs/CUSTOM_API_CONNECTIONS.md) | Letting Josi call an external API, one reviewed action at a time |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Every threat with its control and the test that would fail without it |
| [`docs/HELP.md`](docs/HELP.md) | Current feature help and links to each operator/user guide |
| [`docs/LEGAL.md`](docs/LEGAL.md) | Terms, privacy, cookies, licences, support and security policies |

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
- Not a white-label product. You may fork it and put your own identity on it —
  the AGPL grants that and the trademark policy expects it. What is not on offer
  is *us* standing behind a rebranded build; that is a commercial arrangement.
  See `TRADEMARK.md`.
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
  shares your own Codex usage limits, reports no cost, and can use Josi's
  permission-checked tools through the bundled private MCP harness. The same
  first-party-CLI mechanism is implemented for Claude Code, but its public
  release representation remains gated on the counsel review recorded in
  FI-006. Both positions, with sources, are in
  [`docs/SUBSCRIPTION_AUTH.md`](docs/SUBSCRIPTION_AUTH.md).

`linux/amd64` and `linux/arm64` images are published. Low-power ARM64 devices are
supported within realistic limits.

> **No capacity numbers are published yet.** Concurrency and performance depend
> on your hardware, database, connector load and whether inference is local or
> remote. Real figures will be published only after representative hardware has
> actually been benchmarked — not estimated.

## Installation

Install and open Docker, then copy the command for your computer.

### Mac

```bash
JOSI_HOST_IP="$(ipconfig getifaddr "$(route -n get default | awk '/interface:/{print $2;exit}')")" && \
test -n "$JOSI_HOST_IP" && \
mkdir -p "$HOME/josi-ce" && cd "$HOME/josi-ce" && \
docker run --rm \
  -e JOSI_INSTALLER_HOSTNAME="$JOSI_HOST_IP" -p 8080:8080 \
  -v "$HOME/.docker/run/docker.sock:/var/run/docker.sock" \
  -v "$PWD:$PWD" -w "$PWD" \
  docker.io/romanvaxman/josi-ce-installer:latest
```

### Linux

```bash
JOSI_HOST_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')" && \
test -n "$JOSI_HOST_IP" && \
mkdir -p "$HOME/josi-ce" && cd "$HOME/josi-ce" && \
docker run --rm \
  -e JOSI_INSTALLER_HOSTNAME="$JOSI_HOST_IP" -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  docker.io/romanvaxman/josi-ce-installer:latest
```

The installer prints one private setup link. Open it and finish everything in
the browser, including the domain choice and recovery-key handling. No Git
checkout, source build, `.env` editing, or separate Josi CLI is required.

The complete walkthrough is in
[`docs/INSTALLATION.md`](docs/INSTALLATION.md).

## Backups and recovery

Create and manage backups from **Administration → Backups**. During first-time
browser setup, Josi shows the recovery key once and offers **Copy** and
**Download** actions. Save it somewhere separate from the Mac or Linux computer
running Josi. There is no manual shell key-copy step in the normal setup flow.

See [the backup guide](docs/BACKUPS.md) for recovery and advanced storage.

## Using and updating Josi

Use Josi's administration screens for everyday management. A super-admin can
open **Admin → System checkup**, check the stable release channel, review the
release notes, and approve an update with the exact confirmation shown there.
Josi creates a backup, applies the pinned release, verifies health, and rolls
back automatically when a safe rollback is possible.

If Josi cannot open or the maintenance helper is unavailable, rerun the same
installer command above as the recovery update path. It detects the existing
installation and preserves its configuration and data.

## Privacy

- Telemetry is **off** unless you affirmatively switch it on during setup. It
  never includes prompts, message contents, contacts, calendars, credentials or
  identifiable business data.
- Enabling an external LLM provider means the data needed for a request leaves
  your server and is processed under that provider's terms. Self-hosting the
  application does not by itself keep everything local.
- **Local-only mode** blocks external LLM providers entirely and shows a
  persistent badge while active.
- Full data categories, recipients, Family BETA handling, retention and user
  choices are in the [`Privacy Notice`](docs/PRIVACY_NOTICE.md). Strictly
  necessary cookies and PWA caching are in the [`Cookie Notice`](docs/COOKIE_NOTICE.md).

## Terms and Family BETA

Use of the official application and paid modules is governed by the
[`Terms of Use`](docs/TERMS_OF_USE.md). **Family and Parental Controls are BETA
and must not be relied on for a child's safety.** They control only Josi, not a
device, other apps, websites, location, emergencies or actual screen time.

## Support

Josi CE includes no support entitlement, guaranteed response, or SLA. Read the
[`Community Preview support policy`](SUPPORT.md) before opening a report.

## Licence

Code: **GNU AGPL v3** — see [`LICENSE`](LICENSE).

Branding: the Josi name, the mark (the white `J` on navy), the wordmark and the
product identity are **not** covered by the AGPL and remain the property of
SOCAL RECEPTIONIST LLC.

This does not restrict what the AGPL grants. You may modify Josi CE and you may
remove its branding — for a fork, removing it is the right thing to do. What the
trademark asks is only that a modified version not present itself as the
official Josi product. Unmodified redistribution may keep the branding, because
it is accurate. See [`TRADEMARK.md`](TRADEMARK.md).

## Appliance platforms and launch material

- [`Portainer, Unraid, and TrueNAS SCALE`](docs/APPLIANCE_PLATFORMS.md)
- [`Product Hunt launch kit`](docs/PRODUCT_HUNT.md)

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.
