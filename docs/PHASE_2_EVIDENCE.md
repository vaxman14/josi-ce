# Phase 2 evidence

Runtime verification performed 2026-08-31 on a dedicated LAN Docker host. Every claim
below is either backed by recorded output or explicitly marked unproven.

## Test environment

| | |
|---|---|
| Host | a dedicated LAN Docker host (x86_64) |
| OS | Ubuntu 26.04 LTS |
| Architecture | x86_64, 16 cores, 28 GB RAM, 3.0 TB free |
| Docker | 29.1.3, build 29.1.3-0ubuntu4.1 |
| Compose | v5.5.0 |
| buildx | v0.30.1 (installed as a user-local CLI plugin at `~/.docker/cli-plugins/`, no system packages touched) |
| QEMU | `qemu-aarch64` binfmt handler registered via `tonistiigi/binfmt --install arm64` |
| Compose project | `josi-ce-test` (isolated; 24 pre-existing containers across 5 unrelated projects untouched) |
| Host ports used | 8380/8543 — the host already serves 80/443 |

Source under test was cloned from `github.com/vaxman14/josi-ce` and checked out
by commit hash, verified: `15e1388b1ed8e5c293e5646b8d9ec319ddbad7c6`, clean tree.

---

## Runs

| Run | Commit | Result | What it found |
|---|---|---|---|
| 1 | `15e1388` | 33 passed, 1 failed | Caddy could not bind `0.0.0.0:80` on a populated host. **And a false pass**: "caddy cannot reach the database" passed *while caddy was not running*, because `docker compose exec` into a dead container fails and the check read that as isolation. |
| 2 | `c4a6d2f` | 32 passed, 2 failed | Port preflight fixed. The new positive control immediately earned its place: it reported "the probe is broken: caddy cannot reach web either". Caddy was **restart-looping**. |
| 3 | `f94ff32` | **36 passed, 0 failed** | Green. |

### The defect that mattered

```
caddy-1 | Error: adapting config using caddyfile: parsing caddyfile tokens for
          'email': wrong argument count or unexpected line ending after 'email',
          at /etc/caddy/Caddyfile:14
restarting=true exit=1
```

The Caddyfile had `email {$JOSI_ACME_EMAIL}`. Caddy substitutes an unset
variable with nothing, so the line became a bare `email` — a parse error.
**Every fresh install that did not set an ACME email would have had no reverse
proxy at all**, which is the default case. Two commits passed a green static
suite with this in place. It was invisible until the stack was booted.

Fixed by removing the directive (ACME issues fine without a contact address) and
adding a regression test that rejects any directive whose only argument is a
defaultless `{$VAR}` substitution — verified to fail when the original line is
restored.

---

## Run 3 output, verbatim

```
using host ports 8380/8543

== starting from an empty Docker state for this project
  PASS  no containers for project josi-ce-test
  PASS  no volumes for project josi-ce-test

== generating installation secrets
  PASS  install.sh produced usable secrets
  PASS  master key is mode 600

== fresh install
  PASS  docker compose up succeeded
  PASS  migrator exited 0

== waiting for readiness
  PASS  /ready returned 200: {"ready":true,"blockers":[]}
  PASS  /health returned 200

== disabled OCR and ClamAV profiles consume nothing
  PASS  ocr: no container exists
  PASS  clamav: no container exists
  PASS  clamav image was never pulled
  INFO  running services: caddy db web worker
  PASS  no optional service is running
  PASS  all four required services are running

== master key handling
  PASS  no key material in the container environment
  PASS  MASTER_KEY_FILE names a path, not a value
  PASS  master key is readable at /run/secrets/josi_master_key
  PASS  no image layer references the master key
  PASS  the key value never appears in logs
  PASS  web logged that it loaded the key (without the value)

== container hardening
  PASS  web runs as uid 1000 (non-root)
  PASS  web has a read-only root filesystem
  PASS  web drops all capabilities
  PASS  web sets no-new-privileges
  PASS  worker runs as uid 1000 (non-root)
  PASS  worker has a read-only root filesystem
  PASS  worker drops all capabilities
  PASS  worker sets no-new-privileges

== least-privilege networking
  PASS  the database publishes no host port
  PASS  probe works: a container on the edge network reaches web:8080
  PASS  the database is NOT reachable from the edge network
  PASS  caddy is running
  PASS  web serves on its own port

== restart and persistence
  PASS  wrote a marker row
  PASS  data survived a restart
  PASS  data survived down/up (named volume)
  PASS  migrator was idempotent on the second boot

== image size
  INFO  application image: 86 MB

36 passed, 0 failed
```

Commands:

```
git clone https://github.com/vaxman14/josi-ce.git && git checkout f94ff32
JOSI_HTTP_PORT=8380 JOSI_HTTPS_PORT=8543 bash scripts/test-docker.sh
```

---

## Architecture builds

```
$ bash scripts/build-multiarch.sh --load-native
built linux/amd64  86089208 bytes

$ bash scripts/build-multiarch.sh          # linux/amd64,linux/arm64
[both platforms complete through npm ci, tsc -b and npm prune]

$ docker buildx build --platform linux/arm64 --tag josi-ce:arm64-proof --load .
$ docker image inspect josi-ce:arm64-proof --format "os={{.Os}} arch={{.Architecture}} size={{.Size}}"
os=linux arch=arm64 size=85919548

$ docker run --rm --platform linux/arm64 josi-ce:arm64-proof node -e '…'
{"arch":"arm64","platform":"linux","node":"v22.23.2"}

$ docker run --rm --platform linux/arm64 josi-ce:arm64-proof node -e '@node-rs/argon2 hash'
argon2 ok, hash len 97
```

### Image size — the number that matters is not the one `inspect` prints

`docker image inspect --format '{{.Size}}'` reports only the layers this image
adds on top of its base. `docker system df -v` reports what an operator actually
stores and downloads. They differ by a factor of four here, so both are recorded:

```
$ docker system df -v
REPOSITORY   TAG           SIZE     SHARED SIZE   UNIQUE SIZE
josi-ce      local         352MB    266MB         86.09MB
josi-ce      arm64-proof   372MB    0B            371.9MB
```

| Platform | Total image | CE's own layers | Base (`node:22-bookworm-slim`) | Built | Executes | Native bindings |
|---|---|---|---|---|---|---|
| linux/amd64 | **352 MB** | 86.1 MB | 266 MB | yes | yes (native, full stack ran) | yes |
| linux/arm64 | **372 MB** | 85.9 MB | ~286 MB | yes (QEMU) | yes (`process.arch: arm64`) | **yes — argon2 hashed** |

An earlier draft of this file reported "86 MB", which was the unique-layer
figure and would have understated a fresh pull by ~4×. On a Raspberry Pi with a
small SD card that is a material difference, so the total is the headline.

**Three quarters of the image is the Node base**, not Josi. `node:22-alpine`
would cut roughly 200 MB, but Alpine is musl rather than glibc and
`@node-rs/argon2`'s prebuilt binaries would need the musl variant — which is
exactly the assumption this phase went to the trouble of testing. Switching the
base is a real optimisation for low-end hardware and a candidate for a later
phase; it is not a change to make after verification has already been run
against this one.

The argon2 check matters specifically: `@node-rs/argon2` is the one native
dependency, and `npm ci --ignore-scripts` relies on its prebuilt per-platform
binaries. Proving it loads and hashes under arm64 is what makes `--ignore-scripts`
safe on both architectures rather than merely assumed.

**A multi-arch manifest is NOT proven.** Both platforms build, and the arm64
artefact runs — but a manifest list only exists once pushed to a registry.
`--load` cannot accept a multi-platform result (Docker's image store holds one
architecture per tag). Publishing requires explicit approval and has not been
requested.

---

## Proven / unproven matrix

### Proven at runtime on the test host

| Claim | Evidence |
|---|---|
| Fresh install boots (web, worker, db, caddy + migrator) | run 3, `docker compose up succeeded`, all four services running |
| Migrator runs to completion before the app starts | `migrator exited 0`; `service_completed_successfully` gate |
| Migrations are idempotent | `migrator was idempotent on the second boot` |
| `/health` returns 200 | run 3 |
| `/ready` returns 200 with `{"ready":true,"blockers":[]}` | run 3 |
| Disabled OCR/ClamAV consume nothing | zero containers; **ClamAV image never pulled** |
| Master key is a mounted file, readable at `/run/secrets/` | run 3 |
| No key material in the container environment | `docker inspect .Config.Env` grep |
| No image layer references the key | `docker history --no-trunc` grep |
| Key value never appears in logs | `docker compose logs` grepped for the actual bytes |
| web + worker run as uid 1000 | `exec id -u` |
| Read-only rootfs | `docker inspect .HostConfig.ReadonlyRootfs` |
| All capabilities dropped | `docker inspect .HostConfig.CapDrop` |
| `no-new-privileges` set | `docker inspect .HostConfig.SecurityOpt` |
| Database publishes no host port | `docker inspect .NetworkSettings.Ports` |
| **Database unreachable from the edge network** | disposable container on `edge`: reaches `web:8080`, cannot reach `db:5432` |
| Data survives `restart` | marker row re-read |
| Data survives `down` + `up` (named volume) | marker row re-read |
| amd64 image builds and runs | 352 MB total (86.1 MB CE layers) |
| arm64 image builds, runs, native bindings load | 372 MB total (85.9 MB CE layers) |
| Installer: 32-byte CSPRNG key, mode 600, never printed, refuses overwrite | executed locally and on the test host |

### Still unproven

| Claim | Why | What would prove it |
|---|---|---|
| **Fresh install from a genuinely empty Docker daemon** | The designated Proxmox host is **powered off** — no ping response, incomplete ARP entry, SSH and web UI ports closed. Memory records it was shut down for thermal reasons (damaged cooling mount). Only the router and the Docker host respond on the LAN. | Power on the Proxmox host, or provide another disposable machine. the host's daemon is populated; the run above proves an empty *compose project*, not an empty *daemon*. |
| Multi-arch **manifest** published | Requires pushing to a registry | Explicit approval to push, then `docker buildx imagetools inspect` |
| Automatic HTTPS against a real domain | Test ran on `localhost` with alternate ports; no ACME challenge was performed | An install on a public domain with 80/443 reachable |
| Bring-your-own-proxy mode | Documented, never exercised | Run with `COMPOSE_PROFILES=noproxy` and an external proxy |
| ARM64 **on real ARM hardware** | Verified under QEMU emulation only | A Raspberry Pi or ARM server |
| Capacity / concurrency | **Deliberately unmeasured.** Canonical map M97 forbids published numbers without benchmarks on Pi-class ARM64, old x86-64, and a modern mini-PC. | Those three benchmark runs |

Image sizes above are measurements of disk footprint, not capacity claims. They
say nothing about how many users an installation supports.

---

## Static verification (unchanged, still green)

73 tests, `npm test` — 22 authorization, 11 readiness, 11 master key, 29
packaging. Mutation-tested: publishing the database port fails 2, moving the key
to an env var fails 2, removing ClamAV's profile fails 1, restoring the broken
`email` line fails 1, granting the super admin ownership fails 1, downgrading
404→403 fails 4. All restored green.

## Cleanup performed

`docker compose -p josi-ce-test down -v --remove-orphans` removed every
container, volume and network this test created. The probe project
`josi-ce-probe` was likewise removed. Two test images remain on the host
(`josi-ce:local`, `josi-ce:arm64-proof`) plus the buildx builder container; the
24 pre-existing containers across `deploy`, `fivel`, `hephy`, `josi-engine` and
`zammad-docker-compose` were never touched.

## Host changes made to the test host

Both were explicitly authorised for the ARM64 requirement:

1. buildx v0.30.1 installed to `~/.docker/cli-plugins/docker-buildx` (user-local,
   no `apt`, no system files).
2. `qemu-aarch64` binfmt handler registered via `docker run --privileged --rm
   tonistiigi/binfmt --install arm64`. This is a host-level kernel registration
   and **persists until reboot**. It affects nothing else on the machine other
   than allowing arm64 binaries to execute.
