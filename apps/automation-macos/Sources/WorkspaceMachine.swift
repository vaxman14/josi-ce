import AppKit
import Darwin
import Virtualization

enum WorkspaceMachineError: Error { case unavailable, invalidWorkspace, busy, needsRepair }

/// Issued by the verified Vault/encrypted-volume owner. Paths are fixed by
/// that owner, never accepted from model input or a server-rendered web page.
struct MountedAutomationWorkspace {
    let workspaceId: UUID
    let mountRoot: URL
    let volumeDevice: dev_t
    let hardwareModel: Data
    let machineIdentifier: Data
    let cpuCount: Int
    let memoryBytes: UInt64
}

@MainActor
protocol WorkspaceMachineAuthority: AnyObject {
    /// Requires current local owner consent, peer identity and Vault authority.
    /// Return only after a Vault-backed encrypted image is actually mounted.
    func openWorkspace(_ id: UUID) async throws -> MountedAutomationWorkspace
    /// Confirm that the same mounted volume and current authority still exist.
    func requireCurrent(_ workspace: MountedAutomationWorkspace) async throws
    /// Revoke control before pause/stop/takeover or a machine failure.
    func invalidateInput(workspaceId: UUID, reason: String)
    /// Close guest/native channels and drain input before storage detachment.
    func closeChannels(workspaceId: UUID) async throws
    /// Must verify actual unmount. A busy handle is an error, not success.
    func closeWorkspace(_ workspace: MountedAutomationWorkspace) async throws
}

/// Real VM lifecycle for an existing provisioned encrypted workspace. Creation,
/// restore download, Vault mounting and enrolled channel assembly are separate.
/// This component deliberately supplies no NAT or shared host directory.
@MainActor
final class WorkspaceMachine: NSObject, @preconcurrency VZVirtualMachineDelegate {
    enum State: String { case closed, opening, running, paused, closing, needsRepair }
    private(set) var state: State = .closed
    private(set) var workspaceId: UUID?
    private let authority: WorkspaceMachineAuthority
    private var mounted: MountedAutomationWorkspace?
    private var machine: VZVirtualMachine?
    private var transitioning = false
    private var viewer: NSWindow?
    private var closingDeliberately = false
    var stateChanged: ((State) -> Void)?

    init(authority: WorkspaceMachineAuthority) { self.authority = authority }

    private func change(_ state: State) { self.state = state; stateChanged?(state) }
    private func privateFile(_ relative: String, root: MountedAutomationWorkspace) throws -> URL {
        guard !relative.contains("/"), !relative.hasPrefix("."), relative.utf8.count < 100 else { throw WorkspaceMachineError.invalidWorkspace }
        let path = root.mountRoot.appendingPathComponent(relative)
        var rootInfo = stat(), info = stat()
        guard lstat(root.mountRoot.path, &rootInfo) == 0,
              rootInfo.st_mode & S_IFMT == S_IFDIR, rootInfo.st_dev == root.volumeDevice,
              rootInfo.st_uid == geteuid(), rootInfo.st_mode & 0o077 == 0,
              lstat(path.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_dev == root.volumeDevice, info.st_uid == geteuid(),
              info.st_mode & 0o077 == 0, info.st_nlink == 1 else { throw WorkspaceMachineError.invalidWorkspace }
        return path
    }
    private func configuration(_ workspace: MountedAutomationWorkspace) throws -> VZVirtualMachineConfiguration {
        guard VZVirtualMachine.isSupported, workspace.mountRoot.isFileURL,
              workspace.hardwareModel.count <= 64 * 1024, workspace.machineIdentifier.count <= 64 * 1024,
              let model = VZMacHardwareModel(dataRepresentation: workspace.hardwareModel), model.isSupported,
              let identifier = VZMacMachineIdentifier(dataRepresentation: workspace.machineIdentifier),
              workspace.cpuCount >= VZVirtualMachineConfiguration.minimumAllowedCPUCount,
              workspace.cpuCount <= min(8, VZVirtualMachineConfiguration.maximumAllowedCPUCount),
              workspace.memoryBytes >= VZVirtualMachineConfiguration.minimumAllowedMemorySize,
              workspace.memoryBytes <= min(16 * 1024 * 1024 * 1024, VZVirtualMachineConfiguration.maximumAllowedMemorySize) else {
            throw WorkspaceMachineError.invalidWorkspace
        }
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = model; platform.machineIdentifier = identifier
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: try privateFile("AuxiliaryStorage", root: workspace))
        let config = VZVirtualMachineConfiguration()
        config.platform = platform; config.bootLoader = VZMacOSBootLoader()
        config.cpuCount = workspace.cpuCount; config.memorySize = workspace.memoryBytes
        let disk = try VZDiskImageStorageDeviceAttachment(url: privateFile("Disk.img", root: workspace), readOnly: false)
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1440, heightInPixels: 900, pixelsPerInch: 110)]
        config.graphicsDevices = [graphics]
        config.keyboards = [VZUSBKeyboardConfiguration()]
        config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        config.directorySharingDevices = []
        config.networkDevices = []
        config.audioDevices = []
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        try config.validate()
        return config
    }

    func open(_ id: UUID) async throws {
        guard !transitioning, state == .closed else { throw WorkspaceMachineError.busy }
        transitioning = true; workspaceId = id; change(.opening)
        defer { transitioning = false }
        do {
            let volume = try await authority.openWorkspace(id)
            // Retain even a mismatched mount so cleanup cannot lose its handle.
            mounted = volume
            guard volume.workspaceId == id else { throw WorkspaceMachineError.invalidWorkspace }
            try await authority.requireCurrent(volume)
            // This initializer documents main-queue callbacks, matching our
            // MainActor isolation and the delegate's preconcurrency conformance.
            let vm = VZVirtualMachine(configuration: try configuration(volume))
            vm.delegate = self; machine = vm
            try await authority.requireCurrent(volume)
            try await vm.start()
            try await authority.requireCurrent(volume)
            change(.running)
        } catch {
            authority.invalidateInput(workspaceId: id, reason: "workspace_open_failed")
            // Never discard a mounted image or VM handle on failure. close()
            // performs ordered cleanup; a failed cleanup remains repairable.
            change(.needsRepair)
            throw error
        }
    }

    func pause() async throws {
        guard !transitioning, state == .running, let vm = machine, let id = workspaceId else { throw WorkspaceMachineError.busy }
        transitioning = true; defer { transitioning = false }
        authority.invalidateInput(workspaceId: id, reason: "desktop_paused")
        do { try await vm.pause(); change(.paused) }
        catch { change(.needsRepair); throw error }
    }

    func resume() async throws {
        guard !transitioning, state == .paused, let vm = machine, let volume = mounted else { throw WorkspaceMachineError.busy }
        transitioning = true; defer { transitioning = false }
        try await authority.requireCurrent(volume)
        // Resume only the machine. Automation needs its own new lease and
        // observation; an old command cannot resume with the VM.
        do {
            try await vm.resume()
            try await authority.requireCurrent(volume)
            change(.running)
        }
        catch {
            authority.invalidateInput(workspaceId: volume.workspaceId, reason: "authority_changed")
            try? await vm.pause()
            change(.needsRepair); throw error
        }
    }

    /// Called by the native authority owner on Vault lock/revocation/channel
    /// loss. Hide immediately; ordered shutdown may need repair if unmount
    /// encounters a busy handle.
    func authorityLost() async throws {
        if let id = workspaceId { authority.invalidateInput(workspaceId: id, reason: "authority_lost") }
        viewer?.orderOut(nil)
        try await close()
    }

    func close() async throws {
        guard !transitioning else { throw WorkspaceMachineError.busy }
        guard let id = workspaceId else { return }
        transitioning = true; closingDeliberately = true; change(.closing)
        defer { transitioning = false; closingDeliberately = false }
        authority.invalidateInput(workspaceId: id, reason: "desktop_stopped")
        do {
            try await authority.closeChannels(workspaceId: id)
            if let vm = machine, vm.state != .stopped && vm.state != .error { try await vm.stop() }
            // The viewer owns a reference to the VM; detach it before trying
            // to unmount. No suspension snapshots containing runtime keys.
            (viewer?.contentView as? VZVirtualMachineView)?.virtualMachine = nil
            viewer?.orderOut(nil); viewer = nil; machine = nil
            if let volume = mounted { try await authority.closeWorkspace(volume) }
            mounted = nil; workspaceId = nil; change(.closed)
        } catch { change(.needsRepair); throw WorkspaceMachineError.needsRepair }
    }

    /// The channel assembler uses the actual VZ socket device. No TCP listener
    /// or browser-side workspace assertion substitutes for its authentication.
    func socketDevice() throws -> VZVirtioSocketDevice {
        guard state == .running, let device = machine?.socketDevices.first as? VZVirtioSocketDevice else { throw WorkspaceMachineError.unavailable }
        return device
    }

    func show() throws {
        guard let vm = machine, let id = workspaceId, state == .running || state == .paused else { throw WorkspaceMachineError.unavailable }
        if let viewer { viewer.makeKeyAndOrderFront(nil); return }
        let view = WorkspaceMachineView(frame: NSRect(x: 0, y: 0, width: 1080, height: 675))
        view.virtualMachine = vm; view.capturesSystemKeys = false; view.automaticallyReconfiguresDisplay = false
        view.takeover = { [weak self] in self?.authority.invalidateInput(workspaceId: id, reason: "owner_takeover") }
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Josi — Automation desktop"; window.contentView = view; window.isReleasedWhenClosed = false
        // Closing hides the viewer. It does not cancel the durable task.
        window.center(); window.makeKeyAndOrderFront(nil); window.makeFirstResponder(view); viewer = window
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        guard virtualMachine === machine, let id = workspaceId else { return }
        authority.invalidateInput(workspaceId: id, reason: "desktop_failed")
        if !closingDeliberately { change(.needsRepair) }
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        guard virtualMachine === machine, let id = workspaceId else { return }
        authority.invalidateInput(workspaceId: id, reason: "guest_stopped")
        if !closingDeliberately { change(.needsRepair) }
    }
}

/// Host viewer input invalidates the lease synchronously BEFORE forwarding
/// events to the guest. Guest event markers are not the takeover authority.
@MainActor
private final class WorkspaceMachineView: VZVirtualMachineView {
    var takeover: (() -> Void)?
    override func mouseDown(with event: NSEvent) { takeover?(); super.mouseDown(with: event) }
    override func rightMouseDown(with event: NSEvent) { takeover?(); super.rightMouseDown(with: event) }
    override func otherMouseDown(with event: NSEvent) { takeover?(); super.otherMouseDown(with: event) }
    override func mouseDragged(with event: NSEvent) { takeover?(); super.mouseDragged(with: event) }
    override func scrollWheel(with event: NSEvent) { takeover?(); super.scrollWheel(with: event) }
    override func keyDown(with event: NSEvent) { takeover?(); super.keyDown(with: event) }
    override func flagsChanged(with event: NSEvent) { takeover?(); super.flagsChanged(with: event) }
}
