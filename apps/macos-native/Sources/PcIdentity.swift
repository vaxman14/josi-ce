import CryptoKit
import Foundation
import Security

/// This Mac's identity for PC Control. Each Josi app names its computer in the
/// x-josi-pc header; a Mac is mac-<32 hex>, so the server keeps its permissions,
/// requests and presence apart from any Windows PC on the same account.
enum PcDevice {
    static let id: String = {
        var folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Josi", isDirectory: true)
        #if DEBUG
        // A test run keeps its own computer identity, apart from this Mac's real one.
        if let path = ProcessInfo.processInfo.environment["JOSI_PC_STATE_DIR"] { folder = URL(fileURLWithPath: path, isDirectory: true) }
        #endif
        let file = folder.appendingPathComponent("pc-device-id")
        if let saved = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           saved.range(of: "^mac-[a-f0-9]{32}$", options: .regularExpression) != nil { return saved }
        let fresh = "mac-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? fresh.write(to: file, atomically: true, encoding: .utf8)
        return fresh
    }()
    static var name: String { Host.current().localizedName ?? "this Mac" }
}

/// The executor key: one P-256 key per server, owner and Mac, kept in the
/// Secure Enclave when the Mac has one (otherwise in the login Keychain). It
/// signs every executor request; enrolling it grants no permissions by itself.
struct PcExecutorKey {
    let name: String
    let hardware: Bool
    private let enclave: SecureEnclave.P256.Signing.PrivateKey?
    private let software: P256.Signing.PrivateKey?

    /// One key per owner and Mac. The server's address is left out on purpose:
    /// setup pairs over localhost and the app may later reach the same server by
    /// its LAN or public address, and that must not look like a new computer.
    /// An owner id belongs to exactly one server, so it already tells them apart.
    static func name(origin: String, owner: String) -> String {
        "executor-" + SHA256.hash(data: Data((owner + "\n" + PcDevice.id).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    /// Opens the key, creating it the first time.
    static func open(_ name: String) throws -> PcExecutorKey {
        if let stored = PcKeychain.read(name) {
            if stored.first == 1, let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored.dropFirst()) {
                return PcExecutorKey(name: name, hardware: true, enclave: key, software: nil)
            }
            if stored.first == 2, let key = try? P256.Signing.PrivateKey(rawRepresentation: stored.dropFirst()) {
                return PcExecutorKey(name: name, hardware: false, enclave: nil, software: key)
            }
        }
        if SecureEnclave.isAvailable, let key = try? SecureEnclave.P256.Signing.PrivateKey() {
            try PcKeychain.write(name, Data([1]) + key.dataRepresentation)
            return PcExecutorKey(name: name, hardware: true, enclave: key, software: nil)
        }
        let key = P256.Signing.PrivateKey()
        try PcKeychain.write(name, Data([2]) + key.rawRepresentation)
        return PcExecutorKey(name: name, hardware: false, enclave: nil, software: key)
    }
    /// The uncompressed point (65 bytes, 04 | x | y), base64, as the server stores it.
    var publicPoint: String {
        (enclave?.publicKey.x963Representation ?? software!.publicKey.x963Representation).base64EncodedString()
    }
    func sign(_ message: Data) throws -> Data {
        if let enclave { return try enclave.signature(for: message).derRepresentation }
        return try software!.signature(for: message).derRepresentation
    }
}

enum PcKeychain {
    private static let service = "com.heyjosi.ce.pc-executor"
    static func read(_ account: String) -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }
    static func write(_ account: String, _ data: Data) throws {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw JosiError(message: "This Mac could not store its Josi computer-control key (\(status)).") }
    }
}

/// The proof the server checks on every executor request (pcExecutorIdentity.ts):
/// "pc-executor.1\n" + JSON of [owner, pc, method, path, time, nonce, sha256(body)].
enum PcProof {
    static func headers(key: PcExecutorKey, owner: String, method: String, path: String, body: Data) throws -> [String: String] {
        let time = Int64(Date().timeIntervalSince1970 * 1000)
        let nonce = UUID().uuidString.lowercased()
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let message = "pc-executor.1\n" + "[" + [json(owner), json(PcDevice.id), json(method), json(path), String(time), json(nonce), json(digest)].joined(separator: ",") + "]"
        return ["x-josi-pc-time": String(time), "x-josi-pc-nonce": nonce,
                "x-josi-pc-proof": try key.sign(Data(message.utf8)).base64EncodedString()]
    }
    /// A string exactly as JavaScript's JSON.stringify writes it.
    static func json(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }
}
