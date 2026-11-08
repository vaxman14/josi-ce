import Foundation
import CryptoKit
import Security

/// Standalone v2 codec; the older protected-device protocol is unchanged.
enum ComputerWire {
    static let version = "computer-control.2"
    static func canonical(_ value: Wire) throws -> String {
        switch value {
        case .null: return "null"
        case .bool(let v): return v ? "true" : "false"
        case .object(let v): return "{" + (try v.keys.sorted().map { try canonical(.string($0)) + ":" + canonical(v[$0]!) }).joined(separator: ",") + "}"
        case .array(let v): return "[" + (try v.map(canonical)).joined(separator: ",") + "]"
        case .number(let value):
            guard value.isFinite, value.rounded() == value, abs(value) < 9_007_199_254_740_992 else { throw JosiError(message: "Invalid protocol integer.") }
            return String(Int64(value))
        case .string(let value):
            let bytes = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
            guard let text = String(data: bytes, encoding: .utf8) else { throw JosiError(message: "Invalid protocol text.") }
            return text
        }
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func digest(_ value: Wire) throws -> String { digest(Data(try canonical(value).utf8)) }
}

/// Created only from an explicit local enrollment action. Reading a saved key
/// never re-enrolls a revoked device or changes any existing enrollment.
struct ComputerDeviceKey {
    let key: Curve25519.Signing.PrivateKey
    var publicKey: String { key.publicKey.rawRepresentation.base64EncodedString() }
    var id: String { "mac-" + ComputerWire.digest(key.publicKey.rawRepresentation).prefix(40) }
    static func load(server: String, owner: String, create: Bool = false) throws -> ComputerDeviceKey? {
        let account = ComputerWire.digest(Data((server + "\n" + owner).utf8))
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.heyjosi.computer-control.2", kSecAttrAccount as String: account]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { _, b in b } as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return ComputerDeviceKey(key: try Curve25519.Signing.PrivateKey(rawRepresentation: data)) }
        guard status == errSecItemNotFound else { throw JosiError(message: "The computer-control device key is unavailable.") }
        guard create else { return nil }
        let key = Curve25519.Signing.PrivateKey()
        let add = query.merging([kSecValueData as String: key.rawRepresentation, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, b in b }
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw JosiError(message: "Could not save this computer’s device identity.") }
        return ComputerDeviceKey(key: key)
    }
    func proof(owner: String, method: String, body: Wire, now: Int = Int(Date().timeIntervalSince1970 * 1000)) throws -> Wire {
        let payload: Wire = ["version": .string(ComputerWire.version), "ownerId": .string(owner), "deviceId": .string(id),
            "nonce": .string(UUID().uuidString.lowercased()), "timestamp": .number(Double(now)), "method": .string(method), "body": body]
        let signature = try key.signature(for: Data(ComputerWire.canonical(payload).utf8))
        return ["payload": payload, "signature": .string(signature.base64EncodedString())]
    }
}

/// The latch and lease are checked by every native effect, independent of HTTP.
/// Relaunch is always stopped. Clock rollback cannot extend a monotonic lease.
@MainActor final class ComputerLocalGate: ObservableObject {
    enum Mode: String { case stopped, ready, working, takeover, paused }
    @Published private(set) var mode: Mode = .stopped
    @Published private(set) var detail = "Stopped locally. Resume is explicit."
    private(set) var generation = 0
    private var deadline: UInt64 = 0
    private var authorityDeadline: UInt64 = 0
    private var requestId = ""
    private var revision = 0
    private let wallNow: () -> Int
    private let monotonicNow: () -> UInt64
    var cancelOwnedWork: () -> Void = {}
    init(wallNow: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         monotonicNow: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) {
        self.wallNow = wallNow; self.monotonicNow = monotonicNow
    }
    func stop(_ reason: String = "Stopped locally") {
        generation += 1; deadline = 0; mode = .stopped; detail = reason; cancelOwnedWork()
    }
    func pause() { generation += 1; deadline = 0; mode = .paused; detail = "Paused — no new input or commands"; cancelOwnedWork() }
    func takeover() {
        guard mode == .working || mode == .ready else { return }
        generation += 1; deadline = 0; mode = .takeover; detail = "You have control. Resume when ready."; cancelOwnedWork()
    }
    func resume() {
        guard mode != .working else { return }
        generation += 1; deadline = 0; mode = .ready; detail = "Ready; waiting for authorized work"
    }
    func begin(_ request: Wire, device: Wire, owner: String, deviceId: String) throws {
        let now = wallNow()
        guard mode == .ready, request["ownerId"].text == owner, request["deviceId"].text == deviceId,
              device["id"].text == deviceId, !device["stopped"].flag, !device["revoked"].flag,
              request["state"].text == "running", request["revision"] == device["revision"],
              request["leaseUntil"].integer <= request["expiresAt"].integer,
              device["capabilities"].list.contains(request["operation"]["action"]),
              let authorityExpiry = localAuthorityExpiry(request, device: device), authorityExpiry > now
        else { throw JosiError(message: "Local authority does not allow this operation.") }
        requestId = request["id"].text; revision = request["revision"].integer
        // Pin the original permission lifetime to monotonic time. Neither a
        // renewed server lease nor a wall-clock rollback can extend it.
        authorityDeadline = monotonicNow() + UInt64(authorityExpiry - now) * 1_000_000
        try renew(request["leaseUntil"].integer, revision: revision)
        mode = .working; detail = request["operation"]["action"].text
    }
    func renew(_ expires: Int, revision: Int) throws {
        let remaining = expires - wallNow(), now = monotonicNow()
        guard revision == self.revision, remaining > 0, remaining <= 10_000, authorityDeadline > now else { throw JosiError(message: "Execution lease expired or changed.") }
        deadline = min(now + UInt64(remaining) * 1_000_000, authorityDeadline)
    }
    func check(generation expected: Int? = nil) throws {
        guard mode == .working, deadline > monotonicNow(), expected == nil || expected == generation else {
            throw JosiError(message: "Local Stop, human takeover, or an expired lease stopped this work.")
        }
    }
    func finish() { deadline = 0; if mode == .working { mode = .ready; detail = "Ready; last operation finished" } }
    private func localAuthorityExpiry(_ q: Wire, device: Wire) -> Int? {
        let now = wallNow(), op = q["operation"], action = op["action"].text
        let rules = device["rules"].list.filter { rule in
            let d = rule["duration"]
            switch d["kind"].text {
            case "saved": return true
            case "until": return d["expiresAt"].integer > now
            case "once": return d["requestId"] == q["id"]
            case "task": return d["taskId"] == q["taskId"] && d["expiresAt"].integer > now && device["activeTasks"].list.contains(q["taskId"])
            default: return false
            }
        }
        if (action.hasPrefix("terminal.") || ["window.click", "window.type", "window.scroll", "window.drag"].contains(action)), rules.contains(where: { $0["decision"].text != "allow" }) { return nil }
        let matching = rules.filter { r in
            if r["action"].text == "*" { return true }
            guard r["action"] == op["action"] else { return false }
            if r["decision"].text != "allow", r["scope"]["kind"].text == "folder" {
                let root = r["scope"]["target"].text, path = op["args"]["path"].text
                return path == root || path.hasPrefix(root == "/" ? "/" : root + "/")
            }
            return r["scope"] == op["scope"]
        }
        guard !matching.contains(where: { $0["decision"].text != "allow" }), !matching.isEmpty else { return nil }
        return matching.reduce(q["expiresAt"].integer) { expiry, rule in
            ["until", "task"].contains(rule["duration"]["kind"].text) ? min(expiry, rule["duration"]["expiresAt"].integer) : expiry
        }
    }
}
