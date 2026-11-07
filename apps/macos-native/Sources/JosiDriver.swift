#if DEBUG
import AppKit
import Foundation

/// Debug builds only: runs one command per line from $JOSI_DRIVE_FILE, so the
/// app can be exercised against a test server without taking over the screen.
@MainActor enum JosiDriver {
    private static var path: String? { ProcessInfo.processInfo.environment["JOSI_DRIVE_FILE"] }
    static func log(_ text: String) {
        guard let path, let handle = FileHandle(forWritingAtPath: path + ".log") ?? create(path + ".log") else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        handle.write(Data("\(Date().timeIntervalSince1970) \(text)\n".utf8))
    }
    private static func create(_ path: String) -> FileHandle? {
        FileManager.default.createFile(atPath: path, contents: nil); return FileHandle(forWritingAtPath: path)
    }
    static func start(_ model: JosiModel) {
        guard let path else { return }
        Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
                try? "".write(toFile: path, atomically: false, encoding: .utf8)
                for line in text.split(separator: "\n") { await run(String(line), model) }
            }
        }
    }
    private static func run(_ line: String, _ model: JosiModel) async {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let rest = parts.count > 1 ? parts[1] : ""
        do {
            switch parts.first ?? "" {
            case "connect": try await model.connect(rest, local: JosiFlags.serverApp)
            case "login":
                let pair = rest.split(separator: " ", maxSplits: 1).map(String.init)
                guard pair.count == 2 else { break }
                try await model.signIn(identifier: pair[0], password: pair[1], remember: false)
            case "keep":
                let pair = rest.split(separator: " ", maxSplits: 1).map(String.init)
                guard pair.count == 2 else { break }
                try await model.signIn(identifier: pair[0], password: pair[1], remember: true)
            case "code": try await model.verifyMFA(rest)
            case "section": model.section = rest; if rest == "chat" || rest == "tasks" { try await model.reloadWorkspace() }
            case "draft": model.draft = rest
            case "send": model.draft = rest; try await model.send()
            case "new": try await model.newThread()
            case "sidebar": model.toggleSidebar()
            case "server": model.openServerControls()
            case "signout": try await model.signOut()
            case "activate": NSApp.activate(ignoringOtherApps: true); NSApp.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil)
            case "click":
                let point = rest.split(separator: " ").compactMap { Double($0) }
                guard point.count == 2, let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.canBecomeMain }) else { break }
                let at = NSPoint(x: point[0], y: window.frame.height - point[1])
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    if let event = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { window.sendEvent(event) }
                }
            case "type":
                let window = NSApp.keyWindow ?? NSApp.windows.first { $0.canBecomeMain }
                guard let editor = window?.firstResponder as? NSTextView else { log("no text field has focus: \(String(describing: window?.firstResponder))"); break }
                editor.insertText(rest, replacementRange: editor.selectedRange())
            default: break
            }
            log("ok \(parts.first ?? "") screen=\(model.screen) section=\(model.section) error=\(model.error)")
        } catch { log("failed \(parts.first ?? ""): \(error.localizedDescription)") }
    }
}
#endif
