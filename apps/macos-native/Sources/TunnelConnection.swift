import Foundation
import os

/// A WebSocket as a tunnel transport. The relay's own status lines arrive as text.
/// They aren't authenticated, so they can only ever make this give up sooner; they
/// can't make it trust anything. Noise frames are always binary.
final class TunnelSocket: NSObject, URLSessionWebSocketDelegate, TunnelTransport, @unchecked Sendable {
    private enum Incoming { case binary(Data), online, offline }
    private struct State { var opening: CheckedContinuation<Void, Error>?; var closed = false }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!

    private init(_ url: URL) {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
    }

    /// LAN paths are ready when open. The relay's are ready at `server-online`.
    static func open(_ url: URL, relay: Bool, timeout: Duration) async throws -> TunnelSocket {
        let socket = TunnelSocket(url)
        let timedOut = OSAllocatedUnfairLock(initialState: false)
        let watchdog = Task {
            try await Task.sleep(for: timeout)
            timedOut.withLock { $0 = true }
            socket.close()
        }
        defer { watchdog.cancel() }
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                socket.state.withLock { $0.opening = continuation }
                socket.task.resume()
            }
            while relay {
                switch try await socket.next() {
                case .online: return socket
                case .offline: throw TunnelError("offline")
                case .binary: continue   // Nothing can be for us before message 1.
                }
            }
            return socket
        } catch let error as TunnelError where error.code == "offline" {
            socket.close(); throw error
        } catch {
            socket.close()
            throw timedOut.withLock { $0 } ? TunnelError("timeout", "Could not reach that address.")
                : TunnelError("unreachable", "Could not reach that address.")
        }
    }

    private func next() async throws -> Incoming {
        while true {
            let message: URLSessionWebSocketTask.Message
            do { message = try await task.receive() } catch { throw TunnelError("closed") }
            switch message {
            case .data(let data): return .binary(data)
            case .string(let text):
                struct Status: Decodable { var type: String? }
                switch (try? JSONDecoder().decode(Status.self, from: Data(text.utf8)))?.type {
                case "server-online": return .online
                case "server-offline": return .offline
                default: continue
                }
            @unknown default: continue
            }
        }
    }
    func receive() async throws -> Data {
        while true {
            switch try await next() {
            case .binary(let data): return data
            case .online: continue
            case .offline: close(); throw TunnelError("offline")
            }
        }
    }
    func send(_ data: Data) {
        task.send(.data(data)) { [weak self] error in if error != nil { self?.close() } }
    }
    func close() {
        let (waiting, first) = state.withLock { state in
            let values = (state.opening, !state.closed)
            state.opening = nil; state.closed = true
            return values
        }
        waiting?.resume(throwing: TunnelError("closed"))
        guard first else { return }
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        state.withLock { let waiting = $0.opening; $0.opening = nil; return waiting }?.resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        state.withLock { let waiting = $0.opening; $0.opening = nil; return waiting }?.resume(throwing: TunnelError("closed"))
    }
}

enum TunnelPath: Sendable { case none, lan, relay }

/// Keeps one live tunnel to one paired server. A session is only ever a cache: the
/// IK handshake is one round trip, so it is redone on demand. Nothing here falls
/// back to anything unencrypted.
actor TunnelConnection {
    nonisolated let site: String
    private(set) var pairing: TunnelPairing
    private(set) var path = TunnelPath.none
    private let store: TunnelKeychain
    private let lanRetry: Duration
    private let forgotten: @Sendable (String) -> Void
    private var client: TunnelClient?
    private var connecting: Task<TunnelClient, Error>?
    private var lanProbe: Task<Void, Never>?
    private var rotating = false, closed = false

    init(pairing: TunnelPairing, store: TunnelKeychain = TunnelKeychain(), lanRetry: Duration = .seconds(60),
         forgotten: @escaping @Sendable (String) -> Void = { _ in }) {
        site = pairing.site; self.pairing = pairing; self.store = store; self.lanRetry = lanRetry; self.forgotten = forgotten
    }

    /// Pairs and keeps the session it made. `device` comes from the welcome, so the
    /// pairing can only be saved once the server has accepted it.
    static func pair(_ invite: TunnelInvite, name: String, store: TunnelKeychain = TunnelKeychain(), lanRetry: Duration = .seconds(60),
                     forgotten: @escaping @Sendable (String) -> Void = { _ in }) async throws -> TunnelConnection {
        let connection = TunnelConnection(pairing: TunnelPairing(invite: invite, key: TunnelKey()), store: store, lanRetry: lanRetry, forgotten: forgotten)
        try await connection.begin(code: invite.code, name: name)
        return connection
    }
    private func begin(code: String, name: String) async throws {
        let session = try await establish(.pair(code: code, name: String(name.prefix(64))))
        do { try store.save(pairing) } catch { await session.close(); throw error }
    }

    /// The live session, or a new one. Concurrent callers share one attempt.
    func session() async throws -> TunnelClient {
        if let client, !client.isClosed { return client }
        guard !closed else { throw TunnelError("closed") }
        if connecting == nil {
            connecting = Task { [self] in
                defer { connecting = nil }
                return try await establish(.connect)
            }
        }
        return try await connecting!.value
    }

    private func establish(_ hello: TunnelHello) async throws -> TunnelClient {
        var last: Error = TunnelError("unreachable")
        guard let server = TunnelBytes.base64url(pairing.server) else { throw TunnelError("handshake") }
        do {
            for url in TunnelAddress.lan(pairing.lan) {
                do { return try await dial(url, via: .lan, server: server, hello: hello) }
                catch let error as TunnelError where error.isRefusal { throw error }
                catch { last = error }
            }
            guard let relay = TunnelAddress.relay(pairing.relay, site: site) else { throw last }
            do { return try await dial(relay, via: .relay, server: server, hello: hello) }
            catch let error as TunnelError where error.isRefusal || error.code == "offline" { throw error }
            catch {
                guard let previous = pairing.fallbackServer else { throw error }
                return try await dial(relay, via: .relay, server: previous, hello: hello)
            }
        } catch let error as TunnelError where ["revoked", "unknown_device"].contains(error.code) {
            if case .connect = hello { forget() }
            throw error
        }
    }

    private func dial(_ url: URL, via route: TunnelPath, server: Data, hello: TunnelHello) async throws -> TunnelClient {
        func attempt(_ key: Data) async throws -> (client: TunnelClient, welcome: TunnelWelcome) {
            // Only the socket open gets the LAN's short timeout. A pairing code is
            // spent once the hello lands, so a slow answer isn't abandoned as quickly.
            let socket = try await TunnelSocket.open(url, relay: route == .relay, timeout: route == .lan ? .milliseconds(800) : .seconds(10))
            return try await TunnelClient.connect(transport: socket, key: try TunnelKey(raw: key), serverPublic: server,
                                                  hello: hello, timeout: route == .lan ? .seconds(5) : .seconds(15))
        }
        let result: (client: TunnelClient, welcome: TunnelWelcome)
        do { result = try await attempt(pairing.key) }
        catch let error as TunnelError where error.code == "unknown_device" {
            // A rotation went through but its reply didn't reach us.
            guard let pending = pairing.pendingKey else { throw error }
            result = try await attempt(pending)
            // If this save fails, the Keychain still holds both keys and this runs again.
            pairing.promotePending()
            try? store.save(pairing)
        }
        try await adopt(result.client, result.welcome, via: route)
        return result.client
    }

    private func adopt(_ next: TunnelClient, _ welcome: TunnelWelcome, via route: TunnelPath) async throws {
        guard !closed else { await next.close(); throw TunnelError("closed") }
        var updated = pairing
        if let lan = welcome.lan { updated.lan = lan }
        if let device = welcome.device { updated.device = device }
        if let name = welcome.server, !name.isEmpty { updated.name = name }
        if let rotate = welcome.rotate { updated.adopt(rotate) }
        if updated != pairing {
            pairing = updated
            // A pairing is first saved by `begin`. A failed save here costs nothing:
            // the server repeats a rotation, and the next welcome repeats the rest.
            if !pairing.device.isEmpty, (try? store.load(site)) != nil { try? store.save(pairing) }
        }
        let replaced = client
        client = next; path = route
        await next.start { [weak self] notice in Task { await self?.handle(notice, from: next) } }
        if route == .relay { watchLan() } else { lanProbe?.cancel(); lanProbe = nil }
        if let replaced, replaced !== next { await replaced.retire() }
    }

    private func handle(_ notice: TunnelClient.Notice, from source: TunnelClient) {
        switch notice {
        case .rotation(let rotation):
            pairing.adopt(rotation)
            try? store.save(pairing)
        case .revoked: forget()
        case .closed:
            if client === source { client = nil; path = .none; lanProbe?.cancel(); lanProbe = nil }
        }
    }

    /// While on the relay, retry the LAN about once a minute and move new requests
    /// over when one answers. Requests already running finish where they are.
    private func watchLan() {
        guard lanProbe == nil, !TunnelAddress.lan(pairing.lan).isEmpty else { return }
        let wait = lanRetry
        lanProbe = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: wait)
                guard !Task.isCancelled, let self, await self.probeLan() else { return }
            }
        }
    }
    private func probeLan() async -> Bool {
        guard !closed, path == .relay, let server = TunnelBytes.base64url(pairing.server) else { lanProbe = nil; return false }
        for url in TunnelAddress.lan(pairing.lan) where (try? await dial(url, via: .lan, server: server, hello: .connect)) != nil { return false }
        return true
    }

    /// Makes a new device key and has the server switch to it. The running session
    /// carries on. If the reply is lost, `dial` works out which key won.
    func rotateDeviceKey() async throws {
        guard !rotating else { throw TunnelError("busy") }
        rotating = true; defer { rotating = false }
        let session = try await session()
        let fresh = pairing.pendingKey == nil
        let next = try pairing.pendingKey.map { try TunnelKey(raw: $0) } ?? TunnelKey()
        pairing.stage(next)
        try store.save(pairing)
        do { try await session.rotateDevice(publicKey: next.publicKey) }
        catch let error as TunnelError where error.code == "rotate_refused" {
            if fresh { pairing.dropPending(); try? store.save(pairing) }
            throw error
        }
        pairing.promotePending()
        try store.save(pairing)
    }

    private func forget() {
        try? store.delete(site)
        close()
        forgotten(site)
    }
    func close() {
        closed = true
        lanProbe?.cancel(); lanProbe = nil
        connecting?.cancel()
        if let client { Task { await client.close() } }
        client = nil; path = .none
    }
}

/// Which tunnel a host's requests belong to. Counted, because a reconnect attaches
/// the next JosiAPI before it closes the last one.
enum TunnelRoutes {
    private struct Route { var connection: TunnelConnection; var count: Int }
    private static let table = OSAllocatedUnfairLock<[String: Route]>(initialState: [:])
    static func attach(_ host: String, _ connection: TunnelConnection) {
        let replaced: TunnelConnection? = table.withLock { routes in
            let old = routes[host.lowercased()]
            if let old, old.connection === connection { routes[host.lowercased()]?.count += 1; return nil }
            routes[host.lowercased()] = Route(connection: connection, count: 1)
            return old?.connection
        }
        if let replaced { Task { await replaced.close() } }
    }
    static func release(_ host: String, _ connection: TunnelConnection) {
        let last: TunnelConnection? = table.withLock { routes in
            guard let route = routes[host.lowercased()], route.connection === connection else { return nil }
            if route.count > 1 { routes[host.lowercased()]?.count -= 1; return nil }
            routes[host.lowercased()] = nil
            return connection
        }
        if let last { Task { await last.close() } }
    }
    static func connection(_ host: String) -> TunnelConnection? { table.withLock { $0[host.lowercased()]?.connection } }
}
