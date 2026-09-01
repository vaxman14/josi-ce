# Josi CE 0.1 — Community Preview

**Josi. Fetching what's next.**

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

**This repository is under active initial construction.** The documents below
are complete and binding, and the implementation is being built in reviewable
phases. Phases 1–10 are implemented and verified: setup, isolation, the
assistant, the web app, connectors, mail, documents and storage, and backup and
restore. Each phase carries an evidence document recording what is proven and
what is not.

| Document | What it is |
|---|---|
| [`docs/EXTRACTION_MAP.md`](docs/EXTRACTION_MAP.md) | What is derived from the commercial Josi engine, what is deliberately excluded, and why |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Phases, acceptance criteria and risks |
| [`docs/DECISION_TRACEABILITY.md`](docs/DECISION_TRACEABILITY.md) | Every product decision, linked to its implementation or marked deferred |

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

- Not multi-tenant. Running Josi as a service for third parties needs a licence.
- Not white-labellable. Official Josi branding is required — see `TRADEMARK.md`.
- Not an enterprise product. The initial market is SMB.
- No voice or SMS receptionist in 0.1.
- No audio/video transcription or media indexing in 0.1.
- No plugin sideloading or marketplace in 0.1.
- Companion apps are **Coming soon** — there is no download to offer yet.

## Requirements

- Docker and Docker Compose
- PostgreSQL (bundled in the compose file)
- A domain name, if you want the bundled automatic HTTPS
- An LLM provider: OpenAI, Anthropic, xAI, or any OpenAI-compatible endpoint
  such as Ollama, vLLM, LM Studio or LocalAI

`linux/amd64` and `linux/arm64` images are published. Low-power ARM64 devices are
supported within realistic limits.

> **No capacity numbers are published yet.** Concurrency and performance depend
> on your hardware, database, connector load and whether inference is local or
> remote. Real figures will be published only after representative hardware has
> actually been benchmarked — not estimated.

## Installation

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

Josi CE includes no support entitlement. You may email SOCAL RECEPTIONIST LLC,
but there is no guaranteed response time, troubleshooting, installation help or
SLA.

Paid support may be offered separately in future. It is not available now.

Submitting a support ticket never grants remote access to your installation.

## Licence

Code: **GNU AGPL v3** — see [`LICENSE`](LICENSE).

Branding: the Josi name, shepherd logo, wordmark and product identity are **not**
covered by the AGPL and remain the property of SOCAL RECEPTIONIST LLC. See
[`TRADEMARK.md`](TRADEMARK.md).

> `TRADEMARK.md` and `NOTICE` are **drafts pending legal review**. They are not
> approved legal wording.

## Contributing

Not yet open for contributions — the initial structure is still being built.
