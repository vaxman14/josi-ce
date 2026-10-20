# P5 native Mac app — 20 October 2026

The owner requested a native replacement after installing the unfinished Electron candidate, and explicitly authorized signing with this Mac's Socal Receptionist LLC identities. This checkpoint replaces the Mac UI implementation with SwiftUI/AppKit. It is not a completed P5 or release-acceptance gate.

## Implemented

- `apps/macos-native` compiles a native application with a Josi icon, native windows, menus, navigation, forms and chat/task views. No Electron or WebView renders the interface.
- Local hosting and remote CE connections use the existing server API. HTTPS is required for remote connections. Per-connection authentication cookies and CSRF tokens remain in an ephemeral session, with redirects rejected and no persistent credentials in preferences.
- Local first-time setup exchanges the protected bootstrap handoff for a one-use setup session inside the app. Native forms cover host checks, owner, domain, provider/model selection, SMTP, folder/security options, telemetry, review and completion. Recovery material is displayed only in memory unless the owner explicitly saves their recovery copy.
- Password/MFA login, conversations and durable turn submission are connected. A lost submission reply retains the original message identifier/body for an explicit retry during the current app session.
- Chat progress cards and the native Task Manager consume the server's work-goal records. Pause, resume with instructions, cancellation and completion confirmation use the current goal revision.
- The native Task Manager has Active, Needs You / Waiting and History views, continuation questions and scheduled rechecks. Expand a goal for completion criteria, the owner's correction, current progress notes, paginated activity/plan/outcome history and the original conversation.
- Work-memory correction, pin/unpin and clearing, requested-outcome changes and obsolete-step retirement use the existing owner-scoped APIs. An edit retains its original revision and requires explicit review of newer work before submission; server conflict checks remain authoritative.
- Super-admin native settings display current Cardinal Rules, permission scopes/limits and enrolled devices from the Vault. Rule drafts have explicit action/scope/restriction forms, deterministic **Test Validity**, password/MFA-protected Vault saving, exact provider/content preview and an explicit model-review request. Saved advice remains inactive. Unsupported saved draft shapes cannot be silently rewritten by the editor.
- Fixed local lifecycle controls provide install/update, start, stop, restart and journal recovery using macOS administrator authorization and Socal signature verification. Closing the window leaves server hosting independent.
- The package includes the native **Uninstall Josi.app**, with keep-data and complete-removal choices. Its existing removal machinery now recognizes the unified app and installer receipt.
- Installing the package over a recorded existing server invokes the normal recovery-copy/migration lifecycle. A new or remote-only install adds the app without automatically provisioning a local server.
- Existing protected-key and server-consent helpers accept the signed native host identity. They retain their installed-path, signature, hardened-runtime and entitlement checks.
- Native permanent-rule activation/retirement and device revocation now use the protected server challenge flow: fresh administrator verification, hardware host proof, complete native presentation, genuine biometric authentication through the existing key helper, current-Vault checks around signing, and one commit attempt. Closing/cancelling the review kills its owned helper; expiry uses wall and monotonic clocks. Lost commit responses require inspecting refreshed settings, never automatic replay. An already enrolled device is required.
- Native device enrollment connects the existing begin/prepare/review/status/commit APIs. The target Mac creates its hardware wrapping key and signs possession after native review and biometrics. The server Mac separately approves through its installed, signed app and the protected local consent socket. A remote HTTP response cannot substitute for server-local consent. Enrollment grants no automation access; cancellation and uncertain commit responses require fresh review instead of replay.

## Packaging and observed behavior

`scripts/macos/build-native-unified.py` requires a fresh output folder and an offline server runtime. It overlays current built server packages/migrations, compiles the app and native helpers, creates Josi's icon, refreshes inventories and signs with:

- Developer ID Application: **Socal Receptionist LLC (LRH75YR6QW)**
- Developer ID Installer: **Socal Receptionist LLC (LRH75YR6QW)**

Creating an installer requires `--sign --package`. The builder does not install, alter live server data, or notarize. It retains build logs separately from the payload. After packaging it extracts the installer, compares every file's bytes/mode and every link against staging, and verifies both extracted app signatures.

The first signed native build is in `/private/tmp/josi-native-unified-20261020-1`. Swift 6 compilation succeeded. The app, uninstaller and approval helpers were signed; deep/strict verification and exact Socal authority, team and timestamp checks passed. The installer signature also passed. Its 17,604 file/link entries matched staging, including executable modes.

`pkgbuild` printed twelve `write: Permission denied` warnings while returning success. The original source of those warnings remains unknown. Extraction completed and the complete byte/mode/link comparison passed. A signature check inside the restricted sandbox reported an invalid signature; both extracted apps passed the same verification outside the sandbox. Do not interpret that sandbox verdict as package corruption or suppress real failures in a signing-capable environment.

The staged signed app actually launched through the computer-use tool and displayed its native **Welcome to Josi** window, local/remote connection controls and the existing public server receipt version `0.1.78-macos.17`. This is evidence of launch and receipt reading, not server health or functional acceptance. The staging app cannot manage services because it is outside `/Applications/Josi.app`. No installer or uninstaller was run, no provider call was made, and no live server data was changed.

## Remaining work

Additional permission-target types, remaining administrator/settings parity, subscription credential migration and production automation transport remain open. The development desktop's native storage/provisioning/lifecycle is now assembled in source; see [P6/P8 evidence](P6_P8_NATIVE_COMPONENTS.md) for its limits and remaining recovery work. Existing CE web and remote APIs are retained. Authenticated sessions are currently memory-only; a durable client session must use the accepted Vault authority design. Device enrollment is assembled; actual biometric/local-and-remote acceptance and abandoned-key reconciliation remain open.

## Native.5 installer — 20 October

Delivered `JosiDrive/Artifacts/josi-native-unified-20261020-5/Install Josi.pkg` (697,466,497 bytes), built from clean commit `6e1649e8c4d4cf96a6fa5462b0a9900291af52b8`; app version `0.7.0-native.5`, bundle `20261020.5`, package `0.7.0.6`. Includes Vault-backed storage preparation and the development desktop's installation/open/show/pause/resume/close path. The main app has the virtualization entitlement; app, helper and installer use the approved Socal identity/profile.

All 17,618 extracted payload file/link entries matched staged bytes, modes and links. Both extracted app signatures and the installer signature verified. Artifact metadata, checksum, exact Git source archive, corresponding runtime sources and profile are retained alongside the installer. This candidate was **not installed, launched, notarized or functionally tested**; earlier native.4 launch evidence is not evidence of its VM or biometric behavior. Subsequent source-only guardian/recovery changes are tracked in P6/P8.

The follow-up work/task and rule-editor sources compiled successfully with Swift 6. No authenticated functional flow or model review was run on the owner's server. The native package version advances to `0.7.0-native.2`; its installer version is `0.7.0.3`.

That signed installer is retained at `/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-native-unified-20261020-2/Install Josi.pkg`, with clean source revision `db33e6d3f38d89d70241c11519b9ea6a6aac1e6b`, checksums, current application source and retained runtime dependency sources. Its extracted file comparison and both app signature checks passed. This package predates the native protected-approval connection described above.

The later protected-approval sources compile with Swift 6. A bounded, local compatibility check compared the actual native encoder with the CE protocol implementation: a hardware host challenge and three full protected presentations, including quotes, slashes, newline/tab and Unicode text, produced identical signed bytes. No hardware key was created/read, no biometric prompt was opened and no rule/device was changed. Real protected-flow acceptance remains open.

Functional setup/login/chat, service operations, real upgrade/recovery and uninstallation acceptance remain unverified. Notarization and final release acceptance are outstanding. The owner asked to defer functional suites until features are built; the targeted launch and packaged-signature checks address the immediate broken-app report.

## Protected helper provisioning

The native key helper uses the macOS data-protection Keychain. Apple's [Keychain guidance](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) and [restricted-entitlement signing guidance](https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement) require profile-authorized entitlements and an app-like bundle. The earlier bare signed helper was not sufficient evidence of usable key access.

The builder now embeds `JosiProtectedKeyHost.app` with a Developer ID profile and only its own application identifier, team identifier and Keychain group. `--protected-profile` checks the Socal team, macOS platform, distribution eligibility, expiry, exact existing signing certificate, authorized group and absence of debugging entitlements before building. The main app records whether provisioning was included and disables protected flows when it was not. There is no fallback to another team, software wrapping keys or the file-based Keychain.

On 20 October the owner explicitly approved registering this Mac with Socal Receptionist LLC. Xcode's exact-Mac build registered it and produced a development profile containing its identifier; the owner approved the system Keychain prompt. Archive/export then produced a Developer ID profile for `com.heyjosi.ce.protected-key`, team `LRH75YR6QW`, authorizing the selected existing Socal Developer ID certificate. The helper's signed entitlement uses only `LRH75YR6QW.com.heyjosi.ce.protected-key`, even though the profile permits the team's wildcard group. No certificate was revoked and no other team was selected.

The enrollment and profile-gated Swift 6 sources compile. The local protocol comparison now covers seven native/CE signed messages and three consent decode/re-encode round trips, including Unicode and escaped text. No real enrollment, biometric signing, Vault mutation or installation was performed. The next package is `0.7.0-native.3` / installer `0.7.0.4`; artifact production is recorded separately when complete.

That package is now retained at `/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-native-unified-20261020-3/Install Josi.pkg`. It contains clean source revision `d709887ead6dc7da13151de8337d518be8b446e3`, the provisioned helper, native enrollment and protected approval. All 17,607 extracted file/link entries match staging and both extracted app signatures passed. Its folder includes hashes, current source, runtime dependency source and the Apple-issued profile needed to reproduce helper signing. This package is not installed, functionally accepted or notarized.

## Existing permission editing

The subsequent native editor opens a server-validated saved policy and retains its original Vault reference. It supports policy enable/disable, unmatched-action behavior, deny/ask/task/until/standing modes, independent explicit unlimited or whole-number limits, and rule removal/restoration before saving. Identity, exact scopes/revisions and stable grant IDs are preserved; changing limits does not reset prior consumption. Untouched expiry text is preserved exactly. Unsupported policy shapes cannot be silently rewritten.

Changes must pass the server validator again before native protected confirmation becomes available. Any field change invalidates that check. A changed connection, administrator or Vault reference blocks saving; the server repeats authority and version checks inside its existing transaction. The final protected review shows the complete before/after meaning. Removing a denial is explicitly identified as a possible widening.

The editor currently changes **existing** grants. Creating new policies and selecting new browser profiles, applications, folders, runtimes or credential destinations still depends on the production workspace/target catalog. It does not fabricate selectable targets from arbitrary IDs. Swift 6 compilation and the pre-commit public-data scan passed. This source is later than the `native.3` installer and remains subject to functional acceptance.

## Native Vault controls

The native sidebar now includes the owner's credential list and super-admin Master Vault controls. The existing CE routes provide five-minute list unlock, encrypted credential creation/replacement, integrity checks, explicitly confirmed deletion, Vault initialization, master lock/unlock, legacy credential inventory/migration and offline recovery. Existing secret values are never returned or displayed. New secrets, passwords and recovery inputs remain in transient view state and clear on submission or navigation; no second credential store was added.

Recovery initialization opens a native one-time-key sheet that requires the owner's saved-copy acknowledgment. Normal quit is blocked while a setup or Master Vault recovery key is awaiting acknowledgment. An explicit Save dialog writes a private `0600` temporary file, syncs it and renames it into the owner's chosen destination; the initial setup recovery export uses the same implementation. Nothing automatically exports the key. Abrupt OS termination or an unconfirmed initialization response still requires recovery investigation; the UI is not a durability guarantee.

Vault refreshes pause while the app is inactive or a mutation is running. Connection/owner checks, cancellation and a local generation prevent late reads from restoring a stale view after a mutation or navigation. Master health remains independently accessible when personal credential access fails. Swift 6 compilation passed; no real credentials were changed and functional acceptance remains deferred. This source is later than the `native.3` installer.

## Native backups and connected-server health

The super-admin Backups page connects full/portable creation, retained history and live progress to the existing CE routes. Unconfirmed creation responses require inspecting history; there is no automatic retry. The separately stored installation-key requirement stays visible. Creating backups continues to use the server's configured destination; changing an off-site destination remains separate native parity work.

Completed archives save through an explicit native file picker and the existing authenticated session. Downloads accept only the selected backup UUID, same-origin non-redirected ZIP response and exact recorded byte count. Free storage is checked first; streaming uses a bounded 256 KiB buffer and a private `0600` temporary file. The selected destination is replaced only after the complete stream and current client context are checked and the file is synced. Cancellation, errors and truncated or excess data remove the temporary file. Cancel requests during response-header waits take effect when the response arrives or the session times out. No archive or recovery key is opened automatically.

The Server page now shows the connected server's Josi Doctor checks and date separately from controls for the Mac running the client. Failures are shown before warnings and passes, with full expandable details. System checks run on page opening or explicit request; no automatic repair/model call/update is added. Local lifecycle changes continue through the existing signed, administrator-authorized helper.

The assembled Swift 6 app compiles and the pre-commit public-data scan passes. The next installer is `0.7.0-native.4` / package `0.7.0.5`, incorporating existing-grant editing, Vault management, backups and health. No backup, credential mutation, diagnostic request or installation has been executed on the user's server by this implementation work. Functional acceptance remains deferred.

The signed `native.4` installer is now retained at `/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-native-unified-20261020-4/Install Josi.pkg` (697,307,055 bytes). It was built from clean revision `74ea43503e30c847cbf7822d640fbea49580868c`; all 17,607 packaged file/link entries matched staging and both extracted application signatures passed. Source, dependency-source archive, provisioning profile, build metadata and hashes accompany it. Opening the exact staging app displayed the native welcome screen, and process inspection confirmed the `native.4` executable was running. No installation or authenticated flow was performed; this remains an unnotarized development checkpoint.

## Native.6 installer and app permission setup — 20 October

Delivered `JosiDrive/Artifacts/josi-native-unified-20261020-6/Install Josi.pkg` (697,694,207 bytes), from clean commit `9008f5015c9d4157e177be23002149a90d145014`; version `0.7.0-native.6`, bundle `20261020.6`, package `0.7.0.7`. Includes the independent desktop cleanup guardian, retained-storage controls and signed guest companion on read-only support media. All 17,620 extracted file/link entries match staged bytes, modes and links; extracted app signatures and installer signature verified. Source archives, hashes and the Socal profile are retained with it. It was not installed, launched, notarized, paired or functionally accepted.

Subsequent source adds guest-native application selection, canonical Vault target registration with full protected review, and creation of new app permissions from those targets. New rules start with Ask, new policies disabled with unmatched actions denied; the editor exposes task/expiry/standing choices and explicit resource limits. Protected review includes the actual registered name, location, signing identity and code hash. This source advances the next candidate to `native.7`; that installer has not yet been produced. See P6/P8 for remaining execution work.

## Native Models settings — subsequent source checkpoint

The native Models page uses the existing CE administrator APIs for primary/fallback configuration, dynamic provider fields, provider model discovery, explicit capability checks, local-only policy, monthly cost/token caps and metering. It displays reported costs separately from estimates and subscription/local calls. Saving deactivates a provider until a user-triggered check; opening this page never probes a model. A check explicitly explains billing/subscription-quota use. Existing Vault credentials are never returned to the UI; blank secret fields retain the existing server-side credential, while replacement values stay in transient request/view memory.

The model editor rechecks the saved slot before replacing it and rejects a changed slot. The native settings and setup walkthrough now share provider-owned ChatGPT/Codex and Claude sign-in controls, with status, bounded pending polling, cancel, one-time Claude code entry and explicit subscription logout in settings. Only HTTPS links on the corresponding provider's exact domain/subdomains can open. Sign-in codes/links are not saved in preferences. User/provider/server changes clear local form state; late responses cannot repopulate a different sign-in.

Swift 6 compilation passed for the complete page, setup integration and polling/loading changes. No provider call, CLI sign-in, live setting change, credential read or authenticated functional flow was performed. User/account/channel/SMTP settings and production automation assembly remain open. The app source is ahead of the delivered `native.7` candidate.

### Native.7 artifact receipt

Delivered `JosiDrive/Artifacts/josi-native-unified-20261020-7/Install Josi.pkg` (697,737,869 bytes), built from clean commit `a0391bf8b971eea12690cf8c716d5e7047bb2694`; app `0.7.0-native.7`, bundle `20261020.7`, package `0.7.0.8`. All 17,624 extracted file/link entries match staging; app/helper/companion/uninstaller/installer Socal signatures and extracted app signatures verified. Includes app target registration/grants, not the subsequent Models page. Exact source archive, retained runtime sources, checksum and protected profile accompany it. Not installed, launched, notarized or functionally accepted.

## Native account settings — subsequent source checkpoint

Your Settings now exposes existing email/calendar/contact/task approval preferences, honoring the server's effective administrator ceiling without replacing existing mandatory approvals. It explicitly separates those legacy preferences from the new browser/computer permissions. The page also connects authenticator setup, QR/manual key, six-digit verification, password-confirmed disable and existing session step-up to the original CE routes. The canonical authenticator secret remains in the Vault.

Successful authenticator enablement moves the one-time recovery-code response into app-scoped transient state before refreshing anything. A native sheet requires explicit saved-code acknowledgment and offers a private file export through the existing 0600/atomic export helper. Normal quit, sign-out, server switching and local lifecycle changes cannot discard pending codes. Setup secrets/passwords/codes clear on leaving their view; the saved recovery sheet clears only when acknowledged. This is normal lifecycle protection, not a crash-recovery guarantee or another canonical secret store.

Swift 6 compilation passed for the account page, recovery state and app integration. The final consolidation of the shared recovery-sheet presentation is included in the next packaging compile. No account/MFA/session/Vault setting was changed and no live recovery code was generated. The next package version is `native.8` (installer `0.7.0.9`) and combines this account work with the native Models page. Functional acceptance remains deferred.

### Native.8 artifact receipt

Delivered `JosiDrive/Artifacts/josi-native-unified-20261020-8/Install Josi.pkg` (697,904,709 bytes), from clean commit `1f5eb3eb01fff6133a985c991503d85feb69b78d`; app `0.7.0-native.8`, bundle `20261020.8`, package `0.7.0.9`. Includes the Models and account/MFA pages and the final shared recovery-sheet integration. All 17,624 extracted file/link entries matched staged bytes/modes/links, and extracted app signatures and installer signature passed. Exact source, runtime dependency source, checksums and Socal profile accompany it. No installation, launch, sign-in, provider probe, MFA action, VM action, functional acceptance or notarization was performed for this candidate. Subscription CLI credential migration remains a release gate; the new UI does not implement that missing lifecycle.

## Native live progress — subsequent source checkpoint

Chat and Tasks subscribe to the existing owner-authenticated work-goal stream while visible. They refetch saved goal state on changes, coalesce notifications, reject lower revisions and retain polling for older servers and interrupted reads. The footer shows live versus periodic status. Connection changes, inactive views and session revocation end the stream; revoked sessions cannot repopulate the goal view from a pending response. See [P11](P11_TELEGRAM_PROGRESS.md) for the exact scope. The complete native app compiled with Swift 6; live server acceptance remains deferred.

### Native.9 artifact receipt

Delivered `JosiDrive/Artifacts/josi-native-unified-20261020-9/Install Josi.pkg` (698,006,560 bytes), built from clean commit `469b5d36ed03c3ca587a578951af292fe9466351`; app `0.7.0-native.9`, bundle `20261020.9`, package `0.7.0.10`. Adds native live progress and the canonical application readiness connection. All 17,624 extracted entries matched staged bytes/modes/links; extracted app and installer signatures passed under Socal. Exact source, retained runtime sources, profile, integrity receipt and checksums accompany it.

The signed staging candidate was opened through the native-app tool. Its Welcome to Josi screen appeared, and process inspection confirmed the executable under the exact `native.9` staging path was running. This verifies launch only: the package was not installed or notarized, and no authenticated setup, account/provider action, VM connection or automation was exercised.

## Native Task Manager details — subsequent source checkpoint

Compact chat cards now follow the current part of longer plans and omit retired steps from the compact checklist. The full manager exposes step dependencies, timed rechecks, retired-step history, automatic continuation limits/schedule, and the original saved verification task's attempts/approvals through existing owned APIs. Standalone failed tasks appear in Needs You / Waiting and History; tasks already represented by goals are not duplicated as standalone cards.

An expanded delivery section follows the existing Telegram receipt projection every fifteen seconds while the app is active. It distinguishes pending, current, failed, uncertain and disconnected delivery without resending anything; failed status reads are labeled stale. The manager can open the existing local desktop viewer when that desktop is running or paused. This is the current local desktop, not a new remote stream or a claim that it belongs to a particular goal.

The complete native app compiled with Swift 6. No live task, channel message, desktop action or authenticated API flow was executed. These detail changes are later than `native.9` and remain subject to the integrated functional pass.

## Native messaging setup — subsequent source checkpoint

Messaging Apps brings existing Telegram, WhatsApp and Slack account linking and administrator configuration into the native client. Telegram includes bot-token replacement/verification, incoming-delivery registration, enable/disable, attachment policy, metadata-only linked-account revocation, seven-day delivery health and explicit bot removal. WhatsApp/Slack include credential replacement, explicit provider verification, enable/disable and their fixed incoming-message paths. Each member can create a one-time code and disconnect their own links.

New credentials and codes stay in transient view/request state and clear on navigation or account/server changes; the existing CE services retain canonical long-lived credentials in the Vault. Pending linking polls only while the app is active and expires against a monotonic deadline. Telegram opens only a locally constructed `https://t.me/<validated bot>?start=<exact code>` URL matching the returned link, and only on the owner's click. Other instructions are locally constructed plain text. No arbitrary returned URL or provider instruction is executed.

Administrator changes reload and compare current metadata before submission; the original server role/ownership checks remain authoritative. These client checks are not a new atomic server revision protocol. Disconnect/removal controls display their scope before submission. Provider checks, token verification and webhook registration are explicit product actions, never page-load effects. No live token, code, connection, configuration, provider request or message was created while implementing this page. Functional acceptance remains deferred. The next package version is `native.10` / installer `0.7.0.11`, combining these pages with the expanded Task Manager.

The assembled messaging pages compiled with Swift 6. Two subsequent small changes clear pending codes on explicit session revocation; their final compilation is part of packaging. Builder syntax, whitespace and the public-source secret scan (1,234 files) passed.

### Native.10 artifact receipt

Delivered `JosiDrive/Artifacts/josi-native-unified-20261020-10/Install Josi.pkg` (698,178,808 bytes), clean source `d2c7fd3de18daded9f374ba9c8b3b98cb6ec689b`; app `0.7.0-native.10`, bundle `20261020.10`, package `0.7.0.11`. Includes Task Manager details and native Telegram/WhatsApp/Slack setup, including the final session-revocation code clearing. All 17,624 extracted entries matched staged bytes/modes/links; extracted app and installer signatures verified under Socal. Source archives, profile, integrity receipt and hashes accompany it.

The signed staging app opened to Welcome to Josi, and process inspection confirmed the executable under the exact `native.10` staging path. No installation, notarization, authenticated functional flow, provider request, channel message, VM connection or automation action was performed. The subsequent [native Memory page](P10_WORK_MEMORY.md) is source-only and is not included in this candidate.

After retaining and comparing the signed installers, source archives and provenance, disposable staging directories for `native.2`, `.3`, `.5`, `.6`, `.7` and `.8` were removed (approximately 26 GiB). Their packaging evidence is archived alongside each retained artifact as `Packaging-evidence.tar.gz`; artifact checksum lists now cover all retained files. Current builds, the shared module cache, required baseline runtime, repository and existing installed data were retained.
