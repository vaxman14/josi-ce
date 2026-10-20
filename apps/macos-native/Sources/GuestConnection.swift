import AppKit
import SwiftUI
import Virtualization
import Darwin

/// Paired connection on this exact VZ device. The single-command path needs
/// protected local participation and an injected current server authorizer.
/// It cannot export observation contents or register an agent runtime.
@MainActor final class NativeGuestConnection: NSObject, ObservableObject, @preconcurrency VZVirtioSocketListenerDelegate {
    @Published private(set) var state = "Waiting for the companion inside the desktop."
    @Published private(set) var paired = false
    @Published private(set) var accessibility = false
    @Published private(set) var screenCapture = false
    @Published private(set) var supportsExecution = false
    @Published private(set) var applicationCandidate: Wire = .null
    @Published private(set) var applicationReadiness = ""
    @Published private(set) var browserCandidate: Wire = .null
    @Published private(set) var browserConnected = false
    private let device: VZVirtioSocketDevice
    private let context: [String: String]
    private let current: @MainActor () throws -> Int
    private let resolveApplication: @MainActor (Wire) async throws -> Wire
    private let resolveBrowser: @MainActor (Wire) async throws -> Wire
    private let consentProjection: @MainActor () throws -> Wire
    private let listener = VZVirtioSocketListener()
    private var connection: VZVirtioSocketConnection?
    private var wire: GuestLinkWire?
    private var task: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var pending: CheckedContinuation<Bool, Never>?
    private var alert: NSAlert?
    private var closed = false
    private var attempts = 0
    private var applicationTask: Task<Void, Never>?
    private var applicationPin: Wire = .null
    private var browserPin: Wire = .null
    private var browserTask: Task<Void, Never>?
    private var supportsBrowserProfiles = false
    private var supportsBrowserInspection = false
    private var supportsSafariInspection = false
    private var supportsFirefoxInspection = false
    private var supportsChromeDraft = false
    private var pairedBinding: Wire = .null
    private var sentConsent: Wire = .null
    private var execution: GuestPendingExecution?
    private var executionTimeout: Task<Void, Never>?
    private var usedReservations = Set<String>()

    init(device: VZVirtioSocketDevice, context: [String: String], current: @escaping @MainActor () throws -> Int,
         resolveApplication: @escaping @MainActor (Wire) async throws -> Wire,
         resolveBrowser: @escaping @MainActor (Wire) async throws -> Wire,
         consentProjection: @escaping @MainActor () throws -> Wire) {
        self.device = device; self.context = context; self.current = current; self.resolveApplication = resolveApplication
        self.consentProjection = consentProjection
        self.resolveBrowser = resolveBrowser
        super.init()
        listener.delegate = self
        device.setSocketListener(listener, forPort: GuestLinkWire.port)
    }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard !closed, socketDevice === device, listener === self.listener, self.connection == nil, attempts < 3 else { return false }
        do {
            _ = try current()
            let wire = try GuestLinkWire(descriptor: connection.fileDescriptor, host: true)
            attempts += 1; self.connection = connection; self.wire = wire
            state = "Verifying the guest connection…"
            task = Task { await run(wire) }
            return true
        } catch { return false }
    }
    private func hostBoot() throws -> String {
        var bytes = [CChar](repeating: 0, count: 128), size = 128
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0, (1...128).contains(size) else { throw GuestLinkError.unavailable }
        let value = String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self).lowercased()
        guard UUID(uuidString: value)?.uuidString.lowercased() == value else { throw GuestLinkError.invalid }
        return value
    }
    private func ask(_ code: String, expires: Int) async -> Bool {
        guard let parent = NSApp.windows.first(where: { $0.title == "Josi" }), pending == nil, !closed else { return false }
        let alert = NSAlert()
        alert.messageText = "Compare the companion code"
        alert.informativeText = "\(code)\n\nCheck that this exact code appears in Josi Companion inside your separate desktop.\n\nServer: \(context["serverOrigin"] ?? "")\nWorkspace: \(context["workspaceId"] ?? "")\n\nConnecting reports permission readiness only. It grants no computer or browser automation."
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "The Codes Match")
        self.alert = alert
        parent.makeKeyAndOrderFront(nil)
        timer = Task {
            try? await Task.sleep(for: .milliseconds(max(1, expires - Int(Date().timeIntervalSince1970 * 1000))))
            if !Task.isCancelled { cancelQuestion() }
        }
        return await withCheckedContinuation { continuation in
            pending = continuation
            alert.beginSheetModal(for: parent) { [weak self] result in
                guard let self, let waiting = pending else { return }
                pending = nil; self.alert = nil; timer?.cancel(); timer = nil
                waiting.resume(returning: result == .alertSecondButtonReturn && !closed)
            }
        }
    }
    private func cancelQuestion() {
        timer?.cancel(); timer = nil
        let waiting = pending; pending = nil
        if let alert { alert.window.sheetParent?.endSheet(alert.window); alert.window.orderOut(nil) }
        alert = nil; waiting?.resume(returning: false)
    }
    private func run(_ link: GuestLinkWire) async {
        do {
            let guest = try await link.receiveHello()
            guard !closed, Set(guest.keys) == ["version", "role", "key", "channel", "guestBoot", "hostBoot"],
                  guest["hostBoot"] == (try hostBoot()), let boot = guest["guestBoot"],
                  UUID(uuidString: boot)?.uuidString.lowercased() == boot else { throw GuestLinkError.invalid }
            _ = try current()
            let expiry = Int(Date().timeIntervalSince1970 * 1000) + 60_000
            var host = context
            host["version"] = "1"; host["role"] = "host"; host["key"] = link.publicKey
            host["channel"] = guest["channel"]; host["hostBoot"] = guest["hostBoot"]; host["expiresAtMs"] = String(expiry)
            try await link.sendHello(host)
            let code = try await link.configure(guest: guest, host: host)
            state = "Compare and accept the code in both native windows."
            guard await ask(code, expires: expiry), !closed else { throw GuestLinkError.closed }
            _ = try current()
            guard Int(Date().timeIntervalSince1970 * 1000) < expiry else { throw GuestLinkError.expired }
            try await link.send(["kind": "accept", "code": code])
            let accepted = try await link.receive(seconds: max(1, min(60, (expiry - Int(Date().timeIntervalSince1970 * 1000)) / 1000)))
            guard accepted == ["kind": "accept", "code": code], !closed else { throw GuestLinkError.invalid }
            _ = try current()
            pairedBinding = ["guestBootId": .string(boot), "guestChannelId": .string(guest["channel"]!)]
            paired = true; state = "Companion connected. Automation is not enabled."
            while !Task.isCancelled && !closed {
                let until = try current()
                let pin = currentApplicationPin(until: until)
                let encoded = pin == .null ? "" : String(decoding: try JSONEncoder().encode(pin), as: UTF8.self)
                let consent = try consentProjection()
                let consentJSON = consent == .null ? "" : String(decoding: try JSONEncoder().encode(consent), as: UTF8.self)
                var pulse = ["kind": "pulse", "leaseUntilMs": String(until), "applicationPin": encoded]
                if supportsBrowserProfiles {
                    let browser = currentBrowserPin(until: until)
                    pulse["browserPin"] = browser == .null ? "" : String(decoding: try JSONEncoder().encode(browser), as: UTF8.self)
                }
                if supportsExecution { pulse["consent"] = consentJSON }
                else if consent != .null { throw GuestLinkError.invalid }
                try await link.send(pulse)
                sentConsent = consent
                let reply = try await link.receive()
                _ = try current()
                let statusKeys: Set<String> = ["kind", "accessibility", "screenCapture", "executionEnabled", "applicationCandidate", "applicationReadiness"]
                guard (Set(reply.keys) == statusKeys || Set(reply.keys) == statusKeys.union(["executionProtocol"])
                    || Set(reply.keys) == statusKeys.union(["executionProtocol", "browserCandidate"])
                    || Set(reply.keys) == statusKeys.union(["executionProtocol", "browserCandidate", "browserConnection"])),
                      reply["kind"] == "status", reply["executionEnabled"] == "no",
                      reply["executionProtocol"] == nil || ["desktop-command.1", "desktop-command.2", "desktop-command.3", "desktop-command.4", "desktop-command.5", "desktop-command.6"].contains(reply["executionProtocol"] ?? ""),
                      ["yes", "no"].contains(reply["accessibility"] ?? ""),
                      ["yes", "no"].contains(reply["screenCapture"] ?? ""), let candidate = reply["applicationCandidate"],
                      candidate.utf8.count <= 2500 else { throw GuestLinkError.invalid }
                accessibility = reply["accessibility"] == "yes"; screenCapture = reply["screenCapture"] == "yes"
                supportsExecution = ["desktop-command.2", "desktop-command.3", "desktop-command.4", "desktop-command.5", "desktop-command.6"].contains(reply["executionProtocol"] ?? "")
                supportsBrowserInspection = ["desktop-command.3", "desktop-command.4", "desktop-command.5", "desktop-command.6"].contains(reply["executionProtocol"] ?? "")
                supportsSafariInspection = ["desktop-command.4", "desktop-command.5", "desktop-command.6"].contains(reply["executionProtocol"] ?? "")
                supportsFirefoxInspection = ["desktop-command.5", "desktop-command.6"].contains(reply["executionProtocol"] ?? "")
                supportsChromeDraft = reply["executionProtocol"] == "desktop-command.6"
                supportsBrowserProfiles = reply["browserCandidate"] != nil
                guard reply["browserConnection"] == nil || ["connected", "waiting"].contains(reply["browserConnection"] ?? "")
                else { throw GuestLinkError.invalid }
                browserConnected = reply["browserConnection"] == "connected"
                state = consent == .null ? "Companion connected. Inspection is not approved."
                    : supportsChromeDraft ? "Companion connected. Permitted Chrome drafts are available." : "Companion connected. Inspection is approved; input is unavailable."
                if candidate.isEmpty { applicationCandidate = .null }
                else {
                    let value = try JSONDecoder().decode(Wire.self, from: Data(candidate.utf8))
                    guard ProtectedWire.exact(value, ["schemaVersion", "candidateId", "guestBootId", "kind", "label", "bundlePath",
                                                     "bundleId", "signingId", "teamId", "codeHash"]),
                          value["schemaVersion"].text == "1", value["kind"].text == "application",
                          ProtectedWire.uuid(value["candidateId"]), value["guestBootId"].text == guest["guestBoot"],
                          ProtectedWire.text(value["label"], max: 96), ProtectedWire.text(value["bundlePath"], max: 768),
                          ProtectedWire.text(value["bundleId"], max: 200), ProtectedWire.text(value["signingId"], max: 200),
                          (value["teamId"] == .string("") || ProtectedWire.text(value["teamId"], max: 64)),
                          ProtectedWire.matches(value["codeHash"], "^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
                    else { throw GuestLinkError.invalid }
                    applicationCandidate = value
                }
                if let raw = reply["browserCandidate"], !raw.isEmpty {
                    guard raw.utf8.count <= 3000 else { throw GuestLinkError.invalid }
                    let value = try JSONDecoder().decode(Wire.self, from: Data(raw.utf8))
                    guard NativeBrowserTargetWire.candidate(value, guestBoot: boot, workspace: identity["workspaceId"].text) else { throw GuestLinkError.invalid }
                    browserCandidate = value
                } else { browserCandidate = .null }
                applicationReadiness = ""
                guard let rawReadiness = reply["applicationReadiness"], rawReadiness.utf8.count <= 512 else { throw GuestLinkError.invalid }
                if !rawReadiness.isEmpty {
                    let value = try JSONDecoder().decode(Wire.self, from: Data(rawReadiness.utf8))
                    guard pin != .null, ProtectedWire.exact(value, ["requestId", "applicationId", "installationRevision", "state"]),
                          value["requestId"] == pin["requestId"],
                          value["applicationId"] == pin["projection"]["application"]["applicationId"],
                          value["installationRevision"].text == String(pin["projection"]["application"]["installationRevision"].integer),
                          ["running", "background", "not_running", "ambiguous", "changed"].contains(value["state"].text)
                    else { throw GuestLinkError.invalid }
                    if pin["candidateId"] == applicationCandidate["candidateId"],
                       pin["projection"]["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) {
                        applicationReadiness = value["state"].text
                    }
                }
                refreshApplicationPin()
                refreshBrowserPin()
                if let execution { try await runExecution(execution, link: link) }
                try await Task.sleep(for: .seconds(2))
            }
        } catch {
            if !closed { state = "Companion disconnected or could not be verified. Reconnect inside the desktop." }
        }
        cancelQuestion(); paired = false; pairedBinding = .null; accessibility = false; screenCapture = false; supportsExecution = false; applicationCandidate = .null
        browserCandidate = .null
        browserConnected = false
        browserTask?.cancel(); browserTask = nil; browserPin = .null; supportsBrowserProfiles = false
        supportsBrowserInspection = false
        supportsSafariInspection = false
        supportsFirefoxInspection = false; supportsChromeDraft = false
        applicationTask?.cancel(); applicationTask = nil; applicationPin = .null; applicationReadiness = ""
        cancelExecution(); sentConsent = .null
        link.interrupt(); connection?.close(); connection = nil; wire = nil; task = nil
    }
    private func currentApplicationPin(until: Int) -> Wire {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard applicationPin["candidateId"] == applicationCandidate["candidateId"],
              applicationPin["projection"]["expiresAtMs"].integer > now,
              applicationPin["projection"]["expiresAtMs"].integer <= until else { return .null }
        return applicationPin
    }
    private func refreshApplicationPin() {
        guard !closed, paired, applicationTask == nil, applicationCandidate != .null else { return }
        if applicationPin["candidateId"] == applicationCandidate["candidateId"],
           applicationPin["projection"]["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) + 4000 { return }
        let selected = applicationCandidate
        applicationTask = Task {
            defer { if !Task.isCancelled { applicationTask = nil } }
            do {
                _ = try current()
                let projection = try await resolveApplication(selected)
                guard !Task.isCancelled, !closed, paired, applicationCandidate == selected else { return }
                let until = try current()
                guard projection != .null else { applicationPin = .null; return }
                guard projection["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000),
                      projection["expiresAtMs"].integer <= until else { throw GuestLinkError.expired }
                let pin: Wire = ["requestId": .string(UUID().uuidString.lowercased()),
                                 "candidateId": selected["candidateId"], "projection": projection]
                guard try JSONEncoder().encode(pin).count <= 4096 else { throw GuestLinkError.invalid }
                applicationPin = pin
            } catch {
                if !Task.isCancelled { applicationPin = .null; applicationReadiness = "" }
            }
        }
    }
    private func currentBrowserPin(until: Int) -> Wire {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard browserCandidate != .null, browserPin["candidateId"] == browserCandidate["candidateId"],
              browserPin["projection"]["expiresAtMs"].integer > now,
              browserPin["projection"]["expiresAtMs"].integer <= until,
              currentApplicationPin(until: until)["projection"]["application"]["applicationId"] == browserCandidate["applicationId"]
        else { return .null }
        return browserPin
    }
    private func refreshBrowserPin() {
        guard !closed, paired, supportsBrowserProfiles, browserTask == nil, browserCandidate != .null,
              applicationPin["projection"]["application"]["applicationId"] == browserCandidate["applicationId"],
              applicationPin["projection"]["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) else { return }
        if browserPin["candidateId"] == browserCandidate["candidateId"],
           browserPin["projection"]["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) + 4000 { return }
        let selected = browserCandidate
        browserTask = Task {
            defer { if !Task.isCancelled { browserTask = nil } }
            do {
                _ = try current()
                let projection = try await resolveBrowser(selected)
                guard !Task.isCancelled, !closed, paired, browserCandidate == selected else { return }
                let until = try current()
                guard projection != .null else { browserPin = .null; return }
                guard projection["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000),
                      projection["expiresAtMs"].integer <= until else { throw GuestLinkError.expired }
                let pin: Wire = ["candidateId": selected["candidateId"], "projection": projection]
                guard try JSONEncoder().encode(pin).count <= 4096 else { throw GuestLinkError.invalid }
                browserPin = pin
            } catch { if !Task.isCancelled { browserPin = .null } }
        }
    }
    var identity: Wire {
        .object(Dictionary(uniqueKeysWithValues: ["serverId", "userId", "deviceId", "workspaceId"].map {
            ($0, .string(context[$0] ?? ""))
        }))
    }
    /// UI discovery only. The session endpoint must resolve the selected ID
    /// from the current canonical Vault before sending a pin to the guest.
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
    func consentBinding() throws -> Wire {
        _ = try current()
        guard !closed, paired, pairedBinding != .null else { throw GuestLinkError.closed }
        return pairedBinding
    }
    func controlSelection() throws -> Wire {
        let until = try current(), pin = currentApplicationPin(until: until)
        guard !closed, paired, supportsExecution, accessibility, applicationReadiness == "running",
              pin != .null, pin["candidateId"] == applicationCandidate["candidateId"]
        else { throw GuestLinkError.unavailable }
        let app = pin["projection"]["application"]
        var result: [String: Wire] = ["applicationId": app["applicationId"], "installationRevision": app["installationRevision"]]
        if ["com.google.Chrome", "com.brave.Browser", "org.mozilla.firefox", "com.apple.Safari"].contains(app["bundleId"].text) {
            let browser = currentBrowserPin(until: until)["projection"]["browser"]
            guard browserConnected, supportsBrowserInspection, browser != .null, browser["candidate"]["applicationId"] == app["applicationId"],
                  ["chrome", "brave", "safari", "firefox"].contains(browser["candidate"]["family"].text),
                  browser["candidate"]["family"] != .string("safari") || supportsSafariInspection,
                  browser["candidate"]["family"] != .string("firefox") || supportsFirefoxInspection else { throw GuestLinkError.unavailable }
            result["browser"] = ["profileId": browser["profileId"], "family": browser["candidate"]["family"]]
        }
        return .object(result)
    }
    /// Internal server-bridge entry only. No renderer, tool or arbitrary JSON
    /// endpoint may supply the authorizer. There is deliberately no default.
    func execute(_ packet: Wire, authorize: @escaping @MainActor (Wire) async throws -> Wire) async throws -> Wire {
        _ = try current()
        guard paired, supportsExecution, !closed, execution == nil, let link = wire,
              ProtectedWire.exact(packet, ["reservationId", "command", "commandJSON", "application"]),
              ProtectedWire.uuid(packet["reservationId"]), usedReservations.count < 4096,
              !usedReservations.contains(packet["reservationId"].text) else { throw GuestLinkError.unavailable }
        let consent = try consentProjection()
        guard consent != .null, case .string(let commandJSON) = packet["commandJSON"], commandJSON.utf8.count <= 4096,
              try JSONDecoder().decode(Wire.self, from: Data(commandJSON.utf8)) == packet["command"]
        else { throw GuestLinkError.unavailable }
        usedReservations.insert(packet["reservationId"].text)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let request = GuestPendingExecution(packet: packet, consent: consent, authorize: authorize, continuation: continuation)
                execution = request
                executionTimeout = Task { [weak self] in
                    let now = Int(Date().timeIntervalSince1970 * 1000)
                    try? await Task.sleep(for: .milliseconds(max(1, min(10_000, packet["command"]["expiresAtMs"].integer - now))))
                    guard !Task.isCancelled, let self, self.execution === request else { return }
                    self.cancelExecution(); link.interrupt()
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelExecution(); link.interrupt() }
        }
    }
    func revokeAutomation() {
        if sentConsent != .null || execution != nil { wire?.interrupt() }
        cancelExecution(); sentConsent = .null
    }
    private func cancelExecution() {
        executionTimeout?.cancel(); executionTimeout = nil
        let request = execution; execution = nil
        request?.continuation.resume(throwing: GuestLinkError.closed)
    }
    private func requireExecution(_ request: GuestPendingExecution) throws {
        let until = try current(), consent = try consentProjection(), c = request.packet["command"]
        guard !closed, paired, execution === request, consent != .null, sentConsent != .null,
              ["identity", "authority", "guestBootId", "guestChannelId", "generation", "expiresAtMs"]
                .allSatisfy({ consent[$0] == request.consent[$0] && consent[$0] == sentConsent[$0] }),
              c["workspaceId"] == identity["workspaceId"], c["generation"] == consent["generation"],
              ProtectedWire.uuid(c["id"]), ProtectedWire.uuid(c["taskId"]), ProtectedWire.uuid(c["sessionId"]),
              ProtectedWire.integer(c["expiresAtMs"]), c["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000),
              c["expiresAtMs"].integer <= until, c["expiresAtMs"].integer <= consent["leaseUntilMs"].integer,
              ["observe", "project", "press", "focus", "click", "draft"].contains(c["operation"].text),
              currentApplicationPin(until: until)["projection"]["application"] == request.packet["application"],
              c["appId"] == request.packet["application"]["applicationId"],
              c["installationRevision"] == request.packet["application"]["installationRevision"]
        else { throw GuestLinkError.expired }
        if c["operation"] == .string("draft"), !supportsChromeDraft { throw GuestLinkError.unavailable }
        if c["browser"] != .null {
            let browser = currentBrowserPin(until: until)["projection"]["browser"]
            guard browserConnected, supportsBrowserInspection, browser != .null, c["browser"]["profileId"] == browser["profileId"],
                  c["browser"]["family"] == browser["candidate"]["family"] else { throw GuestLinkError.expired }
        }
    }
    private func runExecution(_ request: GuestPendingExecution, link: GuestLinkWire) async throws {
        try requireExecution(request)
        let c = request.packet["command"], reservation = request.packet["reservationId"].text
        let rawCommand = request.packet["commandJSON"].text
        let rawApplication = String(decoding: try JSONEncoder().encode(request.packet["application"]), as: UTF8.self)
        try await link.send(["kind": "execute", "reservationId": reservation, "command": rawCommand, "application": rawApplication,
                             "consentDigest": request.consent["authority"]["consent"]["digest"].text])
        var response = try await link.receive()
        var authorized = false
        if response["kind"] == "authorize" {
            try requireExecution(request)
            guard Set(response.keys) == ["kind", "commandId", "reservationId", "commandDigest", "target", "targetDigest", "consentDigest"],
                  response["commandId"] == c["id"].text, response["reservationId"] == reservation,
                  response["commandDigest"] == ProtectedWire.digest(Data(rawCommand.utf8)),
                  response["consentDigest"] == request.consent["authority"]["consent"]["digest"].text,
                  let targetJSON = response["target"], targetJSON.utf8.count <= 4096,
                  response["targetDigest"] == ProtectedWire.digest(Data(targetJSON.utf8)) else { throw GuestLinkError.invalid }
            let target = try JSONDecoder().decode(Wire.self, from: Data(targetJSON.utf8))
            if c["browser"] != .null {
                let browser = currentBrowserPin(until: try current())["projection"]["browser"]
                guard ProtectedWire.exact(target, ["kind", "profileId", "nativeProfileId", "family", "extensionId", "extensionDigest",
                    "processId", "launchedAtMs", "codeHash", "origin"]),
                      target["kind"] == .string("browser"), target["profileId"] == browser["profileId"],
                      ["nativeProfileId", "family", "extensionId", "extensionDigest"].allSatisfy({ target[$0] == browser["candidate"][$0] }),
                      target["codeHash"] == request.packet["application"]["codeHash"], target["origin"] == c["browser"]["origin"],
                      ProtectedWire.integer(target["processId"], positive: true), ProtectedWire.integer(target["launchedAtMs"], positive: true)
                else { throw GuestLinkError.invalid }
            } else {
                guard ProtectedWire.exact(target, ["processId", "launchedAt", "bundleId", "executablePath", "windowTitle", "bounds"]),
                  ProtectedWire.integer(target["processId"], positive: true), target["windowTitle"] == .string(""),
                  target["bundleId"] == request.packet["application"]["bundleId"],
                  target["executablePath"].text.hasPrefix(request.packet["application"]["bundlePath"].text + "/")
                else { throw GuestLinkError.invalid }
            }
            let query = Wire.object(response.mapValues(Wire.string))
            let permit = try await request.authorize(query)
            try requireExecution(request)
            guard ProtectedWire.exact(permit, ["kind", "commandId", "reservationId", "commandDigest", "targetDigest", "consentDigest", "expiresAtMs"]),
                  permit["kind"] == .string("permit"), ["commandId", "reservationId", "commandDigest", "targetDigest", "consentDigest"]
                    .allSatisfy({ permit[$0] == query[$0] }),
                  case .string(let rawUntil) = permit["expiresAtMs"], let until = Int(rawUntil), String(until) == rawUntil,
                  until > Int(Date().timeIntervalSince1970 * 1000), until == c["expiresAtMs"].integer,
                  case .object(let fields) = permit else { throw GuestLinkError.invalid }
            try await link.send(fields.mapValues(\.text))
            authorized = true
            response = try await link.receive()
        }
        var encrypted = "", recipient = "", contentDigest = "", chunkCount = 0, chunkIndex = 0
        while response["kind"] == "projection" {
            try requireExecution(request)
            guard authorized, c["operation"] == .string("project"), chunkIndex < 29,
                  Set(response.keys) == ["kind", "commandId", "reservationId", "index", "count", "publicKey", "digest", "data"],
                  response["commandId"] == c["id"].text, response["reservationId"] == reservation,
                  response["index"] == String(chunkIndex), let count = Int(response["count"] ?? ""), (1...29).contains(count),
                  response["count"] == String(count), let piece = response["data"], !piece.isEmpty, piece.utf8.count <= 3072,
                  let key = response["publicKey"], let raw = Data(base64Encoded: key), raw.count == 32,
                  raw.base64EncodedString() == key, let digest = response["digest"],
                  digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw GuestLinkError.invalid }
            if chunkIndex == 0 { recipient = key; contentDigest = digest; chunkCount = count }
            guard recipient == key, contentDigest == digest, chunkCount == count, chunkIndex < count,
                  chunkIndex == count - 1 || piece.utf8.count == 3072 else { throw GuestLinkError.invalid }
            encrypted += piece; chunkIndex += 1
            guard encrypted.utf8.count <= 87_420 else { throw GuestLinkError.invalid }
            response = try await link.receive()
        }
        guard Set(response.keys) == ["kind", "commandId", "reservationId", "outcome", "verificationRequired", "observationId", "windowId"],
              response["kind"] == "result", response["commandId"] == c["id"].text, response["reservationId"] == reservation,
              response["verificationRequired"] == "yes", ["observed", "projected", "inputIssued", "filled", "denied", "uncertain"].contains(response["outcome"] ?? "")
        else { throw GuestLinkError.invalid }
        if ["observed", "projected", "inputIssued", "filled"].contains(response["outcome"] ?? ""), !authorized { throw GuestLinkError.invalid }
        if response["outcome"] == "observed" {
            guard c["operation"] == .string("observe"), response["observationId"] == c["resultObservationId"].text,
                  ProtectedWire.uuid(.string(response["windowId"] ?? "")) else { throw GuestLinkError.invalid }
        } else if response["outcome"] == "projected" {
            guard c["operation"] == .string("project"), chunkIndex > 0, chunkIndex == chunkCount,
                  response["observationId"] == c["resultObservationId"].text, response["windowId"] == c["windowId"].text,
                  let box = Data(base64Encoded: encrypted), box.base64EncodedString() == encrypted,
                  ProtectedWire.digest(Data(encrypted.utf8)) == contentDigest else { throw GuestLinkError.invalid }
        } else {
            if response["outcome"] == "filled", c["operation"] != .string("draft") { throw GuestLinkError.invalid }
            guard response["observationId"] == "", response["windowId"] == "",
                  response["outcome"] != "inputIssued" || c["operation"] != .string("observe") else { throw GuestLinkError.invalid }
        }
        try requireExecution(request)
        execution = nil; executionTimeout?.cancel(); executionTimeout = nil
        guard response["outcome"] == "projected" || chunkIndex == 0 else { throw GuestLinkError.invalid }
        var result = response.mapValues(Wire.string)
        if response["outcome"] == "projected" { result["projection"] = .object(["publicKey": .string(recipient), "box": .string(encrypted)]) }
        request.continuation.resume(returning: .object(result))
        if response["outcome"] == "uncertain" { revokeAutomation(); link.interrupt() }
    }
    func close() {
        guard !closed else { return }
        closed = true; cancelQuestion(); wire?.interrupt(); connection?.close()
        cancelExecution(); sentConsent = .null
        device.removeSocketListener(forPort: GuestLinkWire.port)
        task?.cancel(); task = nil; wire = nil; connection = nil
        applicationTask?.cancel(); applicationTask = nil; applicationPin = .null; applicationReadiness = ""
        paired = false; pairedBinding = .null; supportsExecution = false; applicationCandidate = .null; browserCandidate = .null; state = "Companion disconnected."
        browserConnected = false
        browserTask?.cancel(); browserTask = nil; browserPin = .null; supportsBrowserProfiles = false
        supportsBrowserInspection = false
        supportsSafariInspection = false
        supportsFirefoxInspection = false
    }
}

@MainActor private final class GuestPendingExecution {
    let packet: Wire
    let consent: Wire
    let authorize: @MainActor (Wire) async throws -> Wire
    let continuation: CheckedContinuation<Wire, Error>
    init(packet: Wire, consent: Wire, authorize: @escaping @MainActor (Wire) async throws -> Wire,
         continuation: CheckedContinuation<Wire, Error>) {
        self.packet = packet; self.consent = consent; self.authorize = authorize; self.continuation = continuation
    }
}

struct NativeGuestConnectionView: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var connection: NativeGuestConnection
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(connection.state).font(.caption)
            if connection.paired {
                Text("Guest Accessibility: \(connection.accessibility ? "ready" : "not enabled") · Screen capture: \(connection.screenCapture ? "ready" : "not enabled")")
                    .font(.caption).foregroundStyle(.secondary)
                let registered = model.automationSettings["targets"]
                if let change = try? connection.registration(expected: registered["reference"]), registered != .null,
                   !registered["reconciliationRequired"].flag {
                    let candidate = change["candidate"]
                    if !NativeGuestConnection.matchingApplications(candidate, identity: connection.identity, registry: registered).isEmpty {
                        Text(candidate["label"].text + " is registered. Configure its permissions in Automation Settings.").font(.caption)
                        Text(readinessText).font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Selected guest app: " + candidate["label"].text).font(.headline)
                        Text(candidate["bundlePath"].text).font(.caption).textSelection(.enabled)
                        Text("Saving registers the app in the Vault and closes this development desktop. Reopen it after configuring permissions.")
                            .font(.caption).foregroundStyle(.secondary)
                        NativeProtectedChange(title: "Register This App…", change: change,
                            checkSelection: { try connection.requireSelection(change) },
                            requiredDevice: change["identity"]["deviceId"].text)
                    }
                } else {
                    Text("Choose an app in Josi Companion to configure its permissions here.").font(.caption)
                }
                NativeBrowserRegistrationView(connection: connection)
            } else {
                Text("Inside the desktop, copy Josi Companion from the Josi Support disk into Applications, then open it and choose Connect to Josi.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private var readinessText: String {
        switch connection.applicationReadiness {
        case "running": return "The running app matches its saved identity."
        case "not_running": return "Open this app inside the separate desktop when you are ready to use it."
        case "background": return "Bring this app’s window to the front inside the separate desktop before approving inspection."
        case "ambiguous": return "More than one copy is running. Leave only the intended copy open."
        case "changed": return "This running app does not match its saved identity. Select and register the current installation."
        default: return "Checking the selected app against its saved identity…"
        }
    }
}
