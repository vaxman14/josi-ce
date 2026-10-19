# P0 baseline and feasibility evidence

Date: 19 October 2026. Baseline: `ed2987209a984ee412fc6334f5595ba794ea37ec`, branch `macos/native-distribution-20261009`. P0 is **not complete**. These are development probes, not a shipped executor or a production security claim.

## Results

| Check | Observed result | Limit |
|---|---|---|
| Core vault, PC permissions, mobile | 60 tests passed in 3 files | Existing behavior only. |
| Assistant, approval defaults, upgrade, durable effects | 69 tests passed in 4 files | Existing behavior only. |
| Retained desktop source tests | 21 tests passed | Includes static checks and actual local-workspace operations; not live UI acceptance. |
| Apple virtualization | Supported on this Apple Silicon host outside the tool sandbox | Sandbox XPC denial is not a hardware failure. |
| Restore image | Apple metadata retrieved; 26,637,307,067 bytes; pinned SHA-256 matched | OS 27.0.1 / 26A434; no production minimum inferred. |
| VM install | Reached 78%; automatically cancelled below the free-space reserve | No completed installation, boot, or lifecycle claim. |
| Encrypted workspace primitive | Wrong key denied; synthetic data survived lock/reopen | No real browser, vault integration, session revocation, or crash test yet. |
| Native message framing | 2 tests passed: multi-message/unicode and malformed/oversized/unsupported requests | Actual browser invocation still required for all four browsers. |
| Safari app-extension packaging | Generated and compiled for macOS with signing disabled | Xcode's generated parent bundle ID required normalization; no installation or browser invocation. |

Hardware: Mac16,5, arm64, 48 GiB RAM, 16 logical CPUs, hardware virtualization supported. Host macOS 27.0.1 (26A434), Xcode 27.0 (27A266a). Probe uses 4 CPUs, 8 GiB RAM, a sparse 64 GiB disk, 1440×900 display, no NIC, no host share, no audio, and a virtio socket device. Configuration validation passed before installation. This does not prove an authenticated guest socket or selective network enforcement. SDK minimums are not product requirements.

The downloaded restore consumed 26,641,330,176 allocated bytes; the partial guest disk consumed 20,405,854,208. Both were disposable files created by this probe and removed after recording the failed run. The host-space guard worked. The owner subsequently made storage available and authorized a retry. Foundation reported 401.4 GiB available for important usage, including automatically reclaimable space, and 79.4 GiB immediately free. The revised preflight requires 64 GiB available and 16 GiB immediately free **after** the download; the 8 GiB actual-free emergency stop remains. These are conservative development thresholds, not measured customer minimums or a reservation. Do not manually delete user snapshots to force a retry. The retry is in progress; no success is claimed yet.

## Source and distribution baseline

The available desktop 0.6.5 source is outside the CE Git worktree. Its nine `src` files exactly match the desktop source inside the retained current candidate's corresponding-sources archive. [Source lock](desktop-source.lock.json) records their SHA-256 values. The retained packaging baseline and current candidate remain intact. Electron and third-party source locks already exist in `packaging/macos/desktop-sources.lock.json`.

The desktop's `main.js` combines CE with hosted authentication/telemetry and other backends. P1 must extract/rebuild the CE-facing shell, preserve provenance/notices, and exclude those private endpoints, dependencies, and OpenClaw/Hermes paths. Bulk-copying the private client into the public repository is inappropriate. Its direct CE window already uses context isolation, sandboxing, disabled Node integration, and bounded preload messages. Preserve that boundary. Local selected-folder access must retain path containment, read-only mode, and device approval.

## Secret and authority migration inventory

| Consumer / source | Current authority | P2 obligation |
|---|---|---|
| `packages/core/src/vault.ts` | Vault master/box hierarchy and encrypted items | Versioned rule records and current-authority checks; preserve recovery. |
| `storeCredentialPayload` / `openCredentialPayload` | Vault pointer when initialized, direct install-key sealed fallback otherwise | Migrate legacy ciphertext; forbid fallback for new automation authority. |
| LLM registry, connectors/OAuth, SMTP | Vault payload helpers, some direct legacy open paths | Inventory each read/write path and reconcile migration before removing compatibility. |
| Telegram config | Direct install-key sealing for bot/webhook credentials | Move canonical credentials to vault references. |
| Mobile push registrations | Direct install-key sealing of push tokens | Vault references and revocation without breaking ordinary remote clients. |
| Desktop safe storage | Independently encrypted client state | Separate nonsecret connection metadata from vault-managed credential projections. |
| Protected service/bootstrap files | Installation/root-of-trust hierarchy | Document vault bootstrap separately from user-editable credential authority; preserve recovery and permissions. |
| Browser cookies/sign-ins | Not implemented in CE | Vault-controlled encrypted workspace authority; no personal profile import or implicit exception. |

Consumers include API auth/setup/connector/developer/LLM/ops/parental/workflow routes; agent developer tools; external channels/Telegram; connector connection/custom-API/OAuth/storage-sync/workflow code; core mobile/PC control; LLM registry; and SMTP. P2 must check all reads, writes, rotation, backup, and restore. An encrypted primitive alone does not establish vault-only authority.

## Approval and compatibility inventory

Existing PC-control code binds approvals to user/device/payload hashes and policy epochs; high-risk actions still ask. Its executor is unavailable and paths are Windows-scoped. P4 must generalize targets and map supported exact-scope grants deliberately. Existing one-time approvals must never become standing grants.

Approval defaults (`always_ask`, `risky_only`, `automatic`) are bounded by administrator ceilings. High-impact action classes include delete, spend, publish, invite, sign, and access changes. Action-state pinning prevents approval of a changed proposal. Storage deletion separately checks confirmation; folder permission alone is not deletion approval. Preserve these protections until each replacement has a verified operation-specific control. Super-admin rule administration and permission expansion remain human-only.

Existing CE routes to preserve: threads, durable `POST /threads/:id/turns` (202), turn cursor reconciliation, legacy `/threads/:id/messages`, notification device registration, tasks, task runs/activity, approvals, and reminders. A notification device is not an automation-enrolled device. Task/message access is owner-scoped; super-admin aggregate visibility does not grant content access.

Queue leases use fenced claim/renew/complete behavior. Durable effects retain completed receipts and avoid blindly retrying uncertain side effects. Existing failed-attempt terminal states and the agent's default six-hop turn limit are not durable goal completion. P9 must distinguish goal, attempt, and reply without weakening these safeguards.

## Remaining executable gates

- Install/boot the disposable guest on sufficient storage; display, keyboard/pointer, guest Accessibility/screen consent, authenticated guest channel, pause/resume/cold restart and crash recovery.
- Prove guest egress allow/deny and host-file containment. A guest with no NIC proves neither usable browsing nor selective network access. Investigate an approved proxy through the authenticated guest channel; reject alternate ungoverned paths.
- Run Chrome/Brave/Firefox/Safari in dedicated guest workspaces; prove browser/native round trips, observations, forms, redirects/popups/frames, restricted pages, permission loss, and reconnect. Compile/package results alone cannot pass these checks.
- Prove vault-managed workspace reopen/lock/revocation/crash/session reset, with provider-session revocation distinguished from deleting local cookies.
- Record measured resource requirements and required human enablement (OS consent, extension enablement, sign-in). No unattended workaround around platform consent.

## Primary references

- [Apple virtualization](https://developer.apple.com/documentation/virtualization/virtualize-macos-on-a-mac), [virtio sockets](https://developer.apple.com/documentation/virtualization/vzvirtiosocketdevice), and the installed Xcode Virtualization headers.
- [macOS 27 license](https://www.apple.com/legal/sla/docs/macOS27.pdf), section 2B(iii). Commercial business automation in a VM is not assumed to fit the standard development/testing/personal-use permissions. The owner is pursuing written Apple permission; no price or obtainable exception is promised.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): framed native stdio and exact extension origins. [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging): Firefox extension IDs and separate manifest registration.
- [Safari packaging](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari), [Safari native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension), and [Brave extension support](https://support.brave.app/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave). Safari needs its native app-extension adapter; Chromium API parity is not presumed for Firefox or Safari.

Storage semantics: [Apple Disk Utility](https://support.apple.com/en-euro/guide/disk-utility/dskutl1005/mac) distinguishes immediately free and automatically purgeable space; the probe uses Foundation’s `volumeAvailableCapacityForImportantUsage` for admission and actual free blocks for its emergency stop.
