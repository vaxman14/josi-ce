# Canonical protected-device enrollment

19 October 2026. Vault/native component and settings-inventory checkpoint. The subsequent [first-device consent assembly](P4_FIRST_DEVICE_CONSENT.md) connects the macOS enrollment ceremony and settings flow in source; signed installation and integrated acceptance remain open.

Migration 0084 adds a protected-device record kind to the existing encrypted Vault record/history mechanism. It creates no separate credential store. One canonical registry retains at most 32 enrollment records, including revoked entries. Its contents, labels, identities and hardware-wrapped signing material are encrypted; ordinary audit/index rows retain only the existing opaque record/version/epoch metadata.

The store strictly validates exact server origin/server/user/device identity, P-256 wrapping public key, Ed25519 verification key and bounded encrypted signing material. Swift serializes UUIDs in the same lowercase canonical form; binary fields use canonical padded base64 and the confirmation verifier receives an explicit base64url conversion. The server can validate public keys and a proof of signing-key possession; this is **not remote Secure Enclave attestation**.

Enrollment prepares an exact identity/fingerprint presentation and command bound to the proposed material digest, enrollment ID, label, current registry reference and Vault epoch. Committing it requires all of:

- The active super administrator, unlocked Master Vault and private owner box, reconciled authority, exact current registry and trusted installation identity.
- A valid signature from the new Ed25519 key over the domain-separated enrollment command.
- Independent fresh administrator verification and the mandatory trusted first-device/native-owner-consent verifier, both bound to that exact command and presentation.

There is no default first-device verifier, cookie-only path or renderer-boolean substitute. Existing keys, device IDs and enrollment IDs cannot be silently overwritten or revived. Enrollment cannot grant browser, desktop or other execution access.

Revocation likewise prepares and rechecks the exact owned enrollment, requires fresh administrator and protected-human verification, and appends a new canonical version. It retains the encrypted history, advances the Vault epoch and makes old confirmation references stale. It does not erase the OS wrapping root or claim to invalidate a website session. Re-enrollment uses an explicitly reviewed new identity/key; destructive key cleanup and exceptional recovery/reconciliation remain separate release work.

The protected-confirmation journal can resolve the enrolled public key inside its existing Vault transaction through `resolveDeviceKey`. A separate projection operation requires an authenticated current host proof and exact Vault reference, and returns hardware-wrapped material in the redacting `Secret` type with a 60-second lifetime. The native adapter must enforce that lifetime and current authority. Generic protected-record reads cannot export this record; generic draft writes cannot change it.

The Swift adapter now also authenticates and signs the narrow enrollment possession command. It uses the same one-pending-request, one-use authentication context, expiry, monotonic deadline, material binding and Secure Enclave unwrap as protected changes. Invalid signing attempts invalidate the pending context. The enclosing host must show the exact enrollment identity/fingerprints before requesting biometrics and independently establish first-device consent. No generic message signer or new renderer IPC is exposed.

Server settings show the current administrator's **Protected devices** inventory: label, server, enrollment/revocation state and expandable public-key fingerprints. Neither private material nor a projection is returned to this page. The later first-device assembly adds conditional enrollment/pending-review controls. The protected change flow now also supplies **Revoke this device**, using a selected active owned signing device, fresh password/MFA and full native review. No device was actually enrolled or revoked by these build checkpoints.

Validation is limited to compilation/type/build checks. No live Vault migration, Keychain creation, biometric prompt, device enrollment, projection, revocation or functional test was performed. Hardware behavior, concurrent enrollment/revocation, first-device trust, recovery, session loss and projection disposal remain part of the integrated acceptance pass.

The complete root TypeScript build, web type check/production bundle and Swift 6 type check passed for this checkpoint.

The later [protected-host authentication checkpoint](P4_HOST_AUTHENTICATION.md) connects P-256 hardware-root proofs for presentation delivery and wrapped-key projection after enrollment, avoiding use of the unprojected signing key to authorize itself. The subsequent first-device and protected-change assemblies connect enrollment and permanent mutations in source. Signed deployment and functional acceptance remain open.

## Protected revocation assembly

`device.revoke` is now an explicit protected-control purpose in the wire contract, Swift key binding, native review title and server coordinator. The command binds the exact target enrollment and current registry reference. A different active owned device may approve a lost device's revocation; a device may also revoke itself. Revoking the last active owned key adds a full-review warning explaining that a new enrollment on the server Mac is required before further protected changes.

The canonical device mutation independently consumes fresh administrator verification and the signed native challenge in the same Vault transaction that saves revocation. It rechecks the active owned enrollment and current presentation; prior registry/epoch changes make the review stale. The wrapped key projection stays in native main, and the browser receives only the minimized result. A lost final response remains uncertain and is never automatically replayed.

The protocol, root TypeScript build, desktop JavaScript syntax, web production bundle and Swift helper compilation passed. Functional revocation, self/last-device cases, concurrent changes, rollback and lost-response acceptance remain deferred. These checks did not invoke a key, biometric prompt or installed server.
