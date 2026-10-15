import AppKit
import Foundation
import Darwin

@MainActor final class ServerApp: NSObject, NSApplicationDelegate {
    let product = URL(fileURLWithPath: "/Library/Application Support/Josi CE Server")
    var window: NSWindow!
    var state = InstallerState.waiting
    let heading = NSTextField(labelWithString: "Welcome to Josi")
    let detail = NSTextField(wrappingLabelWithString: "Checking Josi…")
    let activity = NSTextField(labelWithString: "")
    let folderLabel = NSTextField(wrappingLabelWithString: "Connect a local folder as /workspace, or continue without folder access.")
    let logLabel = NSTextField(wrappingLabelWithString: "")
    let open = NSButton(title: "Open Josi in Browser", target: nil, action: nil)
    let choose = NSButton(title: "Choose Folder…", target: nil, action: nil)
    let decline = NSButton(title: "No Folder Access", target: nil, action: nil)
    let desktop = NSButton(title: "Open Desktop Client", target: nil, action: nil)
    let copyLog = NSButton(title: "Copy Diagnostics", target: nil, action: nil)
    let repair = NSButton(title: "Restore Previous Version…", target: nil, action: nil)
    let remove = NSButton(title: "Uninstall Josi…", target: nil, action: nil)
    let privacy = NSButton(title: "Open Full Disk Access Settings…", target: nil, action: nil)
    let reveal = NSButton(title: "Show Josi Server in Finder", target: nil, action: nil)
    let spinner = NSProgressIndicator()
    var log: URL?
    var started = Date()
    var timer: Timer?
    var busy = false
    var probing = false
    var port = 8080
    var completedProgress = false
    var maintenanceFailure: String?
    var folderPrivacyDenied = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0,y: 0,width: 640,height: 660),styleMask: [.titled,.closable,.miniaturizable,.resizable],backing: .buffered,defer: false)
        window.contentMinSize = NSSize(width: 640, height: 660)
        window.title = "Josi Server"
        let artwork = JosiArtworkView(logo: NSImage(named: "Josi") ?? NSImage())
        heading.font = .boldSystemFont(ofSize: 26)
        detail.font = .systemFont(ofSize: 14); detail.maximumNumberOfLines = 4
        folderLabel.font = .systemFont(ofSize: 13)
        logLabel.font = .systemFont(ofSize: 11);logLabel.isSelectable = true
        spinner.style = .spinning;spinner.isDisplayedWhenStopped = false
        open.target = self;open.action = #selector(openBrowser)
        choose.target = self;choose.action = #selector(chooseFolder)
        decline.target = self;decline.action = #selector(declineFolder)
        desktop.target = self;desktop.action = #selector(openDesktop)
        copyLog.target = self;copyLog.action = #selector(copyDiagnostics)
        repair.target = self;repair.action = #selector(restorePrevious)
        remove.target = self;remove.action = #selector(uninstallServer)
        privacy.target = self;privacy.action = #selector(openPrivacy)
        reveal.target = self;reveal.action = #selector(revealServer)
        let progress = NSStackView(views: [spinner,activity]);progress.spacing = 8
        let folders = NSStackView(views: [choose,decline]);folders.spacing = 10
        let actions = NSStackView(views: [open,desktop]);actions.spacing = 10
        let maintenance = NSStackView(views: [copyLog,repair,remove]);maintenance.spacing = 8
        let permissions = NSStackView(views: [privacy,reveal]);permissions.spacing = 8;permissions.detachesHiddenViews = true
        let stack = NSStackView(views: [artwork,heading,detail,progress,folderLabel,folders,permissions,actions,logLabel,maintenance])
        stack.orientation = .vertical;stack.alignment = .leading;stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([artwork.widthAnchor.constraint(equalTo: stack.widthAnchor),stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor,constant: 28),stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor,constant: -28),stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor,constant: 28),stack.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor,constant: -24)])
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--progress" {
            let candidate = URL(fileURLWithPath: CommandLine.arguments[2])
            if candidate.deletingLastPathComponent().path == "/Library/Logs/Josi CE Server" && candidate.lastPathComponent.hasPrefix("Install-") && candidate.pathExtension == "jsonl" { log = candidate;state = .working }
        }
        window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps: true)
        applyState();tick()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5,repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
    }
    func applyState() {
        open.isEnabled = state.canOpen && !busy;choose.isEnabled = state.canChangeFolder && !busy
        decline.isEnabled = choose.isEnabled;remove.isEnabled = !busy && FileManager.default.fileExists(atPath:"/Applications/Uninstall Josi.app")
        desktop.isHidden = !FileManager.default.fileExists(atPath: "/Applications/Josi CE.app")
        desktop.isEnabled = open.isEnabled
        repair.isHidden = state != .failed;repair.isEnabled = state == .failed && !busy
        copyLog.isEnabled = log != nil
        privacy.isHidden = !folderPrivacyDenied;reveal.isHidden = !folderPrivacyDenied
        privacy.isEnabled = !busy;reveal.isEnabled = !busy
        if state == .working || busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        if let log { logLabel.stringValue = "Diagnostic log: " + log.path }
    }
    func tick() {
        if busy { activity.stringValue = ProgressState.elapsed(start: started,now: Date());return }
        if let log, !completedProgress, log.pathExtension == "jsonl" {
            state = .working;activity.stringValue = ProgressState.elapsed(start: started,now: Date())
            if let data = try? Data(contentsOf: log), data.count <= 1024*1024,
               let text = String(data: data,encoding: .utf8) {
                let lines = text.split(separator: "\n")
                let first = lines.first.flatMap { try? JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:Any] }
                for line in lines.reversed() {
                    guard let event = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                    state = InstallerState.from(event)
                    detail.stringValue = InstallerState.phase(event["phase"] as? String ?? "",service: event["service"] as? String ?? "")
                    if state == .ready { completedProgress = true;heading.stringValue = "Josi is ready";detail.stringValue = "Choose a folder or continue without access, then open Josi to finish setup.";activity.stringValue = "Installation complete" }
                    if state == .failed {
                        completedProgress = true;heading.stringValue = "Installation stopped"
                        activity.stringValue = "Stopped · " + ProgressState.elapsed(start: started,now: Date()).replacingOccurrences(of: " · working", with: "")
                        detail.stringValue = (event["operation"] as? String == "verification" ? "Josi could not verify its installation files." : "Josi could not finish installation.") + " Your data is retained. Copy Diagnostics for the cause and log location. A previous version can be restored only when it is safe."
                    }
                    break
                }
                if state == .working, let pid = first?["pid"] as? Int32, Darwin.kill(pid,0) != 0 && errno == ESRCH {
                    state = .failed;completedProgress = true;heading.stringValue = "Installation stopped"
                    activity.stringValue = "Stopped"
                    detail.stringValue = "The installer ended without a completion result. Your data is retained. Copy Diagnostics before trying to restore a previous version."
                }
            }
            applyState();return
        }
        guard state != .failed && state != .removed && !probing else { return }
        guard let bytes = try? Data(contentsOf: product.appendingPathComponent("status.json")),
              let receipt = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], receipt["installed"] as? Bool == true,
              let currentPort = receipt["publicPort"] as? Int, (1024...65535).contains(currentPort) else {
            detail.stringValue = "Josi is not installed or has been uninstalled. Open the Josi installer package to install it.";state = .waiting;applyState();return
        }
        port = currentPort;probing = true
        Task {
            defer { probing = false }
            var request = URLRequest(url: URL(string: "http://localhost:\(port)/ready")!);request.timeoutInterval = 3
            do {
                let (_,response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain:"JosiReady",code:1) }
                state = .ready;heading.stringValue = folderPrivacyDenied ? "Allow folder access" : (maintenanceFailure == nil ? "Josi is ready" : "Folder connection not changed")
                if !completedProgress { detail.stringValue = "Open Josi in your browser to finish setup. Your server runs locally on this Mac." }
            } catch { state = .waiting;detail.stringValue = "Josi is starting or unavailable. This window will check again." }
            applyState()
        }
    }
    @objc func copyDiagnostics() {
        guard let log else { return }
        var text = "Josi diagnostic log: " + log.path + "\n"
        if let bytes = try? Data(contentsOf: log), bytes.count <= 1024*1024 { text += DiagnosticLog.redact(String(decoding:bytes,as:UTF8.self)) }
        NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string)
    }
    func confirmation(_ title: String,_ message: String,_ action: String) -> Bool {
        let alert = NSAlert();alert.messageText = title;alert.informativeText = message
        alert.addButton(withTitle: action);alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
    func shell(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'",with: "'\\''") + "'" }
    @objc func openPrivacy() {
        NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
    }
    @objc func revealServer() { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
    func folderPermissionPrompt() {
        let alert = NSAlert();alert.messageText = "Allow Josi Server to read this folder?"
        alert.informativeText = "macOS blocked folder access. Open Full Disk Access settings, add and enable Josi Server at " + Bundle.main.bundleURL.path + ". Then quit and reopen this Josi Server window and choose the folder again. This is separate from Uninstall Josi’s permission. Full Disk Access is broad access and remains enabled until you turn it off; revoking it may stop access to protected folders. Your previous connection and data are retained."
        alert.addButton(withTitle:"Open Full Disk Access Settings…");alert.addButton(withTitle:"Not Now")
        if alert.runModal() == .alertFirstButtonReturn { openPrivacy() }
    }
    func helper(_ operation: String,_ path: String? = nil,_ selectedURL: URL? = nil) {
        guard !busy else { return }
        let record: DiagnosticLog
        do { record = try DiagnosticLog(directory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Josi CE Server/Setup"),operation:operation) }
        catch { detail.stringValue = "Cannot save diagnostics. Check that your home folder is writable.";return }
        let hasScopedAccess = selectedURL?.startAccessingSecurityScopedResource() ?? false
        log = record.url;completedProgress = true;busy = true;folderPrivacyDenied = false;started = Date();detail.stringValue = "Waiting for administrator authorization…";applyState()
        let requirement = "=anchor apple generic and identifier \"com.heyjosi.ce.server\" and certificate leaf[subject.OU] = \"LRH75YR6QW\" and certificate leaf[subject.CN] = \"Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)\""
        let runtime = "/Applications/Josi Server.app/Contents/Resources/runtime"
        let command = "set -eu; /usr/bin/codesign --verify --deep --strict -R " + shell(requirement) + " '/Applications/Josi Server.app'; /usr/bin/env -i PATH=/usr/bin:/bin " + shell(runtime + "/python/bin/python3.11") + " -I -B " + shell(runtime + "/app/native/maintenance.py") + " " + shell(operation) + (path.map { " " + shell($0) } ?? "")
        maintenanceFailure = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process();process.executableURL = URL(fileURLWithPath:"/usr/bin/osascript");process.arguments = ["-e",NativeAuthorization.script(command)]
            process.environment = ["PATH":"/usr/bin:/bin:/usr/sbin:/sbin"]
            let pipe = Pipe();process.standardOutput = pipe;process.standardError = pipe
            var success = false
            var permissionDenied = false
            var failureCause: String?
            do { try process.run();let bytes = pipe.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit();try record.append(String(decoding:bytes,as:UTF8.self));try record.append("Exit: \(process.terminationStatus)\n");success = process.terminationStatus == 0 }
            catch { try? record.append(error.localizedDescription) }
            if !success,operation == "workspace",let text = try? String(contentsOf:record.url,encoding:.utf8) { permissionDenied = DiagnosticLog.requiresFullDiskAccess(in:text);failureCause = DiagnosticLog.failureCause(in:text) }
            let passed = success;let needsPermission = permissionDenied;let reportedCause = failureCause
            DispatchQueue.main.async {
                if hasScopedAccess { selectedURL?.stopAccessingSecurityScopedResource() }
                self.busy = false
                if passed && operation == "uninstall" { self.state = .removed;self.heading.stringValue = "Josi Server uninstalled";self.detail.stringValue = "The server is stopped. Your data and recovery copies are retained for reinstalling. The optional desktop client can be removed separately by moving Josi CE.app to Trash." }
                else if passed { self.state = .ready;self.heading.stringValue = "Josi is ready";self.detail.stringValue = "Saved. Josi is ready.";self.folderLabel.stringValue = operation == "workspace" ? (path?.isEmpty == false ? "Connected as /workspace (read only): " + path! : "Folder access declined.") : self.folderLabel.stringValue }
                else { self.state = InstallerState.afterMaintenanceFailure(operation);self.maintenanceFailure = operation;self.heading.stringValue = operation == "workspace" ? "Folder connection not changed" : "Change not completed";self.detail.stringValue = operation == "workspace" ? "Josi could not save this folder connection. Your previous connection and data are retained. Copy Diagnostics for the exact cause. If macOS denies access, check Josi’s privacy permissions or choose a shared folder." : "The change did not complete. Your data is retained. Copy Diagnostics for details." }
                self.activity.stringValue = passed ? "Completed" : "Stopped";self.applyState()
                if !passed,operation == "workspace",let reportedCause { self.detail.stringValue = reportedCause + " Your previous connection and data are retained. Copy Diagnostics for details." }
                if needsPermission {
                    self.folderPrivacyDenied = true;self.heading.stringValue = "Allow folder access"
                    self.detail.stringValue = "macOS blocked this folder. Enable Josi Server in Full Disk Access, quit and reopen this window, then choose the folder again. Your previous connection and data are retained."
                    self.window.contentMinSize = NSSize(width:640,height:720)
                    if self.window.contentView!.bounds.height < 720 { self.window.setContentSize(NSSize(width:self.window.contentView!.bounds.width,height:720)) }
                    self.applyState();self.folderPermissionPrompt()
                }
            }
        }
    }
    @objc func chooseFolder() {
        guard state.canChangeFolder && !busy else { return }
        let panel = NSOpenPanel();panel.canChooseDirectories = true;panel.canChooseFiles = false;panel.allowsMultipleSelection = false
        panel.title = "Choose Josi’s workspace folder";panel.message = "Josi can read files in this folder as /workspace. File changes stay disabled. Choose a folder readable by the local server. You can change or disconnect it later.";panel.prompt = "Connect Folder"
        guard panel.runModal() == .OK, let url = panel.url,
              confirmation("Connect this folder?","Josi’s server and background tasks will receive read-only access to \(url.path). Administrator authorization adds folder-specific read permissions and access through its parent folders, then restarts Josi. Write permissions are unchanged. Disconnecting or uninstalling removes permissions added by Josi.","Connect") else { return }
        helper("workspace",url.path,url)
    }
    @objc func declineFolder() {
        guard state.canChangeFolder && confirmation("Disconnect folder access?","Administrator authorization removes the workspace connection and restarts Josi. Your files are retained.","Disconnect") else { return }
        helper("workspace","")
    }
    @objc func restorePrevious() {
        guard state == .failed && confirmation("Restore the previous version?","Administrator authorization is required. Josi restores a verified previous version only when no new-version activity has begun. Otherwise it keeps all data and explains the refusal in Diagnostics.","Restore") else { return }
        helper("recover-latest")
    }
    @objc func uninstallServer() {
        guard !busy else { return }
        NSWorkspace.shared.openApplication(at:URL(fileURLWithPath:"/Applications/Uninstall Josi.app"),configuration:NSWorkspace.OpenConfiguration()) { _,error in
            if error != nil { DispatchQueue.main.async { self.detail.stringValue = "Open Uninstall Josi from the installer disk image to remove this installation." } }
        }
    }
    @objc func openDesktop() { guard state.canOpen && !busy else { return };NSWorkspace.shared.openApplication(at:URL(fileURLWithPath:"/Applications/Josi CE.app"),configuration:NSWorkspace.OpenConfiguration()) { _,_ in } }
    @objc func openBrowser() {
        guard state.canOpen && !busy else { return }
        let folder = product.appendingPathComponent("handoff/\(getuid())")
        guard let bytes = try? Data(contentsOf:folder.appendingPathComponent("bootstrap.json")),bytes.count<4096,
              let value = try? JSONSerialization.jsonObject(with:bytes) as? [String:Any], let token = value["token"] as? String else { detail.stringValue = "This Mac user has no setup link. Use the account that installed Josi.";return }
        Task {
            do {
                let address = "http://localhost:\(port)"
                let target = try await BrowserHandoff.issue(address:address,bootstrap:token)
                let encoded = String(data:try JSONEncoder().encode(target),encoding:.utf8)!
                let page = folder.appendingPathComponent("Open-Josi-" + UUID().uuidString + ".html")
                let html = "<!doctype html><meta charset=utf-8><meta name=referrer content=no-referrer><title>Josi</title><script>location.replace(" + encoded + ")</script>Opening Josi…"
                try Data(html.utf8).write(to:page,options:.withoutOverwriting);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:page.path)
                guard let browser = NSWorkspace.shared.urlForApplication(toOpen:URL(string:address)!) else { throw NSError(domain:"JosiBrowser",code:1) }
                NSWorkspace.shared.open([page],withApplicationAt:browser,configuration:NSWorkspace.OpenConfiguration()) { _,_ in }
            } catch { detail.stringValue = "The browser setup link could not open. Check Josi’s status, then try again." }
        }
    }
}
@main struct ServerMain {
    @MainActor static func main() {
        let app = NSApplication.shared;let delegate = ServerApp();app.setActivationPolicy(.regular);app.delegate = delegate;app.run()
    }
}
