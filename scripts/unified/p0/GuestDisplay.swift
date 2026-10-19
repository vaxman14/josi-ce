// View and manual input for the one disposable P0 guest. This does not request
// host Accessibility/screen capture or inject global keyboard/pointer events.
import AppKit
import Virtualization

@MainActor
final class GuestDisplay: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let machine: VZVirtualMachine
    var window: NSWindow?
    var stopping = false
    init(machine: VZVirtualMachine) { self.machine = machine }

    static func run(machine: VZVirtualMachine) {
        let app = NSApplication.shared
        let delegate = GuestDisplay(machine: machine)
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let view = VZVirtualMachineView(frame: NSRect(x: 0, y: 0, width: 1080, height: 675))
        view.virtualMachine = machine
        view.capturesSystemKeys = false
        view.automaticallyReconfiguresDisplay = false
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Josi P0 — disposable offline guest"
        window.contentView = view
        window.delegate = self
        window.isReleasedWhenClosed = false
        self.window = window
        let menu = NSMenu()
        let applicationItem = NSMenuItem(); menu.addItem(applicationItem)
        let applicationMenu = NSMenu(); applicationItem.submenu = applicationMenu
        let quit = NSMenuItem(title: "Stop guest and quit", action: #selector(stopAndQuit), keyEquivalent: "q")
        quit.target = self; applicationMenu.addItem(quit)
        let machineItem = NSMenuItem(); menu.addItem(machineItem)
        let machineMenu = NSMenu(title: "Guest"); machineItem.submenu = machineMenu
        let pause = NSMenuItem(title: "Pause / Resume", action: #selector(togglePause), keyEquivalent: "")
        pause.target = self; machineMenu.addItem(pause)
        NSApplication.shared.mainMenu = menu
        window.center(); window.makeKeyAndOrderFront(nil); window.makeFirstResponder(view)
        NSApplication.shared.activate(ignoringOtherApps: true)
        Task { @MainActor in
            do { try await machine.start(); print("Disposable guest display started; no host input/capture permission requested."); fflush(stdout) }
            catch { showFailure(error) }
        }
    }

    func showFailure(_ error: Error) {
        let alert = NSAlert(); alert.messageText = "The disposable guest could not continue."
        alert.informativeText = (error as NSError).localizedDescription
        alert.runModal()
    }

    @objc func togglePause() {
        guard !stopping else { return }
        Task { @MainActor in
            do {
                if machine.state == .running { try await machine.pause() }
                else if machine.state == .paused { try await machine.resume() }
            } catch { showFailure(error) }
        }
    }

    @objc func stopAndQuit() {
        guard !stopping else { return }
        stopping = true
        Task { @MainActor in
            do {
                if machine.state == .running || machine.state == .paused { try await machine.stop() }
                NSApplication.shared.terminate(nil)
            } catch { stopping = false; showFailure(error) }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { stopAndQuit(); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if machine.state == .stopped || machine.state == .error { return .terminateNow }
        stopAndQuit(); return .terminateCancel
    }
}
