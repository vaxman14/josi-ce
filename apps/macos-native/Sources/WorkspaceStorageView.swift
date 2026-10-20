import AppKit
import SwiftUI
import Darwin
import UniformTypeIdentifiers

extension ProtectedWire {
    static func storageChallenge(_ value: Wire, request: Wire, origin: String, user: String) throws -> Data {
        let base = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId",
                    "keyReference", "wrappingFingerprint", "issuedAtMs", "expiresAtMs"]
        guard exact(value, base + ["operation", "workspaceId", "label", "capacityGiB"]),
              ["provision", "open"].contains(value["operation"].text), value["operation"] == request["operation"],
              value["workspaceId"] == request["workspaceId"],
              value["label"] == request["label"], value["capacityGiB"] == request["capacityGiB"],
              uuid(value["workspaceId"]), text(value["label"], max: 120),
              integer(value["capacityGiB"]), (64...512).contains(value["capacityGiB"].integer),
              value["keyReference"]["recordId"].text == "914a736a-94bf-46f2-a602-82ff4180c45d"
        else { throw approvalUnavailable() }
        let host = Wire.object(Dictionary(uniqueKeysWithValues: base.map { ($0, value[$0]) }))
        _ = try challenge(host, host: true, origin: origin, user: user, device: request["deviceId"].text)
        let key = value["keyReference"]
        var fields = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId"].map { value[$0] }
        fields += [.array([key["recordId"], key["version"], key["digest"], key["epoch"]]),
                   value["wrappingFingerprint"], value["issuedAtMs"], value["expiresAtMs"],
                   value["operation"], value["workspaceId"], value["label"], value["capacityGiB"]]
        return Data(("josi-workspace-storage.1\n" + (try canonical(.array(fields)))).utf8)
    }
}

/// Fixed signed bundle and managed storage paths. Disk creation runs to a
/// bounded result once started; no shell, argv password or persistent key.
@MainActor enum NativeWorkspaceImage {
    static func run(_ request: Wire, admission: @MainActor () throws -> Void = {}) async throws -> Wire {
        guard NativeServer.canManage, ["create", "status", "attach", "detach"].contains(request["operation"].text),
              ProtectedWire.uuid(request["workspaceId"]),
              try await NativeServer.process("/usr/bin/codesign",
                ["--verify", "--deep", "--strict", "-R", NativeServer.requirement, NativeServer.application]) == 0 else {
            throw JosiError(message: "Install the signed Josi app in Applications before preparing workspace storage.")
        }
        try Task.checkCancellation()
        try admission()
        let data = try JSONEncoder().encode(request)
        guard data.count <= 16 * 1024 else { throw approvalUnavailable() }
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process(), input = Pipe(), output = Pipe()
                let runtime = "/Applications/Josi.app/Contents/Resources/runtime"
                process.executableURL = URL(fileURLWithPath: runtime + "/python/bin/python3.11")
                process.arguments = ["-I", "-B", runtime + "/app/native/automation-workspace.py"]
                process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
                process.currentDirectoryURL = URL(fileURLWithPath: "/")
                process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
                do {
                    guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw approvalUnavailable() }
                    try process.run()
                    try input.fileHandleForWriting.write(contentsOf: data)
                    try input.fileHandleForWriting.close()
                    var received = Data()
                    let deadline = DispatchTime.now().uptimeNanoseconds + 240_000_000_000
                    while true {
                        guard DispatchTime.now().uptimeNanoseconds < deadline else { throw approvalUnavailable() }
                        var descriptor = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
                        let ready = poll(&descriptor, 1, 500)
                        if ready == 0 || ready < 0 && errno == EINTR { continue }
                        guard ready > 0 else { throw approvalUnavailable() }
                        let bytes = try output.fileHandleForReading.read(upToCount: 4096) ?? Data()
                        if bytes.isEmpty { break }
                        received.append(bytes)
                        guard received.count <= 16 * 1024 else { throw approvalUnavailable() }
                    }
                    process.waitUntilExit()
                    guard process.terminationStatus == 0 else { throw approvalUnavailable() }
                    let response = try JSONDecoder().decode(Wire.self, from: received)
                    continuation.resume(returning: response)
                } catch {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    continuation.resume(throwing: JosiError(message: "Storage preparation could not be confirmed. Its files were retained; inspect this workspace before retrying."))
                }
            }
        }
    }
    static func status(_ id: String) async throws -> Wire {
        let response = try await run(["schemaVersion": .number(1), "operation": "status", "workspaceId": .string(id)])
        return try result(response, id: id)
    }
    static func result(_ response: Wire, id: String) throws -> Wire {
        guard response["ok"].flag else {
            let reason: String
            switch response["code"].text {
            case "insufficient_storage": reason = "Storage preparation needs at least 72 GiB free."
            case "workspace_already_exists": reason = "This workspace already has local storage. Refresh its status before retrying."
            case "workspace_busy_or_unsafe": reason = "This workspace is busy or its storage permissions need attention."
            default: reason = "This workspace needs storage inspection or repair. Josi retained its files."
            }
            throw JosiError(message: reason)
        }
        let storage = response["storage"]
        guard storage["schemaVersion"] == .number(1), storage["workspaceId"].text == id,
              ["uninitialized", "image_ready", "mounted", "needs_repair"].contains(storage["state"].text)
        else { throw approvalUnavailable() }
        return storage
    }
}

@MainActor enum NativeWorkspaceProvision {
    static func authorize(model: JosiModel, request: Wire) async throws -> (projection: Wire, lease: ApprovalLease) {
        guard model.isAdministrator, NativeProtectedApproval.available, let api = model.api, let parent = NSApp.keyWindow else {
            throw JosiError(message: "Use the installed Josi app, an enrolled Mac and Touch ID to prepare workspace storage.")
        }
        let user = model.user["id"].text, workspaceID = try api.uuid(request["workspaceId"].text)
        func current() throws {
            guard model.api === api, model.user["id"].text == user, parent.isVisible, !Task.isCancelled else { throw approvalUnavailable() }
        }
        let prepared = try await api.request("/admin/automation/storage/prepare", method: "POST", body: request)
        let challenge = prepared["challenge"], id = try api.uuid(challenge["id"].text)
        var committed = false
        var port: NativeKeyPort?
        var review: NativeApprovalWindow?
        defer {
            port?.cancel(); review?.close()
            if !committed {
                Task { _ = try? await api.request("/admin/automation/storage/\(id)/cancel", method: "POST", body: [:]) }
            }
        }
        let message = try ProtectedWire.storageChallenge(challenge, request: request, origin: api.origin.absoluteString, user: user)
        let lease = try ApprovalLease(challenge)
        try current(); try lease.check()
        let key = NativeKeyPort(identity: ProtectedWire.identity(challenge)); port = key
        let opening = request["operation"].text == "open"
        guard case .object(var presentation) = challenge else { throw approvalUnavailable() }
        presentation["purpose"] = "workspace.storage"
        presentation["presentation"] = [
            "wording": .string("\(opening ? "Open" : "Prepare") \(request["label"].text) on this Mac"),
            "meaning": .string("\(opening ? "Open the separate encrypted workspace" : "Create a separate encrypted storage volume") with a maximum capacity of \(request["capacityGiB"].integer) GiB.\nWorkspace: \(workspaceID)\nIts password remains in this server’s Vault.\n" + (opening
                ? "This development desktop stays open while Josi maintains its Vault connection, for up to two hours. You can close it at any time."
                : "The storage stays closed after preparation.")),
            "advisory": .array([.string(opening
                ? "This opens a separate development desktop. It grants no automated browser, app, file or network access. Its network and host sharing are disabled."
                : "This prepares storage only. It does not start a desktop or grant browser, app, file or network access."),
                               "Keep the Vault and your recovery material. If setup is interrupted, resume this same workspace rather than create another."]),
        ]
        let window = NativeApprovalWindow(challenge: .object(presentation), lease: lease, cancelAuthentication: { key.cancel() })
        review = window
        guard await window.present(parent: parent) else { throw approvalUnavailable() }
        try current(); try window.current()
        try await key.start()
        let signed = try await key.request("proveWorkspaceStorage", fields: ["message": .string(message.base64EncodedString())])
        let signature = try ProtectedWire.signature(signed, host: true)
        try current(); try window.current()
        window.phase = "saving"; committed = true
        var projection = try await api.request("/admin/automation/storage/\(id)/\(opening ? "open" : "provision")", method: "POST", body: [
            "proof": ["challengeDigest": .string(ProtectedWire.digest(message)), "signature": .string(signature)],
        ])
        defer { projection = .null }
        try current(); try window.current()
        guard ProtectedWire.exact(projection, ["schemaVersion", "challengeId", "workspace", "expiresAtMs", "imagePassword", "executionEnabled"] + (opening ? ["openSession"] : [])),
              projection["schemaVersion"] == .number(1), projection["challengeId"].text == id,
              projection["expiresAtMs"] == challenge["expiresAtMs"], projection["executionEnabled"] == .bool(false),
              projection["workspace"]["workspaceId"] == request["workspaceId"], projection["workspace"]["label"] == request["label"],
              projection["workspace"]["capacityGiB"] == request["capacityGiB"],
              projection["workspace"]["identity"] == ProtectedWire.identity(challenge),
              ProtectedWire.matches(projection["imagePassword"], "^[A-Za-z0-9_-]{43}$") else { throw approvalUnavailable() }
        window.close(); key.cancel()
        return (projection, lease)
    }
    static func run(model: JosiModel, request: Wire) async throws -> String {
        guard let api = model.api else { throw approvalUnavailable() }
        let user = model.user["id"], workspaceID = try api.uuid(request["workspaceId"].text)
        let local = try await NativeWorkspaceImage.status(workspaceID)
        if local["state"].text == "image_ready" && local["imageCreated"].flag && !local["mounted"].flag
            && local["capacityGiB"] == request["capacityGiB"] {
            return "Encrypted storage is already prepared and closed."
        }
        guard local["state"].text == "uninitialized", !local["imageCreated"].flag, !local["mounted"].flag,
              case .object(var input) = request else {
            throw JosiError(message: "This workspace has existing or unfinished storage. It needs inspection before setup can continue.")
        }
        input["operation"] = "provision"
        var (projection, lease) = try await authorize(model: model, request: .object(input))
        defer { projection = .null }
        model.activity = "Preparing encrypted workspace storage…"
        // The approved disk creation may finish after the short projection
        // lease. It never mounts the disk or starts automation.
        defer { model.activity = "" }
        let response = try await NativeWorkspaceImage.run(["schemaVersion": .number(1), "operation": "create",
            "workspaceId": .string(workspaceID), "capacityGiB": request["capacityGiB"], "imagePassword": projection["imagePassword"]],
            admission: {
                try lease.check()
                guard model.api === api, model.user["id"] == user else { throw approvalUnavailable() }
            })
        projection = .null
        let result = try NativeWorkspaceImage.result(response, id: workspaceID)
        guard result["state"].text == "image_ready", result["imageCreated"].flag, !result["mounted"].flag else {
            throw JosiError(message: "Storage preparation needs inspection before this workspace can be used.")
        }
        return "Encrypted storage is prepared and closed. Desktop provisioning is the next step."
    }
}

struct NativeWorkspaceStorageView: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var desktop: NativeWorkspaceController
    @State private var inventory: Wire = .null
    @State private var label = "Josi Automation"
    @State private var capacity = 128
    @State private var device = ""
    @State private var note = ""
    @State private var generation = 0
    @State private var pendingRequest: Wire?
    private var devices: [Wire] { model.automationSettings["devices"]["devices"].list.filter { $0["revokedAt"] == .null } }
    var body: some View {
        GroupBox("Separate desktop storage") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Prepare a separate development desktop on this Mac. Browser and computer automation are not connected yet.").foregroundStyle(.secondary)
                if desktop.requiresClosure {
                    Text("\(desktop.label) · \(desktop.state.replacingOccurrences(of: "_", with: " "))").font(.headline)
                    Text(desktop.progress)
                    HStack {
                        Button("Show Desktop") { model.run { try desktop.show() } }
                            .disabled(model.busy || !["running", "paused"].contains(desktop.state))
                        Button(desktop.state == "paused" ? "Resume" : "Pause") {
                            model.run { if desktop.state == "paused" { try await desktop.resume() } else { try await desktop.pause() } }
                        }.disabled(model.busy || !["running", "paused"].contains(desktop.state))
                        Button(desktop.state == "needs_repair" ? "Close Again" : "Close Desktop") {
                            model.run { try await desktop.close() }
                        }.disabled(model.busy)
                    }
                    Divider()
                }
                TextField("Workspace name", text: $label).disabled(model.busy || pendingRequest != nil)
                Picker("Enrolled Mac", selection: $device) {
                    Text("Choose this Mac’s enrollment").tag("")
                    ForEach(Array(devices.enumerated()), id: \.offset) { _, d in Text(d["label"].text).tag(d["identity"]["deviceId"].text) }
                }.disabled(model.busy || pendingRequest != nil)
                Picker("Maximum disk capacity", selection: $capacity) {
                    Text("64 GiB").tag(64); Text("128 GiB").tag(128); Text("256 GiB").tag(256); Text("512 GiB").tag(512)
                }.disabled(model.busy || pendingRequest != nil)
                Text("Storage grows as needed. Preparation requires 72 GiB free.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button(pendingRequest == nil ? "Prepare Storage…" : "Retry Storage Preparation…") {
                        begin(pendingRequest ?? ["deviceId": .string(device), "workspaceId": .string(UUID().uuidString.lowercased()),
                               "label": .string(label.trimmingCharacters(in: .whitespacesAndNewlines)), "capacityGiB": .number(Double(capacity))])
                    }.disabled(model.busy || desktop.requiresClosure || inventory == .null || (pendingRequest == nil && (device.isEmpty || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) || !NativeProtectedApproval.available)
                    Button("Refresh") { model.run { try await load() } }.disabled(model.busy)
                }
                if let pendingRequest {
                    Text("Retry will use the same workspace: \(pendingRequest["label"].text).").font(.caption)
                }
                ForEach(Array(inventory["workspaces"].list.enumerated()), id: \.offset) { _, entry in
                    Divider()
                    HStack {
                        VStack(alignment: .leading) {
                            Text(entry["label"].text).font(.headline)
                            Text("\(entry["capacityGiB"].integer) GiB maximum · \(entry["workspaceId"].text)").font(.caption).textSelection(.enabled)
                        }
                        Spacer()
                        VStack(alignment: .trailing) {
                            Button("Resume Storage Preparation…") {
                                begin(["deviceId": entry["identity"]["deviceId"], "workspaceId": entry["workspaceId"],
                                       "label": entry["label"], "capacityGiB": entry["capacityGiB"]])
                            }
                            HStack {
                                Button("Install macOS…") { openDesktop(entry, installing: true) }
                                Button("Open Desktop…") { openDesktop(entry, installing: false) }
                            }
                        }.disabled(model.busy || desktop.requiresClosure || !NativeProtectedApproval.available)
                    }
                }
                if !note.isEmpty { Text(note).textSelection(.enabled) }
            }.padding(10)
        }.task { do { try await load() } catch { note = error.localizedDescription } }
        .onDisappear { generation += 1 }
    }
    private func load() async throws {
        guard let api = model.api else { return }
        let own = generation, user = model.user["id"]
        let value = try await api.request("/admin/automation/storage")
        guard model.api === api, model.user["id"] == user, generation == own else { return }
        inventory = value
    }
    private func begin(_ request: Wire) {
        let own = generation
        pendingRequest = request
        model.run {
            do {
                let result = try await NativeWorkspaceProvision.run(model: model, request: request)
                if generation == own { note = result; pendingRequest = nil }
            } catch {
                if generation == own { note = error.localizedDescription + " Refresh the workspace list before retrying." }
            }
            try await load()
        }
    }
    private func openDesktop(_ entry: Wire, installing: Bool) {
        guard !model.busy, !desktop.requiresClosure else { return }
        var restore: URL?
        if installing {
            let panel = NSOpenPanel()
            panel.title = "Choose the macOS restore image for this development desktop"
            panel.message = "Choose an Apple .ipsw restore image. Josi installs it in this separate workspace with networking and host sharing disabled."
            panel.allowedContentTypes = [UTType(filenameExtension: "ipsw") ?? .data]
            panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            guard panel.runModal() == .OK, let selected = panel.url else { return }
            restore = selected
        }
        let selected = restore
        model.run { try await desktop.open(model: model, entry: entry, restore: selected) }
    }
}
