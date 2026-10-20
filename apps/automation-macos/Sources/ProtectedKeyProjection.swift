import Foundation
import CryptoKit
import LocalAuthentication
import Security

enum ProtectedKeyError: Error { case unavailable, invalid, expired, busy, cancelled }

struct ProtectedDeviceIdentity: Codable, Equatable {
    let serverOrigin: String
    let serverId: UUID
    let userId: UUID
    let deviceId: UUID
    private enum CodingKeys: String, CodingKey { case serverOrigin, serverId, userId, deviceId }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(serverOrigin, forKey: .serverOrigin)
        try container.encode(serverId.uuidString.lowercased(), forKey: .serverId)
        try container.encode(userId.uuidString.lowercased(), forKey: .userId)
        try container.encode(deviceId.uuidString.lowercased(), forKey: .deviceId)
    }
}

/// Canonical material belongs in the Vault. The signing key is additionally
/// encrypted to this Mac's hardware wrapping key, so it is not a plaintext
/// private key export to the server. Persist no copy of this projection here.
struct NativeVaultSigningMaterial: Codable, Equatable {
    let schemaVersion: Int
    let identity: ProtectedDeviceIdentity
    let wrappingPublicKey: Data
    let signingPublicKeySpki: Data
    let wrappedPrivateKey: Data
}

private struct WrappedSigningKey: Codable {
    let purpose: String
    let identity: ProtectedDeviceIdentity
    let privateKey: Data
    let publicKey: Data
}

/// Host-only cryptographic adapter for the protected confirmation broker.
/// No CLI, network listener, renderer IPC, generic sign API, software-key
/// fallback or automatic key replacement is supplied by this component.
@MainActor
final class ProtectedKeyProjection {
    private let identity: ProtectedDeviceIdentity
    private let tag: Data
    private let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorX963SHA256AESGCM
    private var generation = 0
    private var pending: Approval?
    private var hostAuthentication: LAContext?
    private var hostProofUsed = false
    private var consumed = Set<UUID>()
    private struct Approval {
        let id: UUID
        let messageDigest: Data
        let material: NativeVaultSigningMaterial
        let expiresAtMs: Int64
        let monotonicDeadline: ContinuousClock.Instant
        let context: LAContext
        var authenticated: Bool
    }
    private struct Binding { let id: UUID; let expiresAtMs: Int64 }
    private static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

    init(identity: ProtectedDeviceIdentity) throws {
        guard Self.allowedOrigin(identity.serverOrigin), SecureEnclave.isAvailable else { throw ProtectedKeyError.unavailable }
        self.identity = identity
        self.tag = Data("com.heyjosi.vault.wrap.1:\(identity.serverId.uuidString.lowercased()):\(identity.userId.uuidString.lowercased()):\(identity.deviceId.uuidString.lowercased())".utf8)
    }
    private static func allowedOrigin(_ value: String) -> Bool {
        guard value.utf8.count <= 2048, let parts = URLComponents(string: value), let host = parts.host,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              !value.contains(where: { $0.isWhitespace }) else { return false }
        return parts.scheme == "https" || parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)
    }
    private func keyQuery(context: LAContext? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: tag,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let context { query[kSecUseAuthenticationContext as String] = context }
        return query
    }
    private func loadRoot(context: LAContext) throws -> SecKey {
        var item: CFTypeRef?
        guard SecItemCopyMatching(keyQuery(context: context) as CFDictionary, &item) == errSecSuccess,
              let item, CFGetTypeID(item) == SecKeyGetTypeID() else { throw ProtectedKeyError.unavailable }
        let key = unsafeDowncast(item, to: SecKey.self)
        guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              attributes[kSecAttrTokenID as String] as? String == kSecAttrTokenIDSecureEnclave as String,
              SecKeyIsAlgorithmSupported(key, .decrypt, algorithm) else { throw ProtectedKeyError.unavailable }
        return key
    }
    private func publicBytes(_ key: SecKey) throws -> Data {
        guard let publicKey = SecKeyCopyPublicKey(key),
              let bytes = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else { throw ProtectedKeyError.unavailable }
        return bytes
    }
    /// Called only during a locally reviewed, newly identified enrollment.
    /// A failure to store the returned material leaves an orphan wrapping root;
    /// the enrollment coordinator must reconcile it, never silently overwrite.
    func createForNewEnrollment() throws -> NativeVaultSigningMaterial {
        guard pending == nil, hostAuthentication == nil else { throw ProtectedKeyError.busy }
        let context = LAContext(); context.interactionNotAllowed = true
        defer { context.invalidate() }
        var existing: CFTypeRef?
        guard SecItemCopyMatching(keyQuery(context: context) as CFDictionary, &existing) == errSecItemNotFound else {
            throw ProtectedKeyError.unavailable
        }
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet], &accessError) else { throw ProtectedKeyError.unavailable }
        var createError: Unmanaged<CFError>?
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag,
                kSecAttrAccessControl as String: access,
            ],
        ]
        guard let root = SecKeyCreateRandomKey(attributes as CFDictionary, &createError),
              let wrappingPublic = SecKeyCopyPublicKey(root),
              SecKeyIsAlgorithmSupported(wrappingPublic, .encrypt, algorithm) else { throw ProtectedKeyError.unavailable }
        let signing = Curve25519.Signing.PrivateKey()
        var payload = try JSONEncoder().encode(WrappedSigningKey(purpose: "josi-native-protected-signing.1", identity: identity,
            privateKey: signing.rawRepresentation, publicKey: signing.publicKey.rawRepresentation))
        defer { payload.resetBytes(in: payload.startIndex..<payload.endIndex) }
        var encryptionError: Unmanaged<CFError>?
        guard let wrapped = SecKeyCreateEncryptedData(wrappingPublic, algorithm, payload as CFData, &encryptionError) as Data? else {
            throw ProtectedKeyError.unavailable
        }
        return NativeVaultSigningMaterial(schemaVersion: 1, identity: identity, wrappingPublicKey: try publicBytes(root),
            signingPublicKeySpki: Self.spkiPrefix + signing.publicKey.rawRepresentation, wrappedPrivateKey: wrapped)
    }

    private func binding(_ message: Data) throws -> Binding {
        let prefix = Data("josi-protected-control.1\n".utf8)
        guard message.count <= 128 * 1024, message.starts(with: prefix),
              let fields = try JSONSerialization.jsonObject(with: message.dropFirst(prefix.count)) as? [Any], fields.count == 13 else {
            throw ProtectedKeyError.invalid
        }
        func integer(_ value: Any) -> Int64? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue >= 0,
                  number.doubleValue <= 9_007_199_254_740_991, number.doubleValue.rounded() == number.doubleValue else { return nil }
            return number.int64Value
        }
        func string(_ value: Any, max: Int) -> String? {
            guard let text = value as? String, !text.isEmpty, text.utf16.count <= max,
                  text.range(of: "[\\x{0000}-\\x{0008}\\x{000b}\\x{000c}\\x{000e}-\\x{001f}\\x{007f}\\x{202a}-\\x{202e}\\x{2066}-\\x{2069}]", options: .regularExpression) == nil else { return nil }
            return text
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard integer(fields[0]) == 1,
              let rawId = fields[1] as? String, let id = UUID(uuidString: rawId),
              let nonce = fields[2] as? String, nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              fields[3] as? String == identity.serverOrigin,
              (fields[4] as? String).flatMap(UUID.init(uuidString:)) == identity.serverId,
              (fields[5] as? String).flatMap(UUID.init(uuidString:)) == identity.userId,
              (fields[6] as? String).flatMap(UUID.init(uuidString:)) == identity.deviceId,
              let purpose = fields[7] as? String, ["cardinal.activate", "cardinal.retire", "automation.policy.replace", "device.revoke"].contains(purpose),
              let digest = fields[8] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let reference = fields[9] as? [Any], reference.count == 4,
              let referenceId = reference[0] as? String, UUID(uuidString: referenceId) != nil,
              let version = integer(reference[1]), version > 0,
              let checksum = reference[2] as? String, checksum.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let epoch = integer(reference[3]), epoch > 0,
              let issued = integer(fields[10]), let expires = integer(fields[11]), issued <= now, expires > now,
              expires > issued, expires - issued <= 120_000,
              let presentation = fields[12] as? [Any], presentation.count == 3,
              string(presentation[0], max: 4000) != nil, string(presentation[1], max: 64_000) != nil,
              let advisory = presentation[2] as? [Any], advisory.count <= 20,
              advisory.allSatisfy({ string($0, max: 2600) != nil }) else { throw ProtectedKeyError.invalid }
        return Binding(id: id, expiresAtMs: expires)
    }
    private func valid(_ material: NativeVaultSigningMaterial) -> Bool {
        material.schemaVersion == 1 && material.identity == identity && material.wrappingPublicKey.count == 65
            && material.signingPublicKeySpki.count == 44 && material.signingPublicKeySpki.starts(with: Self.spkiPrefix)
            && material.wrappedPrivateKey.count > 32 && material.wrappedPrivateKey.count <= 4096
    }
    private func live(_ approval: Approval) throws {
        guard approval.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000),
              ContinuousClock.now < approval.monotonicDeadline, !Task.isCancelled else { throw ProtectedKeyError.expired }
    }

    /// Protected host must have shown the full exact challenge beforehand and
    /// must revalidate current Vault authority around this operation. This is
    /// real OS authentication, not a renderer boolean or an agent approval.
    func authenticate(message: Data, material: NativeVaultSigningMaterial) async throws {
        try await authenticateBound(message: message, material: material, request: binding(message),
            reason: "Approve the exact Josi protected change you reviewed.")
    }
    private func authenticateBound(message: Data, material: NativeVaultSigningMaterial, request: Binding, reason: String) async throws {
        guard pending == nil, hostAuthentication == nil, valid(material), consumed.count < 4096 else { throw ProtectedKeyError.busy }
        guard !consumed.contains(request.id) else { throw ProtectedKeyError.invalid }
        let context = LAContext()
        context.localizedFallbackTitle = ""
        context.touchIDAuthenticationAllowableReuseDuration = 0
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            context.invalidate(); throw ProtectedKeyError.unavailable
        }
        consumed.insert(request.id)
        let ownGeneration = generation
        let approval = Approval(id: request.id, messageDigest: Data(SHA256.hash(data: message)), material: material,
            expiresAtMs: request.expiresAtMs,
            monotonicDeadline: ContinuousClock.now.advanced(by: .milliseconds(request.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000))),
            context: context, authenticated: false)
        pending = approval
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason) else { throw ProtectedKeyError.cancelled }
            try live(approval)
            guard generation == ownGeneration, pending?.id == request.id else { throw ProtectedKeyError.cancelled }
            context.interactionNotAllowed = true
            pending?.authenticated = true
        } catch {
            context.invalidate()
            if pending?.id == request.id { pending = nil }
            throw ProtectedKeyError.cancelled
        }
    }

    /// Sign only the exact authenticated protected challenge once. The host
    /// receives a signature, never the unwrapped signing private key.
    func sign(message: Data, material: NativeVaultSigningMaterial) throws -> Data {
        do { return try signBound(message: message, material: material, request: binding(message)) }
        catch { cancel(); throw error }
    }
    private func signBound(message: Data, material: NativeVaultSigningMaterial, request: Binding) throws -> Data {
        guard let approval = pending else { throw ProtectedKeyError.unavailable }
        pending = nil
        defer { approval.context.invalidate() }
        try live(approval)
        guard approval.authenticated, approval.id == request.id, approval.expiresAtMs == request.expiresAtMs, approval.material == material,
              approval.messageDigest == Data(SHA256.hash(data: message)), valid(material) else { throw ProtectedKeyError.invalid }
        let root = try loadRoot(context: approval.context)
        guard try publicBytes(root) == material.wrappingPublicKey else { throw ProtectedKeyError.invalid }
        var decryptionError: Unmanaged<CFError>?
        guard var plaintext = SecKeyCreateDecryptedData(root, algorithm, material.wrappedPrivateKey as CFData, &decryptionError) as Data? else {
            throw ProtectedKeyError.unavailable
        }
        defer { plaintext.resetBytes(in: plaintext.startIndex..<plaintext.endIndex) }
        let wrapped = try JSONDecoder().decode(WrappedSigningKey.self, from: plaintext)
        guard wrapped.purpose == "josi-native-protected-signing.1", wrapped.identity == identity,
              wrapped.privateKey.count == 32, wrapped.publicKey.count == 32 else { throw ProtectedKeyError.invalid }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: wrapped.privateKey)
        guard key.publicKey.rawRepresentation == wrapped.publicKey,
              Self.spkiPrefix + wrapped.publicKey == material.signingPublicKeySpki else { throw ProtectedKeyError.invalid }
        try live(approval)
        return try key.signature(for: message)
    }

    private func enrollmentMessage(_ commandDigest: String) throws -> Data {
        guard commandDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ProtectedKeyError.invalid }
        // Narrow possession proof, domain-separated from permanent changes.
        // The exact command digest includes this material's digest, identity,
        // enrollment ID, label and current Vault reference/epoch on the server.
        return Data("josi-protected-device-enrollment.1\n".utf8)
            + (try JSONSerialization.data(withJSONObject: ["device.enroll", commandDigest], options: [.withoutEscapingSlashes]))
    }
    private func enrollmentBinding(attemptId: UUID, expiresAtMs: Int64) throws -> Binding {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard expiresAtMs > now, expiresAtMs - now <= 120_000 else { throw ProtectedKeyError.expired }
        return Binding(id: attemptId, expiresAtMs: expiresAtMs)
    }
    /// The trusted enrollment host must display the exact identity and key
    /// fingerprints and verify the server-derived command before this call.
    /// This proves possession, not remote hardware attestation. Server-side
    /// first-device consent remains an independent mandatory boundary.
    func authenticateEnrollment(commandDigest: String, material: NativeVaultSigningMaterial, attemptId: UUID, expiresAtMs: Int64) async throws {
        try await authenticateBound(message: enrollmentMessage(commandDigest), material: material,
            request: enrollmentBinding(attemptId: attemptId, expiresAtMs: expiresAtMs),
            reason: "Enroll this Mac for the Josi administrator account you reviewed.")
    }
    func signEnrollment(commandDigest: String, material: NativeVaultSigningMaterial, attemptId: UUID, expiresAtMs: Int64) throws -> Data {
        do { return try signBound(message: enrollmentMessage(commandDigest), material: material,
            request: enrollmentBinding(attemptId: attemptId, expiresAtMs: expiresAtMs)) }
        catch { cancel(); throw error }
    }

    /// Authenticate the enrolled hardware root before the server projects the
    /// wrapped Ed25519 key. This operation neither unwraps that key nor signs
    /// a rule change. Only the fixed host-authentication message is accepted.
    func proveHost(message: Data) async throws -> Data {
        try await proveBoundHost(message: message, storage: false)
    }
    /// A separate, exact storage domain; cannot authorize rules or input.
    func proveWorkspaceStorage(message: Data) async throws -> Data {
        try await proveBoundHost(message: message, storage: true)
    }
    private func proveBoundHost(message: Data, storage: Bool) async throws -> Data {
        guard pending == nil, hostAuthentication == nil, !hostProofUsed else { throw ProtectedKeyError.busy }
        let prefix = Data((storage ? "josi-workspace-storage.1\n" : "josi-protected-host-auth.1\n").utf8)
        guard message.count <= 4096, message.starts(with: prefix),
              let fields = try JSONSerialization.jsonObject(with: message.dropFirst(prefix.count)) as? [Any],
              fields.count == (storage ? 15 : 11) else { throw ProtectedKeyError.invalid }
        func integer(_ value: Any) -> Int64? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
                  number.doubleValue.rounded() == number.doubleValue else { return nil }
            return number.int64Value
        }
        func digest(_ value: Any) -> String? {
            guard let value = value as? String, value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
            return value
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard integer(fields[0]) == 1, let id = fields[1] as? String, UUID(uuidString: id) != nil,
              let nonce = fields[2] as? String, nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              fields[3] as? String == identity.serverOrigin,
              (fields[4] as? String).flatMap(UUID.init(uuidString:)) == identity.serverId,
              (fields[5] as? String).flatMap(UUID.init(uuidString:)) == identity.userId,
              (fields[6] as? String).flatMap(UUID.init(uuidString:)) == identity.deviceId,
              let reference = fields[7] as? [Any], reference.count == 4,
              reference[0] as? String == "914a736a-94bf-46f2-a602-82ff4180c45d",
              let version = integer(reference[1]), version > 0, digest(reference[2]) != nil,
              let epoch = integer(reference[3]), epoch > 0, let expectedFingerprint = digest(fields[8]),
              let issued = integer(fields[9]), let expires = integer(fields[10]),
              issued <= now, expires > now, expires > issued, expires - issued <= 60_000 else { throw ProtectedKeyError.invalid }
        if storage {
            guard let operation = fields[11] as? String, ["provision", "open"].contains(operation),
                  let workspace = fields[12] as? String, UUID(uuidString: workspace)?.uuidString.lowercased() == workspace,
                  let label = fields[13] as? String, !label.isEmpty, label.utf16.count <= 120,
                  label.trimmingCharacters(in: .whitespacesAndNewlines) == label,
                  label.range(of: "[\\x{0000}-\\x{001f}\\x{007f}\\x{202a}-\\x{202e}\\x{2066}-\\x{2069}]", options: .regularExpression) == nil,
                  let capacity = integer(fields[14]), (64...512).contains(capacity) else { throw ProtectedKeyError.invalid }
        }
        let context = LAContext()
        context.localizedFallbackTitle = ""
        context.touchIDAuthenticationAllowableReuseDuration = 0
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            context.invalidate(); throw ProtectedKeyError.unavailable
        }
        hostProofUsed = true; hostAuthentication = context
        let ownGeneration = generation
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(expires - now))
        defer { context.invalidate(); hostAuthentication = nil }
        func current() throws {
            let wall = Int64(Date().timeIntervalSince1970 * 1000)
            guard wall >= now, wall < expires, ContinuousClock.now < deadline,
                  generation == ownGeneration, hostAuthentication === context, !Task.isCancelled else { throw ProtectedKeyError.expired }
        }
        let reason = storage
            ? "Authorize the separate Josi workspace storage operation you reviewed, using its key from \(identity.serverOrigin)."
            : "Connect this enrolled Mac to \(identity.serverOrigin) for a protected Josi review. This does not approve a rule change."
        guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) else {
            throw ProtectedKeyError.cancelled
        }
        try current()
        context.interactionNotAllowed = true
        let root = try loadRoot(context: context)
        let fingerprint = try SHA256.hash(data: publicBytes(root)).map { String(format: "%02x", $0) }.joined()
        let signingAlgorithm: SecKeyAlgorithm = .ecdsaSignatureMessageX962SHA256
        guard fingerprint == expectedFingerprint, SecKeyIsAlgorithmSupported(root, .sign, signingAlgorithm) else { throw ProtectedKeyError.invalid }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(root, signingAlgorithm, message as CFData, &error) as Data?,
              signature.count >= 8, signature.count <= 72 else { throw ProtectedKeyError.unavailable }
        try current()
        return signature
    }

    func cancel() {
        generation += 1; pending?.context.invalidate(); pending = nil
        hostAuthentication?.invalidate(); hostAuthentication = nil
    }
}
