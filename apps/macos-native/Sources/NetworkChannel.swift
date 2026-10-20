import Foundation
import Network

enum NativeNetworkDirection: String, Sendable { case upload, download }

protocol NativeNetworkChannelAuthority: NativeNetworkResolutionAuthority {
    /// Must commit the exact original-task reservation before returning.
    func beforeConnect(_ destination: NativeNetworkDestination, address: String) async throws
    /// Rechecks the same current reservation/consent; never creates another
    /// task, allowance or action ID for chunks of an existing connection.
    func beforeTransfer(_ destination: NativeNetworkDestination, address: String,
                        direction: NativeNetworkDirection, maximumBytes: Int) async throws
    func revalidate(_ destination: NativeNetworkDestination, address: String) async throws
}

struct NativeNetworkChannelReceipt: Sendable {
    let requestId: UUID
    let connected: Bool
    let uploadedBytes: Int
    let downloadedBytes: Int
    let reservedBytes: Int
    let chargedPayloadBytes: Int
    let end: String
    let verificationRequired = true
}

/// A single numeric TCP destination, no DNS retry, redirect, TLS
/// interception or alternate address. Guest transport must supply separately
/// verified browser/app request coverage; a TCP peer alone proves no origin.
/// This component has no production authority or guest entry point yet.
actor NativeNetworkChannel {
    private let authority: any NativeNetworkChannelAuthority
    private let destination: NativeNetworkDestination
    private let address: String
    private let connection: NWConnection
    private let deadline: ContinuousClock.Instant
    private let initialWall: Int64
    private var lastWall: Int64
    private var stopped = false, connected = false, reading = false, writing = false
    private var charged = 0, uploaded = 0, downloaded = 0
    private var end = "open"
    private var monitor: Task<Void, Never>?
    private var authorityMonitor: Task<Void, Never>?
    private var pending: [UUID: @Sendable () -> Void] = [:]

    fileprivate init(destination: NativeNetworkDestination, address: String, authority: any NativeNetworkChannelAuthority) throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard destination.request.expiresAtMs > now, destination.request.expiresAtMs - now <= 10_000,
              let port = NWEndpoint.Port(rawValue: destination.port) else { throw NativeNetworkError.expired }
        let host: NWEndpoint.Host
        if let v4 = IPv4Address(address) { host = .ipv4(v4) }
        else if let v6 = IPv6Address(address) { host = .ipv6(v6) }
        else { throw NativeNetworkError.denied }
        self.destination = destination; self.address = address; self.authority = authority
        initialWall = now; lastWall = now
        deadline = .now.advanced(by: .milliseconds(destination.request.expiresAtMs - now))
        let parameters = NWParameters.tcp
        parameters.preferNoProxies = true
        connection = NWConnection(host: host, port: port, using: parameters)
    }

    deinit {
        monitor?.cancel(); authorityMonitor?.cancel()
        for cancel in pending.values { cancel() }
        connection.cancel()
    }

    private func live() throws {
        try Task.checkCancellation()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard !stopped, now >= initialWall, now >= lastWall, now < destination.request.expiresAtMs,
              ContinuousClock.now < deadline else { stop("expired"); throw NativeNetworkError.expired }
        lastWall = now
    }
    fileprivate func start() async throws {
        do {
            try live()
            // This monitor runs independently of server checks and callbacks.
            // Expiry ends their local waits; a late reply cannot revive access.
            monitor = Task { [weak self] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .milliseconds(100))
                        guard let self else { return }
                        try await self.checkExpiry()
                    } catch { return }
                }
            }
            try await checkAuthority { [authority, destination, address] in
                try await authority.beforeConnect(destination, address: address)
            }
            try live()
            try await perform { [connection] (completion: NetworkChannelResult<Void>) in
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready: completion.finish(.success(()))
                    case .failed, .cancelled: completion.finish(.failure(NativeNetworkError.unavailable))
                    default: break
                    }
                }
                connection.start(queue: DispatchQueue(label: "com.heyjosi.network.channel"))
            }
            try live(); connected = true
            try await revalidate()
            try live()
            authorityMonitor = Task { [weak self] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .seconds(1))
                        guard let self else { return }
                        try await self.revalidate()
                    } catch { return }
                }
            }
        } catch { stop("uncertain"); throw error }
    }
    private func checkExpiry() throws { try live() }

    private func revalidate() async throws {
        do {
            try await checkAuthority { [authority, destination, address] in
                try await authority.revalidate(destination, address: address)
            }
        } catch { stop("authority_unavailable"); throw error }
    }

    /// Server checks have a two-second response limit, even if the adapter
    /// ignores cancellation. There is no renewal past the original deadline.
    private func checkAuthority(_ operation: @escaping @Sendable () async throws -> Void) async throws {
        try await perform(maximumWait: .seconds(2)) { completion in
            let task = Task {
                do { try await operation(); completion.finish(.success(())) }
                catch { completion.finish(.failure(NativeNetworkError.denied)) }
            }
            completion.onFinish { task.cancel() }
        }
    }

    /// Callback waits, authority waits and caller cancellation share the same
    /// one-shot completion. Stop does not depend on a network callback arriving.
    private func perform<T: Sendable>(maximumWait: Duration? = nil,
        _ begin: @escaping @Sendable (NetworkChannelResult<T>) -> Void) async throws -> T {
        try live()
        let id = UUID(), completion = NetworkChannelResult<T>()
        let waitUntil = maximumWait.map { min(deadline, .now.advanced(by: $0)) } ?? deadline
        let timer = Task {
            do {
                try await Task.sleep(until: waitUntil, clock: .continuous)
                completion.finish(.failure(NativeNetworkError.expired))
            } catch {}
        }
        pending[id] = { completion.finish(.failure(NativeNetworkError.unavailable)) }
        defer { pending.removeValue(forKey: id); timer.cancel() }
        let value = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                completion.attach(continuation)
                if !Task.isCancelled { begin(completion) }
                else { completion.finish(.failure(CancellationError())) }
            }
        } onCancel: { completion.finish(.failure(CancellationError())) }
        try live()
        return value
    }

    func send(_ data: Data) async throws {
        guard !writing, !data.isEmpty, data.count <= 32_768 else { stop("denied"); throw NativeNetworkError.denied }
        writing = true
        defer { writing = false }
        do {
            try live()
            guard connected, data.count <= destination.request.maximumBytes - charged else { throw NativeNetworkError.denied }
            // Reserve before suspension so simultaneous upload/download cannot
            // both spend the same remaining allowance. Errors never refund it.
            charged += data.count
            try await checkAuthority { [authority, destination, address] in
                try await authority.beforeTransfer(destination, address: address, direction: .upload, maximumBytes: data.count)
            }
            try live()
            try await perform { [connection] (completion: NetworkChannelResult<Void>) in
                connection.send(content: data, completion: .contentProcessed { error in
                    if error != nil { completion.finish(.failure(NativeNetworkError.unavailable)) }
                    else { completion.finish(.success(())) }
                })
            }
            uploaded += data.count
            try live()
        } catch { stop("uncertain"); throw error }
    }

    func receive(maximumBytes: Int = 32_768) async throws -> Data {
        guard !reading, (1...32_768).contains(maximumBytes) else { stop("denied"); throw NativeNetworkError.denied }
        reading = true
        defer { reading = false }
        do {
            try live()
            let amount = min(maximumBytes, destination.request.maximumBytes - charged)
            guard connected, amount > 0 else { throw NativeNetworkError.denied }
            charged += amount
            try await checkAuthority { [authority, destination, address] in
                try await authority.beforeTransfer(destination, address: address, direction: .download, maximumBytes: amount)
            }
            try live()
            let result = try await perform { [connection] (completion: NetworkChannelResult<(Data, Bool)>) in
                connection.receive(minimumIncompleteLength: 1, maximumLength: amount) { data, _, complete, error in
                    guard error == nil, data != nil || complete, (data?.count ?? 0) <= amount else {
                        completion.finish(.failure(NativeNetworkError.unavailable)); return
                    }
                    completion.finish(.success((data ?? Data(), complete)))
                }
            }
            downloaded += result.0.count
            charged -= amount - result.0.count
            try live()
            // A successful short read releases only unused local in-flight
            // capacity. The full server reservation is never refunded.
            if result.1 { stop("closed") }
            return result.0
        } catch { stop("uncertain"); throw error }
    }

    /// Explicit cancellation is independent of a pending transfer or remote
    /// response. All late callbacks still encounter the stopped state.
    func close() { stop("closed") }
    func receipt() -> NativeNetworkChannelReceipt {
        NativeNetworkChannelReceipt(requestId: destination.request.id, connected: connected,
            uploadedBytes: uploaded, downloadedBytes: downloaded,
            reservedBytes: destination.request.maximumBytes, chargedPayloadBytes: charged, end: end)
    }
    private func stop(_ reason: String) {
        guard !stopped else { return }
        stopped = true; end = reason; monitor?.cancel(); monitor = nil
        authorityMonitor?.cancel(); authorityMonitor = nil
        let cancellations = pending.values
        pending.removeAll()
        for cancel in cancellations { cancel() }
        connection.cancel()
    }
}

/// One adapter serves both DNS and transfer checks. Keep this connector for the
/// workspace lifetime: recreating it for every request loses local replay state.
/// Production integration must also consume IDs durably on the server.
actor NativeNetworkConnector {
    private let authority: any NativeNetworkChannelAuthority
    private let resolver: NativeNetworkResolver
    private var channels: [UUID: NativeNetworkChannel] = [:]
    private var opening: Set<UUID> = []
    private var stopped = false
    init(authority: any NativeNetworkChannelAuthority) {
        self.authority = authority
        resolver = NativeNetworkResolver(authority: authority)
    }
    func open(_ request: NativeNetworkRequest) async throws -> NativeNetworkChannel {
        guard !stopped, channels.count + opening.count < 16, channels[request.id] == nil,
              opening.insert(request.id).inserted else { throw NativeNetworkError.denied }
        defer { opening.remove(request.id) }
        let destination = try await resolver.resolve(request)
        guard !stopped, let address = destination.addresses.first else { throw NativeNetworkError.denied }
        let channel = try NativeNetworkChannel(destination: destination, address: address, authority: authority)
        channels[request.id] = channel
        do {
            try await channel.start()
            guard !stopped else { throw NativeNetworkError.denied }
            return channel
        } catch { await channel.close(); channels.removeValue(forKey: request.id); throw error }
    }
    func close(_ id: UUID) async -> NativeNetworkChannelReceipt? {
        guard let channel = channels.removeValue(forKey: id) else { return nil }
        await channel.close()
        return await channel.receipt()
    }
    func stop() async {
        stopped = true
        let current = Array(channels.values); channels.removeAll()
        for channel in current { await channel.close() }
    }
}

final class NetworkChannelResult<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var result: Result<T, Error>?
    private var finished: (@Sendable () -> Void)?
    func attach(_ continuation: CheckedContinuation<T, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result) }
        else { self.continuation = continuation; lock.unlock() }
    }
    func onFinish(_ callback: @escaping @Sendable () -> Void) {
        lock.lock()
        if result != nil { lock.unlock(); callback() }
        else { finished = callback; lock.unlock() }
    }
    func finish(_ result: Result<T, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = continuation, callback = finished
        self.continuation = nil; finished = nil
        lock.unlock()
        continuation?.resume(with: result)
        callback?()
    }
}
