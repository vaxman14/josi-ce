import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation
import ScreenCaptureKit

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Josi's hands on this Mac's screen: the windows of your session, read through
/// the Mac's Accessibility, pictured with ScreenCaptureKit, and operated with
/// clicks, typing and keys. Every request arrives already decided by PC Control
/// for one exact program; this re-checks that the window still belongs to that
/// program before touching it. Josi's own windows and the system's password
/// prompts are never read or operated.
final class PcDesktop: @unchecked Sendable {
    static let shared = PcDesktop()
    /// Marks every event Josi posts, so the takeover monitor can tell them from yours.
    static let marker: Int64 = 0x4A4F_5349
    private let maxElements = 400, maxDepth = 16, screenshotLimit = 131_072
    private let lock = NSLock()
    private var observations: [String: Observation] = [:]
    private struct Observation {
        let window: AXUIElement; let windowId: CGWindowID; let pid: pid_t; let application: String
        let at: Date; let frame: CGRect; var elements: [String: AXUIElement]
    }

    // ------------------------------------------------------------ permissions
    static var accessibilityTrusted: Bool { AXIsProcessTrusted() }
    static func askForAccessibility() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    static func needsAccessibility() -> PcOutcome {
        DispatchQueue.main.async { askForAccessibility() }
        return pcRefuse("accessibility_permission_needed", "Josi needs the Mac's Accessibility permission to see and use windows. The owner turns it on in System Settings > Privacy & Security > Accessibility, then asks again.")
    }

    // ------------------------------------------------------------ windows
    private static let ownPath = Bundle.main.bundlePath
    private static let protectedApps: Set<String> = ["/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle",
                                                     "/System/Library/CoreServices/loginwindow.app", "/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle"]
    static func isProtected(_ application: String) -> Bool {
        application == ownPath || application.hasPrefix(ownPath + "/") || protectedApps.contains(application)
            || application.hasSuffix("/SecurityAgent.app") || application.hasSuffix("/coreautha.app")
    }
    private func apps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != getpid() && $0.bundleURL != nil }
    }
    private func axWindows(_ pid: pid_t) -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
        return (Self.value(app, kAXWindowsAttribute) as [AXUIElement]?) ?? []
    }
    private static func identifier(_ window: AXUIElement) -> CGWindowID? {
        var id: CGWindowID = 0
        return _AXUIElementGetWindow(window, &id) == .success && id != 0 ? id : nil
    }
    func windows() -> [Wire] {
        var list: [Wire] = []
        for app in apps() {
            guard let path = app.bundleURL?.path, !Self.isProtected(path) else { continue }
            for window in axWindows(app.processIdentifier) {
                guard let id = Self.identifier(window) else { continue }
                let title = (Self.value(window, kAXTitleAttribute) as String?)?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) ?? ""
                var entry: [String: Wire] = ["windowId": .string(String(id)), "title": .string(title.isEmpty ? (app.localizedName ?? "") : title),
                                             "application": .string(path), "processId": .number(Double(app.processIdentifier))]
                if (Self.value(window, kAXMinimizedAttribute) as Bool?) == true { entry["minimized"] = .bool(true) }
                list.append(.object(entry))
                if list.count >= 200 { return list }
            }
        }
        return list
    }
    /// The live window with this id, if it still belongs to that exact program.
    private func window(_ id: String, application: String) -> (AXUIElement, pid_t)? {
        guard let number = CGWindowID(id) else { return nil }
        for app in apps() where app.bundleURL?.path == application {
            if let found = axWindows(app.processIdentifier).first(where: { Self.identifier($0) == number }) { return (found, app.processIdentifier) }
        }
        return nil
    }
    private static func frame(_ window: AXUIElement) -> CGRect {
        CGRect(origin: point(window, kAXPositionAttribute) ?? .zero, size: size(window, kAXSizeAttribute) ?? .zero)
    }

    // ------------------------------------------------------------ requests
    func perform(kind: String, requestId: String, payload: Wire, scope: Wire, cancel: PcCancel) async -> PcOutcome {
        if kind == "desktop.windows" {
            guard Self.accessibilityTrusted else { return Self.needsAccessibility() }
            return (true, ["kind": "desktop_windows", "windows": .array(windows()), "untrustedContent": .bool(true)])
        }
        if kind == "desktop.launch" { return await launch(payload, scope) }
        guard Self.accessibilityTrusted else { return Self.needsAccessibility() }
        let application = scope["target"].text
        guard scope["kind"].text == "application", !application.isEmpty else { return pcRefuse("scope_mismatch") }
        if Self.isProtected(application) { return pcRefuse("protected_surface") }
        guard let (window, pid) = window(payload["windowId"].text, application: application) else { return pcRefuse("window_gone") }
        if kind == "desktop.read" { return (true, observe(requestId, window, pid, application, action: nil)) }
        if kind == "desktop.screenshot" { return await screenshot(requestId, window, pid, application) }
        // Everything else acts on a fresh observation of this same window.
        let current = take(payload["observationId"].text)
        let frame = Self.frame(window)
        guard let current, current.windowId == Self.identifier(window), current.pid == pid, current.application == application,
              current.frame == frame, Date().timeIntervalSince(current.at) <= 60 else { return pcRefuse("observation_stale_read_again") }
        do {
            try cancel.check()
            if kind == "desktop.close" {
                if let button: AXUIElement = Self.value(window, kAXCloseButtonAttribute) { AXUIElementPerformAction(button, kAXPressAction as CFString) }
                else { try foreground(window, pid); try keys("cmd+w", pid: pid, cancel: cancel) }
                try await Task.sleep(for: .milliseconds(800))
                return (true, ["kind": "desktop_closed", "windowId": .string(payload["windowId"].text),
                               "stillOpen": .bool(self.window(payload["windowId"].text, application: application) != nil), "untrustedContent": .bool(true)])
            }
            let method: String
            switch kind {
            case "desktop.scroll":
                try foreground(window, pid)
                let amount = max(-20, min(20, payload["amount"].integer))
                Self.move(to: CGPoint(x: frame.midX, y: frame.midY))
                let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                                    wheel1: payload["horizontal"].flag ? 0 : Int32(amount * 3), wheel2: payload["horizontal"].flag ? Int32(amount * 3) : 0, wheel3: 0)
                Self.post(event)
                method = "scroll"
            case "desktop.drag", "desktop.clickpoint":
                let scale = Self.number(payload["scale"])
                guard scale > 0 else { return pcRefuse("invalid_geometry") }
                guard Int(frame.origin.x.rounded()) == payload["originX"].integer, Int(frame.origin.y.rounded()) == payload["originY"].integer else { return pcRefuse("window_moved") }
                let start = CGPoint(x: frame.minX + Double(payload["x"].integer) / scale, y: frame.minY + Double(payload["y"].integer) / scale)
                let end = CGPoint(x: frame.minX + Double(payload["endX"].integer) / scale, y: frame.minY + Double(payload["endY"].integer) / scale)
                guard frame.contains(start), frame.contains(end) else { return pcRefuse("point_outside") }
                try foreground(window, pid)
                guard Self.owner(at: start) == pid else { return pcRefuse("another_window_under_point") }
                if kind == "desktop.clickpoint" { try Self.click(start, pid: pid); method = "point" }
                else { try Self.drag(start, end, pid: pid, cancel: cancel); method = "drag" }
            default:
                let elementId = payload["elementId"].text
                var element: AXUIElement?
                if kind == "desktop.click" || (kind == "desktop.type" && !elementId.isEmpty) {
                    guard let found = current.elements[elementId] else { return pcRefuse("element_unknown") }
                    element = found
                }
                if let element, Self.isSecure(element) { return pcRefuse("protected_field") }
                try foreground(window, pid)
                try cancel.check()
                if let focused = Self.focused(), Self.isSecure(focused) { return pcRefuse("protected_field") }
                switch kind {
                case "desktop.click": method = try click(element!, pid: pid)
                case "desktop.type": method = try type(element, text: payload["text"].text, pid: pid, cancel: cancel)
                case "desktop.keys": method = try keys(payload["keys"].text, pid: pid, cancel: cancel)
                default: return pcRefuse("unsupported_operation")
                }
            }
            try await Task.sleep(for: .milliseconds(350))
            try cancel.check()
            // A fresh read of the same window rides back, so the next step needs no other request.
            return (true, observe(requestId, window, pid, application, action: ["action": .string(String(kind.dropFirst(8))), "method": .string(method)]))
        } catch is PcStop { return pcRefuse("paused") }
        catch let error as JosiError { return pcRefuse("desktop_action_failed", error.message) }
        catch { return pcRefuse("desktop_action_failed", String(describing: Swift.type(of: error))) }
    }

    private func launch(_ payload: Wire, _ scope: Wire) async -> PcOutcome {
        let application = scope["target"].text
        guard scope["kind"].text == "application", payload["application"].text == application, application.hasSuffix(".app"),
              FileManager.default.fileExists(atPath: application) else { return pcRefuse("application_missing") }
        if Self.isProtected(application) { return pcRefuse("protected_surface") }
        let configuration = NSWorkspace.OpenConfiguration()
        let arguments = payload["arguments"].text
        if !arguments.isEmpty { configuration.arguments = arguments.split(separator: " ").map(String.init) }
        do { _ = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: application), configuration: configuration) }
        catch { return pcRefuse("application_not_launchable", error.localizedDescription) }
        try? await Task.sleep(for: .milliseconds(1500))
        let opened = Self.accessibilityTrusted ? windows().filter { $0["application"].text == application } : []
        return (true, ["kind": "desktop_launched", "application": .string(application), "arguments": .string(arguments), "windows": .array(opened), "untrustedContent": .bool(true)])
    }

    // ------------------------------------------------------------ reading
    private static let interactive: Set<String> = ["button", "textfield", "textarea", "checkbox", "radiobutton", "popupbutton", "combobox", "menuitem",
                                                   "menubutton", "link", "slider", "incrementor", "disclosuretriangle", "row", "cell", "searchfield", "webarea", "tab"]
    private func observe(_ requestId: String, _ window: AXUIElement, _ pid: pid_t, _ application: String, action: [String: Wire]?) -> Wire {
        var observation = Observation(window: window, windowId: Self.identifier(window) ?? 0, pid: pid, application: application,
                                      at: Date(), frame: Self.frame(window), elements: [:])
        var elements: [Wire] = [], text = "", partial = false
        var queue: [(AXUIElement, Int)] = [(window, 0)], index = 0
        while index < queue.count {
            let (element, depth) = queue[index]; index += 1
            if observation.elements.count >= maxElements { partial = true; break }
            if Self.isSecure(element) { continue }
            let rawRole = (Self.value(element, kAXRoleAttribute) as String?) ?? ""
            let role = (rawRole.hasPrefix("AX") ? String(rawRole.dropFirst(2)) : rawRole).lowercased()
            let value = Self.value(element, kAXValueAttribute) as String?
            var name = (Self.value(element, kAXTitleAttribute) as String?) ?? ""
            if name.isEmpty { name = (Self.value(element, kAXDescriptionAttribute) as String?) ?? "" }
            if name.isEmpty { name = (Self.value(element, kAXPlaceholderValueAttribute) as String?) ?? "" }
            if name.isEmpty, role == "statictext" || role == "heading" { name = value ?? "" }
            name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
            let position = Self.point(element, kAXPositionAttribute), size = Self.size(element, kAXSizeAttribute)
            let visible = (size.map { $0.width > 0 && $0.height > 0 } ?? false)
            if depth > 0 && visible {
                if ["statictext", "heading", "webarea"].contains(role), !name.isEmpty, text.count < 20_000 { text += name + "\n" }
                if Self.interactive.contains(role) {
                    let id = UUID().uuidString.lowercased()
                    observation.elements[id] = element
                    var entry: [String: Wire] = ["id": .string(id), "role": .string(role == "webarea" ? "document" : role), "name": .string(name),
                                                 "enabled": .bool((Self.value(element, kAXEnabledAttribute) as Bool?) ?? true)]
                    if let value, !value.isEmpty, role != "webarea" { entry["value"] = .string(String(value.prefix(300))) }
                    if let position, let size {
                        entry["bounds"] = ["x": .number(position.x.rounded()), "y": .number(position.y.rounded()), "width": .number(size.width.rounded()), "height": .number(size.height.rounded())]
                    }
                    elements.append(.object(entry))
                }
            }
            if depth >= maxDepth { partial = true; continue }
            for child in (Self.value(element, kAXChildrenAttribute) as [AXUIElement]?) ?? [] { queue.append((child, depth + 1)) }
        }
        remember(requestId, observation)
        var result: [String: Wire] = ["kind": "desktop_observation", "observationId": .string(requestId), "windowId": .string(String(observation.windowId)),
                                      "title": .string((Self.value(window, kAXTitleAttribute) as String?) ?? ""), "application": .string(application),
                                      "text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines)), "elements": .array(elements),
                                      "partial": .bool(partial), "untrustedContent": .bool(true)]
        if let action { result["action"] = .object(action) }
        return .object(result)
    }
    private func remember(_ id: String, _ observation: Observation) {
        lock.lock(); defer { lock.unlock() }
        observations[id] = observation
        observations = observations.filter { Date().timeIntervalSince($0.value.at) <= 60 }
        while observations.count > 32, let oldest = observations.min(by: { $0.value.at < $1.value.at }) { observations.removeValue(forKey: oldest.key) }
    }
    private func take(_ id: String) -> Observation? { lock.lock(); defer { lock.unlock() }; return observations.removeValue(forKey: id) }
    func forget() { lock.lock(); observations = [:]; lock.unlock() }

    // ------------------------------------------------------------ screenshot
    private func screenshot(_ requestId: String, _ window: AXUIElement, _ pid: pid_t, _ application: String) async -> PcOutcome {
        guard CGPreflightScreenCaptureAccess() else {
            DispatchQueue.main.async { _ = CGRequestScreenCaptureAccess() }
            return pcRefuse("screen_recording_permission_needed", "Josi needs the Mac's Screen Recording permission to take pictures of windows. The owner turns it on in System Settings > Privacy & Security > Screen & System Audio Recording, then asks again. Reading windows works without it.")
        }
        guard let id = Self.identifier(window) else { return pcRefuse("window_gone") }
        let frame = Self.frame(window)
        guard frame.width >= 8, frame.height >= 8 else { return pcRefuse("nothing_to_capture") }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let target = content.windows.first(where: { $0.windowID == id }) else { return pcRefuse("window_gone") }
            let configuration = SCStreamConfiguration()
            let longest = max(frame.width, frame.height), factor = min(2.0, 1280.0 / longest)
            configuration.width = max(1, Int(frame.width * factor)); configuration.height = max(1, Int(frame.height * factor))
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: target), configuration: configuration)
            guard Self.frame(window) == frame else { return pcRefuse("window_moved") }
            let observation = Observation(window: window, windowId: id, pid: pid, application: application, at: Date(), frame: frame, elements: [:])
            for side in [1280.0, 1024.0, 800.0] {
                let scale = min(1.0, side / Double(max(image.width, image.height)))
                guard let small = Self.resized(image, scale: scale) else { continue }
                for quality in [0.8, 0.6, 0.45, 0.3] {
                    guard let jpeg = NSBitmapImageRep(cgImage: small).representation(using: .jpeg, properties: [.compressionFactor: quality]) else { continue }
                    let base64 = jpeg.base64EncodedString()
                    if base64.count <= screenshotLimit {
                        remember(requestId, observation)
                        // Geometry travels with the picture, so a click at a point in it maps back to the screen.
                        return (true, ["kind": "desktop_screenshot", "observationId": .string(requestId), "windowId": .string(String(id)),
                                       "title": .string((Self.value(window, kAXTitleAttribute) as String?) ?? ""), "application": .string(application),
                                       "width": .number(Double(small.width)), "height": .number(Double(small.height)),
                                       "originX": .number(frame.origin.x.rounded()), "originY": .number(frame.origin.y.rounded()),
                                       "scale": .number(Double(small.width) / frame.width), "untrustedContent": .bool(true),
                                       "shown": "The picture is attached as an image.",
                                       "__images": .array([.object(["data": .string(base64), "mimeType": .string("image/jpeg")])])])
                    }
                }
            }
            return pcRefuse("screenshot_too_large")
        } catch { return pcRefuse("screenshot_failed", error.localizedDescription) }
    }
    private static func resized(_ image: CGImage, scale: Double) -> CGImage? {
        if scale >= 1 { return image }
        let width = max(1, Int(Double(image.width) * scale)), height = max(1, Int(Double(image.height) * scale))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    // ------------------------------------------------------------ acting
    private func foreground(_ window: AXUIElement, _ pid: pid_t) throws {
        if (Self.value(window, kAXMinimizedAttribute) as Bool?) == true { AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
        NSRunningApplication(processIdentifier: pid)?.activate()
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.2)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw JosiError(message: "The target window did not come to the front.") }
    }
    private static func checkTarget(_ pid: pid_t) throws {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw JosiError(message: "The input target changed.") }
        if let focused = focused(), isSecure(focused) { throw JosiError(message: "The input field is protected.") }
    }
    private func click(_ element: AXUIElement, pid: pid_t) throws -> String {
        var names: CFArray?
        if AXUIElementCopyActionNames(element, &names) == .success, let actions = names as? [String], actions.contains(kAXPressAction) {
            if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return "press" }
        }
        guard let position = Self.point(element, kAXPositionAttribute), let size = Self.size(element, kAXSizeAttribute), size.width > 0 else {
            throw JosiError(message: "The control has no position on screen.")
        }
        try Self.click(CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2), pid: pid)
        return "mouse"
    }
    private func type(_ element: AXUIElement?, text: String, pid: pid_t, cancel: PcCancel) throws -> String {
        if let element {
            if Self.isSecure(element) { throw JosiError(message: "Protected field.") }
            AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
               AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) == .success { return "value" }
            Thread.sleep(forTimeInterval: 0.08)
        }
        for character in text {
            try cancel.check(); try Self.checkTarget(pid)
            if character == "\n" { Self.key(CGKeyCode(kVK_Return), flags: []); continue }
            if character == "\r" { continue }
            let units = Array(String(character).utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                Self.post(event)
            }
            Thread.sleep(forTimeInterval: 0.006)
        }
        return "keystrokes"
    }
    private static let keyCodes: [String: Int] = [
        "enter": kVK_Return, "return": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape, "esc": kVK_Escape, "backspace": kVK_Delete,
        "delete": kVK_ForwardDelete, "del": kVK_ForwardDelete, "space": kVK_Space, "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow,
        "right": kVK_RightArrow, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9,
        "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H,
        "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P,
        "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
        "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5,
        "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9]
    private func keys(_ combination: String, pid: pid_t, cancel: PcCancel) throws -> String {
        var flags: CGEventFlags = [], key: CGKeyCode?
        for part in combination.lowercased().split(separator: "+").map(String.init) {
            switch part {
            case "cmd", "command", "win", "meta", "super": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "fn": flags.insert(.maskSecondaryFn)
            default:
                guard let code = Self.keyCodes[part] else { throw JosiError(message: "Unknown key: \(part)") }
                key = CGKeyCode(code)
            }
        }
        guard let key else { throw JosiError(message: "No key in: \(combination)") }
        try cancel.check(); try Self.checkTarget(pid)
        Self.key(key, flags: flags)
        return "keys"
    }

    // ------------------------------------------------------------ input
    private static func post(_ event: CGEvent?) {
        guard let event else { return }
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        event.post(tap: .cghidEventTap)
    }
    private static func key(_ code: CGKeyCode, flags: CGEventFlags) {
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            event?.flags = flags
            post(event); Thread.sleep(forTimeInterval: 0.015)
        }
    }
    private static func move(to point: CGPoint) { post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)) }
    private static func mouse(_ type: CGEventType, _ point: CGPoint) { post(CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)) }
    private static func click(_ point: CGPoint, pid: pid_t) throws {
        try checkTarget(pid)
        move(to: point); Thread.sleep(forTimeInterval: 0.04)
        mouse(.leftMouseDown, point); mouse(.leftMouseUp, point)
    }
    private static func drag(_ start: CGPoint, _ end: CGPoint, pid: pid_t, cancel: PcCancel) throws {
        move(to: start); mouse(.leftMouseDown, start)
        defer { mouse(.leftMouseUp, end) }
        for step in 1...24 {
            try cancel.check(); try checkTarget(pid)
            let p = CGPoint(x: start.x + (end.x - start.x) * Double(step) / 24, y: start.y + (end.y - start.y) * Double(step) / 24)
            mouse(.leftMouseDragged, p); Thread.sleep(forTimeInterval: 0.02)
        }
    }
    private static func owner(at point: CGPoint) -> pid_t? {
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success, let element else { return nil }
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }

    // ------------------------------------------------------------ helpers
    private static func focused() -> AXUIElement? { value(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) }
    private static func isSecure(_ element: AXUIElement) -> Bool {
        (value(element, kAXSubroleAttribute) as String?) == (kAXSecureTextFieldSubrole as String)
            || (value(element, kAXRoleAttribute) as String?) == "AXSecureTextField"
    }
    static func value<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success, let raw else { return nil }
        if T.self == AXUIElement.self, CFGetTypeID(raw) == AXUIElementGetTypeID() { return (raw as! AXUIElement) as? T }
        return raw as? T
    }
    private static func point(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        var raw: CFTypeRef?; var point = CGPoint.zero
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success, let raw, CFGetTypeID(raw) == AXValueGetTypeID(),
              AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
        return point
    }
    private static func size(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var raw: CFTypeRef?; var size = CGSize.zero
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success, let raw, CFGetTypeID(raw) == AXValueGetTypeID(),
              AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
        return size
    }
    private static func number(_ value: Wire) -> Double { if case .number(let n) = value { return n }; return 0 }
}
