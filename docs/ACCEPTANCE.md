# Clean-install acceptance

A record of what has actually been run, on what, and when. **A profile with no
row in the results table has not been tested**, whatever the script's existence
might suggest.

## v0.1.23 publication — 2026-09-15

Release source: public `main` commit
`78e4b5924969749fe56026e97c02f4e10982e151`, tagged `v0.1.23`.

Evidence on Bananana (Linux x86_64, Docker Engine 29.7.2, Buildx 0.29.1):

- TypeScript and production build passed;
- 2,446 tests passed across 97 files;
- dependency audit reported zero vulnerabilities;
- secret scan passed across 548 files;
- release and reverse-proxy Compose configurations parsed successfully;
- the application image built locally for `linux/amd64` and `linux/arm64`;
- the browser-installer image built locally for both architectures; and
- the public release workflow completed successfully.

Registry readback proved real `linux/amd64` and `linux/arm64` child manifests
for application and installer tags `0.1.23` and `latest` in both GHCR and
Docker Hub. Docker Hub uses the `romanvaxman` namespace. The numbered Docker
Hub indexes carry the exact same child digests as GHCR; stable `latest` aliases
were promoted from those existing indexes without rebuilding.

This document exists because M97 forbids capacity claims without measurements,
and because a script that has never been run is a plan.

## The script

```bash
bash scripts/acceptance/clean-install.sh                  # host defaults
bash scripts/acceptance/clean-install.sh --profile n150   # Intel N150 / 16 GB
bash scripts/acceptance/clean-install.sh --profile pi4    # Raspberry Pi 4 / 8 GB
bash scripts/acceptance/clean-install.sh --keep           # leave it running
```

It takes a Docker daemon with nothing of Josi's on it, builds the image, brings
the stack up, drives the setup wizard, signs in, and then checks the properties
that only exist on a real installation. It touches nothing outside its own
Compose project and tears itself down.

### What it checks

| Group | What |
|---|---|
| Prerequisites | Docker, Compose v2, python3, host memory against the profile |
| Clean start | Zero containers and zero volumes for this project before anything runs |
| Secrets | `install.sh` produces them; `master.key` is not world-readable |
| Build | The image builds; **size and build time recorded** |
| Edition | The image reports `ce`, **and `JOSI_EDITION=hosted` in the environment does not change it** |
| Boot | `/health` then `/ready`; **both durations recorded** |
| Profiles | OCR and ClamAV absent, and the ClamAV image never pulled |
| Setup gate | Every non-wizard route answers 503 before setup |
| Wizard | Nine steps and completion; **duration recorded** |
| Closure | The wizard 404s afterwards |
| **Credentials** | The stored provider key is **opened with the real master key inside the real container and compared to what was submitted** |
| Sign-in | The owner can sign in and the session resolves |
| PWA | Manifest, `no-store` on `sw.js`, `Service-Worker-Allowed`, all three icons, an offline shell with no script, `worker-src`/`manifest-src` in the CSP, and still no external origin |
| Telegram | The webhook is invisible with the channel off; there is no webhook inside `/api`; the admin surface loads with no token configured |
| Subscription | The running app reports `ce`; the Codex path is offered; the Claude path is not and cites the policy; no option says "coming soon" |
| Resources | Idle memory per container, **recorded** |
| Audit | Events were written, and no credential reached a payload |

The credential check is there for a specific reason. Phase 13 found that
`seal()` had been storing the string `[secret redacted]` instead of every
credential wrapped in `asSecret` — for the whole life of the project — and every
unit test passed because they all sealed plain strings. The only thing that
would have caught it is opening a real stored value on a real installation, so
that is now a step.

## The failure bundle

On any failed check, the script writes
`diagnostics/josi-acceptance-<profile>-<timestamp>.tar.gz` containing:

- `summary.txt` — the profile, which checks failed, and every measurement taken
- `host.txt` — kernel, architecture, CPU count, memory, disk, Docker versions
- `compose-ps.txt`, `compose-config.txt`, `docker-stats.txt`, `images.txt`
- `logs/<service>.log` — the last 400 lines of each service
- `ready.json`, `health.json`, `last-response.txt`
- `database-counts.txt` — **counts only**, and the edition the running image reports

Everything is passed through a redactor (sealed values, bot tokens, API keys,
`password`/`secret`/`token` assignments, connection strings, JWTs) and then the
whole archive is unpacked and run through `scripts/scan-secrets.sh`. If the
scanner flags it, the script says so loudly rather than letting it be sent.

No table is read. A bundle that could carry a row is a bundle nobody can send.

## Results

The script has now been run on real hardware. The rows below include the runs
that failed, because a table of only successes is a table that has been curated
— and in this case the failures are the most useful thing in it.

**Linux test host** — AMD Ryzen 7 8745H, 28 GiB, Ubuntu 26.04 LTS, Linux 7.0.0,
Docker 29.1.3, Compose 5.5.0, amd64.

| Profile | Arch | Host | Date | Result | Image MB | Build s | Boot→ready s | Idle MiB | Bundle |
|---|---|---|---|---|---|---|---|---|---|
| default | amd64 | Linux test host (Ryzen 7 8745H / 28 GiB) | 2026-09-02 | **19 passed, 36 failed** | 348 | 8 | never reached | — | `josi-acceptance-default-20260902T031033Z.tar.gz` |
| default | amd64 | Linux test host (Ryzen 7 8745H / 28 GiB) | 2026-09-02 | **50 passed, 0 failed, 5 skipped** | 348 | 7 | 9 | 92.9 | none — bundles are collected on failure |
| n150 | amd64 | Intel N150 / 16 GB | **this script: never run** | — | — | — | — | — | — |
| pi4 | arm64 | Raspberry Pi 4 / 8 GB | **never run** | — | — | — | — | — | — |

The `default` profile records the host it ran on, not a hardware claim. The
`n150` and `pi4` rows stay empty until the script runs on those boxes: "it
installs" and "it installs in ten minutes on the hardware CE targets" are
different claims and only one of them is proven here.

### Published-image and live isolation run — 4 September 2026

The public-alpha path was tested separately on an Apple Silicon Mac Mini with
Docker Desktop 29.7.2 and Buildx 0.36.1. The test began in an empty directory
and used only the published `josi-ce-installer:0.1.0` and
`josi-ce:0.1.0` images. Both OCI indexes were independently inspected and
contained `linux/amd64` and `linux/arm64` manifests plus SBOM/provenance
attestations.

The first published-image run found that restrictive checkout directory modes
were preserved into the image, preventing the non-root runtime user from
traversing `packages/db`. The second found that the generated browser URL named
port 8080 while only ports 80/443 were published. Both were fixed and the run
was restarted from a new database volume. The passing run proved:

- the one-shot installer generated mode-0600 secrets and then exited;
- migrations completed and PostgreSQL, web, worker and Caddy were healthy;
- `/health` and the web UI returned HTTP 200 at the generated URL;
- no installer container or Docker-socket mount remained in the running stack;
- `scripts/test-persona-runtime.sh`, pointed at that published installation,
  passed **69 checks with 0 failures** across three real HTTP sessions and real
  PostgreSQL rows. Alice and Bob could not read, delete, import or inject each
  other's profiles, memories, prompts or live turns, and neither a member nor
  the super administrator could cross the per-user memory boundary.

This run used a local OpenAI-compatible stub on the installation's Docker
network so the model boundary was exercised without sending data to a third
party. It proves request assembly and user isolation, not the behaviour of a
commercial model provider.

**A real first install HAS happened on the N150**, by hand rather than by this
script, and it is written up in `docs/FIRST_INSTALL_FINDINGS.md`. That run
confirmed the stack starts, all four containers report healthy, migrations exit
0, and `/health` and `/ready` both answer — and it produced six open findings,
including the scheme-qualified `JOSI_DOMAIN` defect this script's own site
address fix does not cover. The `n150` row above stays empty regardless: a
manual install and a scripted acceptance run measure different things, and
filling the row from the former would be exactly the curation this table exists
to prevent.

### What the first run found

The first run to actually boot the stack failed 36 of 55 checks on a single
line. The bundled proxy's site address was a bare hostname defaulting to
`localhost`, which is what turns Caddy's automatic HTTPS ON — so every
plain-HTTP request was answered with `308 Permanent Redirect` to `https://`
on a port that had been dropped. The documented LAN path did not work at all,
and no static test could see it because the line was syntactically perfect.

That is the entire argument for this script existing. Four further rounds were
needed before the run said anything trustworthy, and every one of those was a
defect in the harness rather than the product:

- the run configured itself into the same defect by exporting
  `JOSI_DOMAIN=localhost`, so it could not have caught it;
- it never fetched a CSRF token, so every POST was refused 403 and the whole
  wizard section reported failures that said nothing about the product;
- the sealed-credential probe passed `ENC=` where the shell read it as an
  argument rather than an assignment, so it reported a decryption error
  regardless of what was stored;
- the Phase 13.3 section gave `python3` two stdin redirections, so the JSON
  body was executed as the program. It had never run, and its verdicts were
  printed where the summary could not count them — a traceback sat inside a
  run reporting "0 failed".

### What the passing run does not prove

Five checks are reported **SKIPPED**, which is never counted as a pass:

| Skipped | Exact dependency |
|---|---|
| The wizard closes behind itself | A real model credential |
| The owner can sign in, session resolves | A real model credential |
| No webhook route inside `/api` | A real model credential |
| The Telegram admin surface | A real model credential |
| The subscription-auth options | A real model credential |

All five live past one gate: setup will not finish with a model that has never
been successfully called (LB4.4). That refusal is itself asserted as a pass, so
the gate is tested rather than merely encountered. Supply a working key and the
five run for real:

```bash
JOSI_ACCEPTANCE_LLM_KEY=sk-... bash scripts/acceptance/clean-install.sh
```

No such key has been supplied to this repository, and the five have never run.
Note that `docs/FIRST_INSTALL_FINDINGS.md` FI-003 reports the same gate firing
on a real install against a real OpenAI key, because the verification request
Josi sends is malformed. Until FI-003 is fixed, supplying a key here would very
likely reproduce FI-003 rather than turn these five green — so a future run
that still shows five skips is not necessarily a run that was configured
wrongly.

SMTP is skipped by the same principle: configuring mail means proving mail can
be sent, this host has no relay, and a fixture that passed would report a mail
system that does not exist. Sending is covered by
`scripts/test-mail-runtime.sh` against a real server.

### What will never be proven from this repository

Confirmed by Roman on 2 September 2026. These are not pending; nothing is
queued behind them, and no future run here will fill them in.

| Item | Exact dependency that will not be supplied |
|---|---|
| LB2.10 — subscription path returns a real model response | A ChatGPT account with an active subscription, and a person with a browser to approve the device code |
| LB5.8 — two real users connect real accounts | A Google Cloud project with the People API enabled, and a Microsoft Entra tenant with an app registration |
| LB8 Part B — sync against real providers | `JOSI_REAL_GOOGLE_*` and `JOSI_REAL_MS_*` credentials for real accounts |
| LB9.6 — native contact sync on real devices | A physical iOS device, a physical Android device, and the separate Josi mobile repository |

Each remains **BLOCKED**, which is a statement about evidence and not about the
code: the paths are built and unit-tested, and none of them has ever contacted a
provider. Nothing in this document should be read as claiming otherwise, and no
green count anywhere in this repository covers them.

## The Codex subscription path

`scripts/test-codex-runtime.sh` covers LB2 separately, because the property that
matters there is what happens across an update rather than at install time.
Measured on a Linux test host, **10 passed, 0 failed, 1 skipped**:

- the Dockerfile pins `0.152.0` and the running container reports
  `codex-cli 0.152.0` — the pin is real, not aspirational;
- `CODEX_HOME=/data/codex`, mounted as a named volume, and writable from inside
  a read-only container;
- the container was genuinely replaced (`6dcda9a41a90` → `835a8f41c725`) and
  the replacement read back exactly the bytes the old one wrote. A device login
  that `docker compose pull && up -d` discards is a login the operator repeats
  on every update;
- `codex login status` on a fresh volume says "Not logged in" in words, rather
  than failing the way an absent CLI would.

**SKIPPED:** completing a real device login needs a person with a browser and a
ChatGPT subscription. The parsing of the CLI's output is covered against a
byte-for-byte capture of the pinned version in
`packages/llm/test/codexLogin.test.ts`.

## Operator checklist for a hardware run

## Build-list 13 central Calendar source acceptance — 2026-09-14

Migration `0042` replaces the one-account-per-provider constraint with durable
provider-account identity for Google and Microsoft while retaining the existing
single Nextcloud contract. OAuth re-consent is bound to the selected connection
and refuses account substitution. Workspace → Calendar discovers all calendars
under every enabled account, preserves account/calendar names and colors,
allows each owner to independently include or exclude calendars, aggregates
selected events in day/week/month ranges, and supports owner-only inspection.
Account-scoped capability checks prevent one account's switch from authorizing
another account.

Evidence on this source worktree:

- 2,432 tests passed across 94 files, including HTTP selection isolation and
  secondary-calendar aggregation;
- TypeScript and production build passed;
- the complete migration chain was exercised by the integration suite;
- production dependency audit reported zero vulnerabilities;
- secret scan passed across 535 files; and
- Compose configuration and diff whitespace checks passed.

Published multi-architecture image verification remains a release-time gate;
this source change has not published a numbered release.

## Build-list 14 Master Vault source acceptance — 2026-09-14

Migration `0043` adds one installation control plane, independently random
per-user box keys, AEAD-encrypted items, and session-bound five-minute UI
unlocks. The administrator-created Vault key is wrapped separately by the
installation key and a one-time offline recovery key; only its hash and
fingerprint persist. Setup pauses until the recovery key is confirmed saved.
Users receive masked CRUD, integrity checking, box rotation and strict owner
isolation. Administrators see health, lock, recovery and blocked-job metadata,
but no endpoint enumerates or reveals another user's values. Guardian access
requires the existing password-plus-TOTP, single-use parental authority grant.

New model, OAuth application, connected-account, developer-service, SMTP and
backup credentials use the Vault after initialization. Old sealed values stay
readable for an upgrade but are never silently imported; re-entry or rotation
moves them to the Vault. Locking fails Vault-backed credential resolution
closed, clears UI unlocks, and records a metadata-only administrator alert.
Full backup rows include the encrypted Vault but neither recovery key.

Published multi-architecture image verification remains a release-time gate;
this source change has not published a numbered release.

## Build-list 7–12 source acceptance — 2026-09-14

Telegram is again reachable from Admin → Channels without replacing WhatsApp
or Slack. Backup destination selection is one controlled radio group, so its
highlight, keyboard state, and submitted destination cannot diverge. Full
backups can target a tested mounted NAS path under `/mnt` or `/data`; the server
requires a real read/write probe before using it. Every Developer Service is an
accessible disclosure that opens automatically when a connection needs
attention. Family and Parental Controls expose only a disabled Coming Soon
teaser with no active safety claims. Setup creates and populates the singleton
workspace before completion, migration `0040` backfills missing rows without
overwriting valid ones, and Admin offers an authenticated recovery action.

Evidence on this source worktree:

- 2,429 tests passed across 94 files;
- TypeScript and production build passed;
- the complete migration chain was exercised by the setup integration suite;
- production dependency audit reported zero vulnerabilities;
- secret scan passed across 533 files;
- Compose configuration and diff whitespace checks passed.

Published multi-architecture image verification remains a release-time gate;
this host's Docker installation does not provide Buildx.

## Parental Controls integration — 2026-09-13

The complete paid Parental Controls module was restored onto current public
main after the v0.1.5 source rebuild had removed its family routes, UI,
enforcement, and migration while leaving only the licence-management shell.
The integrated module provides managed-child account creation, explicit
parent/controller authority, password-plus-TOTP relationship changes,
conversation visibility, schedules, daily limits, usage summaries, Child Mode
disclosures, server-side turn enforcement, audit events, and unlink cleanup.
It explicitly does not claim device, browser, or third-party-app enforcement.

Evidence on Bananana (Linux, Node 26.8.1, Docker Engine 29.7.2):

- TypeScript and the production build passed;
- 2,415 tests passed across 93 files;
- the focused parental/licence suite passed 93 tests, including cross-family
  isolation and all-channel enforcement;
- the current two-part signed licence format activates the parental entitlement,
  so already-issued v0.1.16 licences remain valid;
- all 40 migrations applied to a fresh PostgreSQL 16 database, with Parental
  Controls assigned the non-colliding `0039_parental_controls.sql` migration;
- `npm audit --audit-level=high` reported zero vulnerabilities;
- the repository secret scan was clean across 527 files; and
- diff whitespace checks passed.

Published-image, clean-install, and authenticated browser evidence are recorded
separately after a versioned multi-architecture artifact exists. They are not
claimed by the source-level evidence above.

## Talk mockup fidelity — 2026-09-12

The mobile Talk redesign was verified at a 390×844 viewport against the
approved mockup, using the real authenticated browser harness and microphone
capture path. The compact Josi header, separate message timestamps, delivery
marks, centered Voice Box status, rounded composer, and icon navigation all
rendered in the browser. `scripts/test-voice-browser.mjs` passed microphone
capture, partial/final transcription, assistant response, speech interruption,
and media-track cleanup. The complete release gate passed 2,307 tests, the
production web build and TypeScript check, zero high-severity dependency audit
findings, and the 502-file secret scan.

Browser evidence was captured at `/tmp/josi-voice-browser-x1ukoD/talk.png` on
the test host; this path is ephemeral and records the environment rather than
shipping an acceptance artifact.

1. Start from a machine with Docker installed and **no Josi containers,
   volumes or images**. If it has been used before, `docker system prune -a` on
   a machine you are willing to prune.
2. Clone the repository at the exact tag being accepted. Note the commit.
3. `bash scripts/acceptance/clean-install.sh --profile n150`
4. Record every `TIME` line into the table above, with the date and the commit.
5. If anything failed, attach the bundle path and do **not** mark the profile
   as passing.
6. Tear down: the script does this itself unless `--keep` was given.

### On the N150 specifically

- 4 efficiency cores and no hyperthreading. The image build is the slow step and
  is dominated by `npm ci` and `tsc -b`; expect it to be several times a laptop.
- 16 GB is comfortable for the default stack. It is **not** comfortable with
  ClamAV enabled at the same time as OCR — the profile lowers both ceilings and
  that is a hint rather than a guarantee.
- Storage is usually NVMe on these boxes. If it is eMMC, the database will be
  the bottleneck and the boot timing will not resemble the table.

### On the Pi 4 specifically — not yet attempted

- arm64. The image is built for it, and Phase 2 proved the manifest resolves per
  platform, but nothing has been installed on one.
- 8 GB with slow USB or SD storage. Swap behaviour will dominate any timing, and
  a timing taken with swap thrashing is not a measurement of Josi.
- `@node-rs/argon2` ships an arm64 prebuild, so no compiler is needed. That is
  the assumption a real run has to confirm.
