// Disposable P0 transport proof. No shell, filesystem or automation command.
// The generated fixture key is not production enrollment or Vault integration.
import Foundation
import CryptoKit
import Darwin

enum ProbeWireError: Error { case rejected, closed, io, oversized }

struct ProbeFixture: Codable {
    let purpose: String
    let workspace: String
    let key: String
    static func load(_ url: URL) throws -> ProbeFixture {
        let value = try JSONDecoder().decode(ProbeFixture.self, from: Data(contentsOf: url))
        guard value.purpose == "disposable-josi-p0", !value.workspace.isEmpty,
              let bytes = Data(base64Encoded: value.key), bytes.count == 32 else { throw ProbeWireError.rejected }
        return value
    }
    var secret: SymmetricKey { SymmetricKey(data: Data(base64Encoded: key)!) }
}

final class ProbeWire {
    let fd: Int32
    let fixture: ProbeFixture
    let server: Bool
    var key: SymmetricKey?
    var session = ""
    private var sent = 0
    private var received = 0
    static let limit = 65536

    init(fd: Int32, fixture: ProbeFixture, server: Bool) throws {
        self.fd = fd; self.fixture = fixture; self.server = server
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        var yes: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw ProbeWireError.io }
    }
    private func exact(_ count: Int) throws -> Data {
        guard count > 0, count <= Self.limit else { throw ProbeWireError.oversized }
        var bytes = [UInt8](repeating: 0, count: count), offset = 0
        while offset < count {
            let n = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: offset), count-offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw n == 0 ? ProbeWireError.closed : ProbeWireError.io }
            offset += n
        }
        return Data(bytes)
    }
    private func writeAll(_ data: Data) throws {
        var offset = 0
        while offset < data.count {
            let n = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), data.count-offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw ProbeWireError.io }
            offset += n
        }
    }
    private func readFrame() throws -> Data {
        let header = try exact(4)
        let count = header.reduce(0) { ($0 << 8) | Int($1) }
        return try exact(count)
    }
    func writeFrame(_ data: Data) throws {
        guard data.count > 0, data.count <= Self.limit else { throw ProbeWireError.oversized }
        var count = UInt32(data.count).bigEndian
        try writeAll(withUnsafeBytes(of: &count) { Data($0) } + data)
    }
    private func sendJSON(_ value: [String: Any]) throws {
        try writeFrame(JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }
    private func readJSON() throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: readFrame()) as? [String: Any] else { throw ProbeWireError.rejected }
        return value
    }
    private func nonce() -> String {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() }
    }
    private func proof(_ role: String, _ host: String, _ guest: String) throws -> Data {
        // JSON array encoding gives every authenticated field an unambiguous boundary.
        return try JSONSerialization.data(withJSONObject: ["josi-p0-v1", role, fixture.workspace, host, guest])
    }
    private func mac(_ role: String, _ host: String, _ guest: String) throws -> String {
        Data(HMAC<SHA256>.authenticationCode(for: try proof(role, host, guest), using: fixture.secret)).base64EncodedString()
    }
    private func verify(_ value: Any?, _ role: String, _ host: String, _ guest: String) throws {
        guard let value = value as? String, let bytes = Data(base64Encoded: value),
              HMAC<SHA256>.isValidAuthenticationCode(bytes, authenticating: try proof(role, host, guest), using: fixture.secret) else { throw ProbeWireError.rejected }
    }
    private func validNonce(_ value: Any?) throws -> String {
        guard let string = value as? String, Data(base64Encoded: string)?.count == 32 else { throw ProbeWireError.rejected }
        return string
    }
    func handshake() throws {
        let host: String, guest: String
        if server {
            host = nonce()
            try sendJSON(["version": 1, "workspace": fixture.workspace, "nonce": host])
            let reply = try readJSON()
            guest = try validNonce(reply["nonce"])
            try verify(reply["proof"], "guest", host, guest)
            try sendJSON(["proof": mac("host", host, guest)])
        } else {
            let hello = try readJSON()
            guard hello["version"] as? Int == 1, hello["workspace"] as? String == fixture.workspace else { throw ProbeWireError.rejected }
            host = try validNonce(hello["nonce"]); guest = nonce()
            try sendJSON(["nonce": guest, "proof": mac("guest", host, guest)])
            try verify(try readJSON()["proof"], "host", host, guest)
        }
        let context = try proof("session", host, guest)
        session = Data(SHA256.hash(data: context)).base64EncodedString()
        key = HKDF<SHA256>.deriveKey(inputKeyMaterial: fixture.secret, salt: context, info: Data("josi-p0-encrypted-channel".utf8), outputByteCount: 32)
    }
    private func aad(direction: String, sequence: Int) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["josi-p0-v1", fixture.workspace, session, direction, String(sequence)])
    }
    @discardableResult
    func send(_ value: [String: Any]) throws -> Data {
        guard let key = key else { throw ProbeWireError.rejected }
        let body = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        let sealed = try ChaChaPoly.seal(body, using: key, authenticating: aad(direction: server ? "host" : "guest", sequence: sent))
        let frame = try JSONSerialization.data(withJSONObject: ["sequence": sent, "sealed": sealed.combined.base64EncodedString()], options: [.sortedKeys])
        try writeFrame(frame); sent += 1
        return frame
    }
    func receive() throws -> [String: Any] {
        guard let key = key else { throw ProbeWireError.rejected }
        let envelope = try readJSON()
        guard envelope["sequence"] as? Int == received, let encoded = envelope["sealed"] as? String,
              let ciphertext = Data(base64Encoded: encoded) else { throw ProbeWireError.rejected }
        let raw = try ChaChaPoly.open(ChaChaPoly.SealedBox(combined: ciphertext), using: key, authenticating: aad(direction: server ? "guest" : "host", sequence: received))
        guard let value = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else { throw ProbeWireError.rejected }
        received += 1
        return value
    }
}
