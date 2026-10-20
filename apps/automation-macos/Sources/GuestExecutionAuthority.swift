import Foundation
import CryptoKit

private struct GuestAuthorityReference: Codable, Equatable {
    let recordId: UUID; let version: Int; let digest: String; let epoch: Int
    var valid: Bool { version > 0 && epoch > 0 && digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
}
private struct GuestExecutionConsent: Codable, Equatable {
    struct Identity: Codable, Equatable { let userId: UUID; let serverId: UUID; let deviceId: UUID; let workspaceId: UUID }
    struct Authority: Codable, Equatable {
        let consent: GuestAuthorityReference; let permissions: GuestAuthorityReference; let cardinal: GuestAuthorityReference
    }
    let schemaVersion: Int; let identity: Identity; let guestBootId: UUID; let guestChannelId: UUID
    let authority: Authority; let generation: Int; let expiresAtMs: Int64; let leaseUntilMs: Int64
}

/// Runs only in the signed guest companion, after code comparison and the
/// host's protected local consent. A packet alone never authorizes an effect:
/// every command requests a current, exact server permit over that channel.
@MainActor final class GuestExecutionAuthority: GuestDesktopAuthority {
    private let link: GuestLinkWire
    private let host: [String: String]
    private let guestBoot: String
    private let channel: String
    private let requireConnection: @MainActor () throws -> Void
    private let onStop: @MainActor () -> Void
    private var consent: GuestExecutionConsent?
    private var consentDeadline: ContinuousClock.Instant = .now
    private var lastWall = Int64(Date().timeIntervalSince1970 * 1000)
    private var ended = false
    private var engine: GuestDesktopEngine?
    private var packet: [String: String]?
    private var command: GuestDesktopCommand?
    private var pin: GuestPinnedApplication?
    private var taskBinding: (task: UUID, session: UUID)?
    private var reservationIds = Set<String>()
    private var commandIds = Set<UUID>()
    private var watchdog: Task<Void, Never>?

    init(link: GuestLinkWire, host: [String: String], guestBoot: String, channel: String,
         current: @escaping @MainActor () throws -> Void, stopped: @escaping @MainActor () -> Void) {
        self.link = link; self.host = host; self.guestBoot = guestBoot; self.channel = channel
        requireConnection = current; onStop = stopped
    }
    private static func decode<T: Decodable>(_ type: T.Type, _ raw: String) throws -> T {
        guard !raw.isEmpty, raw.utf8.count <= 4096 else { throw GuestDesktopError.denied }
        return try JSONDecoder().decode(type, from: Data(raw.utf8))
    }
    private static func exact(_ raw: String, _ names: Set<String>) throws {
        guard let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              Set(object.keys) == names else { throw GuestDesktopError.denied }
    }
    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func live() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try requireConnection()
        guard !ended, let c = consent, now >= lastWall, now < c.expiresAtMs,
              now < c.leaseUntilMs, ContinuousClock.now < consentDeadline,
              try GuestEnvironment.identity().guest == guestBoot else { throw GuestDesktopError.denied }
        lastWall = now
    }
    func adopt(_ raw: String, leaseUntil: Int) throws {
        if raw.isEmpty {
            if consent != nil { stop() }
            return
        }
        guard !ended else { throw GuestDesktopError.denied }
        try Self.exact(raw, ["schemaVersion", "identity", "guestBootId", "guestChannelId", "authority",
                             "generation", "expiresAtMs", "leaseUntilMs"])
        let next = try Self.decode(GuestExecutionConsent.self, raw)
        guard let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              let identity = object["identity"] as? [String: Any], Set(identity.keys) == ["userId", "serverId", "deviceId", "workspaceId"],
              let authority = object["authority"] as? [String: Any], Set(authority.keys) == ["consent", "permissions", "cardinal"],
              authority.values.allSatisfy({ value in
                  guard let r = value as? [String: Any] else { return false }
                  return Set(r.keys) == ["recordId", "version", "digest", "epoch"]
              }) else { throw GuestDesktopError.denied }
        let now = Int64(Date().timeIntervalSince1970 * 1000), refs = [next.authority.consent, next.authority.permissions, next.authority.cardinal]
        guard next.schemaVersion == 1, next.generation >= 0, now >= lastWall,
              next.guestBootId.uuidString.lowercased() == guestBoot, next.guestChannelId.uuidString.lowercased() == channel,
              next.identity.userId.uuidString.lowercased() == host["userId"],
              next.identity.serverId.uuidString.lowercased() == host["serverId"],
              next.identity.deviceId.uuidString.lowercased() == host["deviceId"],
              next.identity.workspaceId.uuidString.lowercased() == host["workspaceId"],
              next.leaseUntilMs > now, next.leaseUntilMs - now <= 10_000, next.leaseUntilMs <= leaseUntil,
              next.expiresAtMs >= next.leaseUntilMs, next.expiresAtMs - now <= 7_200_000,
              refs.allSatisfy({ $0.valid }), Set(refs.map(\.recordId)).count == 3, Set(refs.map(\.epoch)).count == 1,
              next.authority.permissions.recordId.uuidString.lowercased() == "5864be11-7936-43c5-a8bc-5c725df6c1fd",
              next.authority.cardinal.recordId.uuidString.lowercased() == "ea230e88-65fc-4c35-b05d-1792c00471cf"
        else { throw GuestDesktopError.denied }
        if let previous = consent {
            // Renewal may extend only the short transport lease.
            guard previous.identity == next.identity, previous.authority == next.authority,
                  previous.generation == next.generation, previous.guestBootId == next.guestBootId,
                  previous.guestChannelId == next.guestChannelId, previous.expiresAtMs == next.expiresAtMs
            else { stop(); throw GuestDesktopError.denied }
            try live()
        }
        consent = next; lastWall = now
        consentDeadline = .now.advanced(by: .milliseconds(next.leaseUntilMs - now))
        if engine == nil {
            engine = GuestDesktopEngine(authority: self)
            watchdog = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(200)); try self?.live() }
                    catch { self?.stop(); return }
                }
            }
        }
    }
    var approved: Bool { !ended && consent != nil }
    func stop() {
        guard !ended else { return }
        ended = true; consent = nil; packet = nil; command = nil; pin = nil
        watchdog?.cancel(); watchdog = nil
        let current = engine; engine = nil; current?.dispose()
        onStop()
    }
    func stopped(reason: String) { stop() }

    func execute(_ incoming: [String: String]) async throws -> [String: String] {
        try live()
        guard packet == nil, let c = consent, let engine,
              Set(incoming.keys) == ["kind", "reservationId", "command", "application", "consentDigest"],
              incoming["kind"] == "execute", let reservation = incoming["reservationId"],
              UUID(uuidString: reservation)?.uuidString.lowercased() == reservation,
              !reservationIds.contains(reservation), reservationIds.count < 4096,
              let rawCommand = incoming["command"], let rawPin = incoming["application"] else { throw GuestDesktopError.denied }
        let decoded = try Self.decode(GuestDesktopCommand.self, rawCommand)
        let application = try Self.decode(GuestPinnedApplication.self, rawPin)
        let keys = Set((try JSONSerialization.jsonObject(with: Data(rawCommand.utf8)) as? [String: Any] ?? [:]).keys)
        let required: Set<String> = ["id", "workspaceId", "appId", "installationRevision", "taskId", "sessionId", "generation", "expiresAtMs", "operation"]
        guard required.isSubset(of: keys),
              keys.isSubset(of: required.union(["observationId", "resultObservationId", "windowId", "maxOutputBytes", "elementId", "x", "y", "valueReference", "key", "projection"])),
              [.observe, .project, .press, .focus, .click].contains(decoded.operation),
              decoded.workspaceId == c.identity.workspaceId, decoded.generation == c.generation,
              decoded.expiresAtMs <= c.leaseUntilMs, decoded.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000),
              decoded.appId == application.applicationId, decoded.installationRevision == application.installationRevision,
              application.workspaceId == decoded.workspaceId, application.installationRevision > 0,
              incoming["consentDigest"] == c.authority.consent.digest, !commandIds.contains(decoded.id),
              commandIds.count < 4096 else { throw GuestDesktopError.denied }
        try Self.exact(rawPin, ["workspaceId", "applicationId", "installationRevision", "bundlePath", "bundleId", "signingId", "teamId", "codeHash"])
        if let bound = taskBinding {
            guard bound.task == decoded.taskId, bound.session == decoded.sessionId else { throw GuestDesktopError.denied }
        } else {
            guard decoded.operation == .observe, decoded.observationId == nil else { throw GuestDesktopError.denied }
            taskBinding = (decoded.taskId, decoded.sessionId)
        }
        reservationIds.insert(reservation); commandIds.insert(decoded.id)
        packet = incoming; command = decoded; pin = application
        defer { packet = nil; command = nil; pin = nil }
        if decoded.operation == .project {
            guard let projection = decoded.projection, projection.configurationRevision == 1,
                  projection.modelReference.version > 0, projection.modelReference.epoch == c.authority.consent.epoch,
                  projection.modelReference.digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let recipient = Data(base64Encoded: projection.recipientPublicKey), recipient.count == 32,
                  recipient.base64EncodedString() == projection.recipientPublicKey,
                  let resultId = decoded.resultObservationId, let windowId = decoded.windowId else { throw GuestDesktopError.denied }
            var plain = try await engine.project(decoded)
            defer { plain.resetBytes(in: 0..<plain.count) }
            try live()
            let ephemeral = Curve25519.KeyAgreement.PrivateKey()
            let secret = try ephemeral.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipient))
            let binding = Data(("josi-native-projection.1\n" + reservation + "\n" + Self.digest(rawCommand)).utf8)
            let key = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: binding,
                sharedInfo: Data("josi-native-projection.1".utf8), outputByteCount: 32)
            guard let box = try AES.GCM.seal(plain, using: key, authenticating: binding).combined else { throw GuestDesktopError.denied }
            let encoded = box.base64EncodedString(), pieces = stride(from: 0, to: encoded.utf8.count, by: 3072).map { offset in
                String(encoded.dropFirst(offset).prefix(3072))
            }
            guard pieces.count > 0, pieces.count <= 29 else { throw GuestDesktopError.denied }
            let publicKey = ephemeral.publicKey.rawRepresentation.base64EncodedString(), digest = Self.digest(encoded)
            for (index, piece) in pieces.enumerated() {
                try live()
                try await link.send(["kind": "projection", "commandId": decoded.id.uuidString.lowercased(),
                    "reservationId": reservation, "index": String(index), "count": String(pieces.count),
                    "publicKey": publicKey, "digest": digest, "data": piece])
            }
            return ["kind": "result", "commandId": decoded.id.uuidString.lowercased(), "reservationId": reservation,
                "outcome": "projected", "verificationRequired": "yes", "observationId": resultId.uuidString.lowercased(),
                "windowId": windowId.uuidString.lowercased()]
        }
        let receipt = await engine.execute(decoded)
        // Content stays in guest memory. A separate bounded projection with
        // exact model-transmission authority must precede any future export.
        if receipt.outcome == .uncertain { stop() }
        let observation = receipt.observation
        return ["kind": "result", "commandId": decoded.id.uuidString.lowercased(), "reservationId": reservation,
                "outcome": receipt.outcome.rawValue, "verificationRequired": "yes",
                "observationId": observation?.id.uuidString.lowercased() ?? "",
                "windowId": observation?.windowId.uuidString.lowercased() ?? ""]
    }
    func requireCurrentGuest(_ value: GuestDesktopCommand) async throws {
        try live()
        guard command == value, value.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000) else { throw GuestDesktopError.denied }
    }
    func pinnedApplication(_ value: GuestDesktopCommand) async throws -> GuestPinnedApplication {
        try await requireCurrentGuest(value)
        guard let pin else { throw GuestDesktopError.denied }
        return pin
    }
    func authorize(_ value: GuestDesktopCommand, target: GuestDesktopTarget) async throws {
        try await requireCurrentGuest(value)
        guard let packet, let consent, let rawCommand = packet["command"], let reservation = packet["reservationId"] else {
            throw GuestDesktopError.denied
        }
        // No labels, window title, screenshot or element content in the
        // authorization request. These fields identify the running target.
        let metadata = GuestDesktopTarget(processId: target.processId, launchedAt: target.launchedAt, bundleId: target.bundleId,
            executablePath: target.executablePath, windowTitle: "", bounds: target.bounds)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let targetJSON = String(decoding: try encoder.encode(metadata), as: UTF8.self)
        guard targetJSON.utf8.count <= 4096 else { throw GuestDesktopError.denied }
        let request = ["kind": "authorize", "commandId": value.id.uuidString.lowercased(), "reservationId": reservation,
                       "commandDigest": Self.digest(rawCommand), "target": targetJSON, "targetDigest": Self.digest(targetJSON),
                       "consentDigest": consent.authority.consent.digest]
        try await link.send(request)
        let permit = try await link.receive()
        try await requireCurrentGuest(value)
        guard Set(permit.keys) == ["kind", "commandId", "reservationId", "commandDigest", "targetDigest", "consentDigest", "expiresAtMs"],
              permit["kind"] == "permit", ["commandId", "reservationId", "commandDigest", "targetDigest", "consentDigest"]
                .allSatisfy({ permit[$0] == request[$0] }),
              let raw = permit["expiresAtMs"], let until = Int64(raw), String(until) == raw,
              until > Int64(Date().timeIntervalSince1970 * 1000), until == value.expiresAtMs else { throw GuestDesktopError.denied }
    }
    func projectText(_ reference: UUID, for command: GuestDesktopCommand) async throws -> String {
        throw GuestDesktopError.unsupported
    }
}
