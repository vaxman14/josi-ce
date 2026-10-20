# P7 browser control implementation

19 October 2026. Implementation checkpoint; execution and acceptance remain gated by P0/P4/P6.

## Implemented source

`apps/browser-extension/src` contains the shared extension, popup and isolated page agent. `scripts/unified/build-browser-extensions.mjs` emits separate Chrome, Brave, Firefox and Safari resource directories. Chromium uses an MV3 worker; Firefox/Safari use background scripts. Nothing installs into a user's existing browser.

The popup connects only through `com.heyjosi.workspace`, the native workspace host. It cannot accept a server address, token, copied policy or arbitrary profile. A current native session must name the browser, isolated workspace/profile, exact allowed origins and a short expiry. Native messaging is the only command source. Pages cannot invoke the background controller.

Implemented operations are granted tab discovery, navigation, top-frame observation, element click and text fill. Observations provide bounded visible text, element references and geometry. They exclude input values, cookies and browser storage; page text is still untrusted and may contain sensitive information. Forwarding it requires the host's observation/data permissions. Fill values use ephemeral references resolved by the host. There is no arbitrary JavaScript tool, download/upload, clipboard, personal-profile selection or embedded credential store.

Element actions consume an observation, check document/URL revision, current geometry/name, visibility and enabled state. Mutation, input, change, scrolling and resizing invalidate observations. Navigation and clicks are input receipts, never proof of a business outcome. Real pointer/keyboard input inside an observed page or the popup's takeover control stops this extension session; resume requires a fresh session and observation.

`packages/automation/src/browserWorkspace.ts` implements the single-command native rendezvous: strict envelopes, exact command matching, authenticated-peer hooks, current-session checks, expiry, replay refusal, bounded replies, cancellation and uncertain-outcome handling. Authorization rechecks the actual browser tab immediately before input and requires durable dispatch recording. Lost/uncertain replies stop the session; the bridge does not retry them. Results are marked untrusted and require outcome verification. Sessions/commands/page values remain in memory.

## Connections still to build

The native host is **not registered or installed**. Production peer verification, guest/browser profile attestation, Vault key projection, enrollment, native transport, durable reservation integration and real browser launching belong to P4/P6. The new bridge requires those adapters and provides no permissive defaults. Missing native authority means the popup refuses to connect.

The [CE execution checkpoint](P4_P7_P8_CE_EXECUTION.md) now connects agent tool schemas and the server-side dispatcher to the Vault reservation store, with current task/turn checks and explicit uncertain-result handling. Its native transport and real effect/evidence adapters remain mandatory unassembled dependencies; this does not register a browser host.

Safari still needs its signed native extension wrapper and a verified native round trip. Firefox signing/consent, Chromium distribution identifiers and enterprise/user installation routes remain open. Resource generation is not a packaged Safari app or store submission.

The initial action set does not cover nested frames, shadow roots, file dialogs, content-editable text, drag/drop, full keyboard input, dialogs/popups or browser-chrome takeover. DOM click/fill may be refused by sites requiring trusted native input; the native engine must handle supported fallbacks under the same permissions. New tabs and redirects require authorized workspace routing. Exact effect classification and destination verification must precede live execution. P0's four-browser checks and the integrated acceptance pass are deferred under the owner's build-first direction.

## Build checks

Root TypeScript compilation and extension JavaScript syntax checks passed. Functional tests, browser installation and live automation were not run for this checkpoint. Candidate generation and source publication do not enable execution.

## API references

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [WebExtension background script differences](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Firefox extension identity and data declarations](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [Safari native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)

## Native browser connection components — 20 October 2026

The extension now keeps a single native port for Chrome, Brave and Firefox instead of spawning a host for every poll. Safari uses its containing app's native-message handler. Pending exchanges, reply size and time are bounded; disconnects reject outstanding requests without reconnecting or replaying them. Local takeover invalidates extension state immediately and sends a bounded stop notification before closing the old connection.

New guest-only Swift source includes a framed stdio host, a signature-constrained per-user XPC relay, and the Safari native handler. The stdio host checks the real browser parent, signed app identity and managed-profile launch arguments, then rechecks that process/profile identity per request. It accepts only profiles under the dedicated guest workspace tree. The Safari handler uses the OS-supplied profile ID rather than a JavaScript claim. Both require the signed enclosing Companion and isolated guest boot environment. A separate owner service accepts only the signed Companion; the relay can forward requests only while that owner holds a matching workspace/profile/consent scope with a ten-second lease. It cannot authorize a browser action itself. Old consent digests are retired after stop/expiry; a lower-trust peer cannot renew them. Normal completed Safari handler exit is distinguished from an interrupted request or lost persistent host.

`scripts/macos/build-guest-browser-components.py` builds the two native helpers, four extension resource sets, a real Safari `.appex`, native-message manifest candidates and the guest LaunchAgent candidate. The Safari bundle ID is `com.heyjosi.ce.guestcompanion.workspace-safari`, under the containing app's identifier. Public development-only Chromium identity is pinned in source; no private signing key is stored or needed for that unpacked identity. This is not a Chrome Web Store identity, signed Firefox release, browser approval or installed service.

The components compiled with Swift 6 and the installed Xcode SDK in `/private/tmp/josi-guest-browser-20261020-1`; the Safari connection-lifetime refinement was compiled separately. JavaScript syntax and generation passed. No component was signed, installed, launched, registered or enabled. These sources are newer than `native.13` and are not included in it. The production Companion owner callback, canonical Vault browser/profile registration and grants, profile preparation/extension provenance, guest service installation, server command/model-projection assembly, permitted egress and functional four-browser acceptance remain open. The relay has no permissive fallback while that authority assembly is absent.

Platform references rechecked: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Chromium development identity](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Mozilla native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging), and [Safari app messaging/profile identity](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension). Public XPC code-signing requirement APIs and `SFExtensionProfileKey` were also checked in the installed Foundation/SafariServices SDK headers.

## Vault browser targets and native permissions — 20 October 2026

The canonical target registry now accepts protected browser registrations alongside app and model targets. It binds an immutable permission ID to the exact workspace, registered browser installation, physical guest profile and extension identity/version/fingerprint. Existing app/model documents remain readable; adding a browser writes document version 3 inside the same encrypted Vault record. Updating browser or extension code requires another registration and new grants. The physical browser profile UUID alone is never a grantable identity.

Protected permission review and reservation preview resolve browser scopes, including credential destinations, against that registry and its linked app. Missing or stale registrations cannot provide an allowance. The native permission editor offers exact site origins and per-operation rules, initially Ask, with the existing task/time/action/byte controls and protected save. Registration is metadata for permission setup; real guest/process/profile/extension verification remains mandatory at execution.

Root TypeScript and native Swift 6 compilation passed. No live Vault data or permission was changed, and no functional suite was run. Guest profile preparation, registration selection UI and production execution assembly are the next work; these changes are not in the delivered `native.13` installer.

## Guest profile setup and package assembly — 20 October 2026

The guest Companion now prepares a dedicated Chrome, Brave or Firefox profile after receiving the selected browser's current canonical app pin. It checks the installed browser signature/code hash and the packaged extension catalog, creates private guest-only profile folders, and reuses a bounded local folder hint across reconnects. The hint contains no credential, grant or authoritative rule. A fresh candidate returns through the paired guest channel; the native host displays protected browser registration and existing registrations in Automation Settings.

Explicit guest controls open that separate profile for extension setup, reveal the packaged extension folder, and enable/disable the browser connection service using `SMAppService`. Native-message manifests are installed only inside the guest user's browser directories, without replacing a conflicting existing file. Existing browser processes must be closed before the setup launch. The helper continues to check the actual browser parent/profile on every message. The development flow uses Chromium's Load unpacked and Firefox's temporary add-on UI; it does not disable browser protections or claim store distribution.

The unified builder now embeds the two helpers, four extension resource sets and their catalog, native-message manifests, the LaunchAgent and Safari `.appex` inside the Companion. Socal signing runs from the nested helpers/extension outward to the Companion. This assembly has not yet been produced as a new signed unified installer. Native host/guest Swift 6 compilation, the browser component builder (including Safari Xcode build), extension resource generation and Python builder syntax passed. No actual profile, service, browser installation or live configuration was changed during development.

Safari's OS-selected profile discovery, the Companion owner callback, production server command delivery and permitted egress remain unfinished. Installing the service alone grants no control; without current owner/server authority it refuses browser connections. The matching host and Companion are required for the new candidate status field.

Platform setup references: [Apple's bundled LaunchAgent API](https://developer.apple.com/documentation/servicemanagement/smappservice/agent(plistname:)) and [Chrome's removal of command-line extension loading](https://developer.chrome.com/docs/extensions/whats-new). The installed ServiceManagement SDK documents the bundle-relative `BundleProgram` key and per-user registration/approval behavior.

## Canonical profile projection and idle connection — 20 October 2026

The hardware-authenticated storage session now resolves a registered browser from the current Vault, with the linked selected application, owner/workspace/device and authority epoch checked in the transaction. The native host renews a bounded projection over the paired guest channel. The guest compares its prepared profile and extension fingerprint against that projection; an old boot's registration remains usable only when the actual profile, app and extension identity still match. This metadata projection does not issue an action permit.

The Companion's native owner callback now renews the per-user broker and handles extension hello, idle polling and takeover. It checks the real browser process, app signature, launch identity, physical managed profile and extension identifier before accepting a connection. The broker's routing scope uses a fresh connection ID instead of a consent digest: connecting must be possible before local automation approval, because interacting with the guest after approval can trigger takeover. This supersedes the earlier relay's consent-bound routing description, not the requirement for consent at execution.

Idle sessions have an empty origin list, no command queue and no accepted authorization/receipt path. The extension and shared bridge reject every command while the list is empty. This allows honest “connected, waiting for a permitted task” status without page access. Native and guest screens show the connection state. Loss, expiry and stop close the scope; reconnect cannot replay an operation.

Root TypeScript, native app, guest Companion, broker Swift 6 and extension JavaScript checks passed. This is compiled source, not a demonstrated browser round trip or enabled action adapter. Production reserved browser operations, loaded-extension provenance for action dispatch, Safari profile discovery, selective egress and functional acceptance remain open. No live service, browser profile or Vault record was changed.

## Reserved Chrome/Brave inspection and model projection — 20 October 2026

The first browser read is now assembled through the production task/runtime, durable reservation, native host, guest owner and extension. `observe_automation_workspace` accepts an exact `browser_origin` for browser captures (null for desktop; legacy desktop requests remain accepted). The selected registered browser is bound to the native control lease. A browser read reserves exactly `browser.observe` for that profile/site and its output budget. Browser applications cannot use the generic AX observation path to bypass site permissions.

The extension selects the active tab in the last-focused window, requires the exact reserved origin and sends its locally observed target back before reading. The guest verifies its actual browser peer and obtains the final current server permit. The page agent returns bounded visible text and element metadata; it does not read input values, cookies or storage. Budget trimming is marked partial. The result stays in guest RAM for at most fifteen seconds, with an opaque capture receipt returned to the server. The existing separate `model.transmit` reservation and one-use encrypted projection then carry it only to the registered current model. Capture alone does not grant transmission or input.

Before inspection and projection, the guest revalidates its signed container, packaged extension fingerprint and managed profile. Chrome/Brave's on-disk extension entry must identify the exact packaged resource folder as an unpacked installation; conflicting locations or disable reasons fail closed. This is a development installation check, not a store signature or a defense against a compromised guest OS/browser. It never rewrites preference files or manufactures their integrity metadata. Browser setting formats and the actual loaded-extension behavior still require functional acceptance.

Firefox temporary add-ons are not serialized in its extension database, so that route is not treated as equivalent evidence. Firefox can use the connection setup but inspection remains unavailable pending its verified distribution/installation route. Safari's native wrapper is built; OS-profile discovery and its action route remain unfinished. Source references: [Chromium extension preferences](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/extension_prefs.cc), [Chromium installation-location values](https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/mojom/manifest.mojom), and [Firefox's extension database serializer](https://searchfox.org/firefox-main/source/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs).

The matching guest now advertises `desktop-command.3`; older `.2` companions retain desktop support but cannot claim browser inspection. Root TypeScript, native and guest Swift 6, JavaScript syntax and whitespace checks passed. Browser input/navigation, verified outcomes/task handoff, Firefox/Safari actions, selective networking and integrated functional acceptance remain open. No VM, live browser, provider call, database migration or Vault mutation was performed. The unified builder is advanced to `native.14` for the next signed artifact; artifact production and acceptance are separate receipts.
