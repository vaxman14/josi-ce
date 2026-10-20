import AppKit
import Foundation

/// A live browser connection is separate from permission to operate it. This
/// owner handles connection readiness only until task-bound dispatch is wired.
/// Empty origins, no queued command and no authorize/receipt handler ensure
/// that a readiness session cannot read a page or produce an input event.
@MainActor final class GuestBrowserSession {
    private let connection = NSXPCConnection(machServiceName: GuestBrowserBoundary.ownerService)
    private let sessionId = UUID().uuidString.lowercased()
    private let scopeId = UUID().uuidString.lowercased()
    private let hostBoot: String
    private let requireConnection: @MainActor () throws -> Void
    private let notify: @MainActor (Bool) -> Void
    private let takeover: @MainActor () -> Void
    private var canonical: GuestCanonicalBrowser
    private var deadline: ContinuousClock.Instant = .now
    private var lastWall = Int64(Date().timeIntervalSince1970 * 1000)
    private var ended = false, connected = false, renewing = false
    private var source: Data?
    private var requests = Set<String>()
    private var monitor: Task<Void, Never>?

    init(_ target: GuestCanonicalBrowser, current: @escaping @MainActor () throws -> Void,
         status: @escaping @MainActor (Bool) -> Void, stopped: @escaping @MainActor () -> Void) throws {
        try GuestEnvironment.signedApplication()
        let boot = try GuestEnvironment.identity()
        guard boot.guest == target.prepared.candidate.guestBootId else { throw GuestLinkError.invalid }
        canonical = target; hostBoot = boot.host; requireConnection = current; notify = status; takeover = stopped
        connection.remoteObjectInterface = NSXPCInterface(with: GuestBrowserOwner.self)
        connection.exportedInterface = NSXPCInterface(with: GuestBrowserOwnerCallback.self)
        connection.setCodeSigningRequirement(GuestBrowserBoundary.requirement(GuestBrowserBoundary.brokerIdentifier))
        connection.exportedObject = BrowserSessionCallback { [weak self] request, peer in
            guard let self else { throw GuestBrowserError.unavailable }
            return try self.handle(request, peer: peer)
        }
        connection.interruptionHandler = { [weak self] in Task { @MainActor in self?.stop() } }
        connection.invalidationHandler = { [weak self] in Task { @MainActor in self?.stop() } }
        connection.resume()
    }
    var available: Bool { !ended }
    private func live() throws {
        try requireConnection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard !ended, now >= lastWall, now < canonical.expiresAtMs, ContinuousClock.now < deadline else { throw GuestLinkError.expired }
        lastWall = now
    }
    func renew(_ next: GuestCanonicalBrowser) async throws {
        try requireConnection()
        let now = Int64(Date().timeIntervalSince1970 * 1000), previous = canonical
        guard !ended, !renewing, now >= lastWall, next.expiresAtMs > now, next.expiresAtMs - now <= 10_000,
              next.profileId == previous.profileId, next.recordId == previous.recordId, next.version == previous.version,
              next.epoch == previous.epoch, next.digest == previous.digest,
              next.prepared.candidate == previous.prepared.candidate,
              next.prepared.application == previous.prepared.application else { stop(); throw GuestLinkError.invalid }
        if monitor != nil { try live() }
        renewing = true
        defer { renewing = false }
        let c = next.prepared.candidate
        let data = try JSONSerialization.data(withJSONObject: [
            "workspaceId": next.prepared.application.workspaceId.uuidString.lowercased(), "profileId": c.nativeProfileId,
            "family": c.family, "guestBootId": c.guestBootId, "hostBootId": hostBoot,
            "connectionId": scopeId, "generation": 0, "leaseUntilMs": next.expiresAtMs,
        ])
        let accepted = await withCheckedContinuation { continuation in
            let reply = BrowserSessionRenewal { continuation.resume(returning: $0) }
            let timeout = DispatchWorkItem { reply.finish(false) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: timeout)
            guard let proxy = connection.remoteObjectProxyWithErrorHandler({ _ in timeout.cancel(); reply.finish(false) }) as? GuestBrowserOwner
            else { timeout.cancel(); reply.finish(false); return }
            proxy.renew(data) { value in timeout.cancel(); reply.finish(value) }
        }
        guard accepted, !ended else { stop(); throw GuestLinkError.unavailable }
        canonical = next
        deadline = .now.advanced(by: .milliseconds(max(0, next.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000))))
        try live()
        if monitor == nil {
            monitor = Task { [weak self] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .milliseconds(200))
                        guard let self else { return }
                        try self.live()
                    }
                    catch { self?.stop(); return }
                }
            }
        }
    }
    func stop() {
        guard !ended else { return }
        ended = true; connected = false; source = nil
        monitor?.cancel(); monitor = nil
        (connection.remoteObjectProxy as? GuestBrowserOwner)?.stop()
        connection.invalidate(); notify(false)
    }
    private func peer(_ data: Data) throws -> Data {
        guard data.count <= 8192, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["kind", "family", "extensionId", "guestBootId", "hostBootId", "workspaceId", "profileId",
                                 "profilePath", "processId", "launchedAtMs", "bundleId", "bundlePath", "signingId", "teamId", "codeHash"]
        else { throw GuestLinkError.invalid }
        let p = canonical.prepared, c = p.candidate, pin = p.application
        guard value["kind"] as? String == "browser-process", value["family"] as? String == c.family,
              value["extensionId"] as? String == c.extensionId, value["guestBootId"] as? String == c.guestBootId,
              value["hostBootId"] as? String == hostBoot, value["workspaceId"] as? String == pin.workspaceId.uuidString.lowercased(),
              value["profileId"] as? String == c.nativeProfileId, value["profilePath"] as? String == c.profilePath,
              value["bundleId"] as? String == pin.bundleId, value["bundlePath"] as? String == pin.bundlePath,
              value["signingId"] as? String == pin.signingId, value["teamId"] as? String == pin.teamId,
              value["codeHash"] as? String == pin.codeHash,
              let pid = value["processId"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID(),
              pid.doubleValue == Double(pid.int32Value), pid.int32Value > 0,
              let launch = value["launchedAtMs"] as? NSNumber, CFGetTypeID(launch) != CFBooleanGetTypeID(),
              launch.doubleValue == Double(launch.int64Value),
              let app = NSRunningApplication(processIdentifier: pid.int32Value), let date = app.launchDate,
              Int64(date.timeIntervalSince1970 * 1000) == launch.int64Value else { throw GuestLinkError.invalid }
        try GuestDesktopEngine.verifyApplication(app, pin: pin)
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    private func session() -> [String: Any] {
        ["sessionId": sessionId, "workspaceId": canonical.prepared.application.workspaceId.uuidString.lowercased(),
         "profileId": canonical.profileId.uuidString.lowercased(), "family": canonical.prepared.candidate.family,
         "isolatedWorkspace": true, "origins": [String](), "expiresAt": canonical.expiresAtMs]
    }
    private func handle(_ data: Data, peer peerData: Data) throws -> Data {
        try live()
        let request = try GuestBrowserBoundary.request(data)
        guard let id = request["requestId"] as? String, let operation = request["operation"] as? String,
              let payload = request["payload"] as? [String: Any], requests.count < 16384, !requests.contains(id) else { throw GuestLinkError.invalid }
        requests.insert(id)
        let verified = try peer(peerData)
        try live()
        if let source, source != verified { stop(); throw GuestLinkError.invalid }
        let output: [String: Any]
        switch operation {
        case "browser.hello":
            guard !connected, request["sessionId"] is NSNull, Set(payload.keys) == ["family", "extensionId"],
                  payload["family"] as? String == canonical.prepared.candidate.family,
                  payload["extensionId"] as? String == canonical.prepared.candidate.extensionId else { throw GuestLinkError.invalid }
            connected = true; source = verified; notify(true); output = session()
        case "browser.poll":
            guard connected, request["sessionId"] as? String == sessionId, payload.isEmpty else { throw GuestLinkError.invalid }
            output = ["session": session(), "command": NSNull()]
        case "browser.stop":
            guard connected, request["sessionId"] as? String == sessionId, Set(payload.keys) == ["reason"],
                  payload["reason"] as? String == "local_takeover" else { throw GuestLinkError.invalid }
            // No further request or action can pass while the stop propagates.
            stop(); takeover(); output = ["stopped": true]
        default:
            // There is no pending, server-reserved browser command. Never
            // treat a browser's proposed authorize/receipt payload as one.
            return try JSONSerialization.data(withJSONObject: ["version": 1, "requestId": id, "ok": false, "code": "no_reserved_command"])
        }
        return try JSONSerialization.data(withJSONObject: ["version": 1, "requestId": id, "ok": true, "payload": output])
    }
}

private final class BrowserSessionCallback: NSObject, GuestBrowserOwnerCallback, @unchecked Sendable {
    let handler: @MainActor @Sendable (Data, Data) throws -> Data
    init(_ handler: @escaping @MainActor @Sendable (Data, Data) throws -> Data) { self.handler = handler }
    func handle(_ request: Data, peer: Data, reply: @escaping (Data?, NSError?) -> Void) {
        let completion = BrowserSessionResponse(reply)
        Task { @MainActor in
            do { completion.finish(try handler(request, peer)) }
            catch { completion.finish(nil) }
        }
    }
}
private final class BrowserSessionResponse: @unchecked Sendable {
    private let callback: (Data?, NSError?) -> Void
    init(_ callback: @escaping (Data?, NSError?) -> Void) { self.callback = callback }
    func finish(_ data: Data?) { callback(data, data == nil ? NSError(domain: "JosiWorkspace", code: 1) : nil) }
}
private final class BrowserSessionRenewal: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: ((Bool) -> Void)?
    init(_ callback: @escaping (Bool) -> Void) { self.callback = callback }
    func finish(_ result: Bool) {
        lock.lock(); let completion = callback; callback = nil; lock.unlock()
        completion?(result)
    }
}
