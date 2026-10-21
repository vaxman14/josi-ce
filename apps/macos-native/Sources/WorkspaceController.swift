import AppKit
import SwiftUI
import Darwin

/// Owns a short-lived connection to the current desktop. All effects require
/// a current local consent generation and an exact server permission reservation.
@MainActor final class NativeWorkspaceController: ObservableObject {
    @Published private(set) var state = "closed"
    @Published private(set) var progress = ""
    @Published private(set) var label = ""
    @Published private(set) var guest: NativeGuestConnection?
    @Published private(set) var localConsent: Wire = .null
    private var consentGeneration = 0
    private var consentDeadline: ContinuousClock.Instant = .now
    private var consentLeaseUntil = 0
    private weak var model: JosiModel?
    private var api: JosiAPI?
    private var user: Wire = .null
    private var session: Wire = .null
    private var workspace: Wire = .null
    private var leaseDeadline: ContinuousClock.Instant = .now
    private var previousWall = 0
    private var busy = false
    private var lost = false
    private var heartbeat: Task<Void, Never>?
    private var commandLoop: Task<Void, Never>?
    private var serverControlActive = false
    private var watchdog: Task<Void, Never>?
    private var sleepObserver: NSObjectProtocol?
    var requiresClosure: Bool { state != "closed" }

    func connect(model: JosiModel, projection: Wire) async throws {
        guard !busy, !requiresClosure, let api = model.api,
              projection["mode"].text == "current_desktop" else { throw approvalUnavailable() }
        let entry = projection["workspace"]
        let id = try api.uuid(entry["workspaceId"].text)
        self.model = model; self.api = api; user = model.user["id"]; workspace = entry
        label = entry["label"].text; lost = false; session = projection["openSession"]
        do {
            guard ProtectedWire.exact(session, ["sessionId", "expiresAtMs", "leaseUntilMs"]),
                  ProtectedWire.uuid(session["sessionId"]) else { throw approvalUnavailable() }
            try adoptLease(session)
            guest = try NativeGuestConnection(context: [
                "serverOrigin": api.origin.absoluteString, "serverId": entry["identity"]["serverId"].text,
                "userId": user.text, "deviceId": entry["identity"]["deviceId"].text, "workspaceId": id,
            ], current: { [weak self] in
                guard let self else { throw GuestLinkError.closed }
                try self.current(); return self.session["leaseUntilMs"].integer
            }, resolveApplication: { [weak self] candidate in
                guard let self else { throw GuestLinkError.closed }
                return try await self.applicationProjection(candidate)
            }, resolveBrowser: { [weak self] candidate in
                guard let self else { throw GuestLinkError.closed }
                return try await self.browserProjection(candidate)
            }, consentProjection: { [weak self] in
                guard let self else { throw GuestLinkError.closed }
                return try self.automationConsentProjection()
            }, stopped: { [weak self] in
                guard let self else { return }
                self.stopAutomationLocally()
                self.progress = "Control stopped. Approve again when you are ready."
                Task { try? await self.stopAutomation() }
            })
            state = "running"
            progress = "Connected to your current desktop. Select an app or attach a browser tab."
            startMonitoring()
        } catch { try? await close(); throw error }
    }
    private func applicationProjection(_ candidate: Wire) async throws -> Wire {
        try current()
        guard let model, let api else { throw GuestLinkError.closed }
        let identity: Wire = ["serverId": workspace["identity"]["serverId"], "userId": user,
                              "deviceId": workspace["identity"]["deviceId"], "workspaceId": workspace["workspaceId"]]
        let matches = NativeGuestConnection.matchingApplications(candidate, identity: identity,
            registry: model.automationSettings["targets"])
        // Multiple old registrations are ambiguous; never silently move grants.
        guard matches.count == 1 else { return .null }
        let selected = matches[0], id = try api.uuid(session["sessionId"].text)
        let applicationId = try api.uuid(selected["applicationId"].text)
        guard ProtectedWire.integer(selected["installationRevision"], positive: true) else { throw GuestLinkError.invalid }
        let value = try await api.request("/admin/automation/desktop/sessions/\(id)/application", method: "POST",
            body: ["applicationId": .string(applicationId), "installationRevision": selected["installationRevision"]])
        try current()
        let pin = value["application"]
        guard ProtectedWire.exact(value, ["schemaVersion", "sessionId", "identity", "reference", "application", "expiresAtMs", "executionEnabled"]),
              value["schemaVersion"] == .number(1), value["sessionId"] == session["sessionId"], value["identity"] == identity,
              value["executionEnabled"] == .bool(false), ProtectedWire.reference(value["reference"]),
              value["reference"]["recordId"].text == "32eae367-3509-4241-9829-81c28b7b4088",
              ProtectedWire.integer(value["expiresAtMs"]), value["expiresAtMs"].integer <= session["leaseUntilMs"].integer,
              value["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000),
              ProtectedWire.exact(pin, ["workspaceId", "applicationId", "installationRevision", "bundlePath", "bundleId", "signingId", "teamId", "codeHash"]),
              pin["workspaceId"] == workspace["workspaceId"], pin["applicationId"] == selected["applicationId"],
              pin["installationRevision"] == selected["installationRevision"],
              ["bundlePath", "bundleId", "signingId", "teamId", "codeHash"].allSatisfy({ pin[$0] == candidate[$0] })
        else { throw GuestLinkError.invalid }
        return value
    }
    private func browserProjection(_ candidate: Wire) async throws -> Wire {
        try current()
        guard let model, let api else { throw GuestLinkError.closed }
        let identity: Wire = ["serverId": workspace["identity"]["serverId"], "userId": user,
                              "deviceId": workspace["identity"]["deviceId"], "workspaceId": workspace["workspaceId"]]
        let registry = model.automationSettings["targets"]
        guard !registry["reconciliationRequired"].flag else { throw GuestLinkError.unavailable }
        let matches = registry["browsers"].list.filter { NativeBrowserTargetWire.matches(candidate, $0, identity: identity) }
        guard matches.count == 1 else { return .null }
        let selected = matches[0], id = try api.uuid(session["sessionId"].text)
        let value = try await api.request("/admin/automation/desktop/sessions/\(id)/browser", method: "POST",
            body: ["profileId": selected["profileId"], "family": candidate["family"]])
        try current()
        guard ProtectedWire.exact(value, ["schemaVersion", "sessionId", "identity", "reference", "browser", "expiresAtMs", "executionEnabled"]),
              value["schemaVersion"] == .number(1), value["sessionId"] == session["sessionId"], value["identity"] == identity,
              value["executionEnabled"] == .bool(false), ProtectedWire.reference(value["reference"]),
              value["reference"]["recordId"].text == "32eae367-3509-4241-9829-81c28b7b4088",
              ProtectedWire.integer(value["expiresAtMs"]), value["expiresAtMs"].integer <= session["leaseUntilMs"].integer,
              value["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000),
              value["browser"] == selected else { throw GuestLinkError.invalid }
        return value
    }
    private func adoptLease(_ value: Wire) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard value["sessionId"] == session["sessionId"], ProtectedWire.integer(value["leaseUntilMs"]),
              ProtectedWire.integer(value["expiresAtMs"]), value["expiresAtMs"] == session["expiresAtMs"],
              value["leaseUntilMs"].integer > now, value["leaseUntilMs"].integer <= value["expiresAtMs"].integer,
              value["leaseUntilMs"].integer - now <= 10_000 else { throw approvalUnavailable() }
        session = ["sessionId": value["sessionId"], "expiresAtMs": value["expiresAtMs"], "leaseUntilMs": value["leaseUntilMs"]]
        leaseDeadline = .now.advanced(by: .milliseconds(value["leaseUntilMs"].integer - now)); previousWall = now
    }
    private func current() throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard !lost, let model, let api, model.api === api, model.user["id"] == user, model.isAdministrator,
              now >= previousWall, now < session["leaseUntilMs"].integer, ContinuousClock.now < leaseDeadline else {
            throw JosiError(message: "The Vault or desktop connection ended. Reconnect this Mac to continue.")
        }
        previousWall = now
    }
    private func startMonitoring() {
        heartbeat = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled && !lost {
                do {
                    try await Task.sleep(for: .seconds(2)); try current()
                    guard let api else { throw approvalUnavailable() }
                    let id = try api.uuid(session["sessionId"].text)
                    let presence: Wire = ["machineState": .string(["running", "paused", "stopped"].contains(state) ? state : "starting"),
                                          "companionConnected": .bool(guest?.paired == true)]
                    let priorConsent = localConsent, generation = consentGeneration
                    var body: Wire = ["presence": presence]
                    if localConsent != .null, let selection = try? guest?.controlSelection(), selection != .null,
                       case .object(var fields) = body {
                        var control: [String: Wire] = ["generation": .number(Double(consentGeneration)),
                            "guestBootId": localConsent["guestBootId"], "guestChannelId": localConsent["guestChannelId"],
                            "applicationId": selection["applicationId"], "installationRevision": selection["installationRevision"]]
                        if selection["browser"] != .null { control["browser"] = selection["browser"] }
                        fields["control"] = .object(control)
                        body = .object(fields)
                    }
                    let next = try await api.request("/admin/automation/desktop/sessions/\(id)/renew", method: "POST",
                                                     body: body)
                    try current()
                    guard next["workspaceId"] == workspace["workspaceId"], next["executionEnabled"] == .bool(false) else { throw approvalUnavailable() }
                    try adoptLease(next)
                    if priorConsent != .null, generation == consentGeneration, priorConsent == localConsent {
                        let c = next["consent"]
                        if c["reference"] == localConsent["reference"], c["permissions"] == localConsent["permissions"],
                           c["cardinal"] == localConsent["cardinal"], c["expiresAtMs"] == localConsent["expiresAtMs"],
                           c["guestBootId"] == localConsent["guestBootId"], c["guestChannelId"] == localConsent["guestChannelId"],
                           (try? guest?.consentBinding()) == .object(["guestBootId": c["guestBootId"], "guestChannelId": c["guestChannelId"]]),
                           state == "running" {
                            consentDeadline = leaseDeadline
                            consentLeaseUntil = session["leaseUntilMs"].integer
                            if serverControlActive && !next["nativeControl"].flag { stopAutomationLocally() }
                            else { serverControlActive = next["nativeControl"].flag }
                        } else { stopAutomationLocally() }
                    }
                    try await guest?.refresh()
                } catch { if !Task.isCancelled { await connectionLost() }; return }
            }
        }
        watchdog = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(1)); try current()
                    if localConsent != .null && (ContinuousClock.now >= consentDeadline || guest?.paired != true
                        || state != "running" || Int(Date().timeIntervalSince1970 * 1000) >= localConsent["expiresAtMs"].integer) {
                        stopAutomationLocally()
                        if let api, ProtectedWire.uuid(session["sessionId"]) {
                            let id = session["sessionId"].text
                            Task { _ = try? await api.request("/admin/automation/desktop/sessions/\(id)/consent/stop", method: "POST", body: [:]) }
                        }
                    }
                }
                catch { if !Task.isCancelled { await connectionLost() }; return }
            }
        }
        sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.connectionLost() }
        }
        commandLoop = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled && !lost {
                do {
                    try await Task.sleep(for: .seconds(1))
                    guard serverControlActive, localConsent != .null, let api, let guest else { continue }
                    try current()
                    let id = try api.uuid(session["sessionId"].text), generation = consentGeneration
                    let base = "/admin/automation/desktop/sessions/\(id)/commands"
                    let response = try await api.request(base + "/next", method: "POST", body: [:])
                    try current()
                    guard generation == consentGeneration, localConsent != .null, self.guest === guest else { throw GuestLinkError.closed }
                    let packet = response["command"]
                    if packet == .null { continue }
                    let result = try await guest.execute(packet, authorize: { query in
                        try self.current()
                        guard self.api === api, generation == self.consentGeneration,
                              self.localConsent != .null, self.guest === guest else { throw GuestLinkError.closed }
                        let permit = try await api.request(base + "/permit", method: "POST", body: query)
                        try self.current()
                        guard generation == self.consentGeneration, self.localConsent != .null else { throw GuestLinkError.closed }
                        return permit
                    })
                    try current()
                    guard generation == consentGeneration, localConsent != .null else { throw GuestLinkError.closed }
                    let recorded = try await api.request(base + "/result", method: "POST", body: result)
                    guard recorded["recorded"].flag else { throw GuestLinkError.invalid }
                } catch {
                    if !Task.isCancelled && !lost {
                        try? await stopAutomation()
                        model?.error = "Automation stopped because command delivery could not be confirmed. Check the original task before trying again."
                    }
                }
            }
        }
    }
    private func connectionLost() async {
        stopAutomationLocally(); lost = true
        progress = "Disconnected because this desktop’s authority expired."
        try? await close()
    }
    func close() async throws {
        stopAutomationLocally(); lost = true
        heartbeat?.cancel(); heartbeat = nil; watchdog?.cancel(); watchdog = nil
        commandLoop?.cancel(); commandLoop = nil
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver); self.sleepObserver = nil }
        guest?.close(); guest = nil
        if let api, ProtectedWire.uuid(session["sessionId"]) {
            let id = session["sessionId"].text
            Task { _ = try? await api.request("/admin/automation/desktop/sessions/\(id)/close", method: "POST", body: [:]) }
        }
        api = nil; model = nil; session = .null; workspace = .null
        state = "closed"; progress = "Disconnected. Your apps remain open."
    }
    func show() throws { try current(); try guest?.showApplication() }
    func pause() async throws { try await stopAutomation() }
    func resume() async throws { try await approveAutomation() }

    private func stopAutomationLocally() {
        consentGeneration += 1; localConsent = .null; consentDeadline = .now
        serverControlActive = false
        consentLeaseUntil = 0; guest?.revokeAutomation()
        // The dispatch bridge must consult this volatile generation and lease
        // immediately before input. A saved Vault receipt cannot restart it.
    }
    func stopAutomation() async throws {
        stopAutomationLocally()
        try current()
        guard let api else { throw approvalUnavailable() }
        let id = try api.uuid(session["sessionId"].text)
        _ = try await api.request("/admin/automation/desktop/sessions/\(id)/consent/stop", method: "POST", body: [:])
    }
    func approveAutomation() async throws {
        try current()
        guard state == "running", localConsent == .null, let model, let guest, guest.supportsExecution else { throw approvalUnavailable() }
        _ = try guest.controlSelection()
        let binding = try guest.consentBinding(), generation = consentGeneration
        let result = try await NativeAutomationConsent.approve(model: model, workspace: workspace, session: session, guest: binding,
            current: {
                try self.current()
                guard self.state == "running", self.guest === guest, self.consentGeneration == generation,
                      try guest.consentBinding() == binding else { throw approvalUnavailable() }
            })
        do {
            try current()
            let now = Int(Date().timeIntervalSince1970 * 1000)
            guard consentGeneration == generation, state == "running", try guest.consentBinding() == binding,
                  ProtectedWire.integer(result["leaseUntilMs"]), result["leaseUntilMs"].integer > now,
                  result["leaseUntilMs"].integer - now <= 10_000,
                  result["leaseUntilMs"].integer <= session["expiresAtMs"].integer else { throw approvalUnavailable() }
            localConsent = result
            consentLeaseUntil = min(session["leaseUntilMs"].integer, result["leaseUntilMs"].integer)
            consentDeadline = min(leaseDeadline, .now.advanced(by: .milliseconds(result["leaseUntilMs"].integer - now)))
            try await guest.refresh()
        } catch {
            stopAutomationLocally()
            if let api, ProtectedWire.uuid(session["sessionId"]) {
                let id = session["sessionId"].text
                _ = try? await api.request("/admin/automation/desktop/sessions/\(id)/consent/stop", method: "POST", body: [:])
            }
            throw error
        }
    }
    private func automationConsentProjection() throws -> Wire {
        try current()
        guard localConsent != .null else { return .null }
        let now = Int(Date().timeIntervalSince1970 * 1000), binding = try guest?.consentBinding()
        guard ContinuousClock.now < consentDeadline, consentLeaseUntil > now, state == "running",
              binding == .object(["guestBootId": localConsent["guestBootId"], "guestChannelId": localConsent["guestChannelId"]])
        else { stopAutomationLocally(); return .null }
        return ["schemaVersion": .number(1), "identity": localConsent["identity"],
                "guestBootId": localConsent["guestBootId"], "guestChannelId": localConsent["guestChannelId"],
                "generation": .number(Double(consentGeneration)), "expiresAtMs": localConsent["expiresAtMs"],
                "leaseUntilMs": .number(Double(consentLeaseUntil)),
                "authority": ["consent": localConsent["reference"], "permissions": localConsent["permissions"], "cardinal": localConsent["cardinal"]]]
    }
}
