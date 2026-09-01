# Clean-install acceptance

A record of what has actually been run, on what, and when. **A profile with no
row in the results table has not been tested**, whatever the script's existence
might suggest.

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

**Nothing below has been run yet.** The development host for Phase 13 has no
Docker daemon, and the host earlier phases used is not reachable from it. The
script is written and syntax-checked; that is all that is currently true.

| Profile | Arch | Host | Date | Result | Image MB | Build s | Boot→ready s | Idle MiB | Bundle |
|---|---|---|---|---|---|---|---|---|---|
| default | — | — | **never run** | — | — | — | — | — | — |
| n150 | amd64 | Intel N150 / 16 GB | **never run** | — | — | — | — | — | — |
| pi4 | arm64 | Raspberry Pi 4 / 8 GB | **never run** | — | — | — | — | — | — |

When a run happens, add a row with the real numbers and keep the failed runs
too. A table of only successes is a table that has been curated.

## Operator checklist for a hardware run

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
