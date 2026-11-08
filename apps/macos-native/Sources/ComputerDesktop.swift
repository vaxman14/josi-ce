import AppKit
import ApplicationServices
import ScreenCaptureKit
import Security

@MainActor final class ComputerDesktop {
    struct Observation {
        let id: String; let identity: String; let pid: pid_t; let window: AXUIElement
        let bounds: CGRect; let created: Date; let generation: Int; let task: String; let displays: String
        let elements: [String: AXUIElement]
    }
    private var displaySignature: String { NSScreen.screens.map { "\($0.frame)|\($0.backingScaleFactor)" }.joined(separator: ";") }
    private var observations: [String: Observation] = [:]
    let gate: ComputerLocalGate
    let overlay: ComputerOverlay
    init(gate: ComputerLocalGate, overlay: ComputerOverlay) { self.gate = gate; self.overlay = overlay }
    func clear() { observations.removeAll() }
    static func protected(_ id: String) -> Bool {
        id.hasPrefix("com.heyjosi.") || id == Bundle.main.bundleIdentifier ||
        ["com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.securityagent", "com.apple.systempreferences",
         "com.apple.keychainaccess", "com.apple.Passwords", "com.apple.LocalAuthentication.UIAgent", "com.apple.CoreServicesUIAgent"].contains(id)
    }
    static func identity(_ url: URL) throws -> String {
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL
        guard canonical == url.standardizedFileURL, let bundle = Bundle(url: canonical), let id = bundle.bundleIdentifier, !protected(id) else { throw JosiError(message: "This application is protected or has changed identity.") }
        var code: SecStaticCode?, info: CFDictionary?
        guard SecStaticCodeCreateWithPath(canonical as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any] else { throw JosiError(message: "A verified application signature is required.") }
        let team = values[kSecCodeInfoTeamIdentifier as String] as? String ?? "apple"
        // A missing team is accepted only for the OS signing anchor.
        if team == "apple" {
            var requirement: SecRequirement?
            guard SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess,
                  SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess else { throw JosiError(message: "The application has no verified signing team.") }
        }
        return id + "|" + team + "|" + canonical.path
    }
    static func applications() -> Wire {
        var results: [Wire] = [], paths = Set<String>()
        for root in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
            for url in (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "app" {
                guard paths.insert(url.path).inserted, let identity = try? identity(url) else { continue }
                let running = NSWorkspace.shared.runningApplications.first { $0.bundleURL == url }
                results.append(["identity": .string(identity), "name": .string(url.deletingPathExtension().lastPathComponent),
                    "pid": .number(Double(running?.processIdentifier ?? 0))])
            }
        }
        return ["applications": .array(results), "untrusted": .bool(true)]
    }
    private func application(_ identity: String, pin: Wire = .null) throws -> (URL, NSRunningApplication?) {
        let parts = identity.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { throw JosiError(message: "Choose an exact application identity from the inventory.") }
        let url = URL(fileURLWithPath: parts[2]); guard try Self.identity(url) == identity else { throw JosiError(message: "Application identity changed. Review a new permission.") }
        if pin != .null {
            var code: SecStaticCode?, info: CFDictionary?
            guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
                  SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
                  let values = info as? [String: Any], let hash = values[kSecCodeInfoUnique as String] as? Data,
                  values[kSecCodeInfoIdentifier as String] as? String == pin["signingId"].text,
                  hash.map({ String(format: "%02x", $0) }).joined() == pin["codeHash"].text else {
                throw JosiError(message: "This app no longer matches the installation covered by your saved permissions.")
            }
        }
        return (url, NSWorkspace.shared.runningApplications.first { $0.bundleURL?.standardizedFileURL == url.standardizedFileURL })
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func string(_ element: AXUIElement, _ name: String) -> String { String((attribute(element, name) as? String ?? "").prefix(500)) }
    private func bounds(_ element: AXUIElement) throws -> CGRect {
        guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { throw JosiError(message: "Window geometry is unavailable.") }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &p), AXValueGetValue(unsafeDowncast(size, to: AXValue.self), .cgSize, &s) else { throw JosiError(message: "Window geometry changed.") }
        return CGRect(origin: p, size: s)
    }
    func execute(_ q: Wire) async throws -> Wire {
        let op = q["operation"], action = op["action"].text, identity = op["scope"]["target"].text, args = op["args"]
        try gate.check()
        if action == "app.list" { return Self.applications() }
        let (url, app) = try application(identity, pin: q["applicationPin"])
        if action == "app.launch" {
            let config = NSWorkspace.OpenConfiguration(); config.activates = false
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            try gate.check(); return ["opened": .bool(true)]
        }
        try overlay.checkScreen()
        guard let app, app.processIdentifier != getpid(), NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            throw JosiError(message: "Bring the approved application to the front, then Resume. Josi will not type into a different focused app.")
        }
        let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 0.1)
        guard let raw = attribute(ax, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw JosiError(message: "The application has no accessible focused window.") }
        let window = unsafeDowncast(raw, to: AXUIElement.self), rect = try bounds(window)
        if action == "window.read" || action == "window.capture" {
            var queue: [AXUIElement] = [window], elements: [String: AXUIElement] = [:], nodes: [Wire] = [], secure = false, truncated = false
            while !queue.isEmpty, nodes.count < 120 {
                await Task.yield()
                try gate.check(); try overlay.checkScreen()
                let element = queue.removeFirst(); AXUIElementSetMessagingTimeout(element, 0.05)
                let role = string(element, kAXRoleAttribute), subrole = string(element, kAXSubroleAttribute)
                if subrole == kAXSecureTextFieldSubrole { secure = true; continue }
                let id = UUID().uuidString.lowercased(); elements[id] = element
                // No generic value export; password and other field values stay out of observations.
                nodes.append(["id": .string(id), "role": .string(role), "label": .string(string(element, kAXTitleAttribute)),
                    "description": .string(string(element, kAXDescriptionAttribute))])
                if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                    let capacity = max(0, 120 - nodes.count - queue.count)
                    if children.count > capacity { truncated = true }
                    queue.append(contentsOf: children.prefix(capacity))
                }
            }
            if secure { throw JosiError(message: "This window contains a protected input. Finish it yourself before continuing.") }
            let id = UUID().uuidString.lowercased()
            observations.removeAll()
            observations[id] = Observation(id: id, identity: identity, pid: app.processIdentifier, window: window, bounds: rect,
                created: Date(), generation: gate.generation, task: q["taskId"].text, displays: displaySignature, elements: elements)
            let treeTruncated = truncated || !queue.isEmpty
            var result: [String: Wire] = ["observationId": .string(id), "application": .string(identity), "nodes": .array(nodes),
                "width": .number(Double(Int(rect.width))), "height": .number(Double(Int(rect.height))), "treeTruncated": .bool(treeTruncated), "untrusted": .bool(true)]
            if action == "window.capture" {
                guard !treeTruncated else { throw JosiError(message: "This window is too complex to finish checking for protected inputs. Use the bounded accessibility observation instead.") }
                guard CGPreflightScreenCaptureAccess() else { throw JosiError(message: "Screen Recording is not granted. Open the local permission panel when ready.") }
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                let candidates = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 }
                let title = string(window, kAXTitleAttribute)
                let matches = candidates.filter { candidate in
                    let frame = candidate.frame
                    return candidate.title == title && abs(frame.minX - rect.minX) <= 1 && abs(frame.minY - rect.minY) <= 1
                        && abs(frame.maxX - rect.maxX) <= 1 && abs(frame.maxY - rect.maxY) <= 1
                }
                guard matches.count == 1, let target = matches.first else { throw JosiError(message: "Cannot uniquely match the approved window for capture.") }
                try gate.check(); try overlay.checkScreen()
                let filter = SCContentFilter(desktopIndependentWindow: target)
                let pixels = CGSize(width: rect.width * CGFloat(filter.pointPixelScale), height: rect.height * CGFloat(filter.pointPixelScale))
                let scale = min(1, 1600 / max(1, pixels.width), 1200 / max(1, pixels.height))
                let configuration = SCStreamConfiguration(); configuration.width = max(1, Int(pixels.width * scale)); configuration.height = max(1, Int(pixels.height * scale)); configuration.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                try gate.check(); try overlay.checkScreen()
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier, try bounds(window) == rect,
                      let png = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.65]), png.count < 150_000 else { throw JosiError(message: "Capture changed or exceeded the bounded result size.") }
                result["image"] = ["mimeType": "image/jpeg", "data": .string(png.base64EncodedString())]
                result["imageWidth"] = .number(Double(configuration.width)); result["imageHeight"] = .number(Double(configuration.height))
            }
            guard try JSONEncoder().encode(Wire.object(result)).count <= (action == "window.capture" ? 256000 : 65536) else {
                observations.removeAll(); throw JosiError(message: "This observation exceeds the bounded result size.")
            }
            return .object(result)
        }
        guard let prior = observations[args["observationId"].text], prior.identity == identity, prior.pid == app.processIdentifier,
              prior.generation == gate.generation, prior.task == q["taskId"].text, prior.displays == displaySignature, Date().timeIntervalSince(prior.created) < 10,
              CFEqual(prior.window, window), prior.bounds == rect else { throw JosiError(message: "Observation is stale. Read the window again.") }
        try gate.check(); try overlay.checkScreen()
        if action == "window.close" {
            guard let button = attribute(window, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID(),
                  AXUIElementPerformAction(unsafeDowncast(button, to: AXUIElement.self), kAXPressAction as CFString) == .success else { throw JosiError(message: "This window has no supported close control.") }
            observations.removeAll(); return ["performed": .bool(true), "verifyByReadingAgain": .bool(true)]
        }
        if action == "window.scroll" {
            let amount = args["deltaY"].integer
            guard amount != 0, abs(amount) <= 1000, let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(amount), wheel2: 0, wheel3: 0) else { throw JosiError(message: "Use a bounded nonzero scroll delta of at most 1000 pixels.") }
            event.location = CGPoint(x: rect.midX, y: rect.midY); event.postToPid(app.processIdentifier)
            observations.removeAll(); return ["performed": .bool(true), "verifyByReadingAgain": .bool(true)]
        }
        if action == "window.drag" {
            let points = ["fromX", "fromY", "toX", "toY"].map { CGFloat(args[$0].integer) }
            guard points[0] >= 0, points[1] >= 0, points[2] >= 0, points[3] >= 0,
                  points[0] < rect.width, points[2] < rect.width, points[1] < rect.height, points[3] < rect.height else { throw JosiError(message: "Drag coordinates must be inside the freshly observed window, in points.") }
            let start = CGPoint(x: rect.minX + points[0], y: rect.minY + points[1]), end = CGPoint(x: rect.minX + points[2], y: rect.minY + points[3])
            var lastPoint = start
            func send(_ type: CGEventType, _ point: CGPoint) {
                CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.postToPid(app.processIdentifier)
            }
            send(.leftMouseDown, start)
            defer { send(.leftMouseUp, lastPoint) } // Release where cancellation occurred; never finish the remaining drag.
            for step in 1...12 {
                try await Task.sleep(for: .milliseconds(15)); try gate.check(); try overlay.checkScreen()
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier, try bounds(window) == rect else { throw JosiError(message: "Window moved during drag. Input stopped.") }
                let t = CGFloat(step) / 12; lastPoint = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t); send(.leftMouseDragged, lastPoint)
            }
            observations.removeAll(); return ["performed": .bool(true), "verifyByReadingAgain": .bool(true)]
        }
        guard let element = prior.elements[args["elementId"].text], string(element, kAXSubroleAttribute) != kAXSecureTextFieldSubrole else { throw JosiError(message: "Choose a nonprotected element from the latest observation.") }
        if action == "window.click" {
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw JosiError(message: "This element has no supported structured press action.") }
        } else if action == "window.type" {
            guard args["text"].text.count <= 4096, AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, args["text"].text as CFString) == .success else { throw JosiError(message: "This element does not accept bounded structured text input.") }
        } else { throw JosiError(message: "This desktop operation is not implemented. No input was sent.") }
        observations.removeAll(); return ["performed": .bool(true), "verifyByReadingAgain": .bool(true)]
    }
}
