import AppKit
import SwiftUI
import Virtualization
import Darwin

/// Readiness/consent connection on this exact VZ device. It cannot dispatch
/// input, export observations, resolve a secret or register an agent runtime.
@MainActor final class NativeGuestConnection: NSObject, ObservableObject, @preconcurrency VZVirtioSocketListenerDelegate {
    @Published private(set) var state = "Waiting for the companion inside the desktop."
    @Published private(set) var paired = false
    @Published private(set) var accessibility = false
    @Published private(set) var screenCapture = false
    @Published private(set) var applicationCandidate: Wire = .null
    @Published private(set) var applicationReadiness = ""
    private let device: VZVirtioSocketDevice
    private let context: [String: String]
    private let current: @MainActor () throws -> Int
    private let resolveApplication: @MainActor (Wire) async throws -> Wire
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

    init(device: VZVirtioSocketDevice, context: [String: String], current: @escaping @MainActor () throws -> Int,
         resolveApplication: @escaping @MainActor (Wire) async throws -> Wire) {
        self.device = device; self.context = context; self.current = current; self.resolveApplication = resolveApplication
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
            paired = true; state = "Companion connected. Automation is not enabled."
            while !Task.isCancelled && !closed {
                let until = try current()
                let pin = currentApplicationPin(until: until)
                let encoded = pin == .null ? "" : String(decoding: try JSONEncoder().encode(pin), as: UTF8.self)
                try await link.send(["kind": "pulse", "leaseUntilMs": String(until), "applicationPin": encoded])
                let reply = try await link.receive()
                _ = try current()
                guard Set(reply.keys) == ["kind", "accessibility", "screenCapture", "executionEnabled", "applicationCandidate", "applicationReadiness"],
                      reply["kind"] == "status", reply["executionEnabled"] == "no",
                      ["yes", "no"].contains(reply["accessibility"] ?? ""),
                      ["yes", "no"].contains(reply["screenCapture"] ?? ""), let candidate = reply["applicationCandidate"],
                      candidate.utf8.count <= 2500 else { throw GuestLinkError.invalid }
                accessibility = reply["accessibility"] == "yes"; screenCapture = reply["screenCapture"] == "yes"
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
                applicationReadiness = ""
                guard let rawReadiness = reply["applicationReadiness"], rawReadiness.utf8.count <= 512 else { throw GuestLinkError.invalid }
                if !rawReadiness.isEmpty {
                    let value = try JSONDecoder().decode(Wire.self, from: Data(rawReadiness.utf8))
                    guard pin != .null, ProtectedWire.exact(value, ["requestId", "applicationId", "installationRevision", "state"]),
                          value["requestId"] == pin["requestId"],
                          value["applicationId"] == pin["projection"]["application"]["applicationId"],
                          value["installationRevision"].text == String(pin["projection"]["application"]["installationRevision"].integer),
                          ["running", "not_running", "ambiguous", "changed"].contains(value["state"].text)
                    else { throw GuestLinkError.invalid }
                    if pin["candidateId"] == applicationCandidate["candidateId"],
                       pin["projection"]["expiresAtMs"].integer > Int(Date().timeIntervalSince1970 * 1000) {
                        applicationReadiness = value["state"].text
                    }
                }
                refreshApplicationPin()
                try await Task.sleep(for: .seconds(2))
            }
        } catch {
            if !closed { state = "Companion disconnected or could not be verified. Reconnect inside the desktop." }
        }
        cancelQuestion(); paired = false; accessibility = false; screenCapture = false; applicationCandidate = .null
        applicationTask?.cancel(); applicationTask = nil; applicationPin = .null; applicationReadiness = ""
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
    func close() {
        guard !closed else { return }
        closed = true; cancelQuestion(); wire?.interrupt(); connection?.close()
        device.removeSocketListener(forPort: GuestLinkWire.port)
        task?.cancel(); task = nil; wire = nil; connection = nil
        applicationTask?.cancel(); applicationTask = nil; applicationPin = .null; applicationReadiness = ""
        paired = false; applicationCandidate = .null; state = "Companion disconnected."
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
            } else {
                Text("Inside the desktop, copy Josi Companion from the Josi Support disk into Applications, then open it and choose Connect to Josi.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private var readinessText: String {
        switch connection.applicationReadiness {
        case "running": return "The running app matches its saved identity. Automation is not enabled yet."
        case "not_running": return "Open this app inside the separate desktop when you are ready to use it."
        case "ambiguous": return "More than one copy is running. Leave only the intended copy open."
        case "changed": return "This running app does not match its saved identity. Select and register the current installation."
        default: return "Checking the selected app against its saved identity…"
        }
    }
}
