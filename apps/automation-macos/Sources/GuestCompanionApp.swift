import AppKit
import SwiftUI
import Security
@preconcurrency import ApplicationServices
import Darwin
import UniformTypeIdentifiers

enum GuestEnvironment {
    static func sysctlText(_ name: String) throws -> String {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, (1...256).contains(size) else { throw GuestLinkError.unavailable }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &bytes, &size, nil, 0) == 0 else { throw GuestLinkError.unavailable }
        return String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self).lowercased()
    }
    static func identity() throws -> (guest: String, host: String) {
        var present: Int32 = 0, size = MemoryLayout<Int32>.size
        guard sysctlbyname("kern.hv_vmm_present", &present, &size, nil, 0) == 0, present == 1,
              size == MemoryLayout<Int32>.size else { throw GuestLinkError.unavailable }
        let guest = try sysctlText("kern.bootsessionuuid"), host = try sysctlText("kern.hvg.host_bootsessionuuid")
        guard UUID(uuidString: guest)?.uuidString.lowercased() == guest,
              UUID(uuidString: host)?.uuidString.lowercased() == host else { throw GuestLinkError.unavailable }
        return (guest, host)
    }
    static func signedApplication() throws {
        guard Bundle.main.bundlePath == "/Applications/Josi Companion.app" else { throw GuestLinkError.unavailable }
        var code: SecCode?, requirement: SecRequirement?, source: SecStaticCode?
        let rule = "anchor apple generic and identifier \"com.heyjosi.ce.guestcompanion\" and certificate leaf[subject.OU] = \"LRH75YR6QW\""
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCheckValidity(code, [], requirement) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &source) == errSecSuccess, let source,
              SecStaticCodeCheckValidity(source, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
            throw GuestLinkError.unavailable
        }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(source, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let info = information as? [String: Any], let flags = info[kSecCodeInfoFlags as String] as? NSNumber,
              flags.uint32Value & 0x00010000 != 0 else { throw GuestLinkError.unavailable }
        let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
        for name in ["get-task-allow", "com.apple.security.get-task-allow", "com.apple.security.cs.disable-library-validation",
                     "com.apple.security.cs.allow-dyld-environment-variables"] {
            if (entitlements[name] as? NSNumber)?.boolValue == true { throw GuestLinkError.unavailable }
        }
    }
    static func connect() async throws -> Int32 {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let fd = socket(AF_VSOCK, SOCK_STREAM, 0)
                do {
                    guard fd >= 0, fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0 else { throw GuestLinkError.unavailable }
                    var address = sockaddr_vm()
                    address.svm_len = UInt8(MemoryLayout<sockaddr_vm>.size); address.svm_family = sa_family_t(AF_VSOCK)
                    address.svm_cid = 2; address.svm_port = GuestLinkWire.port
                    let result = withUnsafePointer(to: &address) { pointer in
                        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_vm>.size)) }
                    }
                    if result != 0 {
                        guard errno == EINPROGRESS else { throw GuestLinkError.unavailable }
                        var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                        guard poll(&ready, 1, 5000) > 0 else { throw GuestLinkError.expired }
                        var error: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
                        guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0, error == 0 else { throw GuestLinkError.unavailable }
                    }
                    continuation.resume(returning: fd)
                } catch { if fd >= 0 { Darwin.close(fd) }; continuation.resume(throwing: GuestLinkError.unavailable) }
            }
        }
    }
}

@MainActor final class GuestCompanionModel: ObservableObject {
    @Published var message = "Use this companion only inside your separate Josi desktop."
    @Published var comparison = ""
    @Published var server = ""
    @Published var workspace = ""
    @Published var pairing = false
    @Published var connected = false
    @Published var working = false
    @Published var selectedApplication = ""
    @Published var canPrepareBrowser = false
    @Published var browserProfile = ""
    @Published var browserMessage = ""
    @Published var browserRegistrationReady = false
    @Published var browserConnected = false
    private var task: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var wire: GuestLinkWire?
    private var approval: CheckedContinuation<Bool, Never>?
    private var runID = UUID()
    private var deadline: ContinuousClock.Instant = .now
    private var expires = 0
    private var hostBoot = ""
    private var candidate = ""
    private var execution: GuestExecutionAuthority?
    private var browserPin: GuestPinnedApplication?
    private var browserPinUntil = 0
    private var preparedBrowser: GuestBrowserProfiles.Prepared?
    private var canonicalBrowser: GuestCanonicalBrowser?
    private var browserSession: GuestBrowserSession?

    func start() {
        guard !working else { return }
        working = true; connected = false; message = "Connecting to this desktop’s Josi app…"
        let own = UUID(); runID = own
        task = Task { [self] in
            do {
                try GuestEnvironment.signedApplication()
                let environment = try GuestEnvironment.identity(); hostBoot = environment.host
                let fd = try await GuestEnvironment.connect()
                let link: GuestLinkWire
                do { link = try GuestLinkWire(descriptor: fd, host: false); Darwin.close(fd) }
                catch { Darwin.close(fd); throw error }
                wire = link
                let hello = ["version": "1", "role": "guest", "key": link.publicKey, "channel": UUID().uuidString.lowercased(),
                             "guestBoot": environment.guest, "hostBoot": environment.host]
                try await link.sendHello(hello)
                let host = try await link.receiveHello()
                guard runID == own, Set(host.keys) == ["version", "role", "key", "channel", "hostBoot",
                    "serverOrigin", "serverId", "userId", "deviceId", "workspaceId", "expiresAtMs"],
                      host["hostBoot"] == environment.host,
                      ["serverId", "userId", "deviceId", "workspaceId"].allSatisfy({ key in
                          guard let value = host[key] else { return false }; return UUID(uuidString: value)?.uuidString.lowercased() == value
                      }), let origin = host["serverOrigin"], let url = URL(string: origin),
                      ["https", "http"].contains(url.scheme), url.user == nil, url.password == nil,
                      origin.utf8.count <= 2048, !origin.contains("\n"),
                      let rawExpires = host["expiresAtMs"], let end = Int(rawExpires), String(end) == rawExpires else { throw GuestLinkError.invalid }
                let now = Int(Date().timeIntervalSince1970 * 1000)
                guard end > now, end - now <= 60_000 else { throw GuestLinkError.expired }
                expires = end; deadline = .now.advanced(by: .milliseconds(end - now))
                comparison = try await link.configure(guest: hello, host: host)
                server = origin; workspace = host["workspaceId"]!; pairing = true
                message = "Compare this code with the code in the Josi app on your Mac. Continue only when both codes match."
                timeout = Task {
                    try? await Task.sleep(for: .milliseconds(end - now))
                    if !Task.isCancelled && runID == own { answer(false) }
                }
                let allowed = await withCheckedContinuation { approval = $0 }
                timeout?.cancel(); timeout = nil; pairing = false
                guard allowed, runID == own else { throw GuestLinkError.closed }
                try current(pairing: true)
                try await link.send(["kind": "accept", "code": comparison])
                let accepted = try await link.receive(seconds: max(1, min(60, (end - Int(Date().timeIntervalSince1970 * 1000)) / 1000)))
                guard accepted == ["kind": "accept", "code": comparison] else { throw GuestLinkError.invalid }
                connected = true; comparison = ""
                execution = GuestExecutionAuthority(link: link, host: host, guestBoot: environment.guest, channel: hello["channel"]!,
                    current: { [weak self] in
                        guard let self, self.runID == own else { throw GuestLinkError.closed }
                        try self.current()
                    }, stopped: { [weak self] in
                        guard let self, self.runID == own else { return }
                        self.stop()
                        self.message = "Automation stopped. Reconnect and approve this desktop again to continue."
                    })
                message = "Companion connected. Computer and browser automation are not enabled."
                while !Task.isCancelled {
                    let pulse = try await link.receive(seconds: 5)
                    if pulse["kind"] == "execute" {
                        try current()
                        guard runID == own, let execution else { throw GuestLinkError.closed }
                        let result = try await execution.execute(pulse)
                        try current()
                        try await link.send(result)
                        continue
                    }
                    let pulseKeys = Set(pulse.keys), requiredPulse: Set<String> = ["kind", "leaseUntilMs", "applicationPin"]
                    guard runID == own, requiredPulse.isSubset(of: pulseKeys),
                          pulseKeys.isSubset(of: requiredPulse.union(["consent", "browserPin"])), pulse["kind"] == "pulse",
                          let raw = pulse["leaseUntilMs"], let until = Int(raw), String(until) == raw else { throw GuestLinkError.invalid }
                    let now = Int(Date().timeIntervalSince1970 * 1000)
                    guard until > now, until - now <= 10_000 else { throw GuestLinkError.expired }
                    expires = until; deadline = .now.advanced(by: .milliseconds(until - now))
                    try current()
                    try execution?.adopt(pulse["consent"] ?? "", leaseUntil: until)
                    try current()
                    message = execution?.approved == true
                        ? "Josi may inspect permitted apps. Interact with the desktop or choose Disconnect to stop. Input automation is unavailable."
                        : "Companion connected. Inspection is not approved."
                    let readiness = try GuestApplicationReadiness.inspect(pulse["applicationPin"] ?? "", selection: candidate,
                        identity: host, leaseUntil: until)
                    browserPin = try GuestApplicationReadiness.selectedPin(pulse["applicationPin"] ?? "", selection: candidate,
                        identity: host, leaseUntil: until)
                    if let data = pulse["applicationPin"]?.data(using: .utf8),
                       let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let projection = raw["projection"] as? [String: Any],
                       let end = projection["expiresAtMs"] as? Int { browserPinUntil = min(end, until) }
                    else { browserPinUntil = 0 }
                    canPrepareBrowser = browserPin.map { GuestBrowserProfiles.families[$0.bundleId] != nil } ?? false
                    if let preparedBrowser, let browserPin, browserPin != preparedBrowser.application { clearBrowserProfile() }
                    canonicalBrowser = try GuestBrowserProjection.resolve(pulse["browserPin"] ?? "", prepared: preparedBrowser,
                        identity: host, application: browserPin, leaseUntil: until)
                    browserRegistrationReady = canonicalBrowser != nil
                    await renewBrowserConnection()
                    try current()
                    try await link.send(["kind": "status", "accessibility": AXIsProcessTrusted() ? "yes" : "no",
                        "screenCapture": CGPreflightScreenCaptureAccess() ? "yes" : "no", "executionEnabled": "no",
                        "applicationCandidate": candidate, "applicationReadiness": readiness, "executionProtocol": "desktop-command.2",
                        "browserCandidate": try preparedBrowser.map { String(decoding: try JSONEncoder().encode($0.candidate), as: UTF8.self) } ?? "",
                        "browserConnection": browserConnected ? "connected" : "waiting"])
                }
            } catch {
                if runID == own { message = "Connection ended or could not be verified. Install the signed companion in this guest’s Applications folder, then connect from the Josi app." }
            }
            if runID == own {
                let oldExecution = execution; execution = nil; oldExecution?.stop()
                wire?.interrupt(); wire = nil; timeout?.cancel(); timeout = nil
                connected = false; working = false; pairing = false; comparison = ""; task = nil
                candidate = ""; selectedApplication = ""
                browserPin = nil; browserPinUntil = 0; canPrepareBrowser = false; clearBrowserProfile()
            }
        }
    }
    private func current(pairing: Bool = false) throws {
        guard !Task.isCancelled, pairing || connected, ContinuousClock.now < deadline,
              Int(Date().timeIntervalSince1970 * 1000) < expires, try GuestEnvironment.identity().host == hostBoot else {
            throw GuestLinkError.expired
        }
    }
    func answer(_ allowed: Bool) {
        if allowed && !NSApp.isActive { return }
        let waiting = approval; approval = nil; waiting?.resume(returning: allowed)
    }
    func stop() {
        runID = UUID(); answer(false); wire?.interrupt(); wire = nil; task?.cancel(); task = nil; timeout?.cancel(); timeout = nil
        let oldExecution = execution; execution = nil; oldExecution?.stop()
        working = false; connected = false; pairing = false; comparison = ""; message = "Companion disconnected."
        candidate = ""; selectedApplication = ""
        browserPin = nil; browserPinUntil = 0; canPrepareBrowser = false; clearBrowserProfile()
    }
    private func clearBrowserProfile() {
        preparedBrowser = nil; browserProfile = ""; browserMessage = ""
        canonicalBrowser = nil; browserRegistrationReady = false
        browserSession?.stop(); browserSession = nil; browserConnected = false
    }
    private func renewBrowserConnection() async {
        let own = runID
        do {
            try current()
            guard GuestBrowserProfiles.bridgeEnabled, let canonicalBrowser else {
                browserSession?.stop(); browserSession = nil; browserConnected = false; return
            }
            if browserSession?.available != true {
                browserSession?.stop()
                browserSession = try GuestBrowserSession(canonicalBrowser, current: { [weak self] in
                    guard let self, self.runID == own else { throw GuestLinkError.closed }
                    try self.current()
                }, status: { [weak self] connected in
                    guard let self, self.runID == own else { return }
                    self.browserConnected = connected
                }, stopped: { [weak self] in
                    guard let self, self.runID == own else { return }
                    self.stop()
                    self.message = "You have control. Reconnect and approve this desktop again to resume automation."
                })
            }
            try await browserSession?.renew(canonicalBrowser)
        } catch {
            if runID == own {
                browserSession?.stop(); browserSession = nil; browserConnected = false
            }
        }
    }
    func prepareBrowser() {
        do {
            try current()
            guard NSApp.isActive, let pin = browserPin, browserPinUntil > Int(Date().timeIntervalSince1970 * 1000) else { throw GuestLinkError.expired }
            let prepared = try GuestBrowserProfiles.prepare(pin)
            try current()
            guard browserPin == pin, browserPinUntil > Int(Date().timeIntervalSince1970 * 1000) else { throw GuestLinkError.expired }
            preparedBrowser = prepared; browserProfile = prepared.candidate.label
            browserMessage = "This profile is ready for registration in Josi on your Mac. Registration grants no automation access."
        } catch { clearBrowserProfile(); browserMessage = "Register the selected browser in Josi first, then prepare its separate profile." }
    }
    func openPreparedBrowser() {
        let own = runID
        Task {
            do {
                try current()
                guard NSApp.isActive, let prepared = preparedBrowser, browserPin == prepared.application,
                      browserPinUntil > Int(Date().timeIntervalSince1970 * 1000) else { throw GuestLinkError.expired }
                try await GuestBrowserProfiles.open(prepared)
                guard runID == own else { return }
                try current()
                browserMessage = prepared.candidate.family == "firefox"
                    ? "In Firefox, choose Load Temporary Add-on and select manifest.json from the extension folder. Development installs last until Firefox closes."
                    : "In the browser, turn on Developer mode and choose Load unpacked, then select the extension folder."
            } catch {
                if runID == own { browserMessage = "Close the selected browser’s other windows and processes, refresh its registration if it changed, then try again." }
            }
        }
    }
    func revealBrowserExtension() {
        do {
            try current()
            guard NSApp.isActive, let prepared = preparedBrowser else { return }
            NSWorkspace.shared.activateFileViewerSelecting([prepared.extensionFolder])
        } catch { stop() }
    }
    func enableBrowserBridge() {
        do {
            try current()
            guard NSApp.isActive, let prepared = preparedBrowser else { throw GuestLinkError.unavailable }
            browserMessage = try GuestBrowserProfiles.enableBridge(prepared)
                ? "The guest browser connection service is enabled. Server automation permissions and a current local approval are still required."
                : "Allow Josi Companion in this guest’s Login Items settings, then enable the connection again."
        } catch { browserMessage = "The guest browser connection could not be installed. Keep the signed Josi Companion in Applications and check its Login Items permission." }
    }
    func disableBrowserBridge() {
        Task {
            do {
                guard NSApp.isActive else { return }
                browserSession?.stop(); browserSession = nil; browserConnected = false
                try await GuestBrowserProfiles.disableBridge()
                browserMessage = "The guest browser connection service is disabled."
            } catch { browserMessage = "The guest browser connection service could not be disabled. Check Login Items settings." }
        }
    }
    func accessibility() {
        do {
            try current()
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        } catch { stop() }
    }
    func screenCapture() {
        do { try current(); _ = CGRequestScreenCaptureAccess() }
        catch { stop() }
    }
    func selectApplication() {
        let selectionSession = runID
        Task {
            do {
                try current()
                guard let window = NSApp.keyWindow else { throw GuestLinkError.unavailable }
                let panel = NSOpenPanel()
                panel.title = "Choose a guest app for Josi permissions"
                panel.message = "Share this app’s name, location and signing identity with Josi so its administrator can configure permissions. Selecting it grants no access."
                panel.allowedContentTypes = [.applicationBundle]
                panel.canChooseDirectories = false; panel.canChooseFiles = true; panel.allowsMultipleSelection = false
                panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
                let response = await withCheckedContinuation { continuation in
                    panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
                }
                guard response == .OK, let selected = panel.url, selectionSession == runID else { return }
                try current()
                let boot = try GuestEnvironment.identity().guest
                let value = try await Self.inspectApplication(selected, boot: boot)
                guard selectionSession == runID else { throw GuestLinkError.closed }
                try current()
                candidate = String(decoding: try GuestLinkWire.encode(value), as: UTF8.self)
                selectedApplication = value["label"] ?? ""
                browserPin = nil; browserPinUntil = 0; canPrepareBrowser = false; clearBrowserProfile()
            } catch { message = "The selected app could not be shared through the current verified connection." }
        }
    }
    private nonisolated static func inspectApplication(_ selected: URL, boot: String) async throws -> [String: String] {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let url = selected.resolvingSymlinksInPath().standardizedFileURL
                    guard url.isFileURL, url.pathExtension == "app", url.path.utf8.count <= 768,
                          let bundle = Bundle(url: url), let identifier = bundle.bundleIdentifier,
                          !["com.apple.systempreferences", "com.apple.systemsettings", "com.apple.securityagent", "com.apple.loginwindow", "com.apple.keychainaccess"].contains(identifier.lowercased()),
                          !identifier.lowercased().hasPrefix("com.heyjosi."), !identifier.lowercased().hasPrefix("com.socalreceptionist.josi"),
                          let executable = bundle.executableURL, executable.resolvingSymlinksInPath().path.hasPrefix(url.path + "/") else {
                        throw GuestLinkError.invalid
                    }
                    var code: SecStaticCode?, requirement: SecRequirement?
                    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
                          SecRequirementCreateWithString("anchor apple generic" as CFString, [], &requirement) == errSecSuccess, let requirement,
                          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw GuestLinkError.invalid }
                    var information: CFDictionary?
                    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
                          let info = information as? [String: Any], let signing = info[kSecCodeInfoIdentifier as String] as? String,
                          let hash = info[kSecCodeInfoUnique as String] as? Data, [20, 32].contains(hash.count) else { throw GuestLinkError.invalid }
                    let team = info[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
                    let label = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                        ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent
                    let value = ["schemaVersion": "1", "candidateId": UUID().uuidString.lowercased(), "guestBootId": boot,
                                 "kind": "application", "label": label, "bundlePath": url.path, "bundleId": identifier,
                                 "signingId": signing, "teamId": team, "codeHash": hash.map { String(format: "%02x", $0) }.joined()]
                    for (name, limit) in [("label", 96), ("bundleId", 200), ("signingId", 200), ("teamId", 64), ("bundlePath", 768)] {
                        guard let text = value[name], (name == "teamId" || !text.isEmpty), text.trimmingCharacters(in: .whitespacesAndNewlines) == text, text.utf8.count <= limit,
                              text.range(of: "[\\x{0000}-\\x{001f}\\x{007f}\\x{202a}-\\x{202e}\\x{2066}-\\x{2069}]", options: .regularExpression) == nil else { throw GuestLinkError.invalid }
                    }
                    guard try GuestLinkWire.encode(value).count <= 2500 else { throw GuestLinkError.invalid }
                    continuation.resume(returning: value)
                } catch { continuation.resume(throwing: GuestLinkError.unavailable) }
            }
        }
    }
}

@main struct JosiGuestCompanionApp: App {
    @StateObject private var model = GuestCompanionModel()
    var body: some Scene {
        Window("Josi Companion", id: "companion") {
            VStack(alignment: .leading, spacing: 18) {
                Text("Josi Companion").font(.largeTitle.bold())
                Text(model.message)
                if model.pairing {
                    Text(model.comparison).font(.system(size: 30, weight: .bold, design: .monospaced)).textSelection(.enabled)
                    Text(model.server + "\nWorkspace: " + model.workspace).font(.caption).textSelection(.enabled)
                    HStack {
                        Button("Cancel") { model.answer(false) }
                        Button("The Codes Match") { model.answer(true) }.buttonStyle(.borderedProminent)
                    }
                } else if model.connected {
                    Text("macOS permission setup").font(.headline)
                    Text("These permissions apply only inside this separate desktop. Josi’s server permissions are still required before automation can run.")
                    HStack {
                        Button("Enable Accessibility…") { model.accessibility() }
                        Button("Enable Screen Capture…") { model.screenCapture() }
                    }
                    Button("Choose App for Permissions…") { model.selectApplication() }
                    if !model.selectedApplication.isEmpty { Text("Shared for permission setup: " + model.selectedApplication).font(.caption) }
                    if model.canPrepareBrowser {
                        Divider()
                        Text("Separate browser profile").font(.headline)
                        Button("Prepare Browser Profile") { model.prepareBrowser() }
                        if !model.browserProfile.isEmpty {
                            Text(model.browserProfile).font(.caption)
                            Text(model.browserRegistrationReady ? "Current Vault registration verified." : "Waiting for this profile’s Vault registration.")
                                .font(.caption).foregroundStyle(.secondary)
                            if model.browserConnected {
                                Text("Extension connected. Page access and input are not enabled.").font(.caption)
                            }
                            HStack {
                                Button("Open Profile for Extension Setup") { model.openPreparedBrowser() }
                                Button("Show Extension Folder") { model.revealBrowserExtension() }
                            }
                            HStack {
                                Button("Enable Browser Connection") { model.enableBrowserBridge() }
                                Button("Disable Connection") { model.disableBrowserBridge() }
                                Button("Login Items…") { GuestBrowserProfiles.bridgeSettings() }
                            }
                        }
                    }
                    if !model.browserMessage.isEmpty { Text(model.browserMessage).font(.caption).foregroundStyle(.secondary) }
                }
                HStack {
                    Button("Connect to Josi") { model.start() }.disabled(model.working)
                    Button("Disconnect") { model.stop() }.disabled(!model.working)
                }
            }.padding(28).frame(width: 580, alignment: .leading)
        }.defaultSize(width: 640, height: 400)
    }
}
