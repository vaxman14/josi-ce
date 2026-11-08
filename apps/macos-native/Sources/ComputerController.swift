import AppKit
import SwiftUI
import LocalAuthentication
@preconcurrency import ApplicationServices

@MainActor final class ComputerController: ObservableObject {
    let gate = ComputerLocalGate()
    lazy var overlay = ComputerOverlay(gate: gate)
    lazy var desktop = ComputerDesktop(gate: gate, overlay: overlay)
    @Published var snapshot: Wire = .null
    @Published var problem = ""
    @Published var showPanel = false
    @Published var connected = false
    @Published var selectedSavedWorkspace = ""
    private weak var model: JosiModel?
    private var key: ComputerDeviceKey?
    private var identity = ""
    private var worker: Task<Void, Never>?
    private var work: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var seenProposals = Set<String>()
    private var polling = false
    private var stopping = false
    private var stopTask: Task<Void, Never>?
    private var stopKey: String { "computerControl.pendingStop." + ComputerWire.digest(Data(identity.utf8)) }
    private var pendingStop: Bool { UserDefaults.standard.object(forKey: stopKey) == nil || UserDefaults.standard.bool(forKey: stopKey) }
    // Advertise only implemented operations. Unsupported terminal and generic
    // pointer controls cannot acquire an execution lease in this preview.
    static let capabilities = ["environment", "file.list", "file.read", "file.write", "app.list", "app.launch",
        "window.read", "window.capture", "window.click", "window.type", "window.scroll", "window.drag", "window.close"]
    func attach(_ model: JosiModel) {
        self.model = model
        overlay.resumeWork = { [weak self] in self?.resume() }
        overlay.permissions = { [weak self] in
            guard let self else { return }; self.gate.pause(); self.showPanel = true
            model.section = "chat"; NSApp.activate(ignoringOtherApps: true)
        }
        gate.cancelOwnedWork = { [weak self] in
            guard let self else { return }; self.work?.cancel(); self.desktop.clear()
            if self.gate.mode == .stopped { self.sendStop() }
        }
        guard worker == nil else { return }
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self else { return }
                if self.gate.mode == .working {
                    do { try self.gate.check() } catch { self.gate.stop("Local execution lease expired") }
                }
            }
        }
        worker = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
    func disconnect() {
        gate.stop("Disconnected locally"); key = nil; connected = false; identity = ""; snapshot = .null; overlay.hide()
    }
    private func api() throws -> (JosiAPI, String, ComputerDeviceKey) {
        guard let model, model.screen == .workspace, let api = model.api, let key, !model.user["id"].text.isEmpty,
              identity == api.origin.absoluteString + "\n" + model.user["id"].text else { throw JosiError(message: "Connect and enroll this Mac first.") }
        return (api, model.user["id"].text, key)
    }
    private func call(_ method: String, _ body: Wire = [:]) async throws -> Wire {
        let (api, owner, key) = try api(); let proof = try key.proof(owner: owner, method: method, body: body)
        let response = try await api.request("/computer-control/device/" + method, method: "POST", body: ["proof": proof])
        guard model?.api === api, model?.user["id"].text == owner else { throw CancellationError() }
        return response
    }
    func enroll(password: String) async throws {
        guard let model, model.isAdministrator, let api = model.api, !password.isEmpty else { throw JosiError(message: "Sign in as the owner and enter the account password in this form.") }
        gate.stop("Reviewing computer enrollment")
        overlay.authenticationActive = true; overlay.hide()
        defer { overlay.authenticationActive = false; overlay.start() }
        let owner = model.user["id"].text
        snapshot = try await api.request("/computer-control")
        let saved = snapshot["savedPermissionChoices"].list.filter {
            $0["identity"]["userId"].text == owner && $0["identity"]["serverOrigin"].text == api.origin.absoluteString
        }
        var choice: Wire = .null
        if !saved.isEmpty {
            if !selectedSavedWorkspace.isEmpty { choice = saved.first { $0["workspaceId"].text == selectedSavedWorkspace } ?? .null }
            else if saved.count == 1 { choice = saved[0] }
            else {
                var matches: [Wire] = []
                for candidate in saved {
                    let port = NativeKeyPort(identity: candidate["identity"])
                    do {
                        try await port.start()
                        let found = try await port.request("computerFingerprint", fields: [:])
                        if found["fingerprint"] == candidate["wrappingFingerprint"] { matches.append(candidate) }
                    } catch { /* Another saved Mac does not possess this local key. */ }
                    port.cancel()
                }
                if matches.count == 1 { choice = matches[0] }
                else { throw JosiError(message: "Choose the saved desktop whose permissions you want to use on this Mac.") }
            }
        }
        if choice == .null {
            if snapshot["policyStatus"]["required"].flag { throw JosiError(message: "This Mac needs its saved current-desktop enrollment before it can use the existing permissions.") }
            let context = LAContext(); defer { context.invalidate() }
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil),
                  try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Enroll this Mac for the computer-control permission card you reviewed.") else { throw JosiError(message: "Local owner authentication was declined or unavailable.") }
        }
        guard let created = try ComputerDeviceKey.load(server: api.origin.absoluteString, owner: owner, create: true) else { throw JosiError(message: "Cannot create this Mac’s key.") }
        if let existing = snapshot["devices"].list.first(where: { $0["id"].text == created.id }) {
            guard !existing["revoked"].flag else { throw JosiError(message: "This computer-control key was revoked. It cannot be silently enrolled again.") }
        } else {
            let proof = try created.proof(owner: owner, method: "enroll", body: ["publicKey": .string(created.publicKey), "platform": "macos", "label": .string(Host.current().localizedName ?? "This Mac")])
            _ = try await api.request("/computer-control/enroll", method: "POST", body: ["password": .string(password), "proof": proof])
        }
        guard model.api === api, model.user["id"].text == owner else { throw CancellationError() }
        key = created; identity = api.origin.absoluteString + "\n" + owner; connected = true
        if choice != .null {
            let challenge = try await call("link-prepare", ["enrollmentId": choice["enrollmentId"], "workspaceId": choice["workspaceId"]])
            let prefix = Data("josi-computer-control-link.1\n".utf8)
            guard challenge["identity"] == choice["identity"],
                  let message = Data(base64Encoded: challenge["message"].text), message.count <= 4096, message.starts(with: prefix),
                  case .array(let fields) = try JSONDecoder().decode(Wire.self, from: message.dropFirst(prefix.count)), fields.count == 14,
                  fields[1] == challenge["challengeId"], fields[3].text == api.origin.absoluteString, fields[5].text == owner,
                  fields[6] == choice["identity"]["deviceId"], fields[8] == choice["wrappingFingerprint"],
                  fields[11].text == created.id, fields[12].text == created.publicKey, fields[13] == choice["workspaceId"] else { throw approvalUnavailable() }
            let port = NativeKeyPort(identity: choice["identity"]); defer { port.cancel() }
            try await port.start()
            let signed = try await port.request("proveComputerControlLink", fields: ["message": challenge["message"]])
            guard model.api === api, model.user["id"].text == owner else { throw CancellationError() }
            _ = try await call("link-complete", ["challengeId": challenge["challengeId"], "signature": .string(try ProtectedWire.signature(signed, host: true))])
        }
        await poll()
    }
    func decide(_ proposal: Wire, approve: Bool, password: String) async throws {
        guard let model, let api = model.api, model.isAdministrator else { throw JosiError(message: "Sign in as the owner.") }
        let owner = model.user["id"].text
        guard proposal["ownerId"].text == owner, proposal["expiresAt"].integer > Int(Date().timeIntervalSince1970 * 1000) else { throw JosiError(message: "This permission card is stale or belongs to a different owner.") }
        var resumeGeneration: Int?
        if approve {
            // Phone-side cryptographic confirmation is not shipped in this adapter.
            guard proposal["deviceId"].text == key?.id else { throw JosiError(message: "Approve this change on its enrolled target Mac. Paired-phone confirmation is not available yet.") }
            let wasReady = gate.mode == .ready
            gate.pause()
            if wasReady { resumeGeneration = gate.generation }
            overlay.authenticationActive = true; overlay.hide()
            defer { overlay.authenticationActive = false; overlay.start() }
            let context = LAContext(); defer { context.invalidate() }
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil),
                  try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Confirm the exact computer-control permission displayed in Josi.") else { throw JosiError(message: "Local authentication was declined or unavailable.") }
        }
        guard model.api === api, model.user["id"].text == owner else { throw CancellationError() }
        _ = try await api.request("/computer-control/proposals/\(try api.uuid(proposal["id"].text))/decision", method: "POST",
            body: ["approve": .bool(approve), "digest": proposal["digest"], "password": .string(password)])
        snapshot = try await api.request("/computer-control")
        // Applying a card can continue an already-ready executor. It cannot
        // clear a pre-existing Stop/takeover or a Stop pressed during review.
        if let resumeGeneration, gate.generation == resumeGeneration, gate.mode == .paused { gate.resume() }
        overlay.start()
    }
    func resume() {
        problem = ""; overlay.start(); overlay.installInputMonitor()
        let generation = gate.generation
        Task {
            do {
                // A local click can resume already-granted authority; it cannot
                // add a permission. Flush an offline Stop before this Resume.
                await stopTask?.value
                if pendingStop {
                    _ = try await call("stop")
                    UserDefaults.standard.set(false, forKey: stopKey)
                }
                _ = try await call("resume")
                guard gate.generation == generation else { sendStop(); return }
                gate.resume()
            } catch { problem = error.localizedDescription }
        }
    }
    enum PrivacyPermission { case accessibility, recording, monitoring }
    /// Invoked only by an explicit local button, never by polling or a tool.
    func requestPrivacy(_ permission: PrivacyPermission) {
        gate.pause(); overlay.authenticationActive = true; overlay.hide()
        defer { overlay.authenticationActive = false }
        let accepted: Bool
        switch permission {
        case .accessibility:
            accepted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case .recording: accepted = CGRequestScreenCaptureAccess()
        case .monitoring: accepted = CGRequestListenEventAccess()
        }
        problem = accepted ? "Permission is available. Resume locally when you are ready." : "Complete the Mac’s Privacy & Security prompt if you want this access. Control remains paused; a restart may be required."
    }
    func stopDevice(_ deviceId: String) async {
        if key?.id == deviceId { gate.stop() }
        guard let api = model?.api, deviceId.range(of: "^mac-[a-f0-9]{40}$", options: .regularExpression) != nil else { return }
        do {
            _ = try await api.request("/computer-control/devices/\(deviceId)/stop", method: "POST", body: [:])
            snapshot = try await api.request("/computer-control")
        } catch { problem = error.localizedDescription }
    }
    private func sendStop() {
        guard connected, !identity.isEmpty else { return }
        UserDefaults.standard.set(true, forKey: stopKey)
        guard !stopping else { return }; stopping = true
        let capturedIdentity = identity
        stopTask = Task {
            defer { stopping = false }
            do {
                _ = try await call("stop")
                if identity == capturedIdentity { UserDefaults.standard.set(false, forKey: stopKey) }
            } catch { /* Retry before claiming anything after reconnection. */ }
        }
    }
    private func poll() async {
        guard !polling, let model, model.screen == .workspace, model.isAdministrator, let api = model.api else { return }
        polling = true; defer { polling = false }
        do {
            let current = api.origin.absoluteString + "\n" + model.user["id"].text
            if identity != current {
                disconnect(); identity = current
                key = try ComputerDeviceKey.load(server: api.origin.absoluteString, owner: model.user["id"].text)
            }
            snapshot = try await api.request("/computer-control")
            guard model.api === api else { throw CancellationError() }
            guard let key, let device = snapshot["devices"].list.first(where: { $0["id"].text == key.id && !$0["revoked"].flag }) else { connected = false; return }
            connected = true; overlay.start()
            if pendingStop {
                _ = try await call("stop")
                UserDefaults.standard.set(false, forKey: stopKey)
                snapshot = try await api.request("/computer-control")
                return
            }
            for proposal in snapshot["proposals"].list where proposal["deviceId"].text == key.id {
                if seenProposals.insert(proposal["id"].text).inserted { showPanel = true }
            }
            if device["stopped"].flag, gate.mode == .working { gate.stop("Server revoked or stopped this work") }
            _ = try await call("presence", ["capabilities": .array(Self.capabilities.map(Wire.string))])
            guard gate.mode == .ready, work == nil else { return }
            let next = try await call("next")
            guard next["request"] != .null else { return }
            let q = next["request"]
            try gate.begin(q, device: next["device"], owner: model.user["id"].text, deviceId: key.id)
            work = Task { [weak self] in await self?.execute(q) }
        } catch {
            if connected { gate.stop("Connection or authorization lost") }
            if let e = error as? JosiError, e.status == 404 { problem = "This server does not yet support computer-control.2." }
            else { problem = error.localizedDescription }
        }
    }
    private func execute(_ q: Wire) async {
        let generation = gate.generation
        let heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3)); guard !Task.isCancelled, let self else { return }
                do {
                    let lease = try await self.call("lease", ["requestId": q["id"]])
                    try self.gate.check(generation: generation); try self.gate.renew(lease["leaseUntil"].integer, revision: lease["revision"].integer)
                } catch { self.gate.stop("Execution lease ended"); return }
            }
        }
        defer { heartbeat.cancel(); work = nil; gate.finish() }
        do {
            try gate.check(generation: generation); try Task.checkCancellation()
            let op = q["operation"]
            let result: Wire
            switch op["action"].text {
            case "environment": result = ["platform": "macos", "home": .string(NSHomeDirectory()), "version": .string(ProcessInfo.processInfo.operatingSystemVersionString),
                "capabilities": .array(Self.capabilities.map(Wire.string)), "terminal": "Unavailable: persistent terminal authority and detached process containment are not verified.", "administrator": "Unavailable"]
            case "file.list", "file.read", "file.write": result = try ComputerFiles.execute(op)
            default: result = try await desktop.execute(q)
            }
            try gate.check(generation: generation); try Task.checkCancellation()
            _ = try await call("result", ["requestId": q["id"], "ok": .bool(true), "result": result])
        } catch {
            _ = try? await call("result", ["requestId": q["id"], "ok": .bool(false), "result": ["error": .string(error.localizedDescription)]])
            problem = error.localizedDescription
        }
    }
}

struct ComputerControlPanel: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var controller: ComputerController
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var busy = false
    @State private var problem = ""
    @AppStorage("computerControl.emergencyShortcut") private var shortcut = ComputerEmergencyShortcut.controlOptionEscape.rawValue
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Computer control · This Mac").font(.title2)
            Text("Set permissions by talking to Josi. Review the exact computer and change here. Local Stop works without the server; Resume is explicit.").font(.callout)
            Text("Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted") · Screen Recording: \(CGPreflightScreenCaptureAccess() ? "granted" : "not granted") · Input Monitoring: \(CGPreflightListenEventAccess() ? "granted" : "not granted")").font(.caption)
            HStack {
                Button("Review Accessibility…") { controller.requestPrivacy(.accessibility) }
                Button("Review Screen Recording…") { controller.requestPrivacy(.recording) }
                Button("Review Input Monitoring…") { controller.requestPrivacy(.monitoring) }
            }.controlSize(.small).disabled(busy)
            Picker("Emergency Stop", selection: $shortcut) {
                ForEach(ComputerEmergencyShortcut.allCases) { Text($0.label).tag($0.rawValue) }
            }.font(.caption)
            SecureField("Account password — kept outside chat", text: $password).textFieldStyle(.roundedBorder).disabled(busy)
            if !controller.snapshot["policyStatus"]["reason"].text.isEmpty {
                Text(controller.snapshot["policyStatus"]["reason"].text).foregroundStyle(.orange).font(.caption)
            }
            if controller.snapshot["savedPermissionChoices"].list.count > 1 {
                Picker("Saved desktop permissions", selection: $controller.selectedSavedWorkspace) {
                    Text("Match this Mac automatically").tag("")
                    ForEach(Array(controller.snapshot["savedPermissionChoices"].list.enumerated()), id: \.offset) { _, choice in
                        Text(choice["label"].text).tag(choice["workspaceId"].text)
                    }
                }
            }
            if controller.connected && controller.snapshot["policyStatus"]["required"].flag {
                Button("Connect Saved Permissions…") { perform { try await controller.enroll(password: $0) } }.disabled(busy)
            }
            if !controller.connected {
                Text("Enrollment creates a device signing key in this Mac’s Keychain. It grants no computer access.").font(.caption)
                Button("Enroll This Mac…") { perform { try await controller.enroll(password: $0) } }.disabled(busy)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(controller.snapshot["devices"].list, id: \.identifier) { device in
                        DisclosureGroup(device["label"].text + (device["stopped"].flag ? " · stopped" : " · enabled")) {
                            Text(device["savedPermissions"] != .null ? "Your existing Vault permissions and Cardinal Rules are enforced for every operation." : "Local Resume and operating-system permissions are also required.").font(.caption).foregroundStyle(.secondary)
                            ForEach(device["rules"].list, id: \.identifier) { rule in
                                Text(rule["decision"].text + " · " + rule["action"].text + " · " + rule["scope"]["target"].text + " · " + rule["duration"]["kind"].text)
                                    .font(.caption).textSelection(.enabled)
                            }
                            if device["rules"].list.isEmpty { Text("No computer access granted.").font(.caption) }
                        }
                    }
                    ForEach(controller.snapshot["proposals"].list, id: \.identifier) { proposal in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(proposal["summary"].text).textSelection(.enabled)
                            Text("Your chat instruction: " + proposal["instruction"].text).font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Button("Decline") { perform { try await controller.decide(proposal, approve: false, password: $0) } }
                                Button("Authenticate and Apply…") { perform { try await controller.decide(proposal, approve: true, password: $0) } }
                            }
                        }.padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    }
                    Text("Terminal sessions, remote phone approvals, and administrator operations are not available in this preview.").font(.caption).foregroundStyle(.secondary)
                }
            }.disabled(busy)
            if !problem.isEmpty || !controller.problem.isEmpty { Text(problem.isEmpty ? controller.problem : problem).foregroundStyle(.red).font(.caption) }
            HStack {
                Button("Stop", role: .destructive) { controller.gate.stop() }
                Button("Resume Locally") { controller.resume() }.disabled(busy || !controller.connected)
                Button("Permissions in Chat") { model.section = "chat"; dismiss() }
                Spacer(); Button("Close") { dismiss() }
            }
        }.padding(24).frame(width: 700, height: 640)
    }
    private func perform(_ fn: @escaping (String) async throws -> Void) {
        let secret = password; password = ""; busy = true; problem = ""
        Task { defer { busy = false }; do { try await fn(secret) } catch { problem = error.localizedDescription } }
    }
}
