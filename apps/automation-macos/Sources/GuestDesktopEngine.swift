import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import ScreenCaptureKit
import Security

enum GuestDesktopError: Error { case unavailable, stale, denied, busy, unsupported, uncertain }

struct GuestDesktopCommand: Codable, Equatable {
    enum Operation: String, Codable { case observe, capture, press, focus, click, text, key }
    let id: UUID
    let workspaceId: UUID
    let appId: UUID
    let installationRevision: Int
    let sessionId: UUID
    let generation: Int
    let expiresAtMs: Int64
    let operation: Operation
    let observationId: UUID?
    let elementId: UUID?
    let x: Double?
    let y: Double?
    let valueReference: UUID?
    let key: String?
}

struct GuestDesktopTarget: Codable, Equatable {
    let processId: Int32
    let launchedAt: Date
    let bundleId: String
    let executablePath: String
    let windowTitle: String
    let bounds: CGRect
}

/// Minimized immutable identity from the canonical Vault target registry.
/// The authority port, never a model or page, supplies this projection.
struct GuestPinnedApplication: Codable, Equatable {
    let workspaceId: UUID
    let applicationId: UUID
    let installationRevision: Int
    let bundlePath: String
    let bundleId: String
    let signingId: String
    let teamId: String
    let codeHash: String
}

struct GuestDesktopNode: Codable {
    let id: UUID
    let role: String
    let label: String
    let enabled: Bool
    let focused: Bool
    let bounds: CGRect?
    let actions: [String]
}

struct GuestDesktopObservation: Codable {
    let id: UUID
    let workspaceId: UUID
    let appId: UUID
    let installationRevision: Int
    let sessionId: UUID
    let generation: Int
    let target: GuestDesktopTarget
    let elements: [GuestDesktopNode]
    let partial: Bool
    let capturedAt: Date
    let untrustedContent: Bool
}

struct GuestDesktopReceipt: Codable {
    enum Outcome: String, Codable { case observed, inputIssued, denied, uncertain }
    let commandId: UUID
    let outcome: Outcome
    let verificationRequired: Bool
    let observation: GuestDesktopObservation?
}

/// Implemented by the authenticated guest-channel boundary, not by a renderer
/// or model. No default implementation, plaintext config token or host-desktop
/// fallback. Local consent and current canonical Vault authority are required.
@MainActor
protocol GuestDesktopAuthority: AnyObject {
    /// Verify this process belongs to the enrolled isolated guest and this
    /// exact workspace/session/generation is still current. Must fail closed.
    func requireCurrentGuest(_ command: GuestDesktopCommand) async throws
    /// Resolve this exact app/revision from current canonical Vault authority.
    /// Returning caller-supplied metadata does not implement this contract.
    func pinnedApplication(_ command: GuestDesktopCommand) async throws -> GuestPinnedApplication
    /// Verify exact command + locally observed target, current policy, consent,
    /// budget and one-use reservation. Record durable dispatch before input.
    /// Observation and capture require their own read/transmission permission.
    func authorize(_ command: GuestDesktopCommand, target: GuestDesktopTarget) async throws
    /// Ephemeral projection for this already-authorized exact text command.
    /// Must not persist, log or return the value to the agent.
    func projectText(_ reference: UUID, for command: GuestDesktopCommand) async throws -> String
    /// Revoke execution on a local takeover, uncertain input or lost channel.
    func stopped(reason: String)
}

/// Guest-only native operations. This library has no listener/CLI entry point:
/// the signed guest app must supply verified authority before using it.
@MainActor
final class GuestDesktopEngine {
    private let authority: GuestDesktopAuthority
    private var generation = 0
    private var stopped = false
    private var busy = false
    private var snapshot: GuestDesktopObservation?
    private var window: AXUIElement?
    private var elements: [UUID: AXUIElement] = [:]
    private var fingerprint: Data?
    private var seen = Set<UUID>()
    private var inputMonitor: Any?
    private var lastWall = Date()
    private var lastMonotonic = ContinuousClock.now
    private var commandDeadline: ContinuousClock.Instant?
    private let eventMarker: Int64 = 0x4a4f534947554553
    private static let blockedApps: Set<String> = [
        "com.apple.systempreferences", "com.apple.systemsettings", "com.apple.securityagent",
        "com.apple.loginwindow", "com.apple.keychainaccess",
    ]

    init(authority: GuestDesktopAuthority) {
        self.authority = authority
        // A monitor failure does not grant input authority. check() requires it.
        inputMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
            // Generated input is marked by this process. All other observed
            // input is treated as takeover, including input from another app.
            guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) != self?.eventMarker else { return }
            MainActor.assumeIsolated { self?.takeOver() }
        }
    }

    /// Called only by protected local controls / authenticated lease teardown.
    /// Resuming creates a new engine/session and requires a new observation.
    func takeOver() {
        guard !stopped else { return }
        stopped = true; generation += 1; snapshot = nil; window = nil; elements.removeAll(); fingerprint = nil
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor); self.inputMonitor = nil }
        authority.stopped(reason: "local_control_or_session_ended")
    }

    func dispose() { takeOver() }

    private func check(_ command: GuestDesktopCommand, epoch: Int) throws {
        let now = Date(), monotonic = ContinuousClock.now
        guard !stopped, epoch == generation, inputMonitor != nil, AXIsProcessTrusted(),
              now >= lastWall, monotonic >= lastMonotonic,
              commandDeadline.map({ monotonic < $0 }) ?? true,
              command.expiresAtMs > Int64(now.timeIntervalSince1970 * 1000),
              command.expiresAtMs <= Int64(now.timeIntervalSince1970 * 1000) + 60_000,
              command.generation >= 0, !Task.isCancelled else { throw GuestDesktopError.unavailable }
        lastWall = now; lastMonotonic = monotonic
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func text(_ element: AXUIElement, _ name: String, limit: Int = 300) -> String {
        String((attribute(element, name) as? String ?? "").prefix(limit))
    }
    private func rectangle(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeDowncast(size, to: AXValue.self), .cgSize, &dimensions),
              [point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite),
              dimensions.width > 0, dimensions.height > 0 else { return nil }
        return CGRect(origin: point, size: dimensions)
    }
    static func verifyApplication(_ application: NSRunningApplication, pin: GuestPinnedApplication) throws {
        guard pin.installationRevision > 0, pin.bundlePath.hasPrefix("/"), pin.bundlePath.hasSuffix(".app"),
              pin.bundlePath.utf8.count <= 768,
              pin.codeHash.range(of: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", options: .regularExpression) != nil,
              let bundleURL = application.bundleURL?.resolvingSymlinksInPath().standardizedFileURL,
              bundleURL.path == pin.bundlePath, application.bundleIdentifier == pin.bundleId,
              let executable = application.executableURL?.resolvingSymlinksInPath().standardizedFileURL,
              executable.path.hasPrefix(bundleURL.path + "/"), !application.isTerminated else { throw GuestDesktopError.denied }
        var code: SecCode?, requirement: SecRequirement?, disk: SecStaticCode?
        // Only validated hexadecimal is interpolated into the requirement.
        // Dynamic validation binds the PID to the expected code directory,
        // while static validation also rejects modified on-disk resources.
        let expression = "anchor apple generic and cdhash H\"\(pin.codeHash)\""
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: application.processIdentifier] as CFDictionary,
                                            [], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], requirement) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &disk) == errSecSuccess, let disk,
              SecStaticCodeCheckValidity(disk, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
        else { throw GuestDesktopError.denied }
        var details: CFDictionary?
        guard SecCodeCopySigningInformation(disk, SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess,
              let fields = details as? [String: Any],
              fields[kSecCodeInfoIdentifier as String] as? String == pin.signingId,
              (fields[kSecCodeInfoTeamIdentifier as String] as? String ?? "") == pin.teamId,
              let hash = fields[kSecCodeInfoUnique as String] as? Data,
              hash.map({ String(format: "%02x", $0) }).joined() == pin.codeHash,
              let again = NSRunningApplication(processIdentifier: application.processIdentifier), !again.isTerminated,
              again.launchDate == application.launchDate,
              again.executableURL?.resolvingSymlinksInPath().standardizedFileURL == executable
        else { throw GuestDesktopError.stale }
    }

    private func frontWindow(_ pin: GuestPinnedApplication) throws -> (GuestDesktopTarget, AXUIElement) {
        guard let app = NSWorkspace.shared.frontmostApplication, !app.isTerminated,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let bundle = app.bundleIdentifier, !Self.blockedApps.contains(bundle.lowercased()),
              !bundle.lowercased().hasPrefix("com.heyjosi."), !bundle.lowercased().hasPrefix("com.socalreceptionist.josi"),
              let path = app.executableURL?.resolvingSymlinksInPath().standardizedFileURL.path,
              let launched = app.launchDate else { throw GuestDesktopError.denied }
        try Self.verifyApplication(app, pin: pin)
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.15)
        guard let rawWindow = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else {
            throw GuestDesktopError.unavailable
        }
        let current = unsafeDowncast(rawWindow, to: AXUIElement.self)
        guard let bounds = rectangle(current) else { throw GuestDesktopError.unavailable }
        return (GuestDesktopTarget(processId: app.processIdentifier, launchedAt: launched, bundleId: bundle,
            executablePath: path, windowTitle: text(current, kAXTitleAttribute), bounds: bounds), current)
    }

    private struct Tree {
        let nodes: [GuestDesktopNode]
        let references: [UUID: AXUIElement]
        let fingerprint: Data
        let partial: Bool
    }
    private func tree(_ root: AXUIElement) throws -> Tree {
        var queue: [(AXUIElement, Int)] = [(root, 0)], offset = 0, nodes: [GuestDesktopNode] = []
        var references: [UUID: AXUIElement] = [:], signatures: [[String: Any]] = []
        var partial = false
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while offset < queue.count && nodes.count < 240 {
            if ContinuousClock.now >= deadline { partial = true; break }
            let (element, depth) = queue[offset]; offset += 1
            AXUIElementSetMessagingTimeout(element, 0.08)
            let role = text(element, kAXRoleAttribute), subrole = text(element, kAXSubroleAttribute)
            // Secure text fields and their descendants are never read or
            // returned as editable targets. No generic AXValue getter exists.
            if subrole == kAXSecureTextFieldSubrole { partial = true; continue }
            let label = text(element, kAXTitleAttribute).isEmpty ? text(element, kAXDescriptionAttribute) : text(element, kAXTitleAttribute)
            let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) == true
            let focused = (attribute(element, kAXFocusedAttribute) as? Bool) == true
            let rect = rectangle(element)
            var names: CFArray?
            _ = AXUIElementCopyActionNames(element, &names)
            let actions = (names as? [String] ?? []).filter { $0 == kAXPressAction }.prefix(8)
            let id = UUID()
            nodes.append(GuestDesktopNode(id: id, role: role, label: label, enabled: enabled, focused: focused, bounds: rect, actions: Array(actions)))
            references[id] = element
            signatures.append(["role": role, "subrole": subrole, "label": label, "enabled": enabled, "focused": focused,
                "bounds": rect.map { [$0.origin.x, $0.origin.y, $0.width, $0.height] } ?? [],
                "actions": Array(actions), "depth": depth])
            if depth < 16 {
                var children: CFArray?
                if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, 241, &children) == .success,
                   let list = children as? [AXUIElement] {
                    let remaining = max(0, 480 - queue.count)
                    if list.count > remaining || list.count == 241 { partial = true }
                    queue.append(contentsOf: list.prefix(remaining).map { ($0, depth + 1) })
                }
            } else { partial = true }
        }
        if offset < queue.count { partial = true }
        let data = try JSONSerialization.data(withJSONObject: signatures, options: [.sortedKeys])
        return Tree(nodes: nodes, references: references, fingerprint: Data(SHA256.hash(data: data)), partial: partial)
    }

    private func fresh(_ command: GuestDesktopCommand, pin: GuestPinnedApplication) throws -> (GuestDesktopObservation, AXUIElement) {
        guard let observation = snapshot, let oldWindow = window, let savedFingerprint = fingerprint,
              command.observationId == observation.id, command.workspaceId == observation.workspaceId,
              command.appId == observation.appId, command.installationRevision == observation.installationRevision,
              command.sessionId == observation.sessionId, command.generation == observation.generation,
              Date().timeIntervalSince(observation.capturedAt) < 15 else { throw GuestDesktopError.stale }
        let (target, current) = try frontWindow(pin)
        guard target == observation.target, CFEqual(current, oldWindow),
              try tree(current).fingerprint == savedFingerprint else { throw GuestDesktopError.stale }
        return (observation, current)
    }

    /// Structured observation and input. Capture has a separate entry point so
    /// pixels never accidentally enter a tool receipt, database log or context.
    func execute(_ command: GuestDesktopCommand) async -> GuestDesktopReceipt {
        let denied = { (outcome: GuestDesktopReceipt.Outcome) in
            GuestDesktopReceipt(commandId: command.id, outcome: outcome, verificationRequired: true, observation: nil)
        }
        guard !busy, !seen.contains(command.id), seen.count < 4096 else { return denied(.denied) }
        busy = true; seen.insert(command.id)
        commandDeadline = ContinuousClock.now.advanced(by: .milliseconds(max(0, min(60_000, command.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)))))
        defer { busy = false; commandDeadline = nil }
        let epoch = generation
        var dispatched = false
        do {
            try check(command, epoch: epoch)
            try await authority.requireCurrentGuest(command)
            try check(command, epoch: epoch)
            let pin = try await authority.pinnedApplication(command)
            guard pin.workspaceId == command.workspaceId, pin.applicationId == command.appId,
                  pin.installationRevision == command.installationRevision else { throw GuestDesktopError.denied }
            try check(command, epoch: epoch)
            if command.operation == .observe {
                guard command.observationId == nil, command.elementId == nil, command.valueReference == nil,
                      command.x == nil, command.y == nil, command.key == nil else { throw GuestDesktopError.unsupported }
                let (target, current) = try frontWindow(pin)
                try await authority.authorize(command, target: target)
                try check(command, epoch: epoch)
                let (after, afterWindow) = try frontWindow(pin)
                guard target == after, CFEqual(current, afterWindow) else { throw GuestDesktopError.stale }
                let captured = try tree(current)
                try check(command, epoch: epoch)
                guard try frontWindow(pin).0 == target else { throw GuestDesktopError.stale }
                let observation = GuestDesktopObservation(id: UUID(), workspaceId: command.workspaceId,
                    appId: command.appId, installationRevision: command.installationRevision, sessionId: command.sessionId,
                    generation: command.generation, target: target, elements: captured.nodes, partial: captured.partial,
                    capturedAt: Date(), untrustedContent: true)
                snapshot = observation; window = current; elements = captured.references; fingerprint = captured.fingerprint
                return GuestDesktopReceipt(commandId: command.id, outcome: .observed, verificationRequired: true, observation: observation)
            }
            guard command.operation != .capture else { throw GuestDesktopError.unsupported }
            let (observation, _) = try fresh(command, pin: pin)
            var projected: String?
            try await authority.authorize(command, target: observation.target)
            if command.operation == .text {
                guard let reference = command.valueReference else { throw GuestDesktopError.unsupported }
                projected = try await authority.projectText(reference, for: command)
            }
            defer { projected = nil }
            try check(command, epoch: epoch)
            let (_, current) = try fresh(command, pin: pin)
            let targetElement = command.elementId.flatMap { elements[$0] }
            // Consume the snapshot before the first native call. A timeout is
            // uncertain, and cannot make this observation reusable.
            snapshot = nil; window = nil; elements.removeAll(); fingerprint = nil
            switch command.operation {
            case .press, .focus:
                guard command.x == nil, command.y == nil, command.key == nil, command.valueReference == nil,
                      let element = targetElement, (attribute(element, kAXEnabledAttribute) as? Bool) == true else { throw GuestDesktopError.denied }
                try check(command, epoch: epoch); dispatched = true
                let result = command.operation == .press
                    ? AXUIElementPerformAction(element, kAXPressAction as CFString)
                    : AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                guard result == .success else { throw GuestDesktopError.uncertain }
            case .click:
                guard command.elementId == nil, command.key == nil, command.valueReference == nil,
                      let x = command.x, let y = command.y, x.isFinite, y.isFinite else { throw GuestDesktopError.unsupported }
                let point = CGPoint(x: x, y: y)
                guard observation.target.bounds.insetBy(dx: 1, dy: 1).contains(point) else { throw GuestDesktopError.denied }
                let system = AXUIElementCreateSystemWide()
                var hit: AXUIElement?
                guard AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &hit) == .success, let hit else { throw GuestDesktopError.denied }
                var pid: pid_t = 0
                guard AXUIElementGetPid(hit, &pid) == .success, pid == observation.target.processId,
                      let hitWindow = attribute(hit, kAXWindowAttribute), CFEqual(hitWindow, current) else { throw GuestDesktopError.denied }
                guard let source = CGEventSource(stateID: .privateState),
                      let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                      let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw GuestDesktopError.unavailable }
                try check(command, epoch: epoch); dispatched = true
                down.setIntegerValueField(.eventSourceUserData, value: eventMarker); up.setIntegerValueField(.eventSourceUserData, value: eventMarker)
                down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            case .text, .key:
                guard command.elementId == nil, command.x == nil, command.y == nil, !IsSecureEventInputEnabled(),
                      let source = CGEventSource(stateID: .privateState) else { throw GuestDesktopError.denied }
                let keyCodes: [String: CGKeyCode] = ["enter": 36, "tab": 48, "escape": 53, "backspace": 51,
                    "left": 123, "right": 124, "down": 125, "up": 126]
                let code: CGKeyCode
                var units: [UniChar] = []
                if command.operation == .text {
                    guard command.key == nil, let projected, !projected.isEmpty, projected.utf16.count <= 256,
                          !projected.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw GuestDesktopError.unsupported }
                    code = 0; units = Array(projected.utf16)
                } else {
                    guard command.valueReference == nil, let key = command.key, let selected = keyCodes[key] else { throw GuestDesktopError.unsupported }
                    code = selected
                }
                defer { units = Array(repeating: 0, count: units.count) }
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { throw GuestDesktopError.unavailable }
                if !units.isEmpty {
                    units.withUnsafeBufferPointer {
                        down.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
                        up.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
                    }
                }
                try check(command, epoch: epoch); dispatched = true
                down.setIntegerValueField(.eventSourceUserData, value: eventMarker); up.setIntegerValueField(.eventSourceUserData, value: eventMarker)
                // Process-directed input avoids typing into a newly focused
                // unrelated process. The window/field still needs verification.
                down.postToPid(observation.target.processId); up.postToPid(observation.target.processId)
            default: throw GuestDesktopError.unsupported
            }
            return denied(.inputIssued)
        } catch {
            if dispatched { takeOver(); return denied(.uncertain) }
            return denied(.denied)
        }
    }

    /// Returns only the approved current window's PNG bytes in memory. The
    /// host must enforce separate viewing/transmission/retention permissions.
    @available(macOS 14.2, *)
    func capture(_ command: GuestDesktopCommand) async throws -> Data {
        guard !busy, command.operation == .capture, !seen.contains(command.id), seen.count < 4096,
              command.elementId == nil, command.valueReference == nil, command.x == nil, command.y == nil, command.key == nil,
              CGPreflightScreenCaptureAccess() else { throw GuestDesktopError.denied }
        busy = true; seen.insert(command.id)
        commandDeadline = ContinuousClock.now.advanced(by: .milliseconds(max(0, min(60_000, command.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)))))
        defer { busy = false; commandDeadline = nil }
        let epoch = generation
        try check(command, epoch: epoch)
        try await authority.requireCurrentGuest(command)
        try check(command, epoch: epoch)
        let pin = try await authority.pinnedApplication(command)
        guard pin.workspaceId == command.workspaceId, pin.applicationId == command.appId,
              pin.installationRevision == command.installationRevision else { throw GuestDesktopError.denied }
        try check(command, epoch: epoch)
        let (observation, _) = try fresh(command, pin: pin)
        try await authority.authorize(command, target: observation.target)
        try check(command, epoch: epoch)
        _ = try fresh(command, pin: pin)
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        try check(command, epoch: epoch)
        _ = try fresh(command, pin: pin)
        let matches = content.windows.filter {
            $0.owningApplication?.processID == observation.target.processId
                && $0.frame == observation.target.bounds && ($0.title ?? "") == observation.target.windowTitle
                && $0.windowLayer == 0 && $0.isOnScreen
        }
        guard matches.count == 1 else { throw GuestDesktopError.stale }
        let filter = SCContentFilter(desktopIndependentWindow: matches[0])
        let configuration = SCStreamConfiguration()
        let scale = min(1, 1600 / max(observation.target.bounds.width, observation.target.bounds.height))
        configuration.width = max(1, Int(observation.target.bounds.width * scale))
        configuration.height = max(1, Int(observation.target.bounds.height * scale))
        configuration.showsCursor = false; configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true; configuration.includeChildWindows = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try check(command, epoch: epoch)
        _ = try fresh(command, pin: pin)
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
              data.count <= 8 * 1024 * 1024 else { throw GuestDesktopError.unavailable }
        return data
    }
}
