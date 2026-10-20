import Foundation
import Security
import LocalAuthentication
import CryptoKit
import Darwin

private enum HostFailure: Error { case unavailable, invalid }

/// The helper accepts only its actual signed, hardened parent. A loopback
/// connection, renderer PID or a claimed bundle identifier is not a peer.
@MainActor
private final class ProtectedParent {
    private let pid: pid_t
    private let requirement: SecRequirement
    init() throws {
        pid = getppid()
        guard pid > 1, isatty(STDIN_FILENO) == 0, isatty(STDOUT_FILENO) == 0 else { throw HostFailure.unavailable }
        for descriptor in [STDIN_FILENO, STDOUT_FILENO] {
            var info = stat()
            guard fstat(descriptor, &info) == 0, [S_IFIFO, S_IFSOCK].contains(info.st_mode & S_IFMT) else { throw HostFailure.unavailable }
        }
        requirement = try ProtectedAppTrust.requirement()
        try current(full: true)
        try ProtectedAppTrust.packagedCode()
    }
    func current(full: Bool = false) throws {
        guard getppid() == pid else { throw HostFailure.unavailable }
        var dynamic: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: pid] as CFDictionary, [], &dynamic) == errSecSuccess,
              let dynamic else { throw HostFailure.unavailable }
        try ProtectedAppTrust.verify(dynamic, requirement: requirement, full: full)
    }
}

private struct KeyRequest: Decodable {
    let schemaVersion: Int
    let id: UUID
    let identity: ProtectedDeviceIdentity
    let operation: String
    let message: String?
    let material: NativeVaultSigningMaterial?
    let commandDigest: String?
    let attemptId: UUID?
    let expiresAtMs: Int64?
}
@main
@MainActor
struct ProtectedKeyHost {
    private static let limit = 256 * 1024
    private static func read(_ count: Int) throws -> Data? {
        var data = Data()
        while data.count < count {
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 120_000)
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { throw HostFailure.unavailable }
            let part = try FileHandle.standardInput.read(upToCount: count - data.count) ?? Data()
            if part.isEmpty { if data.isEmpty { return nil }; throw HostFailure.invalid }
            data.append(part)
        }
        return data
    }
    private static func request() throws -> KeyRequest? {
        guard let header = try read(4) else { return nil }
        let length = header.reduce(0) { ($0 << 8) | Int($1) }
        guard length > 0, length <= limit, let body = try read(length),
              let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let operation = object["operation"] as? String else { throw HostFailure.invalid }
        let base: Set<String> = ["schemaVersion", "id", "identity", "operation"]
        let additional: Set<String>
        switch operation {
        case "hello", "create", "cancel": additional = []
        case "authenticate", "sign": additional = ["message", "material"]
        case "proveHost", "proveWorkspaceStorage": additional = ["message"]
        case "authenticateEnrollment", "signEnrollment": additional = ["commandDigest", "material", "attemptId", "expiresAtMs"]
        default: throw HostFailure.invalid
        }
        guard Set(object.keys) == base.union(additional),
              let identity = object["identity"] as? [String: Any],
              Set(identity.keys) == ["serverOrigin", "serverId", "userId", "deviceId"] else { throw HostFailure.invalid }
        if additional.contains("material") {
            guard let material = object["material"] as? [String: Any],
                  Set(material.keys) == ["schemaVersion", "identity", "wrappingPublicKey", "signingPublicKeySpki", "wrappedPrivateKey"],
                  let identity = material["identity"] as? [String: Any],
                  Set(identity.keys) == ["serverOrigin", "serverId", "userId", "deviceId"] else { throw HostFailure.invalid }
        }
        let value = try JSONDecoder().decode(KeyRequest.self, from: body)
        guard value.schemaVersion == 1 else { throw HostFailure.invalid }
        return value
    }
    private static func respond(_ id: UUID, _ result: [String: Any]) throws {
        let body = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "id": id.uuidString.lowercased(), "result": result])
        guard body.count <= limit else { throw HostFailure.invalid }
        let size = UInt32(body.count)
        let header = Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)])
        try FileHandle.standardOutput.write(contentsOf: header + body)
    }
    private static func message(_ value: String?) throws -> Data {
        guard let value, let data = Data(base64Encoded: value), data.count <= 128 * 1024,
              data.base64EncodedString() == value else { throw HostFailure.invalid }
        return data
    }
    private static func urlBase64(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func main() async {
        // A lost/stalled parent cannot retain a privileged signing process.
        // Cancellation also closes/kills this child from the main-process port.
        signal(SIGPIPE, SIG_IGN)
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(120))
        timer.setEventHandler { Darwin._exit(78) }
        timer.resume()
        defer { timer.cancel() }
        var projection: ProtectedKeyProjection?
        do {
            let parent = try ProtectedParent()
            var identity: ProtectedDeviceIdentity?
            var seen = Set<UUID>()
            while let input = try request() {
                guard seen.count < 16, seen.insert(input.id).inserted else { throw HostFailure.invalid }
                try parent.current()
                if let identity { guard input.identity == identity else { throw HostFailure.invalid } }
                else { identity = input.identity; projection = try ProtectedKeyProjection(identity: input.identity) }
                guard let projection else { throw HostFailure.unavailable }
                let result: [String: Any]
                switch input.operation {
                case "hello":
                    result = ["available": true, "protocol": 1]
                case "create":
                    let context = LAContext()
                    context.localizedFallbackTitle = ""
                    context.touchIDAuthenticationAllowableReuseDuration = 0
                    defer { context.invalidate() }
                    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil),
                          try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                              localizedReason: "Create protected Josi signing material for the server and account you reviewed.") else { throw HostFailure.unavailable }
                    try parent.current()
                    let material = try projection.createForNewEnrollment()
                    result = ["material": try JSONSerialization.jsonObject(with: JSONEncoder().encode(material))]
                case "authenticate":
                    guard let material = input.material else { throw HostFailure.invalid }
                    try await projection.authenticate(message: message(input.message), material: material)
                    result = ["authenticated": true]
                case "proveHost":
                    result = ["signature": urlBase64(try await projection.proveHost(message: message(input.message)))]
                case "proveWorkspaceStorage":
                    result = ["signature": urlBase64(try await projection.proveWorkspaceStorage(message: message(input.message)))]
                case "sign":
                    guard let material = input.material else { throw HostFailure.invalid }
                    result = ["signature": urlBase64(try projection.sign(message: message(input.message), material: material))]
                case "authenticateEnrollment", "signEnrollment":
                    guard let material = input.material, let digest = input.commandDigest, let attempt = input.attemptId,
                          let expires = input.expiresAtMs else { throw HostFailure.invalid }
                    if input.operation == "authenticateEnrollment" {
                        try await projection.authenticateEnrollment(commandDigest: digest, material: material, attemptId: attempt, expiresAtMs: expires)
                        result = ["authenticated": true]
                    } else {
                        result = ["signature": urlBase64(try projection.signEnrollment(commandDigest: digest, material: material, attemptId: attempt, expiresAtMs: expires))]
                    }
                case "cancel":
                    projection.cancel(); result = ["cancelled": true]
                default: throw HostFailure.invalid
                }
                try parent.current()
                try respond(input.id, result)
            }
            projection?.cancel()
        } catch {
            projection?.cancel()
            // Never print command bytes, material, OS error details or a key.
            Darwin._exit(78)
        }
    }
}
