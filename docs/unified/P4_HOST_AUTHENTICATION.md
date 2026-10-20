# Protected native host authentication

19 October 2026. Source/build checkpoint; functional and hardware acceptance remain deferred. This closes the signing-projection authentication dependency for an **already enrolled** device. It does not establish first-device trust or enable a production control route.

The server previously required a protected-host proof before projecting the wrapped Ed25519 signing key, without a concrete proof adapter. Using that same signing key to request its own projection would be circular. The new adapter instead verifies a narrowly scoped P-256 signature from the device's existing hardware wrapping root.

## Connected components

- A public protocol challenge is derived from one pending, freshly authenticated administrator change. It contains the existing random nonce, exact server/user/device, current Vault key reference, wrapping-key fingerprint and a lifetime of at most 60 seconds. It contains no rule wording or wrapped signing material.
- The signed native helper accepts only the fixed `josi-protected-host-auth.1` message domain. It validates its bound identity, registry reference, wall/monotonic expiry and the actual hardware-root fingerprint. It requires fresh biometrics and signs inside the Secure Enclave with P-256/SHA-256. No software-key fallback, generic signer or private-key export is added.
- The main-process bridge validates the public challenge, preserves the same lifetime and returns the narrow proof. Its existing signed-parent/helper checks, one outstanding frame, cancellation and process deadline still apply. The helper permits one host proof per process. That proof does not consume or replace the separate full-presentation approval.
- The server reloads the enrolled wrapping public key from the current canonical Vault registry and verifies the signature over the exact derived challenge. The proof allows one protected presentation delivery and one hardware-wrapped signing projection, separately consumed in the corresponding Vault transactions. Neither claim approves a permanent change.
- Migration 0089 adds authenticated derived receipt state to the existing protected-challenge journal. Consumed flags are HMAC-bound to that challenge; changing a flag alone does not revive it. Old pending challenges with no authenticated host state must expire and be reissued. Existing expiry, quota, cancellation, revocation, recovery and role/Vault checks continue to apply.
- `VaultRecordStore.protectedNativeControl` connects the concrete delivery/projection verifiers to the existing device and confirmation stores. Installation identity, fresh account verification, first-device consent and revocation confirmation remain required trusted application ports.

The P-256 proof and Ed25519 permanent-change receipt have different message domains, schemas, signature algorithms and consumption paths. The host proof cannot be passed to the permanent-policy verifier. Signing a permanent change still requires loading current wrapped material, displaying the exact rule/permission meaning, a separate biometric approval and the existing transaction-bound fresh-administrator proof.

## Limits and next assembly

This verifies possession of a previously enrolled root. It is not remote hardware attestation and cannot justify first enrollment by itself. The independently reviewed enrollment ceremony remains mandatory. No HTTP enrollment/activation route, renderer signing API or model tool is added; production capability flags remain disabled.

The transport/coordinator must deliver the public challenge only for the correct authenticated administrator request, keep proofs and projections in the protected main process, and retain HTTPS for off-device traffic. A lost response after receipt consumption requires a newly issued review; it is not silently replayed. The projection remains a short-lived hardware-encrypted key projection, not a general device-control session or browser permission. Whole-history rollback protection still requires the independent device checkpoint planned in P2/P4.

No live Vault migration, Keychain operation, biometric prompt, device enrollment or rule change was performed. Compilation does not establish hardware behavior, cross-language signature interoperability, concurrent receipt consumption, rollback/recovery or UI/transport acceptance.

Build checks passed: the complete root TypeScript build, main-process JavaScript syntax, public-source secret scan and optimized Swift 6 helper compilation for macOS 14.2. The disposable compiled helper remains unsigned and was not executed.

## Platform references

Apple documents Secure Enclave P-256 key use for signing and ECIES operations in [Protecting keys with the Secure Enclave](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave). The implementation checks algorithm support and uses [SecKeyCreateSignature](https://developer.apple.com/documentation/security/seckeycreatesignature(_:_:_:_:)) with [ECDSA message SHA-256](https://developer.apple.com/documentation/security/seckeyalgorithm/ecdsasignaturemessagex962sha256). These API references do not substitute for the deferred hardware acceptance run.
