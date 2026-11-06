import Foundation
import os

/// One open path to the server, relay or LAN. Binary messages only.
protocol TunnelTransport: Sendable {
    func send(_ data: Data)
    /// Called from one task at a time. Throws once the path has ended.
    func receive() async throws -> Data
    func close()
}

enum TunnelHello: Sendable {
    case connect
    case pair(code: String, name: String)
    func encoded() throws -> Data {
        let ts = Int64(Date().timeIntervalSince1970 * 1000)
        switch self {
        case .connect:
            return try JSONSerialization.data(withJSONObject: ["v": 1, "op": "connect", "client": "mac", "ts": ts] as [String: Any])
        case .pair(let code, let name):
            return try JSONSerialization.data(withJSONObject: ["v": 1, "op": "pair", "code": code, "name": name, "platform": "mac", "ts": ts] as [String: Any])
        }
    }
}

struct TunnelRotation: Decodable, Sendable {
    let publicKey: String
    let until: String?
}
struct TunnelWelcome: Decodable, Sendable {
    let ok: Bool
    var device: String?, server: String?, error: String?
    var lan: [String]?
    var rotate: TunnelRotation?
}

struct TunnelFrame: Sendable {
    enum Kind: UInt8, Sendable {
        case reqHead = 1, reqBody, reqEnd, resHead, resBody, resEnd, reset, ping, pong, control
    }
    /// The largest body piece one frame carries.
    static let maxPiece = TunnelSession.maxFramed - 5
    let kind: UInt8, stream: UInt32, payload: Data
    static func encode(_ kind: Kind, _ stream: UInt32, _ payload: Data = Data()) -> Data {
        var out = Data([kind.rawValue])
        withUnsafeBytes(of: stream.bigEndian) { out.append(contentsOf: $0) }
        return out + payload
    }
    init(_ raw: Data) throws {
        let head = [UInt8](raw.prefix(5))
        guard head.count == 5 else { throw TunnelError("tampered") }
        kind = head[0]
        stream = head[1...4].reduce(0) { $0 << 8 | UInt32($1) }
        payload = Data(raw.dropFirst(5))
    }
}

struct TunnelResponseHead: Decodable, Sendable {
    let status: Int
    let headers: [[String]]
}
enum TunnelStreamEvent: Sendable {
    case head(TunnelResponseHead), body(Data), end, failed(TunnelError)
}

/// A device's end of the tunnel: the handshake, then HTTP over the mux. It knows
/// nothing about how bytes reach the server, so it runs the same over either path.
actor TunnelClient {
    enum Notice: Sendable { case rotation(TunnelRotation), revoked, closed }
    typealias Sink = @Sendable (TunnelStreamEvent) -> Void
    private struct Control: Decodable { let t: String; var publicKey: String?; var until: String?; var error: String? }

    private var session: TunnelSession
    private let transport: any TunnelTransport
    private var streams: [UInt32: Sink] = [:]
    private var nextStream: UInt32 = 1
    private var notices: (@Sendable (Notice) -> Void)?
    private var rotation: CheckedContinuation<Void, Error>?
    private var draining = false
    private var lastHeard = ContinuousClock.now
    private var pump: Task<Void, Never>?, keepalive: Task<Void, Never>?
    private let ended = OSAllocatedUnfairLock(initialState: false)
    nonisolated var isClosed: Bool { ended.withLock { $0 } }

    private init(session: TunnelSession, transport: any TunnelTransport) {
        self.session = session; self.transport = transport
    }

    /// Runs the handshake. A refusal from the server throws with its reason.
    static func connect(transport: any TunnelTransport, key: TunnelKey, serverPublic: Data, hello: TunnelHello,
                        timeout: Duration = .seconds(15)) async throws -> (client: TunnelClient, welcome: TunnelWelcome) {
        let watchdog = Task { try await Task.sleep(for: timeout); transport.close() }
        defer { watchdog.cancel() }
        do {
            var handshake = try TunnelHandshake(key: key, remote: serverPublic)
            transport.send(try handshake.writeFirst(try hello.encoded()))
            let (payload, session) = try handshake.readSecond(try await transport.receive())
            guard let welcome = try? JSONDecoder().decode(TunnelWelcome.self, from: payload) else { throw TunnelError("handshake") }
            guard welcome.ok else { throw TunnelError(welcome.error ?? "closed") }
            return (TunnelClient(session: session, transport: transport), welcome)
        } catch { transport.close(); throw error }
    }

    /// Nothing is read until this runs, so a caller can set up first.
    func start(_ notices: @escaping @Sendable (Notice) -> Void) {
        self.notices = notices
        let transport = transport
        pump = Task { [weak self] in
            do {
                while true {
                    let data = try await transport.receive()
                    guard let self else { return }
                    await self.receive(data)
                }
            } catch {
                await self?.shutdown((error as? TunnelError) ?? TunnelError("closed"))
            }
        }
        keepalive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard !Task.isCancelled, let self, await self.beat() else { return }
            }
        }
    }

    /// Returns the stream id. Events arrive on `sink` in order until `.end` or `.failed`.
    func request(method: String, path: String, headers: [(String, String)], body: Data, sink: @escaping Sink) throws -> UInt32 {
        guard !isClosed, nextStream < .max else { throw TunnelError("closed") }
        let stream = nextStream
        nextStream += 1
        streams[stream] = sink
        let head: [String: Any] = ["method": method, "path": path, "headers": headers.map { [$0.0, $0.1] }]
        do {
            try write(.reqHead, stream, try JSONSerialization.data(withJSONObject: head))
            var at = body.startIndex
            while at < body.endIndex {
                let end = body.index(at, offsetBy: TunnelFrame.maxPiece, limitedBy: body.endIndex) ?? body.endIndex
                try write(.reqBody, stream, Data(body[at..<end]))
                at = end
            }
            try write(.reqEnd, stream)
        } catch { streams[stream] = nil; throw error }
        return stream
    }

    func cancel(_ stream: UInt32) {
        guard streams.removeValue(forKey: stream) != nil else { return }
        if !isClosed { try? write(.reset, stream) }
        settle()
    }

    /// Replaces this device's key. The server keeps the old one a few minutes so a
    /// lost reply can't strand the device.
    func rotateDevice(publicKey: Data) async throws {
        guard !isClosed, rotation == nil else { throw TunnelError("busy") }
        let control = ["t": "rotate-device", "publicKey": TunnelBytes.base64url(publicKey)]
        let watchdog = Task { [weak self] in
            try await Task.sleep(for: .seconds(15))
            await self?.finishRotation(TunnelError("timeout"))
        }
        defer { watchdog.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            rotation = continuation
            do { try write(.control, 0, try JSONSerialization.data(withJSONObject: control)) }
            catch { finishRotation(error) }
        }
    }
    private func finishRotation(_ error: Error?) {
        guard let waiting = rotation else { return }
        rotation = nil
        if let error { waiting.resume(throwing: error) } else { waiting.resume() }
    }

    /// New requests have moved elsewhere. Finish what's running here, then close.
    func retire() { draining = true; settle() }
    func close() { shutdown(TunnelError("closed")) }

    private func settle() { if draining, streams.isEmpty { shutdown(TunnelError("closed")) } }
    private func write(_ kind: TunnelFrame.Kind, _ stream: UInt32, _ payload: Data = Data()) throws {
        // Sealed and handed over in one step, so nonces reach the wire in order.
        transport.send(try session.seal(TunnelFrame.encode(kind, stream, payload)))
    }
    private func beat() -> Bool {
        guard !isClosed else { return false }
        if lastHeard.duration(to: .now) > .seconds(70) { shutdown(TunnelError("closed")); return false }
        try? write(.ping, 0)
        return true
    }
    private func finish(_ stream: UInt32, _ event: TunnelStreamEvent) {
        streams.removeValue(forKey: stream)?(event)
        settle()
    }
    private func receive(_ data: Data) {
        guard !isClosed else { return }
        lastHeard = .now
        let frame: TunnelFrame
        // A frame that fails authentication means the path is being tampered with.
        // Nothing after it can be trusted, so the whole session ends.
        do { frame = try TunnelFrame(try session.open(data)) } catch { shutdown(TunnelError("tampered")); return }
        let sink = streams[frame.stream]
        switch TunnelFrame.Kind(rawValue: frame.kind) {
        case .resHead:
            guard let sink else { return }
            guard let head = try? JSONDecoder().decode(TunnelResponseHead.self, from: frame.payload),
                  head.headers.allSatisfy({ $0.count == 2 }) else {
                try? write(.reset, frame.stream)
                finish(frame.stream, .failed(TunnelError("reset"))); return
            }
            sink(.head(head))
        case .resBody: sink?(.body(frame.payload))
        case .resEnd: finish(frame.stream, .end)
        case .reset: finish(frame.stream, .failed(TunnelError("reset")))
        case .ping: try? write(.pong, 0)
        case .control: if let message = try? JSONDecoder().decode(Control.self, from: frame.payload) { control(message) }
        default: break
        }
    }
    private func control(_ message: Control) {
        switch message.t {
        case "rotate-device-ok": finishRotation(nil)
        case "rotate-device-refused": finishRotation(TunnelError("rotate_refused", "Your server kept the current device key."))
        case "rotate-server":
            if let key = message.publicKey { notices?(.rotation(TunnelRotation(publicKey: key, until: message.until))) }
        case "revoked": notices?(.revoked); shutdown(TunnelError("revoked"))
        default: break
        }
    }
    private func shutdown(_ error: TunnelError) {
        guard !ended.withLock({ let was = $0; $0 = true; return was }) else { return }
        keepalive?.cancel()
        transport.close()
        let open = streams; streams = [:]
        for sink in open.values { sink(.failed(error)) }
        finishRotation(error)
        notices?(.closed)
    }
}
