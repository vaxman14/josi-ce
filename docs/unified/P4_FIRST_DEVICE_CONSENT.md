# First-device local consent

Implementation checkpoint, 19 October 2026. Native helper and server transport compile; enrollment coordination and app review are still being connected. No installed service, Keychain, Vault or device enrollment was changed.

First trust requires an independent approval in the installed Josi app on the server Mac. A target Mac may be local or remote; the server-side review must display the exact target identity and key fingerprints. This is a bootstrap route for the macOS server release, not a claim of hardware attestation or a completed Windows/Linux enrollment route. Existing remote clients keep their normal connections.

`DeviceConsentHost.swift` is a short-lived child of the native API service account. The API supplies one bounded public enrollment presentation over its child pipe. The helper opens a random, attempt-specific Unix socket in the installer-owned control directory. Before disclosing the presentation or accepting a decision it obtains the socket's kernel audit token and verifies the peer is the signed, hardened Josi executable with sealed application resources and the required Electron fuses. The shared application identity checks are also used by the existing key host.

The app review must require an explicit review and OS biometric success in its main process before sending consent. A web checkbox, claimed PID, CE cookie, new software key or a signature alone cannot establish this local trust. The native helper authenticates the actual app process; the reviewed signed app code supplies the human-presence boundary. Root, the trusted server process and a compromised legitimately signed app are not excluded by this mechanism.

The attempt binds the complete presentation, server/account/device/enrollment identities, request digest, Vault epoch, random nonce and expiry. It lasts at most two minutes. Absolute native I/O deadlines, bounded frames/connections, process lifetime limits and server wall/monotonic checks stop stalled requests. The API receives consent only through its own child's pipe and holds a one-use capability in memory. Restart loses pending consent; it cannot create or replay authority.

The control directory stores only ephemeral socket nodes. No key, canonical rule or consent secret is stored there. Canonical enrollment remains in the Vault and still requires fresh administrator verification, exact current authority and new-key possession. Enrollment grants no automation access.

The component builder includes both helpers, and the unified builder copies them into the application. The lifecycle source provisions the service-owned control directory during fresh installation or upgrade. The consent helper needs Developer ID identity `com.heyjosi.ce.device-consent`, team `LRH75YR6QW`, hardened runtime and final bundle signing. The component artifacts built here are unsigned and were not executed.

Build checks: Swift 6 optimized helper compilation for macOS 14.2/arm64 and the root TypeScript project build passed. Functional, signing, native peer, OS-presence, cancellation, simultaneous request, restart and remote enrollment acceptance remain deferred under the owner's build-first direction.

Platform references: Apple's [code guest lookup](https://developer.apple.com/documentation/security/seccodecopyguestwithattributes(_:_:_:_:)) and [audit-token guest attribute](https://developer.apple.com/documentation/security/ksecguestattributeaudit); `SOL_LOCAL` / `LOCAL_PEERTOKEN` are declared in the installed macOS SDK's `sys/un.h`. No claimed PID is accepted by the consent listener.
