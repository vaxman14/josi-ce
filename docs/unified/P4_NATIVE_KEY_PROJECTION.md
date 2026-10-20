# Native protected-key component

19 October 2026. Source implementation checkpoint; enrollment and production host assembly remain open.

`apps/automation-macos/Sources/ProtectedKeyProjection.swift` implements the Mac-side cryptographic adapter for protected changes. Its intended canonical signing material lives in the Vault. A Mac-specific, non-exportable Secure Enclave key in the Data Protection Keychain wraps that material before it reaches the server. This wrapping root is part of the accepted Vault root-of-trust hierarchy, not an independently editable rule or secret store.

The Vault payload contains the exact server origin/server/user/device identity, wrapping public key, Ed25519 verification key and hardware-encrypted signing material. The Mac keeps no on-disk signing projection. Creating a new enrollment refuses an existing wrapping root; failures require reconciliation rather than silently replacing a key. This component does not create an enrollment record or grant any authority by itself.

The private wrapping key requires the currently enrolled biometrics and is restricted to this device while unlocked. There is no software-key or ordinary-dialog fallback. An unsupported Mac or changed biometric enrollment leaves protected signing unavailable. A supported alternative for Macs without biometrics remains a release requirement.

After the trusted host displays the full protected challenge, this adapter authenticates the local user with LocalAuthentication. It binds that authentication to the exact canonical message and Vault material, permits one pending request, consumes the challenge locally, and enforces wall-clock expiry and a monotonic deadline. Cancellation invalidates the authentication context. Signing rechecks the challenge, identity and wrapping public key, decrypts only through that authenticated hardware root, checks the derived Ed25519 public key, and returns only the signature. It accepts only the three existing protected-change purposes, not arbitrary messages. The enclosing broker must still check current Vault authority around every asynchronous operation.

The adapter has no executable entry point, renderer IPC or network listener. The component builder includes it as a library. Enrollment, authenticated host delivery, canonical device-record storage, the host adapter connecting the library to the confirmation broker, and revocation/recovery assembly still need implementation. No current app capability was enabled by this checkpoint.

Validation: the new source passes Swift 6 compilation/type checking for Apple Silicon macOS 14.2. No Keychain item was created, no biometric prompt was shown and no private key was generated during this check. Functional, hardware and recovery acceptance remain deferred until integration, as requested by the owner. Temporary payload buffers are cleared where possible; Swift/CryptoKit may retain copies, so this is not a claim of complete memory zeroization.

API references: Apple's [Secure Enclave key guidance](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave), [key encryption guidance](https://developer.apple.com/documentation/security/using-keys-for-encryption), and installed Security/LocalAuthentication SDK declarations.
