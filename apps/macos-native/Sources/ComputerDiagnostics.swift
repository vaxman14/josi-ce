import AppKit
import SwiftUI
import ApplicationServices

/// Local support check in the shipping app. It has no HTTP entry point, reads
/// no account material, and exercises only its own disposable document.
@MainActor final class ComputerDiagnostics: ObservableObject {
    static let shared = ComputerDiagnostics()
    @Published private(set) var status = "Ready"
    @Published private(set) var results: [String] = []
    @Published private(set) var running = false
    @Published private(set) var awaitingInput = false
    @Published private(set) var reportPath = ""
    private var window: NSWindow?
    private var task: Task<Void, Never>?
    private var gate: ComputerLocalGate?
    private var inputAcknowledged = false
    func present() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 460),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Josi · Computer Control Check"; w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: ComputerDiagnosticsView(check: self)); w.center(); window = w
        }
        window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func acknowledgeInput() { inputAcknowledged = true }
    func stop() { gate?.stop("Stopped locally during the check"); task?.cancel() }
    func run() {
        guard !running else { return }
        running = true; results = []; awaitingInput = false; inputAcknowledged = false
        task = Task { await perform() }
    }
    private func perform() async {
        let folder = URL(fileURLWithPath: "/private/tmp/Josi-Control-Check-" + UUID().uuidString.lowercased(), isDirectory: true)
        let document = folder.appendingPathComponent("Josi-control-check.txt")
        let local = ComputerLocalGate(), overlay = ComputerOverlay(gate: local), desktop = ComputerDesktop(gate: local, overlay: overlay)
        gate = local
        let owner = UUID().uuidString.lowercased(), deviceId = "mac-local-diagnostic", taskId = UUID().uuidString.lowercased()
        let appURL = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        var appIdentity = ""
        func writeReport(_ state: String) {
            let value: Wire = ["state": .string(state), "checks": .array(results.map(Wire.string)),
                "bundleId": .string(Bundle.main.bundleIdentifier ?? ""),
                "version": .string(Bundle.main.object(forInfoDictionaryKey: "JosiReleaseVersion") as? String ?? ""),
                "appPath": .string(Bundle.main.bundlePath), "document": .string(document.path)]
            if let data = try? JSONEncoder().encode(value) { try? data.write(to: folder.appendingPathComponent("result.json"), options: .atomic) }
        }
        func passed(_ name: String) { results.append(name); status = name; writeReport("running") }
        func require(_ ok: Bool, _ message: String) throws { if !ok { throw JosiError(message: message) } }
        func request(_ action: String, _ args: Wire = [:], scope: Wire? = nil, lease: Int = 10000) -> (Wire, Wire) {
            let now = Int(Date().timeIntervalSince1970 * 1000), id = UUID().uuidString.lowercased()
            let scope = scope ?? ["kind": "application", "target": .string(appIdentity)]
            let operation: Wire = ["action": .string(action), "scope": scope, "args": args]
            let q: Wire = ["id": .string(id), "ownerId": .string(owner), "deviceId": .string(deviceId), "taskId": .string(taskId),
                "revision": .number(1), "state": "running", "createdAt": .number(Double(now)),
                "expiresAt": .number(Double(now + 60000)), "leaseUntil": .number(Double(now + lease)), "operation": operation]
            let device: Wire = ["id": .string(deviceId), "revision": .number(1), "stopped": .bool(false), "revoked": .bool(false),
                "capabilities": .array([.string(action)]), "rules": .array([["id": .string(id), "action": .string(action),
                    "scope": scope, "decision": "allow", "duration": ["kind": "once", "requestId": .string(id)]]])]
            return (q, device)
        }
        func begin(_ q: Wire, _ device: Wire) throws { try local.begin(q, device: device, owner: owner, deviceId: deviceId) }
        func file(_ action: String, _ args: Wire) throws -> Wire {
            let (q,d) = request(action,args,scope:["kind":"folder","target":.string(folder.path)])
            try begin(q,d); defer { local.finish() }; try local.check()
            return try ComputerFiles.execute(q["operation"])
        }
        func desktopAction(_ action: String, _ args: Wire = [:]) async throws -> Wire {
            let (q,d) = request(action,args); try begin(q,d); defer { local.finish() }
            return try await desktop.execute(q)
        }
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success ? value : nil
        }
        func ownWindow(_ app: NSRunningApplication) throws -> AXUIElement {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            guard let raw = attribute(root,kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
                throw JosiError(message: "TextEdit has no focused diagnostic document.")
            }
            let w = unsafeDowncast(raw,to:AXUIElement.self)
            guard let path = attribute(w,kAXDocumentAttribute) as? String, let url = URL(string:path),
                  url.standardizedFileURL == document.standardizedFileURL else {
                throw JosiError(message: "The focused document is not this check’s disposable file. No input was sent.")
            }
            return w
        }
        func textArea(_ root: AXUIElement) -> AXUIElement? {
            var queue = [root], count = 0
            while !queue.isEmpty, count < 120 {
                let item = queue.removeFirst(); count += 1
                if attribute(item,kAXRoleAttribute) as? String == kAXTextAreaRole { return item }
                queue += attribute(item,kAXChildrenAttribute) as? [AXUIElement] ?? []
            }
            return nil
        }
        defer { local.stop(); overlay.shutdown(); gate = nil; awaitingInput = false; running = false }
        do {
            try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
            reportPath = folder.appendingPathComponent("result.json").path
            try require(AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() && CGPreflightListenEventAccess(), "Mac permissions are unavailable. Review them in Computer Control.")
            passed("All three macOS permissions are granted")
            appIdentity = try ComputerDesktop.identity(appURL)
            local.resume()
            let original = "Josi computer control check — disposable document.\n"
            _ = try file("file.write",["path":.string(document.path),"text":.string(original),"expectedDigest":""])
            let read = try file("file.read",["path":.string(document.path)])
            try require(read["text"].text == original,"Scoped file round trip did not match.")
            passed("Scoped file create and read matched")
            let config = NSWorkspace.OpenConfiguration(); config.activates = true
            let app = try await NSWorkspace.shared.open([document],withApplicationAt:appURL,configuration:config)
            app.activate()
            for _ in 0..<30 { if (try? ownWindow(app)) != nil { break }; try await Task.sleep(for:.milliseconds(100)) }
            _ = try ownWindow(app)
            overlay.start(); try require(overlay.inputAvailable,"The physical input monitor could not start.")
            passed("Signed TextEdit identity and physical input monitor verified")
            let observed = try await desktopAction("window.read")
            guard let editor = observed["nodes"].list.first(where: { $0["role"].text == kAXTextAreaRole }) else { throw JosiError(message:"TextEdit did not expose a bounded text editor.") }
            passed("Actual TextEdit accessibility observation succeeded")
            let typed = "Josi typed this into its disposable TextEdit document.\n"
            _ = try ownWindow(app)
            _ = try await desktopAction("window.type",["observationId":observed["observationId"],"elementId":editor["id"],"text":.string(typed)])
            guard let area = textArea(try ownWindow(app)) else { throw JosiError(message:"The diagnostic editor disappeared.") }
            try require(attribute(area,kAXValueAttribute) as? String == typed,"TextEdit did not contain the exact typed text.")
            passed("Actual structured text input matched exactly")
            let captured = try await desktopAction("window.capture")
            guard let jpeg = Data(base64Encoded:captured["image"]["data"].text), !jpeg.isEmpty else { throw JosiError(message:"The window screenshot was empty.") }
            try jpeg.write(to:folder.appendingPathComponent("TextEdit.jpg"))
            passed("Actual ScreenCaptureKit window capture succeeded")
            let stale = captured["observationId"]
            let scroll = try await desktopAction("window.scroll",["observationId":stale,"deltaY":.number(80)])
            try require(scroll["performed"].flag,"Scroll did not dispatch.")
            passed("Targeted scroll dispatched to the approved TextEdit window")
            var refused = false
            do { _ = try await desktopAction("window.type",["observationId":stale,"elementId":editor["id"],"text":"stale input must not run"]) }
            catch { refused = true }
            try require(refused,"A consumed observation accepted another input.")
            passed("Stale observation input was refused")
            // The check now waits for a real event from outside Josi. No fake
            // event or direct takeover call can satisfy this stage.
            let (waiting,device) = request("window.read"); try begin(waiting,device)
            status = "Verify takeover using the button below"; awaitingInput = true
            present(); writeReport("awaiting-input")
            for _ in 0..<150 {
                if local.mode == .takeover && inputAcknowledged { break }
                try Task.checkCancellation()
                if local.mode == .working { try local.renew(Int(Date().timeIntervalSince1970 * 1000)+10000,revision:1) }
                try await Task.sleep(for:.milliseconds(200))
            }
            try require(local.mode == .takeover && inputAcknowledged,"Physical input takeover was not observed.")
            awaitingInput = false; passed("External physical input immediately took control")
            refused = false; do { try local.check() } catch { refused = true }
            try require(refused,"Takeover left the old operation authorized.")
            passed("Takeover invalidated the execution lease")
            local.resume(); let (stopRequest,stopDevice) = request("window.read"); try begin(stopRequest,stopDevice)
            local.stop("Offline Stop check")
            refused = false; do { _ = try await desktop.execute(stopRequest) } catch { refused = true }
            try require(refused,"Offline Stop did not prevent another action.")
            passed("Local Stop blocked control without a server connection")
            // Close only the known diagnostic document. Another existing
            // TextEdit window is never used as a cleanup target.
            app.activate(); _ = try ownWindow(app); local.resume()
            let closing = try await desktopAction("window.read")
            _ = try await desktopAction("window.close",["observationId":closing["observationId"]])
            passed("Close dispatched only to the disposable TextEdit document")
            status = "Passed"; writeReport("passed"); present()
        } catch {
            status = error is CancellationError ? "Stopped locally" : "Stopped: " + error.localizedDescription
            writeReport(status); present()
        }
    }
}
private struct ComputerDiagnosticsView: View {
    @ObservedObject var check: ComputerDiagnostics
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            Text("Computer Control Check").font(.title2)
            Text("Checks the installed control code using a disposable TextEdit document. Moving your mouse or using your keyboard interrupts control.").font(.callout)
            Text(check.status).font(.headline)
            ScrollView { VStack(alignment:.leading,spacing:6) { ForEach(Array(check.results.enumerated()),id:\.offset) { _,result in Text("✓ " + result).font(.caption) } } }
            if check.awaitingInput { Button("Verify Physical Takeover") { check.acknowledgeInput() } }
            HStack {
                Button("Run Check") { check.run() }.disabled(check.running)
                Button("Stop",role:.destructive) { check.stop() }.disabled(!check.running)
            }
            if !check.reportPath.isEmpty { Text(check.reportPath).font(.caption2).textSelection(.enabled) }
        }.padding(20).frame(minWidth:580,minHeight:420)
    }
}
