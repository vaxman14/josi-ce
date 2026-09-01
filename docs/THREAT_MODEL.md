# Josi CE 0.1 — Threat model

Every entry below names a **Control** (where the defence lives) and a **Test**
(what would fail if it were removed), or is marked **Accepted** with a reason.
`apps/api/test/threatModel.test.ts` parses this file and fails the suite if any
entry is missing one, if a named control file does not exist, or if a named test
is not in the suite. The acceptance criterion for Phase 11 is therefore checked
by the build rather than by reading.

Entries are written as *what the attacker does*, not as a feature that exists.

## How to read an entry

```
### T-nn Title
**Attacker:** who, and what they already have
**Impact:** what they get if it works
**Control:** path/to/file.ts — one line on the mechanism
**Test:** the exact test name that fails if the control is removed
```

---

## Setup and installation

### T-01 Setup is completed by whoever reaches the server first
**Attacker:** anyone who can reach a freshly deployed installation before its
owner does.
**Impact:** they become the super admin of somebody else's installation.
**Control:** `packages/db/migrations/0002_setup.sql` — a single-row `setup_state`
with a completion timestamp; the wizard refuses once it is set, so setup is a
one-shot rather than a route that stays open.
**Test:** refuses replaying a completed step

### T-02 The master key is read out of the image, the database, or a log
**Attacker:** anyone holding a database dump, an image layer, or log output.
**Impact:** every stored credential becomes readable.
**Control:** `packages/core/src/masterKey.ts` — mounted as a Docker secret, and
`MasterKey`/`Secret` redact through `String`, template literals, `JSON.stringify`
and `util.inspect`.
**Test:** never bakes a secret into the image

### T-03 A weak or reused installation key is accepted
**Attacker:** an operator in a hurry.
**Impact:** brute-forceable credential encryption.
**Control:** `scripts/install.sh` — 32 bytes from a CSPRNG, `umask 077`, refuses
to overwrite an existing key because a new one orphans every stored credential.
**Test:** generates the key from a CSPRNG and never prints it

---

## Authentication and sessions

### T-04 Credential stuffing against sign-in
**Attacker:** anyone with a password list.
**Impact:** account takeover.
**Control:** `packages/auth/src/ratelimit.ts` — failures counted per identifier
and per IP, forgotten on success, since what is being limited is guessing.
**Test:** locks out after repeated failures

### T-05 A stolen session is used to change security settings
**Attacker:** someone with a live session from an unlocked screen.
**Impact:** silent privilege or configuration change.
**Control:** `packages/core/src/stepUp.ts` — re-authentication for sensitive
actions. This defends a held session, not a stolen password.
**Test:** refuses a consequential action on a session alone

### T-06 Cross-site request forgery
**Attacker:** any site the user visits while signed in.
**Impact:** actions performed as the user.
**Control:** `apps/api/src/http/cookies.ts` — double-submit token required on
every mutating request; a GET needs none.
**Test:** refuses a state-changing request with no token

---

## Isolation between users

### T-07 One member reads another member's content
**Attacker:** an ordinary member of the same workspace.
**Impact:** access to a colleague's threads, mail, documents or mappings.
**Control:** `packages/core/src/ownership.ts` — one decision point, owner or an
explicit share, and **404 rather than 403** so the reply does not confirm the
row exists.
**Test:** 404 a colleague, and 404 the administrator

### T-08 The super admin reads member content through an admin screen
**Attacker:** the installation's own administrator.
**Impact:** the privacy promise of the product fails.
**Control:** `apps/api/src/http/storageRoutes.ts` and `mailRoutes.ts` — admin
routes read metadata tables that have no content columns, so widening a SELECT
cannot leak content.
**Test:** contains no subject and no body

### T-09 A share is used to widen or pass on access
**Attacker:** a colleague who was given access to help.
**Impact:** access compounds beyond what the owner agreed to.
**Control:** `apps/api/src/http/authz.ts` — sharing requires `owner`, not
`write`, so somebody trusted to help cannot decide who else reads it.
**Test:** a colleague with write access cannot share it onward

---

## Connectors and outbound requests

### T-10 An operator-supplied endpoint reaches cloud metadata
**Attacker:** an operator pasting a URL from a forum post, or one who has been
socially engineered.
**Impact:** the host's cloud IAM credentials are exfiltrated.
**Control:** `packages/llm/src/ssrf.ts` — link-local and metadata ranges refused
at request time as well as save time, redirects never followed.
**Test:** refuses a cloud-metadata endpoint

### T-11 A telemetry or support URL bypasses the SSRF guard
**Attacker:** the same operator, using the settings Phase 10 added.
**Impact:** as T-10, through a surface built later than the guard.
**Control:** `packages/ops/src/telemetry.ts` — `assertOutboundUrlSafe` on set and
again on send, because a hostname that resolved benignly when saved can resolve
to metadata later.
**Test:** refuses one that only resolves to metadata at send time

### T-12 An OAuth callback is used to attach somebody else's account
**Attacker:** anyone who can reach the callback URL.
**Impact:** a connection created under the wrong user.
**Control:** `packages/connectors/src/oauthState.ts` — the state row carries the
user and session; the callback never trusts a query parameter for identity.
**Test:** refuses a callback carrying another person state

---

## Mapped folders and untrusted files

### T-13 A mapped path escapes its folder
**Attacker:** a member with a mapping, or a crafted filename on disk.
**Impact:** reads anywhere the container can reach.
**Control:** `packages/storage/src/paths.ts` — normalise, structural containment
check, resolve symlinks, check again; `startsWith` is explicitly not used.
**Test:** refuses a symlink that leaves the folder

### T-14 An archive expands until the disk is full
**Attacker:** anyone who can place a file in a mapped folder.
**Impact:** denial of service on a small host.
**Control:** `packages/storage/src/gates.ts` — bounds on entry count, expanded
bytes, recursion depth and wall clock, checked **before** accepting each entry.
**Test:** stops a zip bomb at the size limit, BEFORE accepting the entry

### T-15 An archive entry writes outside the extraction root
**Attacker:** a crafted ZIP.
**Impact:** arbitrary file write.
**Control:** `packages/storage/src/gates.ts` — entry paths get the same traversal
rules as request paths.
**Test:** refuses an entry whose path escapes

### T-16 A malicious document is indexed and its text served back
**Attacker:** anyone who can place a file in a mapped folder.
**Impact:** malware spread, or content laundering through search.
**Control:** `packages/storage/src/ingest.ts` — a finding blocks processing,
purges any extracted text, and **does not touch the source**; an enabled but
unreachable scanner stops processing rather than passing files through.
**Test:** stops processing when the scanner is enabled but unreachable

### T-17 Josi destroys a customer file on a false positive
**Attacker:** none — this is the antivirus being wrong.
**Impact:** data loss caused by the product.
**Control:** `packages/storage/src/ingest.ts` — no move, quarantine, rename or
delete; the source hash is taken before and after so "unmodified" is measured.
**Test:** there is no code path that moves, renames or deletes the source

### T-18 OCR exhausts a small host
**Attacker:** ordinary use on Pi-class hardware.
**Impact:** the installation becomes unusable.
**Control:** `packages/storage/src/queue.ts` — off by default, super-admin only,
concurrency ceiling and an hour window; no per-user override exists.
**Test:** OCR is refused when disabled, with no way for a user to override

---

## Search and derived data

### T-19 Search crosses owners
**Attacker:** a member issuing a crafted query.
**Impact:** reads a colleague's documents.
**Control:** `packages/storage/src/search.ts` — the owner is a required argument
rather than a filter, and no request parameter can widen it.
**Test:** never returns a colleague's document, however well it matches

### T-20 Document text leaves the installation without consent
**Attacker:** an administrator enabling semantic search.
**Impact:** customer documents sent to a third party.
**Control:** `packages/storage/src/search.ts` — Local-only first, then the
administrator's switch, then the individual's consent; consent cannot even be
recorded in Local-only.
**Test:** is refused in Local-only even with the policy on and consent given

### T-21 Revoked access still yields content through old citations
**Attacker:** a member whose access was withdrawn.
**Impact:** continued reading after revocation.
**Control:** `packages/storage/src/search.ts` — citations resolve at display
time, so revocation takes effect immediately without rewriting messages.
**Test:** stops offering it once the document is purged, and says what it was

---

## Mail

### T-22 Josi is used to send mail as somebody else
**Attacker:** a member, or a bug in the send path.
**Impact:** forged mail from a colleague's address.
**Control:** `packages/mail/src/identity.ts` — the From is the installation
mailbox with a display name; the person's own address is never the sender.
**Test:** sends as "<person> via Josi" from the installation mailbox

### T-23 Header injection through an address or subject
**Attacker:** anyone who can influence a recipient string.
**Impact:** added recipients, spoofed headers.
**Control:** `packages/mail/src/identity.ts` — CRLF and `<>,;` refused outright.
**Test:** refuses an address that could carry a second header

### T-24 A reply loop between two automatons
**Attacker:** an ordinary out-of-office reply.
**Impact:** a mail storm from the installation.
**Control:** `packages/mail/src/inbound.ts` — header conventions plus a per-thread
budget, because headers only stop the well-behaved ones.
**Test:** a reply loop terminates

### T-25 An unowned shared inbox forms
**Attacker:** none — this is drift.
**Impact:** everybody can read everybody's correspondence.
**Control:** `packages/mail/src/inbound.ts` — every inbound resolves to a thread
owner or is quarantined; quarantine keeps headers only.
**Test:** quarantines a message with no token rather than guessing an owner

---

## Backup, restore and updates

### T-26 A stolen backup yields credentials
**Attacker:** anyone who obtains an archive.
**Impact:** every provider key, OAuth token and mail password.
**Control:** `packages/ops/src/backup.ts` — the master key is never in an
archive, enforced by a database constraint as well as by absence of a code path.
**Test:** a backup never contains the master key, and the database refuses one that claims to

### T-27 A backup is written somewhere it can be read
**Attacker:** a member with a mapped folder.
**Impact:** an archive of the whole database inside a folder they can read.
**Control:** `packages/db/migrations/0011_operations.sql` — archives constrained
to `/data/backups`, traversal refused, filenames stripped of separators.
**Test:** lives inside Josi and cannot traverse out

### T-28 A broken update leaves the installation unusable
**Attacker:** none — this is a bad release.
**Impact:** downtime with no way back.
**Control:** `packages/ops/src/update.ts` — back up first and refuse to proceed
if that fails, health check afterwards, roll back on failure, and report a failed
rollback as its own category rather than softening it.
**Test:** rolls back when the health check fails, and keeps the old version

### T-29 An update happens without anybody deciding to
**Attacker:** none — this is a default.
**Impact:** an unattended change to a production installation.
**Control:** `packages/db/migrations/0011_operations.sql` — there is no column
that could enable automatic updating, because a setting that exists can be
flipped.
**Test:** there is no setting anywhere that could enable one

---

## Diagnostics and support

### T-30 A support bundle carries customer content
**Attacker:** none — this is the product being careless.
**Impact:** messages or documents in a third party's ticket system.
**Control:** `packages/ops/src/diagnostics.ts` — the builder can only render a
fixed list of sections, so a table added later cannot leak through a redactor
nobody updated.
**Test:** can only produce the sections on the list

### T-31 A bundle carries a credential
**Attacker:** none — a token in a log line.
**Impact:** a live credential in a support ticket.
**Control:** `packages/ops/src/diagnostics.ts` — redaction per section, then a
second scan over the assembled bundle, which must pass before submission.
**Test:** a bundle built from secret-bearing logs comes out clean

### T-32 Something is sent before the user has seen it
**Attacker:** none — this is consent theatre.
**Impact:** the user consented to something they never read.
**Control:** `packages/ops/src/diagnostics.ts` — inspect, then approve, then
scan, as three separate acts, with a database constraint refusing a submission
that skipped any.
**Test:** the database refuses a submission that skipped any step

---

## Telemetry

### T-33 Telemetry carries content or identifiable data
**Attacker:** none — this is a field added later without thought.
**Impact:** customer data leaving every installation, silently and permanently.
**Control:** `packages/ops/src/telemetry.ts` — an allowlist rather than a
denylist, free text refused even in allowlisted fields, nested objects reduced
to counts and flags.
**Test:** carries only allowlisted fields, whatever it is handed

### T-34 Telemetry is on without anybody choosing it
**Attacker:** none — a default.
**Impact:** an installation transmitting without consent.
**Control:** `packages/db/migrations/0002_setup.sql` — off by default with a
constraint that enabling implies a recorded opt-in.
**Test:** is off by default

---

## Resource exhaustion

### T-35 One person exhausts the installation with expensive requests
**Attacker:** any member holding down a button.
**Impact:** a small server made unusable for everybody.
**Control:** `packages/core/src/ratelimit.ts` — per-subject fixed windows on the
expensive endpoints, never global, because a global counter turns a rate limit
into the outage it was meant to prevent.
**Test:** refuses once the allowance is spent, per subject

### T-36 A parser or archive error message quotes the document
**Attacker:** none — this is an error path.
**Impact:** document content in an API response or a log.
**Control:** `packages/storage/src/ingest.ts` and `packages/mail/src/smtp.ts` —
fixed vocabularies of categories; no library message reaches a caller.
**Test:** never repeats the server text, which quotes the message that bounced

---

## Accepted risks

These have no control, deliberately.

### T-37 A compromised host reads everything
**Accepted:** anyone with root on the host can read the master key file, the
database volume and process memory. CE is self-hosted software; defending the
host against its own administrator is not a property it can offer. The
installation guide says so, and recommends full-disk encryption.

### T-38 A malicious administrator abuses their own installation
**Accepted:** an administrator can reset a user's password and sign in as them.
CE narrows this — no admin route reads content, mappings, or mail — so the
abuse is *detectable in the audit log* rather than invisible, but it is not
prevented. A single-workspace product cannot both have an administrator and
defend against one.

### T-39 A user's own LLM provider retains their prompts
**Accepted:** what a provider does with data after it arrives is outside CE's
control. The product's answer is disclosure and Local-only, not a technical
guarantee it cannot make.

### T-40 Deliverability and mail reputation
**Accepted:** whether mail from an installation reaches an inbox depends on SPF,
DKIM, DMARC and the operator's IP reputation. CE makes correct alignment
possible and cannot make it true.

### T-41 Recovery copies are not encrypted by Josi
**Accepted:** M62. Copies inherit the security of the Docker volume and the
host disk. Encrypting them with the master key would put a decryption oracle
next to the data; the honest answer is full-disk encryption, and the product
says so in the words the user sees.
