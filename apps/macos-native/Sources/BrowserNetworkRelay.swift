import Foundation
import Virtualization
import CryptoKit

/// A short-lived relay for one server-reserved Chrome page load. There is no
/// NIC, NAT, host share, DNS fallback, URL fetcher or TLS interception.
@MainActor final class NativeBrowserNetworkRelay: NSObject, @preconcurrency VZVirtioSocketListenerDelegate {
    let channel = UUID().uuidString.lowercased()
    private let secret = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    var encodedSecret: String { secret.base64EncodedString() }
    private let device: VZVirtioSocketDevice
    private let listener = VZVirtioSocketListener()
    private let authority: NativeServerNetworkAuthority
    private let connector: NativeNetworkConnector
    private let reservation: UUID, base: NativeNetworkRequest
    private let current: @MainActor @Sendable () throws -> Void
    private var connection: VZVirtioSocketConnection?
    private var wire: GuestLinkWire?
    private var task: Task<Void, Never>?, timer: Task<Void, Never>?
    private var downloads: [String: Task<Void, Never>] = [:]
    private var flows: [String: NativeNetworkChannel] = [:]
    private var seen = Set<String>()
    private var closed = false, claimed = false

    init(device: VZVirtioSocketDevice, api: JosiAPI, storageSession: UUID, packet: Wire,
         current: @escaping @MainActor @Sendable () throws -> Void) throws {
        let n = packet["command"]["network"]
        guard (packet["command"]["operation"] == .string("navigate")
                || packet["command"]["operation"] == .string("observe") && packet["command"]["photo"] != .null),
              ProtectedWire.exact(n, ["id", "workspaceId", "taskId", "origin", "networkClass", "maximumBytes", "expiresAtMs"]),
              let id = UUID(uuidString: n["id"].text), let workspace = UUID(uuidString: n["workspaceId"].text),
              let task = UUID(uuidString: n["taskId"].text), let reservation = UUID(uuidString: packet["reservationId"].text),
              n["networkClass"] == .string("public"), n["origin"] == packet["command"]["browser"]["origin"],
              n["id"] == packet["command"]["id"], n["expiresAtMs"] == packet["command"]["expiresAtMs"],
              (1...16_777_216).contains(n["maximumBytes"].integer) else { throw GuestLinkError.invalid }
        self.device = device; self.current = current; self.reservation = reservation
        base = NativeNetworkRequest(id: id, workspaceId: workspace, taskId: task, origin: n["origin"].text,
            networkClass: .public, maximumBytes: n["maximumBytes"].integer, expiresAtMs: Int64(n["expiresAtMs"].integer))
        authority = NativeServerNetworkAuthority(api: api, sessionId: storageSession, current: current)
        connector = NativeNetworkConnector(authority: authority)
        super.init()
        try live()
        listener.delegate = self
        device.setSocketListener(listener, forPort: GuestLinkWire.networkPort)
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)); try self?.live() }
                catch { self?.stop(); return }
            }
        }
    }
    private func live() throws {
        try current()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard !closed, now < base.expiresAtMs, base.expiresAtMs - now <= 10_000 else { throw GuestLinkError.expired }
    }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard listener === self.listener, socketDevice === device, !claimed, !closed else { return false }
        do {
            try live()
            let wire = try GuestLinkWire(descriptor: connection.fileDescriptor, host: true, network: (secret, channel))
            claimed = true; self.connection = connection; self.wire = wire
            task = Task { await self.run(wire) }; return true
        } catch { return false }
    }
    private func run(_ wire: GuestLinkWire) async {
        do {
            guard try await wire.receive() == ["kind": "network-hello", "channel": channel] else { throw GuestLinkError.invalid }
            try live()
            try await wire.send(["kind": "network-ready", "channel": channel])
            while !Task.isCancelled {
                let frame = try await wire.receive(seconds: 10); try live()
                guard let id = frame["id"], let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else { throw GuestLinkError.invalid }
                switch frame["kind"] {
                case "network-open":
                    guard Set(frame.keys) == ["kind", "id", "origin"], frame["origin"] == base.origin,
                          !seen.contains(id), seen.count < 8 else { throw GuestLinkError.invalid }
                    seen.insert(id)
                    let request = NativeNetworkRequest(id: uuid, workspaceId: base.workspaceId, taskId: base.taskId,
                        origin: base.origin, networkClass: base.networkClass, maximumBytes: base.maximumBytes, expiresAtMs: base.expiresAtMs)
                    do {
                        try authority.bind(request, reservationId: reservation)
                        // Serialize connection establishment; the resolver has
                        // one bounded DNS lookup in flight, never a DNS race.
                        let flow = try await connector.open(request); try live()
                        flows[id] = flow
                        try await wire.send(["kind": "network-opened", "id": id])
                        downloads[id] = Task { [weak self] in await self?.download(id, flow: flow, wire: wire) }
                    } catch { try await wire.send(["kind": "network-close", "id": id]) }
                case "network-data":
                    guard Set(frame.keys) == ["kind", "id", "data"], seen.contains(id), let encoded = frame["data"],
                          let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 32768,
                          data.base64EncodedString() == encoded else { throw GuestLinkError.invalid }
                    // A peer-close can cross the last already-sent data frame.
                    if let flow = flows[id] {
                        do { try await flow.send(data) }
                        catch { await closeFlow(id, wire: wire) }
                    }
                case "network-close":
                    guard Set(frame.keys) == ["kind", "id"], seen.contains(id) else { throw GuestLinkError.invalid }
                    await closeFlow(id, wire: nil)
                default: throw GuestLinkError.invalid
                }
            }
        } catch { stop() }
    }
    private func download(_ id: String, flow: NativeNetworkChannel, wire: GuestLinkWire) async {
        do {
            while !Task.isCancelled {
                let data = try await flow.receive(); try live()
                if data.isEmpty { break }
                try await wire.send(["kind": "network-data", "id": id, "data": data.base64EncodedString()])
            }
        } catch {}
        await closeFlow(id, wire: wire, cancelReader: false)
    }
    private func closeFlow(_ id: String, wire: GuestLinkWire?, cancelReader: Bool = true) async {
        guard flows.removeValue(forKey: id) != nil else { return }
        let reader = downloads.removeValue(forKey: id)
        if cancelReader { reader?.cancel() }
        if let uuid = UUID(uuidString: id) { _ = await connector.close(uuid) }
        if !closed, let wire { try? await wire.send(["kind": "network-close", "id": id]) }
    }
    func stop() {
        guard !closed else { return }
        closed = true; authority.invalidate(); wire?.interrupt(); connection?.close()
        device.removeSocketListener(forPort: GuestLinkWire.networkPort)
        task?.cancel(); timer?.cancel(); task = nil; timer = nil
        for task in downloads.values { task.cancel() }; downloads.removeAll(); flows.removeAll()
        Task { [connector] in await connector.stop() }
        wire = nil; connection = nil
    }
}
