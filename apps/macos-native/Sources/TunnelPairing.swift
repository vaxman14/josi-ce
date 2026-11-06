import CryptoKit
import Foundation
import Security

/// Pairing codes and the sealed invite the relay holds for them. The relay only
/// ever gets a hash of a code and a box sealed with a key derived from it.
enum TunnelCode {
    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    /// Dashes and case are for people. O, I and L are read as the digits they look like.
    static func normalize(_ input: String) -> String {
        String(input.uppercased().filter { !$0.isWhitespace && $0 != "-" }.map { (c: Character) -> Character in
            c == "O" ? "0" : c == "I" || c == "L" ? "1" : c
        })
    }
    static func isValid(_ code: String) -> Bool { code.count == 32 && code.allSatisfy(alphabet.contains) }
    static func inviteId(_ code: String) -> String {
        String(TunnelBytes.hex(SHA256.hash(data: Data("josi-invite-id/1|\(code)".utf8))).prefix(32))
    }
    static func openInvite(code: String, sealed: String) throws -> TunnelInviteBox {
        let key = SymmetricKey(data: SHA256.hash(data: Data("josi-invite-key/1|\(code)".utf8)))
        guard let raw = TunnelBytes.base64url(sealed), raw.count > 28,
              let plain = try? ChaChaPoly.open(ChaChaPoly.SealedBox(combined: raw), using: key) else { throw TunnelError("bad_code") }
        return try TunnelInviteBox.decode(plain)
    }
}

/// Everything a device needs to reach a server, and nothing that lets it in.
struct TunnelInviteBox: Codable, Sendable, Equatable {
    let v: Int, server: String, site: String, relay: String
    var name: String?, lan: [String]?
    static func decode(_ data: Data) throws -> TunnelInviteBox {
        guard let box = try? JSONDecoder().decode(TunnelInviteBox.self, from: data), box.v == 1,
              TunnelBytes.base64url(box.server)?.count == 32,
              box.site.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
              TunnelAddress.relay(box.relay, site: box.site) != nil else { throw TunnelError("bad_invite", "That pairing link isn’t valid.") }
        return box
    }
}

enum TunnelAddress {
    static let defaultRelay = "https://relay.heyjosi.com"
    private static func isLoopback(_ host: String?) -> Bool { ["localhost", "127.0.0.1", "::1"].contains(host?.lowercased() ?? "") }
    /// The relay is told nothing it can use, but a pairing still only goes to wss,
    /// or plain ws on this Mac.
    static func relay(_ address: String, site: String) -> URL? {
        guard var parts = URLComponents(string: address.trimmingCharacters(in: CharacterSet(charactersIn: "/"))), parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { return nil }
        switch parts.scheme {
        case "wss", "https": parts.scheme = "wss"
        case "ws", "http":
            guard isLoopback(parts.host) else { return nil }
            parts.scheme = "ws"
        default: return nil
        }
        parts.path += "/v1/sites/\(site)/peer"
        return parts.url
    }
    /// Plain ws is fine here: Noise authenticates and encrypts it.
    static func lan(_ addresses: [String]) -> [URL] {
        addresses.prefix(8).compactMap { address in
            guard let url = URL(string: address), ["ws", "wss"].contains(url.scheme ?? ""), url.host?.isEmpty == false else { return nil }
            return url
        }
    }
    /// The address the API sees: the link's own, or <name>.<relay's domain>. A
    /// server with neither gets a name that can't resolve to anything.
    static func origin(link: String?, box: TunnelInviteBox) -> String {
        if let link, let parts = URLComponents(string: link), let host = parts.host?.lowercased(), !host.isEmpty,
           parts.scheme == "https" || (parts.scheme == "http" && isLoopback(host)) {
            return "\(parts.scheme!)://\(host)" + (parts.port.map { ":\($0)" } ?? "")
        }
        guard let name = box.name?.lowercased(), name.range(of: "^[a-z0-9-]{1,63}$", options: .regularExpression) != nil,
              let host = URLComponents(string: box.relay)?.host?.lowercased() else { return "https://\(box.site).josi.invalid" }
        return "https://\(name).\(host.hasPrefix("relay.") ? String(host.dropFirst(6)) : host)"
    }
}

/// What a person pasted, opened. A link carries its box; a typed code is looked up.
struct TunnelInvite: Sendable, Equatable {
    let code: String, box: TunnelInviteBox, origin: String
    static func isLink(_ input: String) -> Bool { input.contains("#josi-pair=") }
    static func parseLink(_ input: String) -> TunnelInvite? {
        let link = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = link.firstMatch(of: /#josi-pair=([0-9A-Z]+)\.([A-Za-z0-9_-]+)$/), TunnelCode.isValid(String(match.1)),
              let raw = TunnelBytes.base64url(String(match.2)), let box = try? TunnelInviteBox.decode(raw) else { return nil }
        return TunnelInvite(code: String(match.1), box: box, origin: TunnelAddress.origin(link: link, box: box))
    }
    static func resolve(_ input: String, relay: String = TunnelAddress.defaultRelay) async throws -> TunnelInvite {
        if isLink(input) {
            guard let invite = parseLink(input) else { throw TunnelError("bad_invite", "That pairing link isn’t valid.") }
            return invite
        }
        let code = TunnelCode.normalize(input)
        guard TunnelCode.isValid(code) else { throw TunnelError("bad_invite", "That doesn’t look like a pairing code. It has 32 characters.") }
        guard let url = URL(string: relay.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/invites/" + TunnelCode.inviteId(code)) else { throw TunnelError("unreachable") }
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(from: url)
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: break
        case 429: throw TunnelError("limited", "Too many tries from this network. Try again in an hour.")
        default: throw TunnelError("bad_code")
        }
        struct Reply: Decodable { let box: String }
        guard data.count <= 16_384, let reply = try? JSONDecoder().decode(Reply.self, from: data) else { throw TunnelError("bad_code") }
        let box = try TunnelCode.openInvite(code: code, sealed: reply.box)
        return TunnelInvite(code: code, box: box, origin: TunnelAddress.origin(link: nil, box: box))
    }
}

/// One paired server. The whole record lives in the Keychain: it holds the private
/// device key, and the server key it pins must not be editable in a plist.
struct TunnelPairing: Codable, Sendable, Equatable, Identifiable, CustomStringConvertible {
    var site: String, origin: String, relay: String
    var server: String
    var previousServer: String?, previousUntil: String?
    var device: String, name: String, lan: [String]
    fileprivate(set) var key: Data
    /// Set before a rotation is sent, cleared once it's settled, so a lost reply
    /// leaves this device holding whichever key the server ended up with.
    fileprivate(set) var pendingKey: Data?
    var id: String { site }
    var host: String { URLComponents(string: origin)?.host ?? origin }
    var description: String { "TunnelPairing(\(site))" }
    var title: String { name.isEmpty ? host : name }

    init(invite: TunnelInvite, key: TunnelKey) {
        site = invite.box.site; origin = invite.origin; relay = invite.box.relay; server = invite.box.server
        device = ""; name = invite.box.name ?? ""; lan = invite.box.lan ?? []; self.key = key.raw
    }
    /// The previous server key still counts only while its overlap runs. A key
    /// replaced with no overlap was replaced for a reason.
    var fallbackServer: Data? {
        guard let previousServer, let previousUntil else { return nil }
        let full = ISO8601DateFormatter(), fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let until = fractional.date(from: previousUntil) ?? full.date(from: previousUntil), until > Date() else { return nil }
        return TunnelBytes.base64url(previousServer)
    }
    mutating func adopt(_ rotation: TunnelRotation) {
        guard TunnelBytes.base64url(rotation.publicKey)?.count == 32, rotation.publicKey != server else { return }
        previousServer = server; previousUntil = rotation.until; server = rotation.publicKey
    }
    mutating func stage(_ next: TunnelKey) { pendingKey = next.raw }
    mutating func dropPending() { pendingKey = nil }
    mutating func promotePending() { if let pendingKey { key = pendingKey; self.pendingKey = nil } }
}

struct TunnelKeychain: Sendable {
    var service = "com.heyjosi.ce.tunnel"
    private func query(_ site: String?) -> [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let site { value[kSecAttrAccount as String] = site }
        return value
    }
    private func failure() -> TunnelError { TunnelError("keychain", "The Keychain could not be used for this pairing. Check that it’s unlocked.") }
    func save(_ pairing: TunnelPairing) throws {
        let data = try JSONEncoder().encode(pairing)
        let found = SecItemUpdate(query(pairing.site) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if found == errSecSuccess { return }
        guard found == errSecItemNotFound else { throw failure() }
        var item = query(pairing.site)
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Josi server pairing"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw failure() }
    }
    func load(_ site: String) throws -> TunnelPairing? {
        var request = query(site), result: CFTypeRef?
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw failure() }
        return try? JSONDecoder().decode(TunnelPairing.self, from: data)
    }
    func list() throws -> [TunnelPairing] {
        var request = query(nil), result: CFTypeRef?
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitAll
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { throw failure() }
        return try items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted().compactMap(load)
    }
    func delete(_ site: String) throws {
        let status = SecItemDelete(query(site) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure() }
    }
}
