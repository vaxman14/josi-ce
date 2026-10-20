import Foundation
import Network
import CryptoKit
import Darwin

/// CONNECT only, loopback only, one command only. Chrome supplies a random
/// proxy credential received from its verified native channel. TLS stays
/// between Chrome and the destination; neither side of this bridge decrypts it.
@MainActor final class GuestBrowserProxy {
    static let port: UInt16 = 40513
    private let wire: GuestLinkWire
    private let listener: NWListener
    private let channel: String, origin: String
    let password: String
    private let current: @MainActor () throws -> Void
    private var connections: [String: NWConnection] = [:]
    private var openings: [String: GuestProxyReply<Void>] = [:]
    private var jobs: [Task<Void, Never>] = []
    private var reader: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var retired = Set<String>()
    private var stopped = false, accepted = 0

    private init(wire: GuestLinkWire, channel: String, secret: Data, origin: String,
                 current: @escaping @MainActor () throws -> Void) throws {
        self.wire = wire; self.channel = channel; self.origin = origin; self.current = current
        password = Data(HMAC<SHA256>.authenticationCode(for: Data("josi-chrome-proxy.1".utf8),
                                                       using: SymmetricKey(data: secret))).base64EncodedString()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        listener = try NWListener(using: parameters)
    }
    static func start(secret: Data, channel: String, origin: String,
                      current: @escaping @MainActor () throws -> Void) async throws -> GuestBrowserProxy {
        try current()
        let fd = try await GuestEnvironment.connect(port: GuestLinkWire.networkPort)
        defer { Darwin.close(fd) }
        let wire = try GuestLinkWire(descriptor: fd, host: false, network: (secret, channel))
        do {
            try await wire.send(["kind": "network-hello", "channel": channel])
            guard try await wire.receive() == ["kind": "network-ready", "channel": channel] else { throw GuestLinkError.invalid }
            let proxy = try GuestBrowserProxy(wire: wire, channel: channel, secret: secret, origin: origin, current: current)
            try await proxy.listen()
            return proxy
        } catch { wire.interrupt(); throw error }
    }
    private func live() throws {
        guard !stopped else { throw GuestLinkError.closed }
        try current()
    }
    private func listen() async throws {
        let ready = GuestProxyReply<Void>()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)); try self?.live() }
                catch { ready.finish(.failure(GuestLinkError.expired)); self?.stop(); return }
            }
        }
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.finish(.success(())) }
            if case .failed = state { ready.finish(.failure(GuestLinkError.unavailable)) }
            if case .cancelled = state { ready.finish(.failure(GuestLinkError.closed)) }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                guard let self, !self.stopped, self.connections.count < 16, self.accepted < 32 else { connection.cancel(); return }
                self.accepted += 1
                let id = UUID().uuidString.lowercased()
                self.connections[id] = connection
                connection.start(queue: .global(qos: .userInitiated))
                self.jobs.append(Task { await self.serve(id, connection: connection) })
            }
        }
        listener.start(queue: .global(qos: .userInitiated))
        try await ready.value()
        try live()
        reader = Task { [weak self] in await self?.readFrames() }
    }
    func stop() {
        guard !stopped else { return }
        stopped = true; listener.cancel(); wire.interrupt(); reader?.cancel(); reader = nil
        watchdog?.cancel(); watchdog = nil
        for job in jobs { job.cancel() }; jobs.removeAll()
        for connection in connections.values { connection.cancel() }; connections.removeAll()
        for reply in openings.values { reply.finish(.failure(GuestLinkError.closed)) }; openings.removeAll()
    }
    private func readFrames() async {
        do {
            while !Task.isCancelled {
                let frame = try await wire.receive(seconds: 10)
                try live()
                guard let id = frame["id"] else { throw GuestLinkError.invalid }
                if retired.contains(id) { continue }
                guard let connection = connections[id] else { throw GuestLinkError.invalid }
                switch frame["kind"] {
                case "network-opened":
                    guard Set(frame.keys) == ["kind", "id"], let reply = openings.removeValue(forKey: id) else { throw GuestLinkError.invalid }
                    reply.finish(.success(()))
                case "network-data":
                    guard Set(frame.keys) == ["kind", "id", "data"], let raw = frame["data"],
                          let data = Data(base64Encoded: raw), !data.isEmpty, data.count <= 32768,
                          data.base64EncodedString() == raw else { throw GuestLinkError.invalid }
                    try await send(data, to: connection)
                case "network-close":
                    guard Set(frame.keys) == ["kind", "id"] else { throw GuestLinkError.invalid }
                    openings.removeValue(forKey: id)?.finish(.failure(GuestLinkError.closed))
                    retired.insert(id)
                    connections.removeValue(forKey: id)?.cancel()
                default: throw GuestLinkError.invalid
                }
            }
        } catch { stop() }
    }
    private func serve(_ id: String, connection: NWConnection) async {
        var opened = false
        do {
            try live()
            var header = Data()
            let delimiter = Data("\r\n\r\n".utf8)
            while header.range(of: delimiter) == nil {
                guard header.count < 8192 else { throw GuestLinkError.invalid }
                let part = try await receive(connection, limit: min(4096, 8192 - header.count))
                guard !part.isEmpty else { throw GuestLinkError.closed }
                header.append(part); try live()
            }
            guard let end = header.range(of: delimiter), end.upperBound == header.endIndex,
                  let text = String(data: header, encoding: .utf8) else { throw GuestLinkError.invalid }
            let lines = text.components(separatedBy: "\r\n"), fields = lines[0].split(separator: " ")
            guard fields.count == 3, fields[0] == "CONNECT", fields[2] == "HTTP/1.1",
                  let target = URLComponents(string: origin), target.scheme == "https",
                  let host = target.host, fields[1] == Substring("\(host):\(target.port ?? 443)") else { throw GuestLinkError.invalid }
            let credentials = lines.dropFirst().filter { $0.lowercased().hasPrefix("proxy-authorization:") }
            let expected = "Basic " + Data(("josi:" + password).utf8).base64EncodedString()
            guard credentials.count == 1,
                  credentials[0].split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) == expected else {
                try await send(Data("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Josi\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8), to: connection)
                throw GuestLinkError.invalid
            }
            let ready = GuestProxyReply<Void>(); openings[id] = ready
            try await wire.send(["kind": "network-open", "id": id, "origin": origin])
            try await ready.value(); try live(); opened = true
            try await send(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8), to: connection)
            while !Task.isCancelled {
                let data = try await receive(connection, limit: 32768)
                try live()
                if data.isEmpty { break }
                try await wire.send(["kind": "network-data", "id": id, "data": data.base64EncodedString()])
            }
        } catch {}
        openings.removeValue(forKey: id)?.finish(.failure(GuestLinkError.closed))
        retired.insert(id)
        connections.removeValue(forKey: id)?.cancel()
        if opened && !stopped { try? await wire.send(["kind": "network-close", "id": id]) }
    }
    private func send(_ data: Data, to connection: NWConnection) async throws {
        try live()
        let reply = GuestProxyReply<Void>()
        connection.send(content: data, completion: .contentProcessed { error in
            reply.finish(error == nil ? .success(()) : .failure(GuestLinkError.unavailable))
        })
        try await reply.value(); try live()
    }
    private func receive(_ connection: NWConnection, limit: Int) async throws -> Data {
        try live()
        let reply = GuestProxyReply<Data>()
        connection.receive(minimumIncompleteLength: 1, maximumLength: limit) { data, _, _, error in
            reply.finish(error == nil ? .success(data ?? Data()) : .failure(GuestLinkError.unavailable))
        }
        let bytes = try await reply.value(); try live(); return bytes
    }
}

private final class GuestProxyReply<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var continuation: CheckedContinuation<T, Error>?
    func finish(_ value: Result<T, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value; let waiting = continuation; continuation = nil
        lock.unlock(); waiting?.resume(with: value)
    }
    func value() async throws -> T {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiting in
                lock.lock()
                if let result { lock.unlock(); waiting.resume(with: result) }
                else { continuation = waiting; lock.unlock() }
            }
        } onCancel: { self.finish(.failure(CancellationError())) }
    }
}
