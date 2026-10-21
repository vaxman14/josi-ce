import AppKit
import SwiftUI
@preconcurrency import ApplicationServices
import Security
import UniformTypeIdentifiers

/// Local desktop connection. The server chooses canonical targets and reserves
/// every operation; browser/page messages never create their own authority.
@MainActor final class NativeGuestConnection: ObservableObject {
    @Published private(set) var state = "Connected to this Mac"
    @Published private(set) var paired = true
    @Published private(set) var accessibility = AXIsProcessTrusted()
    @Published private(set) var screenCapture = CGPreflightScreenCaptureAccess()
    @Published private(set) var applicationCandidate: Wire = .null
    @Published private(set) var applicationReadiness = ""
    @Published private(set) var browserCandidate: Wire = .null
    @Published private(set) var browserConnected = false
    let supportsExecution = true
    private let context: [String: String]
    private let current: @MainActor () throws -> Int
    private let resolveApplication: @MainActor (Wire) async throws -> Wire
    private let resolveBrowser: @MainActor (Wire) async throws -> Wire
    private let consentProjection: @MainActor () throws -> Wire
    private let onStop: @MainActor () -> Void
    private let pairedBinding: Wire
    private var closed = false, refreshing = false, executing = false, revoking = false
    private var applicationPin: Wire = .null
    private var browserPin: Wire = .null
    private var prepared: GuestBrowserProfiles.Prepared?
    private var discovery: GuestSafariDiscovery?
    private var browserSession: GuestBrowserSession?
    private var executor: GuestExecutionAuthority?
    private var issued = Set<String>()
    private var selectionGeneration = 0

    init(context: [String: String], current: @escaping @MainActor () throws -> Int,
         resolveApplication: @escaping @MainActor (Wire) async throws -> Wire,
         resolveBrowser: @escaping @MainActor (Wire) async throws -> Wire,
         consentProjection: @escaping @MainActor () throws -> Wire,
         stopped: @escaping @MainActor () -> Void) throws {
        try GuestEnvironment.signedApplication()
        self.context = context; self.current = current; self.resolveApplication = resolveApplication
        self.resolveBrowser = resolveBrowser; self.consentProjection = consentProjection; onStop = stopped
        pairedBinding = ["guestBootId": .string(try GuestEnvironment.identity().guest),
                         "guestChannelId": .string(UUID().uuidString.lowercased())]
        if let path = UserDefaults.standard.string(forKey: "desktop.selectedApplication") {
            Task { [weak self] in try? await self?.select(URL(fileURLWithPath: path)) }
        }
    }
    var identity: Wire {
        .object(Dictionary(uniqueKeysWithValues: ["serverId", "userId", "deviceId", "workspaceId"].map { ($0, .string(context[$0] ?? "")) }))
    }
    private func wire<T: Encodable>(_ value: T) throws -> Wire { try JSONDecoder().decode(Wire.self, from: JSONEncoder().encode(value)) }
    private func json(_ value: Wire) throws -> String { String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }
    private func pin() throws -> GuestPinnedApplication {
        _ = try current()
        guard !closed, applicationPin != .null,
              applicationPin["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) else { throw GuestLinkError.expired }
        return try JSONDecoder().decode(GuestPinnedApplication.self, from: JSONEncoder().encode(applicationPin["application"]))
    }
    func selectApplication() async throws {
        _ = try current()
        revokeAutomation()
        guard let parent = NSApp.keyWindow else { throw GuestLinkError.unavailable }
        let panel = NSOpenPanel()
        panel.title = "Choose an app on this Mac"
        panel.message = "Register this app’s signing identity, then choose the actions Josi may perform. Selecting it grants no access."
        panel.allowedContentTypes = [.applicationBundle]; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        let response = await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: parent) { continuation.resume(returning: $0) }
        }
        guard response == .OK, let url = panel.url else { return }
        try await select(url)
    }
    private func select(_ url: URL) async throws {
        _ = try current(); selectionGeneration += 1
        let generation = selectionGeneration
        let value = try await Self.inspectApplication(url, boot: pairedBinding["guestBootId"].text)
        _ = try current()
        guard !closed, generation == selectionGeneration else { throw GuestLinkError.closed }
        revokeAutomation(); discovery?.stop(); discovery = nil; prepared = nil
        applicationPin = .null; browserPin = .null; browserCandidate = .null
        applicationCandidate = .object(value.mapValues(Wire.string))
        UserDefaults.standard.set(url.path, forKey: "desktop.selectedApplication")
        try await refresh()
    }
    func requestAccessibility() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        accessibility = AXIsProcessTrusted()
    }
    func requestCapture() { _ = CGRequestScreenCaptureAccess(); screenCapture = CGPreflightScreenCaptureAccess() }
    func showApplication() throws {
        let app = try pin()
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: app.bundleId)
        guard running.count == 1 else { throw GuestLinkError.unavailable }
        try GuestDesktopEngine.verifyApplication(running[0], pin: app)
        running[0].activate(options: [])
    }
    func refresh() async throws {
        _ = try current()
        guard !closed, !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        accessibility = AXIsProcessTrusted(); screenCapture = CGPreflightScreenCaptureAccess()
        guard applicationCandidate != .null else { return }
        let selected = applicationCandidate, generation = selectionGeneration
        let projection = try await resolveApplication(selected)
        _ = try current()
        guard !closed, selected == applicationCandidate, generation == selectionGeneration else { throw GuestLinkError.closed }
        applicationPin = projection
        guard projection != .null else { applicationReadiness = "unregistered"; return }
        let app = try pin(), apps = NSRunningApplication.runningApplications(withBundleIdentifier: app.bundleId)
        if apps.count == 1 {
            do { try GuestDesktopEngine.verifyApplication(apps[0], pin: app); applicationReadiness = "running" }
            catch { applicationReadiness = "changed"; revokeAutomation() }
        } else { applicationReadiness = apps.isEmpty ? "not_running" : "ambiguous"; revokeAutomation() }
        if let family = GuestBrowserProfiles.families[app.bundleId] {
            if prepared == nil, let profile = UserDefaults.standard.string(forKey: "desktop.browserInstance." + family) {
                prepared = try GuestBrowserProfiles.prepare(app, profile: profile)
                browserCandidate = try wire(prepared!.candidate)
            }
            if let prepared {
                browserPin = try await resolveBrowser(browserCandidate)
                _ = try current()
                if browserPin != .null {
                    let canonical = try GuestBrowserProjection.resolve(json(["candidateId": browserCandidate["candidateId"], "projection": browserPin]),
                        prepared: prepared, identity: context, application: app, leaseUntil: current())
                    if let canonical {
                        discovery?.stop(); discovery = nil
                        if browserSession?.available != true {
                            browserSession = try GuestBrowserSession(canonical, current: { [weak self] in
                                guard let self, !self.closed else { throw GuestLinkError.closed }; _ = try self.current()
                            }, status: { [weak self] in self?.browserConnected = $0 }, stopped: { [weak self] in self?.takeover() })
                        }
                        try await browserSession?.renew(canonical)
                        executor?.browserConnection(browserSession)
                    }
                }
            }
            if let discovery, discovery.available { try await discovery.renew(until: current()) }
        }
        let consent = try consentProjection()
        if consent != .null {
            if executor == nil {
                executor = GuestExecutionAuthority(host: context, guestBoot: pairedBinding["guestBootId"].text,
                    channel: pairedBinding["guestChannelId"].text, current: { [weak self] in
                        guard let self, !self.closed, try self.consentProjection() != .null else { throw GuestLinkError.closed }
                        _ = try self.current()
                    }, stopped: { [weak self] in self?.takeover() })
            }
            executor?.browserConnection(browserSession)
            try executor?.adopt(json(consent), leaseUntil: current())
        }
    }
    func connectBrowser() async throws {
        revokeAutomation()
        let app = try pin()
        guard GuestBrowserProfiles.families[app.bundleId] != nil else { throw GuestLinkError.invalid }
        let setup = try GuestBrowserProfiles.prepare(app, profile: UUID().uuidString.lowercased())
        guard try GuestBrowserProfiles.enableBridge(setup) else {
            GuestBrowserProfiles.bridgeSettings()
            throw JosiError(message: "Allow Josi’s browser connection in Login Items, then select Connect Browser again.")
        }
        NSWorkspace.shared.activateFileViewerSelecting([setup.extensionFolder])
        if prepared != nil, browserPin != .null { try await refresh(); state = "Open the Josi extension and attach the tab you want to use."; return }
        discovery?.stop()
        discovery = try GuestSafariDiscovery(pin: app, current: { [weak self] in
            guard let self, !self.closed else { throw GuestLinkError.closed }; _ = try self.current()
        }, found: { [weak self] value in
            guard let self else { return }
            self.prepared = value; self.browserCandidate = (try? self.wire(value.candidate)) ?? .null
            UserDefaults.standard.set(value.candidate.nativeProfileId, forKey: "desktop.browserInstance." + value.candidate.family)
            self.state = "Browser identified. Register it below, configure its sites, then attach your tab."
        })
        try await discovery?.renew(until: current())
        state = "Install the packaged extension in your existing browser, then choose Attach This Tab."
    }
    static func matchingApplications(_ candidate: Wire, identity: Wire, registry: Wire) -> [Wire] {
        guard candidate != .null, !registry["reconciliationRequired"].flag else { return [] }
        return registry["applications"].list.filter { target in
            target["identity"] == identity && ["bundlePath", "bundleId", "signingId", "teamId", "codeHash"]
                .allSatisfy { target["candidate"][$0] == candidate[$0] }
        }
    }
    func registration(expected: Wire) throws -> Wire {
        _ = try current()
        guard paired, !closed, applicationCandidate != .null else { throw GuestLinkError.closed }
        return ["kind": "automation.target.register", "identity": identity,
                "candidate": applicationCandidate, "expected": expected]
    }
    func requireSelection(_ change: Wire) throws {
        guard try registration(expected: change["expected"]) == change else { throw GuestLinkError.invalid }
    }
    func browserRegistration(registry: Wire) throws -> Wire {
        _ = try current()
        guard paired, !closed, browserCandidate != .null, !registry["reconciliationRequired"].flag,
              browserCandidate["guestBootId"] == pairedBinding["guestBootId"],
              Self.matchingApplications(applicationCandidate, identity: identity, registry: registry).contains(where: {
                  $0["applicationId"] == browserCandidate["applicationId"]
                      && $0["installationRevision"] == browserCandidate["installationRevision"]
              }) else { throw GuestLinkError.invalid }
        return ["kind": "automation.target.register", "identity": identity,
                "candidate": browserCandidate, "expected": registry["reference"]]
    }
    func requireBrowserSelection(_ change: Wire, registry: Wire) throws {
        guard try browserRegistration(registry: registry) == change else { throw GuestLinkError.invalid }
    }

    func consentBinding() throws -> Wire { _ = try current(); guard !closed else { throw GuestLinkError.closed }; return pairedBinding }
    func controlSelection() throws -> Wire {
        let app = try pin()
        guard paired, applicationReadiness == "running" else { throw GuestLinkError.unavailable }
        var value: [String: Wire] = ["applicationId": .string(app.applicationId.uuidString.lowercased()), "installationRevision": .number(Double(app.installationRevision))]
        if GuestBrowserProfiles.families[app.bundleId] != nil {
            guard browserConnected, browserPin["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) else { throw GuestLinkError.unavailable }
            value["browser"] = ["profileId": browserPin["browser"]["profileId"], "family": browserCandidate["family"]]
        } else { guard accessibility else { throw GuestLinkError.unavailable } }
        return .object(value)
    }
    func execute(_ packet: Wire, authorize: @escaping @MainActor (Wire) async throws -> Wire) async throws -> Wire {
        _ = try controlSelection()
        guard !executing, let executor, executor.approved,
              ProtectedWire.exact(packet, ["reservationId", "command", "commandJSON", "application"]),
              ProtectedWire.uuid(packet["reservationId"]), !issued.contains(packet["reservationId"].text), issued.count < 4096,
              try JSONDecoder().decode(Wire.self, from: Data(packet["commandJSON"].text.utf8)) == packet["command"],
              packet["application"] == applicationPin["application"] else { throw GuestLinkError.invalid }
        executing = true; issued.insert(packet["reservationId"].text); defer { executing = false }
        let consent = try consentProjection()
        guard consent != .null else { throw GuestLinkError.expired }
        var box = "", publicKey = "", digest = "", count = 0, chunks = 0
        let result = try await executor.execute(["kind": "execute", "reservationId": packet["reservationId"].text,
            "command": packet["commandJSON"].text, "application": try json(packet["application"]),
            "consentDigest": consent["authority"]["consent"]["digest"].text], authorize: { query in
                _ = try self.current()
                guard self.executor === executor, try self.consentProjection() != .null else { throw GuestLinkError.closed }
                let value = try await authorize(.object(query.mapValues(Wire.string)))
                guard case .object(let fields) = value, fields.values.allSatisfy({ if case .string = $0 { return true }; return false }) else { throw GuestLinkError.invalid }
                return fields.mapValues(\.text)
            }, projected: { chunk in
                guard chunk["commandId"] == packet["command"]["id"].text, chunk["reservationId"] == packet["reservationId"].text,
                      chunk["index"] == String(chunks), let total = Int(chunk["count"] ?? ""), (1...29).contains(total),
                      let key = chunk["publicKey"], let hash = chunk["digest"], let piece = chunk["data"], piece.utf8.count <= 3072 else { throw GuestLinkError.invalid }
                if chunks == 0 { count = total; publicKey = key; digest = hash }
                guard total == count, key == publicKey, hash == digest, chunks < total else { throw GuestLinkError.invalid }
                box += piece; chunks += 1
                guard box.utf8.count <= 87420 else { throw GuestLinkError.invalid }
            })
        _ = try current()
        guard self.executor === executor, try consentProjection() != .null else { throw GuestLinkError.closed }
        var wire = result.mapValues(Wire.string)
        if result["outcome"] == "projected" {
            guard chunks > 0, chunks == count, ProtectedWire.digest(Data(box.utf8)) == digest else { throw GuestLinkError.invalid }
            wire["projection"] = ["box": .string(box), "publicKey": .string(publicKey)]
        } else { guard chunks == 0 else { throw GuestLinkError.invalid } }
        return .object(wire)
    }
    private func takeover() { guard !revoking, !closed else { return }; revokeAutomation(); onStop() }
    func revokeAutomation() {
        guard !revoking else { return }
        revoking = true; defer { revoking = false }
        let previous = executor; executor = nil; previous?.stop()
        browserSession?.stop(); browserSession = nil; browserConnected = false
    }
    func close() {
        guard !closed else { return }; closed = true; paired = false; selectionGeneration += 1
        revokeAutomation(); discovery?.stop(); discovery = nil
        applicationPin = .null; browserPin = .null; state = "Disconnected"
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

struct NativeGuestConnectionView: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var connection: NativeGuestConnection
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(connection.state).font(.caption)
            HStack {
                Button("Choose App…") { model.run { try await connection.selectApplication() } }
                Button("Refresh Connection") { model.run { try await connection.refresh() } }
            }.disabled(model.busy)
            HStack {
                Text("Accessibility: \(connection.accessibility ? "enabled" : "needed for app control")")
                if !connection.accessibility { Button("Enable Accessibility…") { connection.requestAccessibility() } }
                if !connection.screenCapture { Button("Enable Screen Capture…") { connection.requestCapture() } }
            }.font(.caption)
            let registry = model.automationSettings["targets"]
            if let change = try? connection.registration(expected: registry["reference"]), registry != .null,
               !registry["reconciliationRequired"].flag {
                Text(change["candidate"]["label"].text).font(.headline)
                if NativeGuestConnection.matchingApplications(change["candidate"], identity: connection.identity, registry: registry).isEmpty {
                    Text("Register this app, then set its permissions below. Saving ends the current connection.").font(.caption)
                    NativeProtectedChange(title: "Register This App…", change: change,
                        checkSelection: { try connection.requireSelection(change) }, requiredDevice: change["identity"]["deviceId"].text)
                } else {
                    Text("Registered · \(connection.applicationReadiness.replacingOccurrences(of: "_", with: " "))").font(.caption)
                    if GuestBrowserProfiles.families[change["candidate"]["bundleId"].text] != nil {
                        Button("Connect Browser Extension…") { model.run { try await connection.connectBrowser() } }.disabled(model.busy)
                        Text("Use your existing browser. Load the extension from the folder Josi opens, then attach a tab using its toolbar button.").font(.caption)
                        NativeBrowserRegistrationView(connection: connection)
                    }
                }
            }
        }
    }
}
