import AppKit
import SwiftUI
import Darwin
import UniformTypeIdentifiers

extension ProtectedWire {
    static func storageChallenge(_ value: Wire, request: Wire, origin: String, user: String) throws -> Data {
        let base = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId",
                    "keyReference", "wrappingFingerprint", "issuedAtMs", "expiresAtMs"]
        guard exact(value, base + ["operation", "workspaceId", "label", "capacityGiB"]),
              value["operation"].text == "connect", value["operation"] == request["operation"],
              value["workspaceId"] == request["workspaceId"],
              value["label"] == request["label"], value["capacityGiB"] == request["capacityGiB"],
              uuid(value["workspaceId"]), text(value["label"], max: 120),
              integer(value["capacityGiB"]), value["capacityGiB"].integer == 0,
              value["keyReference"]["recordId"].text == "914a736a-94bf-46f2-a602-82ff4180c45d"
        else { throw approvalUnavailable() }
        let host = Wire.object(Dictionary(uniqueKeysWithValues: base.map { ($0, value[$0]) }))
        _ = try challenge(host, host: true, origin: origin, user: user, device: request["deviceId"].text)
        let key = value["keyReference"]
        var fields = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId"].map { value[$0] }
        fields += [.array([key["recordId"], key["version"], key["digest"], key["epoch"]]),
                   value["wrappingFingerprint"], value["issuedAtMs"], value["expiresAtMs"],
                   value["operation"], value["workspaceId"], value["label"], value["capacityGiB"]]
        return Data(("josi-current-desktop.1\n" + (try canonical(.array(fields)))).utf8)
    }
}

@MainActor enum NativeWorkspaceProvision {
    static func authorize(model: JosiModel, request: Wire) async throws -> (projection: Wire, lease: ApprovalLease) {
        guard model.isAdministrator, NativeProtectedApproval.available, let api = model.api, let parent = NSApp.keyWindow else {
            throw JosiError(message: "Use the installed Josi app, an enrolled Mac and Touch ID to connect this Mac.")
        }
        let user = model.user["id"].text, workspaceID = try api.uuid(request["workspaceId"].text)
        func current() throws {
            guard model.api === api, model.user["id"].text == user, parent.isVisible, !Task.isCancelled else { throw approvalUnavailable() }
        }
        let prepared = try await api.request("/admin/automation/desktop/prepare", method: "POST", body: request)
        let challenge = prepared["challenge"], id = try api.uuid(challenge["id"].text)
        var committed = false
        var port: NativeKeyPort?
        var review: NativeApprovalWindow?
        defer {
            port?.cancel(); review?.close()
            if !committed {
                Task { _ = try? await api.request("/admin/automation/desktop/\(id)/cancel", method: "POST", body: [:]) }
            }
        }
        let message = try ProtectedWire.storageChallenge(challenge, request: request, origin: api.origin.absoluteString, user: user)
        let lease = try ApprovalLease(challenge)
        try current(); try lease.check()
        let key = NativeKeyPort(identity: ProtectedWire.identity(challenge)); port = key
        
        guard case .object(var presentation) = challenge else { throw approvalUnavailable() }
        presentation["purpose"] = "desktop.connect"
        presentation["presentation"] = [
            "wording": .string("Connect this Mac to Josi"),
            "meaning": .string("Connect your current desktop as \(request["label"].text). Your apps, windows and signed-in browser remain on this Mac.\nConnection: \(workspaceID)\nThe connection expires after two hours or when you disconnect."),
            "advisory": .array(["Connecting does not authorize input. Select an app or attach a browser tab, configure permissions, then approve control.",
                               "Automation acts on your real desktop. Stop Automation immediately ends control."]),
        ]
        let window = NativeApprovalWindow(challenge: .object(presentation), lease: lease, cancelAuthentication: { key.cancel() })
        review = window
        guard await window.present(parent: parent) else { throw approvalUnavailable() }
        try current(); try window.current()
        try await key.start()
        let signed = try await key.request("proveCurrentDesktop", fields: ["message": .string(message.base64EncodedString())])
        let signature = try ProtectedWire.signature(signed, host: true)
        try await window.returnFromAuthentication()
        try current(); try window.current()
        window.phase = "saving"; committed = true
        var projection = try await api.request("/admin/automation/desktop/\(id)/connect", method: "POST", body: [
            "proof": ["challengeDigest": .string(ProtectedWire.digest(message)), "signature": .string(signature)],
        ])
        defer { projection = .null }
        try current(); try window.current()
        guard ProtectedWire.exact(projection, ["schemaVersion", "challengeId", "workspace", "expiresAtMs", "mode", "executionEnabled", "openSession"]),
              projection["schemaVersion"] == .number(1), projection["challengeId"].text == id,
              projection["expiresAtMs"] == challenge["expiresAtMs"], projection["executionEnabled"] == .bool(false),
              projection["workspace"]["workspaceId"] == request["workspaceId"], projection["workspace"]["label"] == request["label"],
              projection["workspace"]["capacityGiB"] == request["capacityGiB"],
              projection["workspace"]["identity"] == ProtectedWire.identity(challenge),
              projection["mode"] == .string("current_desktop"), projection["workspace"]["mode"] == .string("current_desktop") else { throw approvalUnavailable() }
        window.close(); key.cancel()
        return (projection, lease)
    }
}

struct NativeWorkspaceStorageView: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var desktop: NativeWorkspaceController
    @State private var inventory: Wire = .null
    @State private var device = ""
    @State private var label = Host.current().localizedName ?? "This Mac"
    private var devices: [Wire] {
        model.automationDevices["devices"].list.filter {
            $0["revokedAt"] == .null && $0["identity"]["serverOrigin"].text == model.api?.origin.absoluteString
        }
    }
    var body: some View {
        GroupBox("Control this Mac") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Josi works in your current apps and attached browser tabs. Choose what it can use and approve control for this session.").foregroundStyle(.secondary)
                if desktop.requiresClosure {
                    Text("\(desktop.label) · \(desktop.state)").font(.headline)
                    Text(desktop.progress).font(.caption)
                    if let connection = desktop.guest {
                        NativeGuestConnectionView(connection: connection)
                        NativeAutomationConsentControls(desktop: desktop, guest: connection)
                    }
                    HStack {
                        Button("Stop Automation", role: .destructive) {
                            Task { do { try await desktop.stopAutomation() } catch { model.error = error.localizedDescription } }
                        }.keyboardShortcut(.escape, modifiers: [.command, .shift])
                        Button("Disconnect This Mac") { model.run { try await desktop.close() } }.disabled(model.busy)
                    }
                    Text("Press ⌘⇧Esc or use your keyboard or mouse to take over. A new approval is required to resume.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    TextField("Connection name", text: $label)
                    Picker("Enrolled Mac", selection: $device) {
                        Text("Choose this Mac").tag("")
                        ForEach(Array(devices.enumerated()), id: \.offset) { _, d in Text(d["label"].text).tag(d["identity"]["deviceId"].text) }
                    }
                    HStack {
                        Button("Connect This Mac…") { model.run { try await connect() } }
                            .disabled(model.busy || device.isEmpty || !NativeProtectedApproval.available || !model.automationDevicesReady)
                        Button("Refresh Devices") { model.run { try await load() } }.disabled(model.busy)
                    }
                    if devices.isEmpty {
                        Text("Enroll this Mac in Devices below to enable a hardware-backed approval.").font(.caption)
                    }
                    if !model.automationDevicesError.isEmpty { Text(model.automationDevicesError).foregroundStyle(.orange) }
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }.task { do { try await load() } catch { model.error = error.localizedDescription } }
    }
    private func load() async throws {
        try await model.loadAutomationDevices()
        guard let api = model.api else { return }
        inventory = try await api.request("/admin/automation/desktop")
        if device.isEmpty && devices.count == 1 { device = devices[0]["identity"]["deviceId"].text }
    }
    private func connect() async throws {
        guard let api = model.api else { throw approvalUnavailable() }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, devices.contains(where: { $0["identity"]["deviceId"].text == device }) else { throw approvalUnavailable() }
        let entry = inventory["workspaces"].list.first { $0["mode"].text == "current_desktop" && $0["identity"]["deviceId"].text == device }
        let request: Wire = ["operation": "connect", "deviceId": .string(device),
            "workspaceId": entry?["workspaceId"] ?? .string(UUID().uuidString.lowercased()),
            "label": entry?["label"] ?? .string(name), "capacityGiB": .number(0)]
        let approved = try await NativeWorkspaceProvision.authorize(model: model, request: request)
        guard model.api === api else { throw approvalUnavailable() }
        try await desktop.connect(model: model, projection: approved.projection)
    }
}
