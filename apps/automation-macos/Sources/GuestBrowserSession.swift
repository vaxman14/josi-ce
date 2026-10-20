import AppKit
import Foundation

/// A live connection grants no operation. A reserved inspection temporarily
/// names one origin; its final server permit precedes the page read. Content
/// stays in guest RAM until a separately authorized one-use model projection.
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
    private var safariProcess: (pid: Int32, launched: Int64)?
    private var requests = Set<String>()
    private var monitor: Task<Void, Never>?
    private var flight: BrowserInspectionFlight?
    private var capture: Data?
    private var captureWindow: UUID?
    private var lastCapture: GuestDesktopCommand?
    private var captureDeadline: ContinuousClock.Instant = .now
    private var captureExpiry: Task<Void, Never>?
    private var usedCommands = Set<UUID>()
    private var inputSource: (observation: String, tab: Int, window: Int)?
    private var inputDeadline: ContinuousClock.Instant = .now

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
            return try await self.handle(request, peer: peer)
        }
        connection.interruptionHandler = { [weak self] in Task { @MainActor in self?.stop() } }
        connection.invalidationHandler = { [weak self] in Task { @MainActor in self?.stop() } }
        connection.resume()
    }
    var available: Bool { !ended }
    func requireEpoch(_ epoch: Int) throws {
        try live()
        guard canonical.epoch == epoch else { throw GuestDesktopError.denied }
    }
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
        let pending = flight; flight = nil; pending?.timeout?.cancel()
        pending?.completion.resume(throwing: GuestDesktopError.uncertain)
        captureExpiry?.cancel(); captureExpiry = nil
        capture = nil; lastCapture = nil; captureWindow = nil; inputSource = nil
        monitor?.cancel(); monitor = nil
        (connection.remoteObjectProxy as? GuestBrowserOwner)?.stop()
        connection.invalidate(); notify(false)
    }
    private func peer(_ data: Data) throws -> Data {
        if canonical.prepared.candidate.family == "safari" {
            let p = canonical.prepared
            let verified = try Self.safariPeer(data, pin: p.application, profile: p.candidate.nativeProfileId,
                                              guest: p.candidate.guestBootId, host: hostBoot)
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: p.application.bundleId)
            guard apps.count == 1, let launched = apps[0].launchDate else { throw GuestLinkError.invalid }
            let actual = (pid: apps[0].processIdentifier, launched: Int64(launched.timeIntervalSince1970 * 1000))
            if let previous = safariProcess {
                guard previous.pid == actual.pid, previous.launched == actual.launched else { throw GuestLinkError.invalid }
            } else { safariProcess = actual }
            return verified
        }
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
    static func safariPeer(_ data: Data, pin: GuestPinnedApplication, profile: String?, guest: String, host: String) throws -> Data {
        guard data.count <= 8192, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["kind", "family", "profileId", "guestBootId", "hostBootId", "extensionId"],
              value["kind"] as? String == "safari-profile", value["family"] as? String == "safari",
              value["guestBootId"] as? String == guest, value["hostBootId"] as? String == host,
              value["extensionId"] as? String == "com.heyjosi.ce.guestcompanion.workspace-safari",
              let actual = value["profileId"] as? String, UUID(uuidString: actual)?.uuidString.lowercased() == actual,
              profile == nil || profile == actual, pin.bundleId == "com.apple.Safari" else { throw GuestLinkError.invalid }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: pin.bundleId)
        guard apps.count == 1 else { throw GuestLinkError.invalid }
        try GuestDesktopEngine.verifyApplication(apps[0], pin: pin)
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    private func session() -> [String: Any] {
        ["sessionId": sessionId, "workspaceId": canonical.prepared.application.workspaceId.uuidString.lowercased(),
         "profileId": canonical.profileId.uuidString.lowercased(), "family": canonical.prepared.candidate.family,
         "isolatedWorkspace": true, "origins": flight?.original.browser.map { [$0.origin] } ?? [],
         "expiresAt": canonical.expiresAtMs]
    }
    private func current(_ command: GuestDesktopCommand) throws {
        try live()
        let pin = canonical.prepared.application
        guard connected, let browser = command.browser, browser.profileId == canonical.profileId,
              browser.family == canonical.prepared.candidate.family, Self.site(browser.origin) == browser.origin,
              command.workspaceId == pin.workspaceId, command.appId == pin.applicationId,
              command.installationRevision == pin.installationRevision,
              command.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000),
              let source, try peer(source) == source else { throw GuestDesktopError.stale }
        try GuestBrowserProfiles.requireInstalledExtension(canonical.prepared)
        try live()
    }
    private func target(_ command: GuestDesktopCommand) throws -> String {
        try current(command)
        guard let source, let peer = try JSONSerialization.jsonObject(with: source) as? [String: Any],
              let browser = command.browser else { throw GuestDesktopError.denied }
        let c = canonical.prepared.candidate
        let process: Any, launched: Any
        if c.family == "safari", let safariProcess {
            process = safariProcess.pid; launched = safariProcess.launched
        } else {
            guard let pid = peer["processId"], let time = peer["launchedAtMs"] else { throw GuestDesktopError.denied }
            process = pid; launched = time
        }
        let value: [String: Any] = ["kind": "browser", "profileId": canonical.profileId.uuidString.lowercased(),
            "nativeProfileId": c.nativeProfileId, "family": c.family, "extensionId": c.extensionId, "extensionDigest": c.extensionDigest,
            "processId": process, "launchedAtMs": launched, "codeHash": canonical.prepared.application.codeHash,
            "origin": browser.origin]
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    func observe(_ command: GuestDesktopCommand, authorize: @escaping @MainActor (String) async throws -> Void) async throws -> (UUID, UUID) {
        try current(command)
        guard command.operation == .observe, let browser = command.browser, let resultId = command.resultObservationId,
              let limit = command.maxOutputBytes, (4096...65536).contains(limit), flight == nil,
              !usedCommands.contains(command.id), usedCommands.count < 4096 else { throw GuestDesktopError.denied }
        if let preceding = command.observationId {
            guard let lastCapture, lastCapture.resultObservationId == preceding, lastCapture.taskId == command.taskId,
                  lastCapture.sessionId == command.sessionId, lastCapture.generation == command.generation,
                  lastCapture.browser == command.browser else { throw GuestDesktopError.stale }
        }
        var photoSource: (observation: String, tab: Int, window: Int)?
        if command.photo != nil {
            guard browser.family == "chrome", let inputSource, command.windowId == captureWindow,
                  command.observationId != nil, ContinuousClock.now < inputDeadline else { throw GuestDesktopError.stale }
            photoSource = inputSource
        }
        usedCommands.insert(command.id)
        captureExpiry?.cancel(); captureExpiry = nil; capture = nil; captureWindow = nil
        var wire: [String: Any] = ["id": command.id.uuidString.lowercased(), "sessionId": sessionId,
            "profileId": canonical.profileId.uuidString.lowercased(), "kind": "inspect", "origin": browser.origin,
            "expiresAt": min(command.expiresAtMs, canonical.expiresAtMs), "maxOutputBytes": limit - 2048]
        if let photo = command.photo, let photoSource {
            wire["kind"] = "photo"; wire["tabId"] = photoSource.tab; wire["observationId"] = photoSource.observation
            wire["elementId"] = photo.elementId.uuidString.lowercased(); wire["maxOutputBytes"] = limit - 26_000
        }
        let result = try await dispatch(command, wire: wire, authorize: authorize)
        try current(command)
        guard var page = try JSONSerialization.jsonObject(with: result) as? [String: Any] else { throw GuestDesktopError.denied }
        if command.photo != nil {
            guard let photo = page["photo"] as? [String: Any], let encoded = photo["base64"] as? String else { throw GuestDesktopError.denied }
            page["ocrText"] = try await GuestPhotoReader.recognize(encoded)
            try current(command)
        }
        let metadata = page
        guard let observation = metadata["observationId"] as? String,
              let tab = metadata["tabId"] as? Int, let browserWindow = metadata["windowId"] as? Int else { throw GuestDesktopError.denied }
        inputSource = (observation, tab, browserWindow); inputDeadline = .now.advanced(by: .seconds(120))
        let window = UUID()
        let snapshot: [String: Any] = ["id": resultId.uuidString.lowercased(), "workspaceId": command.workspaceId.uuidString.lowercased(),
            "taskId": command.taskId.uuidString.lowercased(), "sessionId": command.sessionId.uuidString.lowercased(),
            "appId": command.appId.uuidString.lowercased(), "installationRevision": command.installationRevision,
            "windowId": window.uuidString.lowercased(), "generation": command.generation, "untrustedContent": true,
            "surface": "browser", "profileId": canonical.profileId.uuidString.lowercased(), "origin": browser.origin,
            "page": page, "verificationRequired": true]
        let body = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys, .withoutEscapingSlashes])
        guard body.count <= limit else { throw GuestDesktopError.denied }
        capture = body; captureWindow = window; lastCapture = command
        captureDeadline = .now.advanced(by: .seconds(15))
        captureExpiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.lastCapture?.resultObservationId == resultId else { return }
            self.capture = nil; self.captureExpiry = nil
        }
        return (resultId, window)
    }
    private func dispatch(_ command: GuestDesktopCommand, wire: [String: Any],
                          authorize: @escaping @MainActor (String) async throws -> Void) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let pending = BrowserInspectionFlight(original: command, wire: wire, authorize: authorize, completion: continuation)
            flight = pending
            pending.timeout = Task { [weak self, weak pending] in
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(for: .milliseconds(max(1, min(command.expiresAtMs, self?.canonical.expiresAtMs ?? now) - now)))
                guard !Task.isCancelled, let self, let pending, self.flight === pending else { return }
                self.stop()
            }
        }
    }
    func draft(_ command: GuestDesktopCommand, authorize: @escaping @MainActor (String) async throws -> Void) async throws {
        try current(command)
        guard command.operation == .draft, command.browser?.family == "chrome", let draft = command.draft,
              !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.text.utf8.count <= 2048,
              command.maxOutputBytes == draft.text.utf8.count,
              let lastCapture, let input = inputSource, ContinuousClock.now < inputDeadline, flight == nil,
              command.observationId == lastCapture.resultObservationId, command.windowId == captureWindow,
              command.browser == lastCapture.browser, command.taskId == lastCapture.taskId,
              command.sessionId == lastCapture.sessionId, command.generation == lastCapture.generation,
              let element = command.elementId, !usedCommands.contains(command.id), usedCommands.count < 4096
        else { throw GuestDesktopError.stale }
        usedCommands.insert(command.id); inputSource = nil
        let wire: [String: Any] = ["id": command.id.uuidString.lowercased(), "sessionId": sessionId,
            "profileId": canonical.profileId.uuidString.lowercased(), "kind": "draft", "tabId": input.tab,
            "observationId": input.observation, "elementId": element.uuidString.lowercased(),
            "expiresAt": min(command.expiresAtMs, canonical.expiresAtMs)]
        _ = try await dispatch(command, wire: wire, authorize: authorize)
        try current(command)
    }
    func project(_ command: GuestDesktopCommand, authorize: @MainActor (String) async throws -> Void) async throws -> Data {
        try current(command)
        guard command.operation == .project, let lastCapture, let body = capture,
              command.observationId == lastCapture.resultObservationId, command.windowId == captureWindow,
              command.browser == lastCapture.browser, command.taskId == lastCapture.taskId,
              command.sessionId == lastCapture.sessionId, command.generation == lastCapture.generation,
              ContinuousClock.now < captureDeadline, let limit = command.maxOutputBytes, body.count <= limit,
              !usedCommands.contains(command.id), usedCommands.count < 4096 else { throw GuestDesktopError.stale }
        usedCommands.insert(command.id); capture = nil // Consume before awaiting any external permit.
        try await authorize(target(command))
        try current(command)
        guard ContinuousClock.now < captureDeadline else { throw GuestDesktopError.stale }
        return body
    }
    private static func site(_ raw: String) -> String? {
        guard var parts = URLComponents(string: raw), ["http", "https"].contains(parts.scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil else { return nil }
        parts.path = ""; parts.query = nil; parts.fragment = nil
        if parts.port == (parts.scheme == "https" ? 443 : 80) { parts.port = nil }
        return parts.string
    }
    private func handle(_ data: Data, peer peerData: Data) async throws -> Data {
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
            let command: Any = flight?.delivered == false ? flight!.wire : NSNull()
            flight?.delivered = true
            output = ["session": session(), "command": command]
        case "browser.authorize":
            guard connected, request["sessionId"] as? String == sessionId,
                  let pending = flight, pending.delivered, !pending.authorized, !pending.authorizing,
                  Set(payload.keys) == ["command", "actual"], let command = payload["command"] as? [String: Any],
                  NSDictionary(dictionary: command).isEqual(to: pending.wire),
                  let actual = payload["actual"] as? [String: Any], Set(actual.keys) == ["tabId", "windowId", "url"],
                  let tab = actual["tabId"] as? Int, tab >= 0, let window = actual["windowId"] as? Int, window >= 0,
                  let url = actual["url"] as? String, url.utf8.count <= 8192,
                  Self.site(url) == pending.original.browser?.origin else { throw GuestDesktopError.denied }
            pending.authorizing = true
            do {
                try await pending.authorize(target(pending.original))
                try current(pending.original)
                guard flight === pending else { throw GuestDesktopError.stale }
                pending.authorized = true; pending.actual = (tab, window)
                var permitted: [String: Any] = ["commandId": pending.original.id.uuidString.lowercased(), "sessionId": sessionId, "allowed": true]
                if pending.original.operation == .draft { permitted["draftText"] = pending.original.draft?.text }
                output = permitted
            } catch { stop(); throw error }
        case "browser.receipt":
            guard connected, request["sessionId"] as? String == sessionId, let pending = flight, pending.delivered,
                  payload["commandId"] as? String == pending.original.id.uuidString.lowercased() else { throw GuestDesktopError.denied }
            if pending.original.operation == .draft {
                guard pending.authorized, payload["outcome"] as? String == "observed_or_issued",
                      Set(payload.keys) == ["commandId", "outcome", "result"],
                      let result = payload["result"] as? [String: Any],
                      Set(result.keys) == ["kind", "matched", "verificationRequired"],
                      result["kind"] as? String == "draft_filled", result["matched"] as? Bool == true,
                      result["verificationRequired"] as? Bool == true else { stop(); throw GuestDesktopError.uncertain }
                try current(pending.original)
                flight = nil; pending.timeout?.cancel(); pending.completion.resume(returning: Data())
                output = ["recorded": true, "verificationRequired": true]
                break
            }
            guard pending.authorized, payload["outcome"] as? String == "observed_or_issued",
                  Set(payload.keys) == ["commandId", "outcome", "result"],
                  let result = payload["result"] as? [String: Any],
                  Set(result.keys) == Set(["kind", "observationId", "revision", "title", "url", "text", "elements", "partial", "framesUnsupported", "viewport", "tabId", "windowId"] + (pending.original.photo == nil ? [] : ["photo"])),
                  result["kind"] as? String == "observation",
                  let observation = result["observationId"] as? String, UUID(uuidString: observation) != nil,
                  let url = result["url"] as? String, Self.site(url) == pending.original.browser?.origin,
                  let title = result["title"] as? String, title.utf8.count <= 1200,
                  let text = result["text"] as? String, text.utf8.count <= 80_000,
                  let elements = result["elements"] as? [[String: Any]], elements.count <= 300,
                  elements.allSatisfy({ element in
                      guard let id = element["id"] as? String else { return false }
                      return UUID(uuidString: id) != nil
                  }), result["tabId"] as? Int == pending.actual?.0, result["windowId"] as? Int == pending.actual?.1
            else { stop(); throw GuestDesktopError.uncertain }
            if pending.original.photo != nil {
                guard let photo = result["photo"] as? [String: Any],
                      Set(photo.keys) == ["mediaType", "base64", "width", "height", "alt", "untrustedContent"],
                      photo["mediaType"] as? String == "image/jpeg", photo["untrustedContent"] as? Bool == true,
                      let encoded = photo["base64"] as? String, encoded.utf8.count <= 32768,
                      let alt = photo["alt"] as? String, alt.utf8.count <= 1200 else { stop(); throw GuestDesktopError.uncertain }
            }
            try current(pending.original)
            let body = try JSONSerialization.data(withJSONObject: result)
            guard body.count <= (pending.original.maxOutputBytes ?? 0) - 2048 else { stop(); throw GuestDesktopError.uncertain }
            flight = nil; pending.timeout?.cancel(); pending.completion.resume(returning: body)
            output = ["recorded": true, "verificationRequired": true]
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

/// An explicit, short-lived local setup gesture. Only Safari's native profile
/// UUID is returned, and the user must confirm it before a candidate is shared
/// for protected Vault registration. This owner cannot create a control session.
@MainActor final class GuestSafariDiscovery {
    private let connection = NSXPCConnection(machServiceName: GuestBrowserBoundary.ownerService)
    private let scope = UUID().uuidString.lowercased()
    private let boot: (guest: String, host: String)
    private let pin: GuestPinnedApplication
    private let requireCurrent: @MainActor () throws -> Void
    private let found: @MainActor (GuestBrowserProfiles.Prepared) -> Void
    private let end = ContinuousClock.now.advanced(by: .seconds(60))
    private var lease = ContinuousClock.now
    private var expiry: Int64 = 0
    private var lastWall = Int64(Date().timeIntervalSince1970 * 1000)
    private var ended = false, renewing = false
    private var selected: String?
    private var requests = Set<String>()
    private var monitor: Task<Void, Never>?
    init(pin: GuestPinnedApplication, current: @escaping @MainActor () throws -> Void,
         found: @escaping @MainActor (GuestBrowserProfiles.Prepared) -> Void) throws {
        try GuestEnvironment.signedApplication()
        boot = try GuestEnvironment.identity()
        guard pin.bundleId == "com.apple.Safari" else { throw GuestLinkError.invalid }
        self.pin = pin; requireCurrent = current; self.found = found
        connection.remoteObjectInterface = NSXPCInterface(with: GuestBrowserOwner.self)
        connection.exportedInterface = NSXPCInterface(with: GuestBrowserOwnerCallback.self)
        connection.setCodeSigningRequirement(GuestBrowserBoundary.requirement(GuestBrowserBoundary.brokerIdentifier))
        connection.exportedObject = BrowserSessionCallback { [weak self] request, peer in
            guard let self else { throw GuestLinkError.closed }
            return try self.handle(request, peer: peer)
        }
        connection.interruptionHandler = { [weak self] in Task { @MainActor in self?.stop() } }
        connection.invalidationHandler = { [weak self] in Task { @MainActor in self?.stop() } }
        connection.resume()
    }
    var available: Bool { !ended && ContinuousClock.now < end }
    private func current() throws {
        try requireCurrent()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard available, now >= lastWall, now < expiry, ContinuousClock.now < lease else { throw GuestLinkError.expired }
        lastWall = now
    }
    func renew(until: Int) async throws {
        try requireCurrent()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard available, !renewing, now >= lastWall, until > now, Int64(until) - now <= 10_000 else { throw GuestLinkError.expired }
        if monitor != nil { try current() }
        renewing = true
        defer { renewing = false }
        let body = try JSONSerialization.data(withJSONObject: [
            "mode": "safari-profile-discovery", "workspaceId": pin.workspaceId.uuidString.lowercased(),
            "profileId": NSNull(), "family": "safari", "guestBootId": boot.guest, "hostBootId": boot.host,
            "connectionId": scope, "generation": 0, "leaseUntilMs": until,
        ])
        let accepted = await withCheckedContinuation { continuation in
            let reply = BrowserSessionRenewal { continuation.resume(returning: $0) }
            let timeout = DispatchWorkItem { reply.finish(false) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: timeout)
            guard let remote = connection.remoteObjectProxyWithErrorHandler({ _ in timeout.cancel(); reply.finish(false) }) as? GuestBrowserOwner
            else { timeout.cancel(); reply.finish(false); return }
            remote.renew(body) { value in timeout.cancel(); reply.finish(value) }
        }
        guard accepted, available else { stop(); throw GuestLinkError.unavailable }
        expiry = Int64(until)
        lease = .now.advanced(by: .milliseconds(max(0, expiry - Int64(Date().timeIntervalSince1970 * 1000))))
        try current()
        if monitor == nil {
            monitor = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(200)); guard let self else { return }; try self.current() }
                    catch { self?.stop(); return }
                }
            }
        }
    }
    private func handle(_ data: Data, peer: Data) throws -> Data {
        try current()
        let request = try GuestBrowserBoundary.request(data)
        guard request["operation"] as? String == "browser.hello", request["sessionId"] is NSNull,
              let id = request["requestId"] as? String, !requests.contains(id), requests.count < 64,
              let payload = request["payload"] as? [String: Any], Set(payload.keys) == ["family", "extensionId"],
              payload["family"] as? String == "safari",
              payload["extensionId"] as? String == "com.heyjosi.ce.guestcompanion.workspace-safari"
        else { throw GuestLinkError.invalid }
        requests.insert(id)
        let verified = try GuestBrowserSession.safariPeer(peer, pin: pin, profile: selected, guest: boot.guest, host: boot.host)
        guard let value = try JSONSerialization.jsonObject(with: verified) as? [String: Any],
              let profile = value["profileId"] as? String else { throw GuestLinkError.invalid }
        let prepared = try GuestBrowserProfiles.prepareSafari(pin, profile: profile)
        try current()
        if selected == nil { selected = profile; found(prepared) }
        return try JSONSerialization.data(withJSONObject: [
            "version": 1, "requestId": id, "ok": true, "payload": ["profileDiscovered": true],
        ])
    }
    func stop() {
        guard !ended else { return }
        ended = true; monitor?.cancel(); monitor = nil
        (connection.remoteObjectProxy as? GuestBrowserOwner)?.stop()
        connection.invalidate()
    }
}

private final class BrowserSessionCallback: NSObject, GuestBrowserOwnerCallback, @unchecked Sendable {
    let handler: @MainActor @Sendable (Data, Data) async throws -> Data
    init(_ handler: @escaping @MainActor @Sendable (Data, Data) async throws -> Data) { self.handler = handler }
    func handle(_ request: Data, peer: Data, reply: @escaping (Data?, NSError?) -> Void) {
        let completion = BrowserSessionResponse(reply)
        Task { @MainActor in
            do { completion.finish(try await handler(request, peer)) }
            catch { completion.finish(nil) }
        }
    }
}
@MainActor private final class BrowserInspectionFlight {
    let original: GuestDesktopCommand, wire: [String: Any]
    let authorize: @MainActor (String) async throws -> Void
    let completion: CheckedContinuation<Data, Error>
    var delivered = false, authorizing = false, authorized = false
    var actual: (Int, Int)?
    var timeout: Task<Void, Never>?
    init(original: GuestDesktopCommand, wire: [String: Any], authorize: @escaping @MainActor (String) async throws -> Void,
         completion: CheckedContinuation<Data, Error>) {
        self.original = original; self.wire = wire; self.authorize = authorize; self.completion = completion
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
