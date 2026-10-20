import AppKit
import SwiftUI
import Virtualization
import Darwin

/// Owns a local development desktop, not an automation grant. There is no
/// guest executor yet; browser/computer tools remain unavailable.
@MainActor final class NativeWorkspaceController: ObservableObject, WorkspaceMachineAuthority {
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
    private var projection: Wire = .null
    private var projectionLease: ApprovalLease?
    private var leaseDeadline: ContinuousClock.Instant = .now
    private var previousWall = 0
    private var machine: WorkspaceMachine?
    private var installingMachine: VZVirtualMachine?
    private var guardian: NativeWorkspaceGuardian?
    private var root: URL?
    private var volumeDevice: dev_t?
    private var restore: URL?
    private var attachmentAttempted = false
    private var busy = false
    private var lost = false
    private var heartbeat: Task<Void, Never>?
    private var commandLoop: Task<Void, Never>?
    private var serverControlActive = false
    private var watchdog: Task<Void, Never>?
    private var sleepObserver: NSObjectProtocol?
    var requiresClosure: Bool { state != "closed" || attachmentAttempted }

    func open(model: JosiModel, entry: Wire, restore: URL?) async throws {
        guard !busy, !requiresClosure, let api = model.api, VZVirtualMachine.isSupported else { throw WorkspaceMachineError.busy }
        let id = try api.uuid(entry["workspaceId"].text)
        busy = true; defer { busy = false }
        self.model = model; self.api = api; user = model.user["id"]; workspace = entry
        label = entry["label"].text; state = "authenticating"; lost = false; self.restore = restore
        do {
            let local = try await NativeWorkspaceImage.status(id)
            guard local["state"].text == "image_ready", local["imageCreated"].flag, !local["mounted"].flag,
                  local["capacityGiB"] == entry["capacityGiB"] else {
                throw JosiError(message: "Prepare or repair this workspace’s encrypted storage before opening the desktop.")
            }
            let authorized = try await NativeWorkspaceProvision.authorize(model: model, request: [
                "operation": "open", "deviceId": entry["identity"]["deviceId"], "workspaceId": entry["workspaceId"],
                "label": entry["label"], "capacityGiB": entry["capacityGiB"],
            ])
            projection = authorized.projection; projectionLease = authorized.lease
            session = projection["openSession"]
            guard ProtectedWire.exact(session, ["sessionId", "expiresAtMs", "leaseUntilMs"]), ProtectedWire.uuid(session["sessionId"]) else {
                throw approvalUnavailable()
            }
            try adoptLease(session)
            startMonitoring()
            let engine = WorkspaceMachine(authority: self)
            engine.stateChanged = { [weak self] state in self?.state = state.rawValue }
            machine = engine
            try await engine.open(UUID(uuidString: id)!)
            try current()
            guest = NativeGuestConnection(device: try engine.socketDevice(), context: [
                "serverOrigin": api.origin.absoluteString, "serverId": entry["identity"]["serverId"].text,
                "userId": user.text, "deviceId": entry["identity"]["deviceId"].text, "workspaceId": id,
            ], current: { [weak self] in
                guard let self else { throw GuestLinkError.closed }
                try self.current(); return self.session["leaseUntilMs"].integer
            }, resolveApplication: { [weak self] candidate in
                guard let self else { throw GuestLinkError.closed }
                return try await self.applicationProjection(candidate)
            }, consentProjection: { [weak self] in
                guard let self else { throw GuestLinkError.closed }
                return try self.automationConsentProjection()
            })
            try engine.show()
            progress = "Separate development desktop · Network and host sharing are disabled."
            self.restore = nil
        } catch {
            lost = true; projection = .null; projectionLease = nil
            // openWorkspace may have attached storage before producing a VM
            // handle. This owner retains that separate handle for cleanup.
            busy = false
            do { try await close() } catch {
                throw JosiError(message: "The desktop stopped but its storage still needs attention. Use Close Again; its files were retained.")
            }
            throw error
        }
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
        let value = try await api.request("/admin/automation/storage/sessions/\(id)/application", method: "POST",
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
              !attachmentAttempted || guardian?.running == true,
              now >= previousWall, now < session["leaseUntilMs"].integer, ContinuousClock.now < leaseDeadline else {
            throw JosiError(message: "The Vault or desktop connection ended. Reopen the workspace to continue.")
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
                        fields["control"] = ["generation": .number(Double(consentGeneration)),
                            "guestBootId": localConsent["guestBootId"], "guestChannelId": localConsent["guestChannelId"],
                            "applicationId": selection["applicationId"], "installationRevision": selection["installationRevision"]]
                        body = .object(fields)
                    }
                    let next = try await api.request("/admin/automation/storage/sessions/\(id)/renew", method: "POST",
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
                    try guardian?.renew()
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
                            Task { _ = try? await api.request("/admin/automation/storage/sessions/\(id)/consent/stop", method: "POST", body: [:]) }
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
                    let base = "/admin/automation/storage/sessions/\(id)/commands"
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
        stopAutomationLocally()
        lost = true; progress = "Closing the desktop because its Vault connection ended."
        // Cleanup cancels both monitors. Run it in its own task so cancelling
        // the calling heartbeat cannot cancel the required unmount operation.
        if !busy { Task { @MainActor [weak self] in try? await self?.close() } }
        // While mounting/installing/opening, the current-authority checks
        // cancel that operation, whose failure path performs ordered cleanup.
    }
    func openWorkspace(_ id: UUID) async throws -> MountedAutomationWorkspace {
        try current(); try projectionLease?.check()
        guard projectionLease != nil, workspace["workspaceId"].text == id.uuidString.lowercased(),
              ProtectedWire.matches(projection["imagePassword"], "^[A-Za-z0-9_-]{43}$") else { throw approvalUnavailable() }
        state = "opening"; progress = "Opening the encrypted workspace…"
        let guardProcess = NativeWorkspaceGuardian()
        try await guardProcess.start(id.uuidString.lowercased())
        guardian = guardProcess
        try current()
        attachmentAttempted = true
        let response = try await NativeWorkspaceImage.run(["schemaVersion": .number(1), "operation": "attach",
            "workspaceId": workspace["workspaceId"], "imagePassword": projection["imagePassword"]],
            admission: { try self.current(); try self.projectionLease?.check() })
        projection = .null; projectionLease = nil
        let storage = try NativeWorkspaceImage.result(response, id: id.uuidString.lowercased())
        guard storage["state"].text == "mounted", storage["mounted"].flag, storage["imageCreated"].flag,
              ProtectedWire.integer(storage["volumeDevice"], positive: true), storage["volumeDevice"].integer <= Int(Int32.max) else {
            throw WorkspaceMachineError.invalidWorkspace
        }
        guard let account = getpwuid(getuid()) else { throw WorkspaceMachineError.invalidWorkspace }
        let home = String(cString: account.pointee.pw_dir)
        let mount = URL(fileURLWithPath: home + "/Library/Application Support/Josi/Automation/" + id.uuidString.lowercased() + "/Mounted")
        let device = dev_t(storage["volumeDevice"].integer)
        root = mount; volumeDevice = device
        try current()
        return try await NativeWorkspaceInstaller.prepare(root: mount, id: id, device: device, capacity: workspace["capacityGiB"].integer,
            restore: restore, current: { try self.current() }, retainMachine: { self.installingMachine = $0 },
            progress: { self.progress = $0 })
    }
    func requireCurrent(_ workspace: MountedAutomationWorkspace) async throws {
        try current()
        guard workspace.workspaceId.uuidString.lowercased() == self.workspace["workspaceId"].text,
              workspace.mountRoot == root, workspace.volumeDevice == volumeDevice else { throw WorkspaceMachineError.invalidWorkspace }
        try NativeWorkspaceInstaller.mounted(workspace.mountRoot, device: workspace.volumeDevice)
    }
    func invalidateInput(workspaceId: UUID, reason: String) {
        stopAutomationLocally()
    }
    func closeChannels(workspaceId: UUID) async throws {
        guest?.close(); guest = nil
    }
    func closeWorkspace(_ workspace: MountedAutomationWorkspace) async throws {
        guard workspace.workspaceId.uuidString.lowercased() == self.workspace["workspaceId"].text else { throw WorkspaceMachineError.invalidWorkspace }
        try await detach()
    }
    private func detach() async throws {
        guard attachmentAttempted else { return }
        let id = workspace["workspaceId"].text
        let response = try await NativeWorkspaceImage.run(["schemaVersion": .number(1), "operation": "detach", "workspaceId": .string(id)])
        let storage = try NativeWorkspaceImage.result(response, id: id)
        guard !storage["mounted"].flag, storage["state"].text == "image_ready" else { throw WorkspaceMachineError.needsRepair }
        attachmentAttempted = false; root = nil; volumeDevice = nil
    }
    func close() async throws {
        stopAutomationLocally()
        guard !busy else { throw WorkspaceMachineError.busy }
        busy = true; lost = true; defer { busy = false }
        heartbeat?.cancel(); heartbeat = nil; watchdog?.cancel(); watchdog = nil
        commandLoop?.cancel(); commandLoop = nil
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver); self.sleepObserver = nil }
        projection = .null; projectionLease = nil
        if let api, ProtectedWire.uuid(session["sessionId"]) {
            let id = session["sessionId"].text
            Task { _ = try? await api.request("/admin/automation/storage/sessions/\(id)/close", method: "POST", body: [:]) }
        }
        do {
            guest?.close(); guest = nil
            if let vm = installingMachine, vm.state != .stopped && vm.state != .error { try await vm.stop() }
            installingMachine = nil
            if let machine { try await machine.authorityLost() }
            try await detach()
            guardian?.closed(); guardian = nil
            machine = nil; api = nil; model = nil; session = .null; workspace = .null; restore = nil
            state = "closed"; progress = "Desktop closed; encrypted storage is closed."
        } catch {
            state = "needs_repair"; progress = "The desktop or its encrypted storage needs attention. Use Close Again."
            throw WorkspaceMachineError.needsRepair
        }
    }
    func show() throws { try current(); try machine?.show() }
    func pause() async throws {
        stopAutomationLocally()
        if let api, ProtectedWire.uuid(session["sessionId"]) {
            let id = session["sessionId"].text
            Task { _ = try? await api.request("/admin/automation/storage/sessions/\(id)/consent/stop", method: "POST", body: [:]) }
        }
        try await machine?.pause()
    }
    func resume() async throws { try current(); try await machine?.resume() }

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
        _ = try await api.request("/admin/automation/storage/sessions/\(id)/consent/stop", method: "POST", body: [:])
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
        } catch {
            stopAutomationLocally()
            if let api, ProtectedWire.uuid(session["sessionId"]) {
                let id = session["sessionId"].text
                _ = try? await api.request("/admin/automation/storage/sessions/\(id)/consent/stop", method: "POST", body: [:])
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
