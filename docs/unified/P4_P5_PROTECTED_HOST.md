# P4/P5 protected native host and desktop packaging

Implementation checkpoint under the owner's build-first direction. This is not a completed enrollment, activation, packaging or acceptance gate.

## Implemented

`JosiProtectedKeyHost` is a short-lived Swift executable using the existing hardware-wrapped Vault signing component. It accepts bounded, length-framed requests through its parent process's pipes, with one immutable server/account/device identity. It has no network listener, command-line signing interface or arbitrary-message signing operation. Enrollment possession and protected policy confirmations use distinct, constrained messages.

The helper verifies its actual parent process against the Josi bundle identifier and Developer ID team, the fixed installed path, hardened runtime, prohibited debugging entitlements, signed bundle resources, packaged-code integrity configuration and pinned Electron fuse states. It rechecks the parent around every request and asynchronous biometric operation. Unsigned development shells cannot use it. Lost parents, invalid requests, expiry and cancellation terminate the signing process. Host creation of new material requires real local biometric authentication; normal signing retains the same authenticated native context used to unlock the hardware wrapping root.

`apps/desktop/src/protected-key.cjs` is a main-process transport. It verifies the helper's fixed path and signature before launch, binds requests to exact identity and Vault projections, checks canonical frame/material/signature formats, and kills the child on cancellation. Projections retain their original expiry through authentication and signing, including monotonic time and clock rollback checks. Wrapped material is transient; it is not another canonical credential store. No renderer IPC exports this transport.

The protected confirmation surface accepts a trusted native authentication callback. This lets the same native authentication context approve and unwrap a key without adding a second unrelated biometric prompt. The existing surface alone still does not enroll a device or activate a rule.

The one-app builder now archives desktop code into `app.asar`, records its SHA-256 header integrity in the app's signed property list, and sets the pinned Electron fuses. Node-as-executable, Node environment options, CLI inspector switches and extra file-protocol privileges are disabled; ASAR-only loading and embedded integrity validation are enabled. Packaged startup rejects alternate launch arguments and developer environment switches before creating any renderer. The pinned official `@electron/asar` and `@electron/fuses` packages are build-only dependencies.

The builder requires an explicit Node 22.12+ executable, compiles the protected helper, and includes only that executable under `Contents/Helpers`. Compilation outputs and caches remain outside the app payload. It records the helper hash and desktop integrity/fuse state in provenance. The app and installer minimum is macOS 14.2, matching the native component target. It continues to create fresh unsigned candidates only.

## Remaining assembly and acceptance

First-device human trust, authenticated app/server pairing and transport, server command coordination, native projection delivery, UI enrollment and permanent policy activation remain to be connected. A valid key signature is possession evidence, not remote hardware attestation or independent human consent. Ordinary session cookies cannot substitute for the missing host proof.

Release signing must use the declared helper identity `com.heyjosi.ce.protected-key`, hardened runtime and the appropriate data-protection Keychain access, then sign the complete sealed application. No signing, Keychain mutation, installed app execution or live server enrollment occurred at this checkpoint. Functional acceptance must check real packaged launch arguments, signature/fuse rejection, biometric cancellation and expiry, Keychain access, launch/update migration and authenticated remote-server operation.

## Build record

The optimized native helper compiled with Swift 6 for Apple Silicon macOS 14.2. Changed JavaScript and Python parsed successfully. No functional suites or signing experiments were run. Full packaging and runtime acceptance remain deferred until feature implementation is assembled.
