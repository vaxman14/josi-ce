# P1 contracts and CE client foundation

Date: 19 October 2026. P0 checkpoint: `1f40c4f`. This independently tested foundation does not close P0’s remaining VM/browser gates or constitute a production app release.

## Implementation

- `@josi-ce/protocol` defines versioned goal/step/attempt/event, progress, continuation, automation identity/observation/action, control lease, vault authority reference, permission verdict, and receipt types. Control-target matching is a consistency check, not an executor or authorization decision.
- Authenticated `GET /api/assistant/capabilities` advertises only existing ordinary CE features. New clients distinguish legacy 404/405 servers, authentication failure, outage, malformed responses, and incompatible versions. Unknown capabilities cannot enable unsupported operations. Existing endpoints and payloads remain intact.
- `apps/desktop` maintains the verified CE preload and selected-folder broker, with a new CE-only main process and connection/recovery page. No OpenClaw/Hermes transports, private hosted configuration, or imported hosted authentication. Source provenance is recorded in its `PROVENANCE.md` and the desktop source lock.
- Each connection has an isolated, memory-only session and folder grants; development uses a fresh temporary app directory. Origin/main-frame checks protect native calls. Reconnection discards previous grants; pending folder dialogs recheck connection ownership. Navigation, popup and notification routes are bounded.
- Selected-folder writes retain native confirmation and recheck grants, root/parent/source identity, and content after approval. Read-only grants, path traversal, changed symlinks, and unsafe recovery directories are rejected.

## Executed evidence

All checks used the retained Node 24.15.0 runtime where applicable. Electron 43.2.0 was extracted from the existing cache only after its SHA-256 matched the retained distribution provenance. No current application, personal browser profile, live database, credentials, or signing key was used.

| Check | Result |
|---|---|
| Protocol, assistant API, authorization suites | 4 files, 79 tests passed; real test loopback listeners required execution outside the tool sandbox. |
| Desktop policy and folder operations | 10 tests passed, including revocation during approval and symlink/path changes. |
| TypeScript build | `tsc -b packages/protocol apps/api` passed. |
| Main-process syntax | `node --check apps/desktop/src/main.cjs` passed. |
| Live Electron smoke | Passed against two synthetic loopback servers: connection replacement/reconnect, legacy/ready/unauthenticated/incompatible negotiation, real temporary-folder reads/writes/revocation, iframe bridge isolation, blocked cross-origin navigation, and actual sandbox/context-isolation/Node settings. |
| Shell visual inspection | Captured and inspected the running app’s connection page; no layout overflow. |
| Public-data scan | Full Bash scanner passed 1,012 tracked files; native equivalent including new files passed 1,033 files before this evidence note. |

Reproduction: `node node_modules/vitest/vitest.mjs run packages/protocol/test apps/api/test/assistant.test.ts apps/api/test/authorization.test.ts`; `node --test apps/desktop/test/*.test.cjs`; `node node_modules/typescript/bin/tsc -b packages/protocol apps/api`; `node apps/desktop/test/smoke.mjs /absolute/path/to/verified/Electron.app/Contents/MacOS/Electron`. The smoke harness only uses its synthetic servers, disposable app state, and temporary selected folder. Evidence stays in ignored `build/unified-p1`.

## Remaining integration gates

Vault-backed persistent credentials are P2 work; embedded local setup, managed service lifecycle and installer integration are P5 work. The current shell intentionally connects to CE only and does not claim these later features. The new shared automation contracts expose no executor. P0 isolation/browser proofs, real upgrade/remote-device acceptance, and final distribution checks remain required. Existing remote API regression tests are not a claim to have physically tested every remote device.
