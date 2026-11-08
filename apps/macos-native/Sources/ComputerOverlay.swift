import AppKit
import SwiftUI
import ApplicationServices
import Carbon

enum ComputerEmergencyShortcut: String, CaseIterable, Identifiable {
    case controlOptionEscape, controlShiftEscape, controlOptionCommandEscape
    var id: String { rawValue }
    var label: String {
        switch self {
        case .controlOptionEscape: return "Control–Option–Escape"
        case .controlShiftEscape: return "Control–Shift–Escape"
        case .controlOptionCommandEscape: return "Control–Option–Command–Escape"
        }
    }
    var flags: CGEventFlags {
        switch self {
        case .controlOptionEscape: return [.maskControl, .maskAlternate]
        case .controlShiftEscape: return [.maskControl, .maskShift]
        case .controlOptionCommandEscape: return [.maskControl, .maskAlternate, .maskCommand]
        }
    }
    var modifiers: SwiftUI.EventModifiers {
        switch self {
        case .controlOptionEscape: return [.control, .option]
        case .controlShiftEscape: return [.control, .shift]
        case .controlOptionCommandEscape: return [.control, .option, .command]
        }
    }
    static var current: Self {
        Self(rawValue: UserDefaults.standard.string(forKey: "computerControl.emergencyShortcut") ?? "") ?? .controlOptionEscape
    }
}

/// Automatic presentation never takes focus. Explicit menu presentation can
/// focus the buttons for keyboard and assistive-technology users.
@MainActor private final class ComputerStripPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor final class ComputerOverlay {
    let gate: ComputerLocalGate
    private var panels: [NSPanel] = []
    private var strip: NSPanel?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var displayObserver: NSObjectProtocol?
    private var lockObserver: NSObjectProtocol?
    private var unlockObserver: NSObjectProtocol?
    private(set) var inputAvailable = false
    private(set) var locked = false
    var authenticationActive = false
    var permissions: () -> Void = {}
    var resumeWork: (() -> Void)?
    init(gate: ComputerLocalGate) { self.gate = gate }
    isolated deinit {
        // The event tap stores an unretained callback context. Invalidate it
        // before this owner is released, including a failed local check.
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let displayObserver { NotificationCenter.default.removeObserver(displayObserver) }
        if let lockObserver { DistributedNotificationCenter.default().removeObserver(lockObserver) }
        if let unlockObserver { DistributedNotificationCenter.default().removeObserver(unlockObserver) }
    }
    func shutdown() {
        hide()
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil; inputAvailable = false
    }
    func present() {
        start(monitor: false)
        guard !locked, !authenticationActive, !IsSecureEventInputEnabled() else { return }
        strip?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func start(monitor: Bool = true) {
        guard !locked, !authenticationActive, !IsSecureEventInputEnabled() else { hide(); return }
        guard strip == nil else { if !locked { panels.forEach { $0.orderFrontRegardless() }; strip?.orderFrontRegardless() }; return }
        rebuild()
        if displayObserver == nil {
        displayObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.gate.takeover(); self?.rebuild() }
        }
        lockObserver = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = true; self?.gate.stop("Mac is locked"); self?.hide() }
        }
        unlockObserver = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = false; self?.rebuild() }
        }
        }
        if monitor { installInputMonitor() }
    }
    func installInputMonitor() {
        if let tap, !CGEvent.tapIsEnabled(tap: tap) {
            // Recreate a failed monitor only after an explicit local Resume.
            if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
            CFMachPortInvalidate(tap); self.tap = nil; source = nil; inputAvailable = false
        }
        guard tap == nil, CGPreflightListenEventAccess() else { return }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let context = Unmanaged.passUnretained(self).toOpaque()
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            let overlay = Unmanaged<ComputerOverlay>.fromOpaque(pointer).takeUnretainedValue()
            MainActor.assumeIsolated {
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    overlay.inputAvailable = false; overlay.gate.stop("Input monitor stopped. Resume requires a healthy monitor.")
                } else {
                    let choice = ComputerEmergencyShortcut.current
                    let modifiers = event.flags.intersection([.maskControl, .maskAlternate, .maskCommand, .maskShift])
                    let shortcut = type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53 && modifiers == choice.flags
                    if shortcut { overlay.gate.stop("Stopped with " + choice.label) }
                    else if event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) { overlay.gate.takeover() }
                }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context)
        guard let tap else { gate.stop("Input monitoring is unavailable; screen control stays off."); return }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        CGEvent.tapEnable(tap: tap, enable: true); inputAvailable = true
    }
    func checkScreen() throws {
        guard !locked, NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow",
              inputAvailable, let tap, CGEvent.tapIsEnabled(tap: tap), AXIsProcessTrusted(), CGPreflightListenEventAccess(), !IsSecureEventInputEnabled() else {
            gate.stop("Screen access, input monitoring or the unlocked desktop is unavailable.")
            hide()
            throw JosiError(message: "Screen control requires an unlocked Mac, Accessibility and Input Monitoring. Protected prompts remain off limits.")
        }
    }
    func hide() { panels.forEach { $0.orderOut(nil) }; strip?.orderOut(nil) }
    private func rebuild() {
        panels.forEach { $0.close() }; panels.removeAll(); strip?.close()
        guard !locked, !authenticationActive, !IsSecureEventInputEnabled() else { strip = nil; return }
        for screen in NSScreen.screens {
            let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating; panel.isOpaque = false; panel.backgroundColor = .clear; panel.ignoresMouseEvents = true
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.sharingType = .readOnly
            panel.contentView = NSHostingView(rootView: ComputerBorder(gate: gate)); panel.orderFrontRegardless(); panels.append(panel)
        }
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        // Keep the ghost above the capsule and leave room for its shadow.
        // Scale the complete composition together on smaller displays.
        let scale = min(1, max(0.5, (screen.visibleFrame.width - 24) / 860))
        let size = NSSize(width: 860 * scale, height: 144 * scale)
        let frame = NSRect(x: screen.visibleFrame.midX - size.width / 2,
                           y: screen.visibleFrame.maxY - size.height - 8, width: size.width, height: size.height)
        let panel = ComputerStripPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.becomesKeyOnlyIfNeeded = true
        panel.title = "Josi Control Bar"
        panel.level = .floating; panel.isOpaque = false; panel.backgroundColor = .clear; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.sharingType = .readOnly
        panel.contentView = NSHostingView(rootView: ComputerStrip(gate: gate, resume: { [weak self] in
            if let resume = self?.resumeWork { resume() }
            else { self?.installInputMonitor(); self?.gate.resume() }
        }, permissions: { [weak self] in self?.permissions() })
            .scaleEffect(scale, anchor: .topLeading).frame(width: size.width, height: size.height, alignment: .topLeading))
        panel.orderFrontRegardless(); strip = panel
    }
}
private struct ComputerBorder: View {
    @ObservedObject var gate: ComputerLocalGate
    var body: some View { RoundedRectangle(cornerRadius: 14).stroke(Color.blue.opacity(gate.mode == .working ? 0.85 : 0.22), lineWidth: 7).padding(4).allowsHitTesting(false) }
}
private struct ComputerStrip: View {
    @ObservedObject var gate: ComputerLocalGate
    @StateObject private var ghost = GhostController()
    var resume: () -> Void
    var permissions: () -> Void
    @AppStorage("computerControl.emergencyShortcut") private var shortcut = ComputerEmergencyShortcut.controlOptionEscape.rawValue
    private var status: String {
        switch gate.mode {
        case .working: "Working on your Mac"
        case .ready: "Ready for approved work"
        case .paused: "Paused · You are in control"
        case .stopped, .takeover: "You are in control"
        }
    }
    var body: some View {
        ZStack(alignment: .topLeading) {
            Capsule()
                .fill(LinearGradient(colors: [Color(hex: 0x43264A), Color(hex: 0x251329)], startPoint: .top, endPoint: .bottom))
                .overlay(Capsule().strokeBorder(ComputerBarPalette.gold, lineWidth: 1.5))
                .shadow(color: .black.opacity(0.32), radius: 10, x: 0, y: 8)
                .frame(width: 836, height: 98).offset(x: 12, y: 28)
            Rectangle().fill(ComputerBarPalette.gold.opacity(0.5))
                .frame(width: 1, height: 52).offset(x: 150, y: 51)
            JosiGhost(ghost: ghost, size: 124).offset(x: 22, y: 0)
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Josi").font(JosiFont.display(27)).foregroundStyle(ComputerBarPalette.gold)
                    Text(status).font(JosiFont.body(13)).foregroundStyle(Color(hex: 0xF7E8CF))
                        .lineLimit(1).minimumScaleFactor(0.8)
                }.frame(width: 143, alignment: .leading)
                    .help((Host.current().localizedName ?? "This Mac") + "\n" + gate.detail)
                    .accessibilityElement(children: .combine).accessibilityValue(gate.detail)
                HStack(spacing: 10) {
                    Button("Take over") { gate.takeover() }.frame(width: 112).buttonStyle(ComputerBarButtonStyle(tone: .gold))
                    Button("Pause") { gate.pause() }.frame(width: 78).buttonStyle(ComputerBarButtonStyle(tone: .plum))
                    Button("Resume", action: resume).frame(width: 90).buttonStyle(ComputerBarButtonStyle(tone: .plum))
                        .disabled(gate.mode == .working)
                    Button("Stop", role: .destructive) { gate.stop() }.frame(width: 74).buttonStyle(ComputerBarButtonStyle(tone: .coral))
                        .keyboardShortcut(.escape, modifiers: (ComputerEmergencyShortcut(rawValue: shortcut) ?? .controlOptionEscape).modifiers)
                    Button("Permissions", action: permissions).frame(width: 113).buttonStyle(ComputerBarButtonStyle(tone: .plum))
                }
            }.frame(height: 98).offset(x: 166, y: 28)
        }.frame(width: 860, height: 144, alignment: .topLeading).environment(\.colorScheme, .dark)
            .onAppear { ghost.set(gate.mode == .working ? .waiting : .resting) }
            .onChange(of: gate.mode) { _, mode in ghost.set(mode == .working ? .waiting : .resting) }
    }
}

private enum ComputerBarPalette {
    static var gold: LinearGradient {
        LinearGradient(colors: [Color(hex: 0xFFE7A3), Color(hex: 0xF0CF7A), Color(hex: 0xC49536)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
private struct ComputerBarButtonStyle: ButtonStyle {
    enum Tone { case gold, plum, coral }
    var tone: Tone
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false
    private var colors: [Color] {
        switch tone {
        case .gold: [Color(hex: 0xFFE4A0), Color(hex: 0xD6A64B)]
        case .plum: [Color(hex: 0x704272), Color(hex: 0x49254F)]
        case .coral: [Color(hex: 0xF1938D), Color(hex: 0xD8797D)]
        }
    }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(JosiFont.body(14, weight: .semibold))
            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
            .frame(maxWidth: .infinity).frame(height: 42)
            .foregroundStyle(tone == .plum ? Color(hex: 0xFFF0DA) : Color(hex: 0x30172C))
            .background(LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom), in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(tone == .plum ? 0.14 : 0.35), lineWidth: 0.8))
            .brightness(enabled && hovering ? 0.06 : 0)
            .opacity(enabled ? 1 : 0.38)
            .scaleEffect(configuration.isPressed && enabled ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
            .contentShape(Capsule()).onHover { hovering = $0 }
    }
}
