import Foundation

/// Uses the existing authenticated CE session. Only the trusted task transport
/// may bind its already-dispatched reservation; a guest cannot create one.
/// This adapter is assembled but is not instantiated by the workspace yet.
@MainActor final class NativeServerNetworkAuthority: NativeNetworkChannelAuthority {
    private let api: JosiAPI
    private let sessionId: UUID
    private let current: @MainActor @Sendable () throws -> Void
    private var bindings: [UUID: (request: NativeNetworkRequest, reservationId: UUID)] = [:]
    private var seen = Set<UUID>()
    private var pending: [UUID: @Sendable () -> Void] = [:]
    private var closed = false

    init(api: JosiAPI, sessionId: UUID, current: @escaping @MainActor @Sendable () throws -> Void) {
        self.api = api; self.sessionId = sessionId; self.current = current
    }
    func bind(_ request: NativeNetworkRequest, reservationId: UUID) throws {
        try live(request)
        bindings = bindings.filter { $0.value.request.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000) }
        guard bindings.count < 16, seen.count < 4096, !seen.contains(request.id) else { throw NativeNetworkError.denied }
        seen.insert(request.id)
        bindings[request.id] = (request, reservationId)
    }
    func invalidate() {
        closed = true; bindings.removeAll()
        let cancellations = Array(pending.values); pending.removeAll()
        for cancel in cancellations { cancel() }
    }
    func beforeLookup(_ request: NativeNetworkRequest) async throws {
        try await permit(request, phase: "lookup")
    }
    func afterLookup(_ destination: NativeNetworkDestination) async throws {
        try await permit(destination.request, phase: "resolved", destination: destination)
    }
    func beforeConnect(_ destination: NativeNetworkDestination, address: String) async throws {
        try await permit(destination.request, phase: "connect", destination: destination, address: address)
    }
    func beforeTransfer(_ destination: NativeNetworkDestination, address: String,
                        direction: NativeNetworkDirection, maximumBytes: Int) async throws {
        try await permit(destination.request, phase: "transfer", destination: destination,
                         address: address, direction: direction, maximumBytes: maximumBytes)
    }
    func revalidate(_ destination: NativeNetworkDestination, address: String) async throws {
        try await permit(destination.request, phase: "current", destination: destination, address: address)
    }
    private func live(_ request: NativeNetworkRequest) throws {
        try Task.checkCancellation()
        try current()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard !closed, request.expiresAtMs > now, request.expiresAtMs - now <= 10_000 else { throw NativeNetworkError.expired }
    }
    private func permit(_ request: NativeNetworkRequest, phase: String, destination: NativeNetworkDestination? = nil,
                        address: String? = nil, direction: NativeNetworkDirection? = nil, maximumBytes: Int? = nil) async throws {
        try live(request)
        guard let binding = bindings[request.id], binding.request == request, pending.count < 8,
              destination == nil || destination?.request == request else { throw NativeNetworkError.denied }
        let reservation = binding.reservationId.uuidString.lowercased(), requestWire: Wire = [
            "id": .string(request.id.uuidString.lowercased()), "workspaceId": .string(request.workspaceId.uuidString.lowercased()),
            "taskId": .string(request.taskId.uuidString.lowercased()), "origin": .string(request.origin),
            "networkClass": .string(request.networkClass.rawValue), "maximumBytes": .number(Double(request.maximumBytes)),
            "expiresAtMs": .number(Double(request.expiresAtMs)),
        ]
        let destinationWire: Wire = destination.map { value in
            ["hostname": .string(value.hostname), "port": .number(Double(value.port)),
             "addresses": .array(value.addresses.map(Wire.string)), "networkClass": .string(value.networkClass.rawValue)]
        } ?? .null
        let body: Wire = ["kind": "network-permit", "reservationId": .string(reservation), "request": requestWire,
            "phase": .string(phase), "destination": destinationWire, "address": address.map(Wire.string) ?? .null,
            "direction": direction.map { .string($0.rawValue) } ?? .null,
            "maximumBytes": maximumBytes.map { .number(Double($0)) } ?? .null]
        let id = UUID(), result = NetworkChannelResult<Wire>()
        pending[id] = { result.finish(.failure(NativeNetworkError.unavailable)) }
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(min(2000, request.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000))))
        let operation = Task { @MainActor [api, sessionId] in
            do {
                try Task.checkCancellation()
                let value = try await api.request("/admin/automation/storage/sessions/\(sessionId.uuidString.lowercased())/network/permit",
                                                  method: "POST", body: body)
                result.finish(.success(value))
            } catch { result.finish(.failure(NativeNetworkError.denied)) }
        }
        result.onFinish { operation.cancel() }
        let timer = Task {
            do {
                try await Task.sleep(until: deadline, clock: .continuous)
                result.finish(.failure(NativeNetworkError.expired))
            } catch {}
        }
        defer { timer.cancel(); pending.removeValue(forKey: id) }
        let reply = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in result.attach(continuation) }
        } onCancel: { result.finish(.failure(CancellationError())) }
        try live(request)
        guard bindings[request.id]?.request == request,
              ProtectedWire.exact(reply, ["kind", "reservationId", "phase", "request", "expiresAtMs"]),
              reply["kind"] == "network-permit", reply["reservationId"] == .string(reservation),
              reply["phase"] == .string(phase), reply["request"] == requestWire,
              reply["expiresAtMs"] == .number(Double(request.expiresAtMs)) else { throw NativeNetworkError.denied }
    }
}
