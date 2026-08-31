# Phase 2 evidence

What is proven, how, and — equally important — what is **not yet proven** and
why. Nothing in this file is a claim about hardware capacity.

## Environment used

Phase 2 was implemented on a machine with **no container runtime installed** —
no Docker, Colima, Podman, OrbStack or Rancher Desktop. Every requirement that
can be verified statically has been. Every requirement that needs a running
daemon has an executable script and is marked **UNPROVEN** below.

That distinction is the point of this file. A Dockerfile that has never been
built is a plausible-looking text file.

---

## Proven — 71 automated tests, `npm test`

| # | Claim | Evidence |
|---|---|---|
| 1 | Four required services exist: web/API, worker, PostgreSQL, Caddy | `packaging.test.ts` › "defines web, worker, db and caddy" |
| 2 | Migrations run as a separate step the app waits for | asserts `service_completed_successfully` on both web and worker |
| 3 | OCR and ClamAV are profile-gated | asserts `profiles: [ocr]` / `[clamav]`, and that nothing default depends on them |
| 4 | Optional components carry resource limits | asserts cpu/memory limits on both |
| 5 | Secrets are files, never env vars | asserts `secrets:` file entries, `MASTER_KEY_FILE` path, and that no service env contains `MASTER_KEY`, `CREDENTIALS_KEY`, `POSTGRES_PASSWORD` or `PGPASSWORD` |
| 6 | PostgreSQL reads its password from a file | asserts `POSTGRES_PASSWORD_FILE` |
| 7 | No secret is baked into the image | asserts the Dockerfile never copies `secrets/` and only names the path |
| 8 | Key is generated from a CSPRNG, 0600, never printed, never clobbered | `install.sh` asserted for `openssl rand`/`/dev/urandom`, `umask 077`, `chmod 600`, refuse-to-overwrite, and absence of any `cat` of the key |
| 9 | Database publishes no port and sits on one network | `packaging.test.ts` › "never publishes the database" |
| 10 | Caddy is on `edge` only, so it cannot reach the database | asserts `networks: [edge]` |
| 11 | Only the proxy publishes ports | asserts the published-service list equals `[caddy]` |
| 12 | Capabilities dropped, no-new-privileges, read-only rootfs | asserted per service |
| 13 | Image runs as non-root | asserts `USER node` in the Dockerfile |
| 14 | Caddy keeps exactly one capability | asserts `cap_add: [NET_BIND_SERVICE]` and `cap_drop: [ALL]` |
| 15 | Restart policies and health checks on all long-running services | asserted per service |
| 16 | Named volume for database data | asserts `db_data` mapping |
| 17 | Proxy config is domain-templated, no hosted hostname | asserts `{$JOSI_DOMAIN}`, rejects `heyjosi`/`socalreceptionist` |
| 18 | Caddy admin API bound to loopback | asserts `admin 127.0.0.1:2019` |
| 19 | `/health` never consults the database | `readiness.test.ts` › stays 200 with a dead database |
| 20 | `/ready` proves database + migrations + master key | asserts each blocker independently |
| 21 | `/ready` leaks no topology | asserts a driver error naming host/port/`ECONNREFUSED`/`postgres` never reaches the response |
| 22 | `/ready` uses a closed vocabulary | asserts every blocker across all failure combinations is one of three known values |
| 23 | Master key refuses to load from an environment variable | `masterKey.test.ts` — throws on `MASTER_KEY` / `CREDENTIALS_KEY` |
| 24 | Master key does not leak through printing | asserts redaction via `String`, template literal, `JSON.stringify`, and `util.inspect` (what `console.log` uses), including nested |
| 25 | No capacity claim in the README | asserts the absence of "supports up to N", "N users", "handles N" |

### Mutation testing

Assertions are only worth the failures they cause. Each control was deliberately
broken and the suite re-run:

| Mutation | Tests failed |
|---|---|
| Publish the database port `5432:5432` | 2 |
| Move the master key into a service environment variable | 2 |
| Remove ClamAV's profile so it starts by default | 1 |
| *(Phase 1, re-verified)* super admin gains ownership in `resolveAccess` | 1 |
| *(Phase 1, re-verified)* non-owner 404 downgraded to 403 | 4 |

All restored; 71/71 green.

### Installer, executed

```
$ scripts/install.sh --check     # empty install
  missing: secrets/master.key
  missing: secrets/db_password
  exit=1

$ scripts/install.sh
  master key written to secrets/master.key (mode 600)
  database password written to secrets/db_password (mode 600)
  (neither value printed)

$ ls -l secrets/
  -rw-------  master.key      45 bytes → decodes to exactly 32 bytes
  -rw-------  db_password     32 bytes

$ scripts/install.sh            # re-run
  master key already exists — leaving it alone
  sha256 before == sha256 after

$ git check-ignore secrets/master.key secrets/db_password
  both ignored
```

---

## UNPROVEN — requires a Docker daemon

These are implemented and scripted but **have never been executed**. Do not
treat them as working until `scripts/test-docker.sh` has been run and its output
recorded here.

| Claim | How to prove it | Status |
|---|---|---|
| Fresh install boots from an empty Docker state | `scripts/test-docker.sh` — tears down containers/volumes/images for the project first, then `up -d --build`, then polls `/ready` | **UNPROVEN** |
| Data survives restart and `down`/`up` | same script: writes a marker row, restarts, then does a full `down`/`up` without `-v` and re-reads it | **UNPROVEN** |
| Migrator exits 0 and is idempotent on a second boot | same script | **UNPROVEN** |
| Disabled profiles consume no runtime resources | same script: asserts zero containers for `ocr`/`clamav`, and that the ClamAV image was never even pulled | **UNPROVEN** |
| Containers actually run as non-root at runtime | same script: `exec id -u` on web and worker | **UNPROVEN** |
| Read-only rootfs and dropped caps hold at runtime | same script: `docker inspect` of `ReadonlyRootfs`, `CapDrop`, `SecurityOpt` | **UNPROVEN** |
| Caddy genuinely cannot reach the database | same script: `nc -z db 5432` from inside the caddy container, expected to fail | **UNPROVEN** |
| The key value never appears in logs or image layers | same script: greps `docker compose logs` and `docker history` for the actual key bytes | **UNPROVEN** |
| **amd64 and arm64 both build from this source** | `scripts/build-multiarch.sh` | **UNPROVEN** |
| Image size | recorded by the script; **not** to be converted into a capacity claim | **UNMEASURED** |

### The multi-arch caveat, stated plainly

`scripts/build-multiarch.sh` builds `linux/amd64,linux/arm64` from the one
Dockerfile in one invocation. Two things about it are worth knowing before
anyone claims cross-platform support:

1. Cross-building requires QEMU binfmt registered with the host kernel. Docker
   Desktop ships this; a bare Linux host may need `tonistiigi/binfmt` installed
   first. The script prints the builder's supported platforms so a missing
   emulator is visible rather than a confusing failure.
2. A multi-platform build **cannot be `--load`ed** into the local daemon —
   Docker's image store holds one architecture per tag. Verifying both locally
   means inspecting the build cache; proving a real manifest requires
   `--push` to a registry. Until an image is pushed and
   `docker buildx imagetools inspect` shows both platforms, "multi-arch" is a
   build that succeeded, not a distribution that exists.

The base images used (`node:22-bookworm-slim`, `postgres:16-alpine`,
`caddy:2-alpine`, `clamav/clamav:stable`) all publish amd64 and arm64 variants,
and nothing in the Dockerfile is architecture-specific — `@node-rs/argon2`
ships prebuilt binaries for both, which is why `--ignore-scripts` is safe.
That is a reason to expect it to work, not evidence that it does.

---

## Deliberate decisions worth challenging

**`/ready` names three coarse subsystems** (`database`, `migrations`,
`master_key`) to an unauthenticated caller. An operator needs to know *which*
dependency is down, and a load balancer's probe cannot authenticate. The
alternative — a bare boolean — makes a broken install undiagnosable from
outside. What is withheld is everything specific: hostnames, ports, driver
names, versions, file paths and database error text, each asserted by test.

**Egress is not restricted.** The `data` network is not marked `internal`,
because the API and worker must reach LLM providers, Google and Microsoft. A
network-level egress block would break the product's core function. The control
that matters here is Local-only mode (Phase 4), which refuses external providers
at the application layer.

**Caddy keeps `NET_BIND_SERVICE`.** Binding 80/443 needs it. It drops everything
else and cannot reach the database. Operators who terminate TLS elsewhere can
run without Caddy entirely (`COMPOSE_PROFILES=noproxy`) and publish `web`
directly.

**The worker's health check is a heartbeat file**, not an HTTP endpoint. The
worker has no listening port by design — it is not on the `edge` network and
publishes nothing — so a port-based probe would mean opening one purely to be
checked.
