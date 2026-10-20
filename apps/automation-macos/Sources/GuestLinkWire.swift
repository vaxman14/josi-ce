import Foundation
import CryptoKit
import Darwin

enum GuestLinkError: Error { case unavailable, invalid, expired, closed }

/// Transport only. Pairing this channel grants no observation, input, secret
/// projection or network access. Its ephemeral agreement keys are never
/// stored; canonical execution authority must still come from the Vault.
///
/// The host must use the actual current VM's VZ socket device, and both native
/// UIs must compare/accept the transcript code before reporting paired state.
/// A self-asserted guest flag or successful key agreement is not that consent.
final class GuestLinkWire: @unchecked Sendable {
    static let port: UInt32 = 40511
    private let descriptor: Int32
    private let queue = DispatchQueue(label: "com.heyjosi.guest-link")
    private let lock = NSLock()
    private var interrupted = false
    private let role: String
    private var agreement: Curve25519.KeyAgreement.PrivateKey?
    let publicKey: String
    private var sendKey: SymmetricKey?
    private var receiveKey: SymmetricKey?
    private var channel = ""
    private var sending: UInt64 = 0
    private var receiving: UInt64 = 0
    private var lastWall = Date()

    init(descriptor: Int32, host: Bool) throws {
        guard descriptor >= 0 else { throw GuestLinkError.unavailable }
        let owned = dup(descriptor)
        guard owned >= 0 else { throw GuestLinkError.unavailable }
        self.descriptor = owned; role = host ? "host" : "guest"
        guard fcntl(owned, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(owned, F_SETFL, fcntl(owned, F_GETFL) | O_NONBLOCK) == 0 else {
            Darwin.close(owned); throw GuestLinkError.unavailable
        }
        var enabled: Int32 = 1
        guard setsockopt(owned, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            Darwin.close(owned); throw GuestLinkError.unavailable
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        agreement = key; publicKey = key.publicKey.rawRepresentation.base64EncodedString()
    }
    deinit { Darwin.close(descriptor) }
    func interrupt() {
        lock.lock(); defer { lock.unlock() }
        if !interrupted { interrupted = true; shutdown(descriptor, SHUT_RDWR) }
        // Do not close/reuse this descriptor while a queued reader owns self.
    }
    private func current() throws {
        lock.lock(); let closed = interrupted; lock.unlock()
        guard !closed else { throw GuestLinkError.closed }
        let now = Date()
        guard now >= lastWall else { throw GuestLinkError.expired }
        lastWall = now
    }
    private func perform<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    do { try self.current(); continuation.resume(returning: try work()) }
                    catch { self.interrupt(); continuation.resume(throwing: GuestLinkError.unavailable) }
                }
            }
        } onCancel: { self.interrupt() }
    }
    private func wait(_ event: Int16, deadline: ContinuousClock.Instant) throws {
        while true {
            try current()
            guard ContinuousClock.now < deadline else { throw GuestLinkError.expired }
            var ready = pollfd(fd: descriptor, events: event, revents: 0)
            let result = poll(&ready, 1, 200)
            if result == 0 || result < 0 && errno == EINTR { continue }
            guard result > 0, ready.revents & Int16(POLLERR | POLLNVAL) == 0 else { throw GuestLinkError.unavailable }
            return
        }
    }
    private func read(_ count: Int, deadline: ContinuousClock.Instant) throws -> Data {
        var data = Data(count: count), offset = 0
        while offset < count {
            try wait(Int16(POLLIN), deadline: deadline)
            let got = data.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress!.advanced(by: offset), count - offset) }
            if got < 0 && [EINTR, EAGAIN].contains(errno) { continue }
            guard got > 0 else { throw GuestLinkError.closed }
            offset += got
        }
        return data
    }
    private func write(_ data: Data, deadline: ContinuousClock.Instant) throws {
        var offset = 0
        while offset < data.count {
            try wait(Int16(POLLOUT), deadline: deadline)
            let count = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), data.count - offset) }
            if count < 0 && [EINTR, EAGAIN].contains(errno) { continue }
            guard count > 0 else { throw GuestLinkError.closed }
            offset += count
        }
    }
    static func encode(_ value: [String: String], envelope: Bool = false) throws -> Data {
        guard value.count <= 24, value.allSatisfy({ $0.key.utf8.count <= 64
            && $0.value.utf8.count <= (envelope && $0.key == "box" ? 22 * 1024 : 4096) }) else { throw GuestLinkError.invalid }
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= (envelope ? 24 : 16) * 1024 else { throw GuestLinkError.invalid }
        return bytes
    }
    private static func decode(_ bytes: Data, envelope: Bool = false) throws -> [String: String] {
        guard bytes.count <= (envelope ? 24 : 16) * 1024, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: String],
              try encode(value, envelope: envelope) == bytes else { throw GuestLinkError.invalid }
        return value
    }
    private func frame(_ bytes: Data) throws {
        guard !bytes.isEmpty, bytes.count <= 24 * 1024 else { throw GuestLinkError.invalid }
        let size = UInt32(bytes.count)
        let header = Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)])
        try write(header + bytes, deadline: .now.advanced(by: .seconds(5)))
    }
    private func frame(seconds: Int) throws -> Data {
        guard (1...60).contains(seconds) else { throw GuestLinkError.invalid }
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        let size = try read(4, deadline: deadline).reduce(0) { ($0 << 8) | Int($1) }
        guard (1...24 * 1024).contains(size) else { throw GuestLinkError.invalid }
        return try read(size, deadline: deadline)
    }
    func sendHello(_ hello: [String: String]) async throws {
        try await perform {
            guard self.sendKey == nil, hello["key"] == self.publicKey else { throw GuestLinkError.invalid }
            try self.frame(Self.encode(hello))
        }
    }
    func receiveHello() async throws -> [String: String] {
        try await perform {
            guard self.receiveKey == nil else { throw GuestLinkError.invalid }
            return try Self.decode(self.frame(seconds: 10))
        }
    }
    /// Caller validates exact hello fields and OS/workspace identity first.
    /// The returned comparison code is for both protected native UIs.
    func configure(guest: [String: String], host: [String: String]) async throws -> String {
        try await perform {
            guard self.sendKey == nil, self.receiveKey == nil, let own = self.agreement,
                  let id = guest["channel"], UUID(uuidString: id)?.uuidString.lowercased() == id,
                  host["channel"] == id, guest["role"] == "guest", host["role"] == "host",
                  guest["version"] == "1", host["version"] == "1",
                  (self.role == "host" ? host : guest)["key"] == self.publicKey,
                  let encoded = (self.role == "host" ? guest : host)["key"],
                  let raw = Data(base64Encoded: encoded), raw.count == 32, raw.base64EncodedString() == encoded else {
                throw GuestLinkError.invalid
            }
            let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
            let secret = try own.sharedSecretFromKeyAgreement(with: peer)
            let transcript = Data("josi-guest-link.1\n".utf8) + (try Self.encode(guest)) + Data([10]) + (try Self.encode(host))
            let salt = Data(SHA256.hash(data: transcript))
            let direction = { (sender: String) in
                secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                    sharedInfo: Data(("josi-guest-link.1/" + sender).utf8), outputByteCount: 32)
            }
            self.channel = id; self.sendKey = direction(self.role); self.receiveKey = direction(self.role == "host" ? "guest" : "host")
            self.agreement = nil
            let code = salt.prefix(6).map { String(format: "%02X", $0) }.joined()
            return stride(from: 0, to: 12, by: 4).map { offset in
                let start = code.index(code.startIndex, offsetBy: offset)
                return String(code[start..<code.index(start, offsetBy: 4)])
            }.joined(separator: "–")
        }
    }
    private func associated(sender: String, sequence: UInt64) -> Data {
        Data("josi-guest-frame.1\n\(sender)\n\(channel)\n\(sequence)".utf8)
    }
    func send(_ value: [String: String]) async throws {
        try await perform {
            guard let key = self.sendKey, self.sending < 4096,
                  ["accept", "pulse", "status", "stop"].contains(value["kind"] ?? "") else { throw GuestLinkError.invalid }
            self.sending += 1
            let box = try AES.GCM.seal(Self.encode(value), using: key,
                authenticating: self.associated(sender: self.role, sequence: self.sending))
            guard let combined = box.combined else { throw GuestLinkError.invalid }
            try self.frame(Self.encode(["version": "1", "channel": self.channel,
                "sequence": String(self.sending), "box": combined.base64EncodedString()], envelope: true))
        }
    }
    func receive(seconds: Int = 5) async throws -> [String: String] {
        try await perform {
            guard let key = self.receiveKey, self.receiving < 4096 else { throw GuestLinkError.invalid }
            let packet = try Self.decode(self.frame(seconds: seconds), envelope: true)
            guard Set(packet.keys) == ["version", "channel", "sequence", "box"], packet["version"] == "1",
                  packet["channel"] == self.channel, packet["sequence"] == String(self.receiving + 1),
                  let encoded = packet["box"], let combined = Data(base64Encoded: encoded),
                  combined.base64EncodedString() == encoded else { throw GuestLinkError.invalid }
            self.receiving += 1
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key,
                authenticating: self.associated(sender: self.role == "host" ? "guest" : "host", sequence: self.receiving))
            let value = try Self.decode(plain)
            guard ["accept", "pulse", "status", "stop"].contains(value["kind"] ?? "") else { throw GuestLinkError.invalid }
            return value
        }
    }
}
