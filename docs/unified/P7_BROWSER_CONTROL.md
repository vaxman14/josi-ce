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
