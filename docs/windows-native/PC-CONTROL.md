# Windows PC control permissions and next desktop phase

## Current implementation and boundary

The native Windows owner has **PC control permissions** under Administration,
at `/admin/pc-control`. The master switch **Allow Josi to control this PC** defaults
off. Turning it on grants no scope. This phase implements persistent encrypted
permissions, human decisions, an activity log and a transactional execution broker.
It does **not** ship a desktop automation executor or bundle/execute a desktop
installer. The UI explicitly reports that control is unavailable until the separate
Windows desktop client is connected. Nothing in this phase controls Roman's PC.

The current identity is the local hosting PC, fixed by trusted server code. Only
the installation owner's authenticated session can manage it. HTTP requests cannot
choose a different owner or PC. Other platforms get 404, and ordinary members get
403. Native paired clients will need distinct authenticated PC identities and
interactive Windows-user consent; an installation account alone must not grant
access to every PC. General email, calendar, workspace and connector policies are
unchanged and are never interpreted as desktop grants.

The additive migration `0065_pc_control_permissions.sql` creates four new tables.
It has not been applied to the accepted live database. The `.5` live installation,
`.6` acceptance EXE/payloads/checksums and all recovery material are unchanged.
No new installer candidate is built for this source-only phase.

## Scope catalogue

| Capability | Exact scope | Separate approval for each action |
| --- | --- | --- |
| Browser viewing/navigation | Browser executable + profile + website origin | Unlisted/ask scopes ask |
| Browser form filling | Same three identities; independent of viewing | Unlisted/ask scopes ask |
| Submission/messages | Same three identities + prepared exact action | Always |
| Purchases/financial actions | Same three identities + prepared exact action | Always |
| Downloads | Browser identities and declared destination-folder effects | Unlisted/ask scopes ask |
| Uploads | Browser identities and declared source-folder effects | Always |
| File Explorer viewing | Exact local folder | Unlisted/ask scopes ask |
| Folder read | Exact local folder | Unlisted/ask scopes ask |
| Folder create/edit | Exact local folder; independent of read | Unlisted/ask scopes ask |
| Rename | Exact affected folder | Unlisted/ask scopes ask |
| Move | Source and destination folder effects | Unlisted/ask scopes ask |
| Delete | Exact affected folder + prepared files | Always |
| Launch application | Exact executable | Unlisted/ask scopes ask |
| Control application | Exact executable/window + prepared action | Always (generic control can hide high-risk effects) |
| Close application | Exact executable/window | Always (unsaved changes may be lost) |
| Terminate application | Exact executable/process instance | Always |
| Commands/scripts/builds/tests | Exact runner executable + working folder + prepared invocation | Always |
| Install software | Exact software scope/version + prepared installation | Always |
| Uninstall software | Exact installed product + prepared removal | Always |
| Change system settings | Exact settings scope + prepared change | Always |
| Credential/secret access | Exact credential/item identifier | Always; existing Vault ownership/unlock also remains required |
| Security-setting changes | Exact setting + prepared change | Always |
| Administrator elevation | Exact prepared action | Always, followed by real Windows UAC |

There are no wildcard grants. HTTPS and HTTP origins, ports, subdomains, browser
executables and profiles are separate. No origin path/query/token is stored as a
scope. Folder permission never grants its parent, children or siblings, or another
operation. Paths must be absolute local drive paths: UNC/device paths, ADS, traversal,
wildcards and ambiguous trailing dots/spaces are rejected. Case is retained to avoid
overgranting on case-sensitive NTFS directories. Exact aliases may require another
consent; the future desktop must resolve final handles and identities safely.

## Approval modes and lifetime

Each capability/scope has all five choices:

- **Never allow:** blocks even an existing broad grant or attempted one-time approval.
- **Ask every time:** a ten-minute, exact prepared action must be approved once.
- **Allow for this task:** requires an active task owned by the same account; ends
  when that task finishes/fails/is cancelled, or after 24 hours, whichever is earlier.
- **Allow temporarily:** explicit expiration, no more than 24 hours from consent.
- **Always allow for this exact scope:** retained across restarts/upgrades; no inheritance.

Unlisted scopes ask each time while the master switch is on. With the switch off,
everything is blocked. High-risk operations always ask, including under task,
temporary or always choices. The approval UI identifies the action, every required
scope, read-only/read-write status, task when present and exact expiration, with
Approve once/Deny. High-risk approval additionally checks the owner's current
password server-side. Passwords are never stored in permission records or activity.
Temporary/task cards show the exact capability, scope, task, expiry and Revoke.
Active tasks are selectable by name/date and distinct identity.

`PcControl.propose` is a trusted internal seam, not an exposed chat tool or an HTTP
command endpoint. It snapshots canonical bounded JSON, encrypts it and pins it with
an owner/PC-bound HMAC. `decide` changes only an active owned pending request.
`execute` commits a single-use claim under a row lock, rechecks the master/epoch,
exact manifest, current scope policy, expiry and task before dispatch. Modified
payloads, concurrent replay, expired grants, revocation and changed policy fail
closed. An action left executing by a crash is never retried automatically. All
declared effects must pass together; a never-denied effect blocks the whole action.
The desktop adapter, not a model or untrusted document, must declare complete effects.

## Storage, audit and stopping

Scope descriptions, action payloads and sensitive activity metadata use the existing
installation AES-256-GCM key outside the local PostgreSQL database. HMAC scope/request
indexes avoid plaintext paths or action payloads. No new owner, recovery key or
installation secret is created. Records bind their ciphertext to both owner and PC.
Only coarse event kinds/timestamps, modes, state and expiry are plaintext. Reads
are authenticated and `no-store`; DTOs never expose ciphertext or execution payloads.
The readable activity log shows the latest 100 attempts, approvals, access/change
actions, launches and outcomes. It omits form values, credential values, command
output and executor exceptions. Descriptions are trusted, redacted human previews,
not model-provided commands. The stored log remains available across restarts.

**Stop control and revoke temporary access** synchronously aborts active broker
signals, disables the master switch, increments its revocation epoch, revokes
pending/approved actions and deletes task/temporary grants. Permanent choices
survive, but grant nothing until deliberately enabled again. Revoke/policy changes
also cancel active broker signals and invalidate queued approvals. Emergency disable
works without the encryption key and with broken permission ciphertext; its
nonsensitive audit event can still be recorded. A completed change cannot be undone,
and a cancellation signal is not a claim that an external operation has stopped.

Windows UAC remains authoritative. No registry/UAC/firewall/Defender changes, UAC
bypass, scheduled elevated agent, standing administrator token or future-prompt
preapproval is implemented or permitted by a Josi scope. The accepted server's
service isolation and local-only listeners remain unchanged.

## Next bounded phase: separate existing Windows desktop client

**Gate: Roman completes the current native-server `.6` physical acceptance first.**
Do not implement installer bundling before that gate. The published desktop EXE
already retained as a download/resume fixture is not a server payload and has never
been run here. Its source/protocol/control capabilities must be inspected and
verified; this checkout has no Windows desktop automation executor. Reuse the
existing client rather than fabricate another owner/account/application database.

The next phase must deliver these independently verifiable steps:

1. Identify/pin the existing client source/version, signature, hash, licenses/SBOM,
   supported local-server authentication and independent maintenance contract.
2. Add installer component selection: **Josi Hosting Server (required)** and
   **Josi Desktop App (selected by default, optional)**. The client remains a
   separate installed application in the interactive user's session, never inside
   a server service. Declining it leaves the hosting server fully usable.
3. Support independent client install/repair/upgrade/uninstall. Client maintenance
   must never remove server PostgreSQL, secrets, config, artifacts, recovery keys,
   snapshots, rollback material or permissions. Test both component selections,
   interrupted client repair and uninstall on a disposable installation only.
4. Securely discover and connect to the local host automatically, with verified
   server/device identity, interactive-user consent and a bounded single-use
   pairing/session exchange. Inspect the client's actual transport first. If it
   cannot authenticate the local server securely, stop rather than invent a
   plaintext credential shortcut. Never pass secrets in arguments/logs/URLs.
   Server accounts, recovery material and application data stay canonical on the
   server; a protected client session is not a duplicate installation master key.
5. Integrate `PcControl` with a narrow authenticated local control bridge. Only
   an interactive Windows user may attach that PC. Resolve application image,
   instance/window, browser profile, origin and final folder/file handle identities
   before preview and again before each operation. Reject reparse/alias/foreground
   changes and undeclared effects. Bind exact nonsecret previews to all targets,
   recipient/form fields, purchase amount/currency, invocation and expected file
   versions. Reading permission must never enable submitting, invoking JS, secret
   inspection or arbitrary keyboard/click actions. File moves check both folders;
   downloads check destination-write and uploads source-read. Generic control or
   commands always retain per-action human approval and their constituent gates.
   The current typed path choices are saved intentions, not verified native
   file/window identities. Preserve those records during upgrade, but require
   local confirmation of resolved identities before they can authorize a newly
   attached executor. Do not silently promote old path-only choices into broad
   control grants. Pin the executable identity so replacement at the same path
   cannot substitute another approved application.
6. Make the bridge observe revocation/task expiry before each bounded operation,
   honour cancellation/watchdog and stop only its own controlled jobs. No blanket
   process killing or undo claims. Propagate real UAC results honestly. Test hostile
   scope substitutions, redirects, aliases, hidden effects, revoked consent,
   mid-action stop, credential boundaries and isolation using disposable targets.
7. Produce a new versioned acceptance candidate after source/runtime and component
   verification. Preserve `.5` and `.6`; no push, publication or signing without
   authorization/credentials. Roman performs hardware/UAC/authenticated acceptance.

## Verification

Machine-readable evidence belongs in ignored `artifacts/windows-native/evidence/`:
`pc-control-core-tests.json` (scope/mode/replay/expiry/stop/storage preservation),
`pc-control-http-tests.json` (real authenticated endpoints, CSRF, password gating,
native boundary, key-unavailable emergency stop and real headless browser UI), and
`pc-control-verification.json` (compilation, candidate/recovery hashes, no deployment).
These checks use only disposable in-memory databases and a new browser profile.
They never connect to the installed database or execute a PC-control operation.
Actual desktop execution, UAC/hardware cancellation and independent client
lifecycle remain acceptance work for the next phase, not passing claims here.

Final source-phase result: 47 passing checks (30 core permission, five real
HTTP/browser, 12 existing approval-policy regressions), zero failures. API/package
compilation, web typecheck, production web build and 904-file secret scan passed.
Every delivered `.6` checksum and 19 preserved original/recovery hashes matched.
