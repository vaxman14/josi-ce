import AppKit
import Foundation
import Darwin

@MainActor final class UninstallApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let choice = NSPopUpButton()
    let heading = NSTextField(labelWithString:"Uninstall Josi")
    let detail = NSTextField(wrappingLabelWithString:"")
    let progress = NSTextField(wrappingLabelWithString:"")
    let button = NSButton(title:"Uninstall…",target:nil,action:nil)
    let copy = NSButton(title:"Copy Diagnostics",target:nil,action:nil)
    let spinner = NSProgressIndicator()
    var busy = false
    var output = ""
    var operation = UUID().uuidString
    var timer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu();let item = NSMenuItem();menu.addItem(item)
        let appMenu = NSMenu();item.submenu = appMenu
        let quit = NSMenuItem(title:"Quit Uninstall Josi",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q");quit.target = NSApp;appMenu.addItem(quit);NSApp.mainMenu = menu
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:500),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title = "Uninstall Josi";window.contentMinSize = NSSize(width:600,height:500);window.delegate = self
        let artwork = JosiArtworkView(logo:NSImage(named:"Josi") ?? NSImage())
        heading.font = .boldSystemFont(ofSize:24)
        choice.addItems(withTitles:["Uninstall — keep my data","Complete removal — delete all Josi data"])
        choice.target = self;choice.action = #selector(updateChoice)
        detail.font = .systemFont(ofSize:14)
        button.target = self;button.action = #selector(start)
        copy.target = self;copy.action = #selector(copyDiagnostics);copy.isEnabled = false
        spinner.style = .spinning;spinner.isDisplayedWhenStopped = false
        let actions = NSStackView(views:[button,copy]);actions.spacing = 12
        let status = NSStackView(views:[spinner,progress]);status.spacing = 10
        let stack = NSStackView(views:[artwork,heading,choice,detail,status,actions]);stack.orientation = .vertical;stack.alignment = .leading;stack.spacing = 18;stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([artwork.widthAnchor.constraint(equalTo:stack.widthAnchor),stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:28),stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-28),stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:28),stack.bottomAnchor.constraint(lessThanOrEqualTo:window.contentView!.bottomAnchor,constant:-24)])
        updateChoice();window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        timer = Timer.scheduledTimer(withTimeInterval:0.4,repeats:true) { [weak self] _ in Task { @MainActor in self?.poll() } }
    }
    @objc func updateChoice() {
        detail.stringValue = choice.indexOfSelectedItem == 0
            ? "Removes Josi Server, the desktop client and automatic startup. Your chats, attachments, settings and recovery copies remain for reinstalling. Folder access added by Josi is disconnected."
            : "Permanently removes Josi apps, chats, attachments, settings, saved Josi sign-ins, recovery copies, background services and local caches. Connected workspace files are kept."
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { !busy }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !busy }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { busy ? .terminateCancel : .terminateNow }
    func poll() {
        guard busy,let data = try? Data(contentsOf:URL(fileURLWithPath:"/Library/Application Support/Josi Uninstall/status.json")),data.count<4096,
              let value = try? JSONSerialization.jsonObject(with:data) as? [String:Any],value["operation"] as? String == operation,
              let phase = value["phase"] as? String else { return }
        progress.stringValue = phase
    }
    @objc func copyDiagnostics() { NSPasteboard.general.clearContents();NSPasteboard.general.setString(DiagnosticLog.redact(output),forType:.string) }
    @objc func start() {
        guard !busy else { return }
        let erase = choice.indexOfSelectedItem == 1
        let alert = NSAlert();alert.messageText = erase ? "Permanently remove Josi and its data?" : "Uninstall Josi and keep your data?"
        alert.informativeText = detail.stringValue + "\n\nJosi will close its server and desktop windows. Your workspace folders, signing certificates and development files are kept. macOS will request administrator authorization."
        alert.addButton(withTitle:erase ? "Delete Josi and its data" : "Uninstall Josi");alert.addButton(withTitle:"Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        busy = true;button.isEnabled = false;choice.isEnabled = false;spinner.startAnimation(nil);operation = UUID().uuidString
        progress.stringValue = "Closing Josi windows…"
        for identifier in ["com.heyjosi.ce.server","com.romanvaxman.josi.desktop"] {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier:identifier) { app.terminate() }
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+2) {
            guard self.busy else { return }
            for identifier in ["com.heyjosi.ce.server","com.romanvaxman.josi.desktop"] {
                for app in NSRunningApplication.runningApplications(withBundleIdentifier:identifier) { app.forceTerminate() }
            }
        }
        let bundle = Bundle.main.bundleURL.path
        let requirement = "=anchor apple generic and identifier \"com.heyjosi.ce.uninstaller\" and certificate leaf[subject.OU] = \"LRH75YR6QW\" and certificate leaf[subject.CN] = \"Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)\""
        // Copy into a fresh root-owned directory before verifying and executing.
        // Neither a writable DMG copy nor deletion of this app can replace the
        // authorized helper between verification and execution.
        let command = "set -eu; task_stage=$(/usr/bin/mktemp -d /private/tmp/josi-uninstall.XXXXXXXX); trap '/bin/rm -rf \"$task_stage\"' EXIT; /usr/bin/ditto --norsrc --noextattr " + NativeAuthorization.shell(bundle) + " \"$task_stage/Uninstall Josi.app\"; /usr/bin/codesign --verify --deep --strict -R " + NativeAuthorization.shell(requirement) + " \"$task_stage/Uninstall Josi.app\"; /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \"$task_stage/Uninstall Josi.app/Contents/Resources/runtime/python/bin/python3.11\" -I -B \"$task_stage/Uninstall Josi.app/Contents/Resources/runtime/app/native/uninstall.py\" " + (erase ? "erase" : "keep") + " " + String(getuid()) + " " + operation
        progress.stringValue = "Waiting for administrator authorization…"
        DispatchQueue.global(qos:.userInitiated).async {
            let task = Process();task.executableURL = URL(fileURLWithPath:"/usr/bin/osascript");task.arguments = ["-e",NativeAuthorization.script(command)];task.environment = ["PATH":"/usr/bin:/bin:/usr/sbin:/sbin"]
            let pipe = Pipe();task.standardOutput = pipe;task.standardError = pipe
            var text = "";var passed = false
            do { try task.run();text = String(decoding:pipe.fileHandleForReading.readDataToEndOfFile(),as:UTF8.self);task.waitUntilExit();passed = task.terminationStatus == 0 && text.contains("\"verified\": true") }
            catch { text = error.localizedDescription }
            let systemPassed = passed
            if passed && erase {
                let key = Process();key.executableURL = URL(fileURLWithPath:"/usr/bin/security");key.arguments = ["delete-generic-password","-s","josi-desktop Safe Storage","-a","josi-desktop Key"]
                let keyPipe = Pipe();key.standardOutput = keyPipe;key.standardError = keyPipe
                do { try key.run();let message = String(decoding:keyPipe.fileHandleForReading.readDataToEndOfFile(),as:UTF8.self);key.waitUntilExit();if key.terminationStatus != 0 && key.terminationStatus != 44 { passed = false;text += "\nFiles removed; desktop Keychain cleanup needs retry.\n" + message } }
                catch { passed = false;text += "\nDesktop Keychain cleanup failed: " + error.localizedDescription }
            }
            let result = passed;let diagnostics = text
            DispatchQueue.main.async {
                self.busy = false;self.spinner.stopAnimation(nil);self.output = diagnostics;self.copy.isEnabled = true
                if result {
                    self.heading.stringValue = "Josi uninstalled";self.progress.stringValue = "Removal verified"
                    self.detail.stringValue = erase ? "Josi apps, server data and saved Josi connections have been removed. Your workspace files are kept. Before a fresh install, clear Josi’s site data for localhost:8080 in the browser you used." : "Josi apps and automatic startup have been removed. Your server data remains for reinstalling. Your connected folder access has been revoked."
                    self.button.title = "Done";self.button.action = #selector(self.done);self.button.isEnabled = true
                } else {
                    self.heading.stringValue = "Removal needs attention";self.progress.stringValue = "Not completed"
                    self.detail.stringValue = DiagnosticLog.failureCause(in:diagnostics).map { $0 + " Copy Diagnostics for details." } ?? "Some removal steps did not finish. Copy Diagnostics for the cause. Retry the same choice to continue the recorded cleanup. Data already deleted by Complete removal cannot be restored."
                    self.button.title = systemPassed ? "Retry desktop key cleanup…" : "Retry…"
                    if systemPassed { self.button.action = #selector(self.retryKey) }
                    self.button.isEnabled = true
                }
            }
        }
    }
    @objc func retryKey() {
        let task = Process();task.executableURL = URL(fileURLWithPath:"/usr/bin/security");task.arguments = ["delete-generic-password","-s","josi-desktop Safe Storage","-a","josi-desktop Key"]
        let pipe = Pipe();task.standardOutput = pipe;task.standardError = pipe
        do {
            try task.run();let bytes = pipe.fileHandleForReading.readDataToEndOfFile();task.waitUntilExit()
            output += String(decoding:bytes,as:UTF8.self)
            if task.terminationStatus == 0 || task.terminationStatus == 44 {
                heading.stringValue = "Josi uninstalled";detail.stringValue = "Josi apps, data and saved connections have been removed. Clear Josi’s browser site data before reinstalling.";progress.stringValue = "Removal verified";button.title = "Done";button.action = #selector(done)
            }
        } catch { output += error.localizedDescription }
    }
    @objc func done() { NSApp.terminate(nil) }
}
@main struct UninstallMain {
    @MainActor static func main() { let app = NSApplication.shared;let delegate = UninstallApp();app.setActivationPolicy(.regular);app.delegate = delegate;app.run() }
}
