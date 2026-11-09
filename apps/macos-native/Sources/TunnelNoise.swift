// The relay is off in this release (JosiFlags.relay); this returns with RELAY_ENABLED.
#if RELAY_ENABLED
import CryptoKit
import Foundation

/// Noise_IK_25519_ChaChaPoly_SHA256 for the device end of the tunnel, written
/// from packages/tunnel/src/noise.ts and checked against the same vectors.
struct TunnelError: LocalizedError, Sendable, Equatable {
    let code: String
    var message: String
    init(_ code: String, _ message: String? = nil) {
        self.code = code
        self.message = message ?? Self.messages[code] ?? "Josi couldn’t be reached just now."
    }
    var errorDescription: String? { message }
    /// The server itself said no, inside the handshake. Another path won't change that.
    var isRefusal: Bool { ["unknown_device", "revoked", "bad_code", "busy", "stale"].contains(code) }
    private static let messages = [
        "unknown_device": "Your server no longer knows this Mac. Pair it again to reconnect.",
        "revoked": "This Mac was removed from your server. Pair it again to reconnect.",
        "bad_code": "That code was wrong, used, or expired. Make a new one on your server.",
        "busy": "Your server is busy. Try again in a moment.",
        "stale": "This Mac’s clock is more than five minutes off. Correct the time, then try again.",
        "offline": "Your Josi server is not connected right now. Check that its computer is on, then try again.",
        "tampered": "The connection to your server was altered on the way, so Josi ended it.",
        "handshake": "Your server could not be verified, so Josi did not connect.",
        "closed": "The connection to your server ended.",
        "reset": "The server ended this request.",
        "timeout": "The server did not answer.",
    ]
}

enum TunnelBytes {
    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    static func base64url(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while value.hasSuffix("=") { value.removeLast() }
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        return Data(base64Encoded: value)
    }
    static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// A static or ephemeral X25519 key. The raw private half leaves this type only
/// to go into the Keychain.
struct TunnelKey: Sendable {
    fileprivate let secret: Curve25519.KeyAgreement.PrivateKey
    init() { secret = .init() }
    init(raw: Data) throws {
        do { secret = try .init(rawRepresentation: raw) } catch { throw TunnelError("handshake") }
    }
    var raw: Data { secret.rawRepresentation }
    var publicKey: Data { secret.publicKey.rawRepresentation }
    /// A low-order peer key gives an all-zero secret, which would key the session
    /// with something anyone can compute.
    func dh(_ remote: Data) throws -> Data {
        guard remote.count == 32, let peer = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: remote),
              let shared = try? secret.sharedSecretFromKeyAgreement(with: peer) else { throw TunnelError("handshake") }
        let out = shared.withUnsafeBytes { Data($0) }
        guard out.contains(where: { $0 != 0 }) else { throw TunnelError("handshake", "Low-order public key") }
        return out
    }
}

struct TunnelCipher: Sendable {
    private var key: SymmetricKey?
    private var n: UInt64 = 0
    init(key: Data? = nil) { self.key = key.map { SymmetricKey(data: $0) } }
    private static func nonce(_ n: UInt64) throws -> ChaChaPoly.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.littleEndian) { bytes.append(contentsOf: $0) }
        return try ChaChaPoly.Nonce(data: bytes)
    }
    mutating func encrypt(_ ad: Data, _ plain: Data) throws -> Data {
        guard let key else { return plain }
        guard n < .max else { throw TunnelError("closed", "Nonce exhausted") }
        let box = try ChaChaPoly.seal(plain, using: key, nonce: Self.nonce(n), authenticating: ad)
        n += 1
        return box.ciphertext + box.tag
    }
    /// A failed message leaves the counter alone. The session ends on it anyway.
    mutating func decrypt(_ ad: Data, _ sealed: Data) throws -> Data {
        guard let key else { return sealed }
        guard sealed.count >= 16, n < .max else { throw TunnelError("tampered") }
        do {
            let box = try ChaChaPoly.SealedBox(nonce: Self.nonce(n), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
            let plain = try ChaChaPoly.open(box, using: key, authenticating: ad)
            n += 1
            return plain
        } catch { throw TunnelError("tampered") }
    }
    /// Noise REKEY: the counter carries on under the new key.
    mutating func rekey() throws {
        guard let key else { return }
        let box = try ChaChaPoly.seal(Data(count: 32), using: key, nonce: Self.nonce(.max), authenticating: Data())
        self.key = SymmetricKey(data: box.ciphertext.prefix(32))
    }
}

private func hkdf2(_ ck: Data, _ ikm: Data) -> (Data, Data) {
    func mac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }
    let temp = mac(ck, ikm), one = mac(temp, Data([1]))
    return (one, mac(temp, one + Data([2])))
}

/// One IK handshake, initiator side. The device always initiates.
struct TunnelHandshake: Sendable {
    static let prologue = Data("josi-relay/1".utf8)
    private var h = Data("Noise_IK_25519_ChaChaPoly_SHA256".utf8)
    private var ck: Data
    private var cipher = TunnelCipher()
    private var ephemeral: TunnelKey?
    private let key: TunnelKey, remote: Data
    var hash: Data { h }

    init(key: TunnelKey, remote: Data, prologue: Data = Self.prologue) throws {
        guard remote.count == 32 else { throw TunnelError("handshake") }
        self.key = key; self.remote = remote; ck = h
        mixHash(prologue); mixHash(remote)
    }
    private mutating func mixHash(_ data: Data) { h = Data(SHA256.hash(data: h + data)) }
    private mutating func mixKey(_ ikm: Data) {
        let (next, temp) = hkdf2(ck, ikm)
        ck = next; cipher = TunnelCipher(key: temp)
    }
    private mutating func encryptAndHash(_ plain: Data) throws -> Data {
        let out = try cipher.encrypt(h, plain); mixHash(out); return out
    }
    private mutating func decryptAndHash(_ sealed: Data) throws -> Data {
        let out = try cipher.decrypt(h, sealed); mixHash(sealed); return out
    }
    mutating func writeFirst(_ payload: Data, ephemeral chosen: TunnelKey? = nil) throws -> Data {
        let e = chosen ?? TunnelKey()
        ephemeral = e
        mixHash(e.publicKey); mixKey(try e.dh(remote))
        let sealedKey = try encryptAndHash(key.publicKey)
        mixKey(try key.dh(remote))
        return e.publicKey + sealedKey + (try encryptAndHash(payload))
    }
    /// Returns the payload and the session. Anything that isn't the pinned server
    /// fails here: only it could have sealed this message.
    mutating func readSecond(_ message: Data, framed: Bool = true) throws -> (payload: Data, session: TunnelSession) {
        guard message.count >= 48, let ephemeral else { throw TunnelError("handshake") }
        let peer = Data(message.prefix(32))
        do {
            mixHash(peer); mixKey(try ephemeral.dh(peer)); mixKey(try key.dh(peer))
            let payload = try decryptAndHash(Data(message.dropFirst(32)))
            let (send, recv) = hkdf2(ck, Data())
            return (payload, TunnelSession(send: TunnelCipher(key: send), recv: TunnelCipher(key: recv), framed: framed))
        } catch { throw TunnelError("handshake") }
    }
}

/// The transport phase. Framed: flags, 2-byte length, the data, then zeros to a
/// multiple of 256, so the relay learns sizes only to the nearest block. The
/// sender rekeys after a message count or an age, and marks its last message
/// under the old key.
struct TunnelSession: Sendable {
    static let maxMessage = 65535, maxFramed = 65516
    private var send: TunnelCipher, recv: TunnelCipher
    private let framed: Bool
    var rekeyMessages = 1 << 20, rekeySeconds: TimeInterval = 3600
    private var sent = 0, rekeyed = Date()

    init(send: TunnelCipher, recv: TunnelCipher, framed: Bool = true) {
        self.send = send; self.recv = recv; self.framed = framed
    }
    mutating func seal(_ plain: Data) throws -> Data {
        guard framed else { return try send.encrypt(Data(), plain) }
        guard plain.count <= Self.maxFramed else { throw TunnelError("closed", "That request is too large to send.") }
        sent += 1
        let rekey = sent >= rekeyMessages || Date().timeIntervalSince(rekeyed) >= rekeySeconds
        var body = Data([rekey ? 1 : 0, UInt8(plain.count >> 8), UInt8(plain.count & 255)]) + plain
        let padded = min((body.count + 255) / 256 * 256, Self.maxMessage - 16)
        body.append(Data(count: padded - body.count))
        let out = try send.encrypt(Data(), body)
        if rekey { try send.rekey(); sent = 0; rekeyed = Date() }
        return out
    }
    mutating func open(_ sealed: Data) throws -> Data {
        guard sealed.count <= Self.maxMessage else { throw TunnelError("tampered") }
        let plain = try recv.decrypt(Data(), sealed)
        guard framed else { return plain }
        let bytes = [UInt8](plain.prefix(3))
        guard bytes.count == 3, bytes[0] & ~1 == 0 else { throw TunnelError("tampered") }
        let size = Int(bytes[1]) << 8 | Int(bytes[2])
        guard 3 + size <= plain.count else { throw TunnelError("tampered") }
        if bytes[0] & 1 != 0 { try recv.rekey() }
        return Data(plain.dropFirst(3).prefix(size))
    }
}

#endif
