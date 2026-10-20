import AppKit
import SwiftUI
import Virtualization
import Darwin

/// Owns a local development desktop, not an automation grant. There is no
/// guest executor/channel yet; browser/computer tools remain unavailable.
@MainActor final class NativeWorkspaceController: ObservableObject, WorkspaceMachineAuthority {
    @Published private(set) var state = "closed"
    @Published private(set) var progress = ""
    @Published private(set) var label = ""
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
                    let next = try await api.request("/admin/automation/storage/sessions/\(id)/renew", method: "POST", body: [:])
                    try current()
                    guard next["workspaceId"] == workspace["workspaceId"], next["executionEnabled"] == .bool(false) else { throw approvalUnavailable() }
                    try adoptLease(next)
                    try guardian?.renew()
                } catch { if !Task.isCancelled { await connectionLost() }; return }
            }
        }
        watchdog = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)); try current() }
                catch { if !Task.isCancelled { await connectionLost() }; return }
            }
        }
        sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.connectionLost() }
        }
    }
    private func connectionLost() async {
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
        // No automation channel is assembled in this development desktop.
        // A later channel must be synchronously revoked here before dispatch.
    }
    func closeChannels(workspaceId: UUID) async throws {
        // No guest/automation channels are opened by this controller.
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
        guard !busy else { throw WorkspaceMachineError.busy }
        busy = true; lost = true; defer { busy = false }
        heartbeat?.cancel(); heartbeat = nil; watchdog?.cancel(); watchdog = nil
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver); self.sleepObserver = nil }
        projection = .null; projectionLease = nil
        if let api, ProtectedWire.uuid(session["sessionId"]) {
            let id = session["sessionId"].text
            Task { _ = try? await api.request("/admin/automation/storage/sessions/\(id)/close", method: "POST", body: [:]) }
        }
        do {
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
    func pause() async throws { try await machine?.pause() }
    func resume() async throws { try current(); try await machine?.resume() }
}
