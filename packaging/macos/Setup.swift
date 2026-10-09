import AppKit
import Foundation

// UI reads only its user-private browser credential, never service secrets.
// The authorized root shell verifies its private copy before executing a helper.
@MainActor final class Setup: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let phase = NSTextField(labelWithString: "Ready to verify the offline Apple Silicon package")
    let elapsed = NSTextField(labelWithString: "")
    let spinner = NSProgressIndicator()
    let install = NSButton(title: "Install Josi CE Server…", target: nil, action: nil)
    let verify = NSButton(title: "Verify package", target: nil, action: nil)
    let open = NSButton(title: "Open Josi", target: nil, action: nil)
    var started: Date?
    var timer: Timer?
    var progress: URL?
    var busy = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 320), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Josi CE Server Setup"
        let title = NSTextField(labelWithString: "Josi CE Server for Apple Silicon")
        title.font = .boldSystemFont(ofSize: 22)
        let copy = NSTextField(wrappingLabelWithString: "Installation may take several minutes. Keep this window open while Josi verifies its files, prepares PostgreSQL, applies migrations and starts each service. Existing data is preserved. Document ingestion stays blocked until a supported scanner is configured and healthy; no scanner is bundled.")
        phase.lineBreakMode = .byWordWrapping
        phase.maximumNumberOfLines = 3
        spinner.style = .spinning
        spinner.isDisplayedWhenStopped = false
        install.target = self; install.action = #selector(beginInstall)
        verify.target = self; verify.action = #selector(beginVerify)
        open.target = self; open.action = #selector(openJosi)
        let buttons = NSStackView(views: [verify, install, open]); buttons.orientation = .horizontal
        let activity = NSStackView(views: [spinner, elapsed]); activity.orientation = .horizontal
        let stack = NSStackView(views: [title, copy, phase, activity, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
        if CommandLine.arguments.contains("--verify-only") { beginVerify() }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if busy { NSSound.beep(); return .terminateCancel }; return .terminateNow
    }
    func tick() {
        guard let start = started else { return }
        elapsed.stringValue = ProgressState.elapsed(start: start, now: Date())
        if let path = progress, let data = try? Data(contentsOf: path), let text = ProgressState.latest(data) { phase.stringValue = text }
    }
    func run(_ executable: String, _ args: [String], label: String) {
        guard !busy else { return }; busy = true; started = Date()
        phase.stringValue = label; spinner.startAnimation(nil); install.isEnabled = false; verify.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = args
            process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
            var success = false
            do { try process.run(); _ = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); success = process.terminationStatus == 0 } catch {}
            let passed = success
            DispatchQueue.main.async {
                self.tick(); self.busy = false; self.started = nil; self.spinner.stopAnimation(nil)
                self.elapsed.stringValue = passed ? "Completed" : "Stopped safely — keep transaction evidence for recovery"
                self.phase.stringValue = passed ? "Package operation completed. See TEST-ME for service and browser acceptance checks." : "Verification or installation did not complete. No success is assumed. If activation began, preserve data and request recovery review."
                self.install.isEnabled = true; self.verify.isEnabled = true
                if passed && self.progress != nil { self.openJosi() }
            }
        }
    }
    @objc func beginVerify() {
        progress = nil
        let runtime = Bundle.main.resourceURL!.appendingPathComponent("runtime")
        run(runtime.appendingPathComponent("python/bin/python3.11").path, ["-I", "-B", runtime.appendingPathComponent("app/native/lifecycle.py").path, "verify"], label: "Verifying every packaged file and pinned inventory")
    }
    func shell(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    @objc func openJosi() {
        let folder = URL(fileURLWithPath: "/Library/Application Support/Josi CE Server/handoff/\(getuid())")
        guard let bytes = try? Data(contentsOf: folder.appendingPathComponent("bootstrap.json")), bytes.count < 4096,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let token = object["token"] as? String, token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let port = object["port"] as? Int, (1024...65535).contains(port) else {
            phase.stringValue = "No private browser handoff is available for this logged-in user. Install first, or use the administrator’s acceptance instructions."; return
        }
        let address = "http://localhost:\(port)"
        Task {
            let target: String
            do { target = try await BrowserHandoff.issue(address: address, bootstrap: token) }
            catch {
                DispatchQueue.main.async { self.phase.stringValue = "Browser handoff unavailable. Wait for readiness, then click Open Josi to retry." }; return
            }
            let encoded = String(data: try! JSONEncoder().encode(target), encoding: .utf8)!
            let html = "<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><title>Open Josi</title><script>location.replace(" + encoded + ")</script>Opening Josi…"
            let page = folder.appendingPathComponent("Open-Josi-" + UUID().uuidString + ".html")
            do {
                try Data(html.utf8).write(to: page, options: [.withoutOverwriting])
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: page.path)
                DispatchQueue.main.async {
                    guard let browser = NSWorkspace.shared.urlForApplication(toOpen: URL(string: address)!) else { self.phase.stringValue = "No default web browser is configured."; return }
                    NSWorkspace.shared.open([page], withApplicationAt: browser, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                        DispatchQueue.main.async { self.phase.stringValue = error == nil ? "Browser opened. Complete setup there; the one-use link expires shortly." : "Browser could not open. Click Open Josi to retry." }
                    }
                }
            } catch { DispatchQueue.main.async { self.phase.stringValue = "Private browser handoff could not be written." } }
        }
    }
    @objc func beginInstall() {
        let id = UUID().uuidString.lowercased()
        let log = "/Library/Application Support/josi-setup-\(id).jsonl"
        progress = URL(fileURLWithPath: log)
        let requirement = "anchor apple generic and identifier \"com.heyjosi.ce.setup\" and certificate leaf[subject.OU] = \"LRH75YR6QW\" and certificate leaf[subject.CN] = \"Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)\""
        let script = "set -eu; umask 022; stage=$(/usr/bin/mktemp -d '/Library/Application Support/.josi-setup.XXXXXXXX'); /bin/chmod 700 \"$stage\"; /usr/bin/ditto --noqtn " + shell(Bundle.main.bundlePath) + " \"$stage/Setup.app\"; /usr/bin/codesign --verify --deep --strict -R " + shell(requirement) + " \"$stage/Setup.app\"; set -C; /usr/bin/env -i PATH=/usr/bin:/bin \"$stage/Setup.app/Contents/Resources/runtime/python/bin/python3.11\" -I -B \"$stage/Setup.app/Contents/Resources/runtime/app/native/lifecycle.py\" install \(getuid()) > " + shell(log)
        // JSON string quoting is also valid AppleScript string quoting for this
        // fixed ASCII command; paths are separately POSIX-shell quoted above.
        let quoted = String(data: try! JSONEncoder().encode(script), encoding: .utf8)!
        run("/usr/bin/osascript", ["-e", "do shell script " + quoted + " with administrator privileges"], label: "Waiting for administrator authorization, then verifying the signed private copy")
    }
}
@main struct SetupMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = Setup()
        app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
    }
}
