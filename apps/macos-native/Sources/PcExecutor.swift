import AppKit
import Foundation

/// The Josi app as this Mac's PC Control executor. Every second while the owner
/// is signed in it makes this Mac known, reports that Josi is open here, shows
/// the owner what waits for their approval, and runs approved work one request
/// at a time under a live lease. Pause and Stop end the work at once; your own
/// mouse or keyboard interrupts work on the screen.
@MainActor final class PcExecutor: ObservableObject {
    static let shared = PcExecutor()
    @Published private(set) var busy = false
    @Published private(set) var activity = ""
    @Published private(set) var onScreen = false
    @Published private(set) var paused = false
    @Published private(set) var takenOver = false
    @Published private(set) var pendingStop = false
    @Published private(set) var needsApproval = false
    @Published private(set) var keyChanged = false
    @Published private(set) var requests: [Wire] = []
    @Published private(set) var terminals = 0
    @Published private(set) var lastWork: Date?
    /// Work in the linked browser, shown in the same control bar with the same Pause and Stop.
    @Published private(set) var browserActivity = ""
    @Published private(set) var browserDiscovery: PcBrowserBridge.Discovery?
    @Published private(set) var browserLinked: String?
    @Published private(set) var browserHelperNeedsApproval = false
    private var externalCount = 0
    private var current: PcCancel?
    private var approved = false
    private var nextIdentityCheck = Date.distantPast
    private var registeredFor: String?
    private var lastPresence: Wire?
    private var presenceAt = Date.distantPast
    private var checkedAt = Date.distantPast
    private var running = false
    private var monitor: Any?
    private var lastMouse: CGPoint?
    private let stateFile = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Josi/pc-control-pause.json")

    private init() {
        // Only a pause the person chose, a lock or a Stop survives a restart; a takeover never does.
        if let data = try? Data(contentsOf: stateFile), let saved = try? JSONDecoder().decode(Wire.self, from: data) {
            paused = saved["paused"].flag; pendingStop = saved["pendingStop"].flag
        }
        PcTerminals.shared.onChange = { Task { @MainActor in PcExecutor.shared.terminals = PcTerminals.shared.count } }
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { _ in Task { @MainActor in PcExecutor.shared.pause() } }
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in
            Task { @MainActor in PcExecutor.shared.pause() }
        }
    }
    private func save() {
        try? FileManager.default.createDirectory(at: stateFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(["paused": .bool(paused), "pendingStop": .bool(pendingStop)] as Wire).write(to: stateFile, options: .atomic)
    }

    // ------------------------------------------------------------ controls
    func setRequests(_ list: [Wire]) { requests = list }
    func beginExternal(_ what: String) { externalCount += 1; browserActivity = what; PcControlBar.shared.update() }
    func endExternal() { externalCount = max(0, externalCount - 1); if externalCount == 0 { browserActivity = ""; lastWork = Date() }; PcControlBar.shared.update() }
    private func syncBrowser() {
        let bridge = PcBrowserBridge.shared
        bridge.blocked = paused || takenOver
        if browserDiscovery != bridge.discovery { browserDiscovery = bridge.discovery }
        if browserLinked != bridge.linkedBrowser { browserLinked = bridge.linkedBrowser }
        if approved, browserHelperNeedsApproval != PcBrowserBridge.brokerNeedsApproval { browserHelperNeedsApproval = PcBrowserBridge.brokerNeedsApproval }
    }
    func pause() {
        defer { PcControlBar.shared.update(); syncBrowser() }
        paused = true; current?.cancel(); PcTerminals.shared.stopAll(); PcDesktop.shared.forget(); save(); lastPresence = nil
    }
    func resume() {
        guard !pendingStop else { return }
        paused = false; takenOver = false; save(); syncBrowser(); PcControlBar.shared.update()
    }
    func stop() { pendingStop = true; pause() }
    func takeOver() { guard onScreen, busy else { return }; takenOver = true; current?.cancel(); syncBrowser() }
    var showsControls: Bool {
        busy || !browserActivity.isEmpty || terminals > 0 || paused || takenOver || pendingStop || (lastWork.map { Date().timeIntervalSince($0) < 20 } ?? false)
    }

    // ------------------------------------------------------------ pairing
    private func key(_ api: JosiAPI, owner: String) throws -> PcExecutorKey {
        let key = try PcExecutorKey.open(PcExecutorKey.name(origin: api.origin.absoluteString, owner: owner))
        api.pcSigner = (owner, key)
        return key
    }
    /// The public key setup sends with the owner's password, so the Mac is paired at install.
    func publicPoint(_ api: JosiAPI, owner: String) throws -> (point: String, hardware: Bool) {
        let key = try key(api, owner: owner); return (key.publicPoint, key.hardware)
    }
    /// Pairs this Mac with the person's password, once. Grants no permissions by itself.
    func approve(_ api: JosiAPI, owner: String, password: String) async throws {
        let identity = try await api.request("/admin/pc-control/identity")
        let key = try key(api, owner: owner)
        if !identity["publicKey"].text.isEmpty, identity["publicKey"].text != key.publicPoint {
            throw JosiError(message: "This Mac's computer-control key changed. Remove its old identity under PC Control before approving it again.")
        }
        if identity["publicKey"].text.isEmpty {
            _ = try await api.request("/admin/pc-control/identity", method: "POST", body: ["publicKey": .string(key.publicPoint), "password": .string(password)])
        }
        approved = true; needsApproval = false; keyChanged = false
    }
    private func ensure(_ api: JosiAPI, owner: String) async throws -> Bool {
        if approved { return true }
        guard Date() >= nextIdentityCheck else { return false }
        nextIdentityCheck = Date().addingTimeInterval(5)
        let identity = try await api.request("/admin/pc-control/identity")
        let key = try key(api, owner: owner)
        if identity["publicKey"].text == key.publicPoint { approved = true; needsApproval = false; keyChanged = false; return true }
        keyChanged = !identity["publicKey"].text.isEmpty
        // Approval is asked for only once control is on, from a card in the chat.
        needsApproval = identity["enabled"].flag
        return false
    }
    func forgetSession() {
        approved = false; registeredFor = nil; lastPresence = nil; needsApproval = false; requests = []
        current?.cancel(); PcTerminals.shared.stopAll()
    }

    // ------------------------------------------------------------ the loop
    func start(_ model: JosiModel) {
        guard !running else { return }
        running = true
        Task { @MainActor in
            while true {
                try? await Task.sleep(for: .seconds(1))
                await tick(model)
                syncBrowser()
                PcControlBar.shared.update()
            }
        }
    }
    private func tick(_ model: JosiModel) async {
        guard let api = model.api, model.screen == .workspace, model.isAdministrator, !busy else { return }
        let owner = model.user["id"].text
        guard !owner.isEmpty else { return }
        do {
            if pendingStop {
                _ = try await api.request("/admin/pc-control/stop", method: "POST", body: [:])
                pendingStop = false; save()
            }
            let registration = api.origin.absoluteString + "|" + owner
            if registeredFor != registration {
                approved = false; nextIdentityCheck = .distantPast; lastPresence = nil
                _ = try? await api.request("/admin/pc-control/register", method: "PUT", body: [:])
                registeredFor = registration
            }
            guard try await ensure(api, owner: owner) else { return }
            // Paired: the browser broker may start, so Safari's extension can reach Josi.
            PcBrowserBridge.shared.start()
            // Paused here means paused for the server too: no presence, so a PC tool
            // answers at once that Josi is paused instead of leaving work waiting.
            if paused { return }
            // A linked browser, or Josi open on this Mac with no browser linked.
            let presence: Wire = PcBrowserBridge.shared.presence() ?? ["connected": .bool(true),
                                  "browser": ["family": "desktop", "application": .string(Bundle.main.bundlePath), "profile": "Default", "origin": .null, "title": .null]]
            if presence != lastPresence || Date().timeIntervalSince(presenceAt) >= 10 {
                _ = try await api.request("/admin/pc-control/executor/presence", method: "PUT", body: presence)
                lastPresence = presence; presenceAt = Date()
            }
            if Date().timeIntervalSince(checkedAt) >= 3 {
                checkedAt = Date()
                let waiting = (try await api.request("/admin/pc-control"))["requests"].list
                if Set(waiting.map(\.identifier)) != Set(requests.map(\.identifier)) {
                    if !NSApp.isActive, waiting.contains(where: { request in !requests.contains { $0.identifier == request.identifier } }) {
                        NSApp.requestUserAttention(.informationalRequest)
                    }
                    requests = waiting
                }
            }
            let next = (try await api.request("/admin/pc-control/executor/next", method: "POST", body: [:]))["request"]
            guard next != .null else { return }
            let outcome = await run(api, next, attached: { [weak model] in model?.api === api && model?.screen == .workspace })
            _ = try? await api.request("/admin/pc-control/executor/\(try api.uuid(next.identifier))/result", method: "POST",
                                       body: ["ok": .bool(outcome.ok), "result": outcome.result])
            if outcome.ok, next["payload"]["kind"].text == "desktop.terminal.open" {
                let id = next.identifier
                Task.detached {
                    await PcTerminals.shared.watch(id) {
                        await MainActor.run { PcExecutor.shared.paused } ? false
                            : ((try? await api.request("/admin/pc-control/executor/terminals/\(try api.uuid(id))/lease"))?["authorized"].flag ?? false)
                    }
                }
            }
        } catch {
            // A failed round leaves nothing running; the next tick tries again.
        }
    }

    /// Runs one approved request while the server keeps authorizing it, checked
    /// every 1.5 seconds. Losing the lease, or the connection, pauses and cancels.
    private func run(_ api: JosiAPI, _ request: Wire, attached: @escaping () -> Bool) async -> PcOutcome {
        let kind = request["payload"]["kind"].text
        let screen = Self.touchesScreen(kind)
        if paused || (screen && takenOver) { return pcRefuse(paused ? "paused" : "human_control") }
        let cancel = PcCancel()
        current = cancel; onScreen = screen; busy = true; activity = Self.describe(kind, request)
        takenOver = false
        if screen { engageTakeover() }
        PcControlBar.shared.update()
        defer { current = nil; busy = false; activity = ""; onScreen = false; takenOver = false; lastWork = Date(); if screen { disengageTakeover() } }
        let leaseRoute = "/admin/pc-control/executor/\((try? api.uuid(request.identifier)) ?? "")/lease"
        func authorized() async -> Bool { (try? await api.request(leaseRoute, timeout: 3))?["authorized"].flag ?? false }
        guard await authorized() else { return pcRefuse("execution_lease_lost") }
        let box = PcResultBox()
        let work = Task.detached { box.set(await pcDispatch(request, cancel: cancel)) }
        var lastCheck = Date()
        while box.value == nil {
            try? await Task.sleep(for: .milliseconds(200))
            if box.value != nil { break }
            if !attached() || paused { cancel.cancel(); _ = await work.value; if !attached() { pause() }; return pcRefuse(paused ? "paused" : "execution_lease_lost") }
            if Date().timeIntervalSince(lastCheck) >= 1.5 {
                lastCheck = Date()
                if !(await authorized()) { cancel.cancel(); pause(); _ = await work.value; return pcRefuse("execution_lease_lost") }
            }
        }
        let outcome = box.value!
        if !outcome.ok, takenOver, outcome.result["code"].text == "paused" { return pcRefuse("human_control") }
        return outcome
    }
    /// Work that moves the mouse, types or changes windows, and so yields to you.
    private static func touchesScreen(_ kind: String) -> Bool {
        ["desktop.scroll", "desktop.drag", "desktop.click", "desktop.clickpoint", "desktop.type", "desktop.keys", "desktop.close", "desktop.launch"].contains(kind)
    }
    private static func describe(_ kind: String, _ request: Wire) -> String {
        let payload = request["payload"], scope = request["requirements"].list.first?["scope"] ?? .null
        let program = scope["kind"].text == "application" ? ((scope["target"].text as NSString).lastPathComponent as NSString).deletingPathExtension : ""
        switch kind {
        case "desktop.windows": return "Looking at the open windows"
        case "desktop.read": return "Reading a window of \(program)"
        case "desktop.screenshot": return "Taking a picture of \(program)"
        case "desktop.click", "desktop.clickpoint": return "Clicking in \(program)"
        case "desktop.type": return "Typing in \(program)"
        case "desktop.keys": return "Pressing keys in \(program)"
        case "desktop.scroll": return "Scrolling in \(program)"
        case "desktop.drag": return "Dragging in \(program)"
        case "desktop.launch": return "Opening \(program)"
        case "desktop.close": return "Closing a window of \(program)"
        case "desktop.environment": return "Looking at this Mac"
        case "desktop.apps": return "Looking for a program"
        case "desktop.command": return "Running a command in \(payload["cwd"].text)"
        case "desktop.terminal.open": return "Opening a terminal in \(payload["cwd"].text)"
        case "desktop.terminal.input": return "Typing into Josi's terminal"
        case "desktop.terminal.read": return "Reading terminal output"
        case "desktop.terminal.close": return "Closing a terminal"
        case "desktop.folder": return "Looking in \(payload["folder"].text)"
        case "desktop.readfile": return "Reading \(payload["path"].text)"
        case "desktop.writefile": return "Writing \(payload["path"].text)"
        default: return "Working on this Mac"
        }
    }

    // ------------------------------------------------------------ takeover
    /// Your mouse or keyboard interrupts the action on the screen, and only that.
    private func engageTakeover() {
        guard monitor == nil else { return }
        lastMouse = NSEvent.mouseLocation
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { event in
            if event.cgEvent?.getIntegerValueField(.eventSourceUserData) == PcDesktop.marker { return }
            let location = NSEvent.mouseLocation
            Task { @MainActor in
                let executor = PcExecutor.shared
                if event.type == .mouseMoved {
                    defer { executor.lastMouse = location }
                    if let last = executor.lastMouse, abs(location.x - last.x) + abs(location.y - last.y) <= 8 { return }
                }
                if executor.busy, executor.onScreen { executor.takenOver = true; executor.current?.cancel() }
            }
        }
    }
    private func disengageTakeover() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}

final class PcResultBox: @unchecked Sendable {
    private let lock = NSLock(); private var stored: PcOutcome?
    var value: PcOutcome? { lock.lock(); defer { lock.unlock() }; return stored }
    func set(_ outcome: PcOutcome) { lock.lock(); stored = outcome; lock.unlock() }
}
