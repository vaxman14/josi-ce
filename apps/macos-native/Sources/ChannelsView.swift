import AppKit
import SwiftUI

struct NativeChannelsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var provider = "telegram"
    var body: some View {
        VStack(spacing: 0) {
            Picker("Messaging app", selection: $provider) {
                Text("Telegram").tag("telegram")
                Text("WhatsApp").tag("whatsapp")
                Text("Slack").tag("slack")
            }.pickerStyle(.segmented).padding(20).disabled(model.busy)
            if provider == "telegram" { NativeTelegramView() }
            else { NativeExternalChannelView(provider: provider).id(provider) }
        }
    }
}

struct NativeExternalChannelView: View {
    @EnvironmentObject var model: JosiModel
    let provider: String
    @State private var channel: Wire = .null
    @State private var config: Wire = .null
    @State private var links: [Wire] = []
    @State private var credentials: [String: String] = [:]
    @State private var code = ""
    @State private var expiresAt = ""
    @State private var deadline: ContinuousClock.Instant?
    @State private var generation = UUID()
    @State private var loading = false
    @State private var notice = ""
    @State private var disconnecting: Wire = .null
    private var name: String { provider == "whatsapp" ? "WhatsApp" : "Slack" }
    private var fields: [(key: String, label: String)] {
        provider == "whatsapp"
            ? [("appSecret", "Meta app secret"), ("accessToken", "Permanent access token"),
               ("phoneNumberId", "Phone number ID"), ("webhookSecret", "Webhook verification token")]
            : [("signingSecret", "Signing secret"), ("botToken", "Bot token")]
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                JosiHeading(title: name, subtitle: "Message the same Josi account from " + name + ".")
                if loading { ProgressView().controlSize(.small) }
                if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
                if channel != .null {
                    GroupBox("Your connection") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(channel["enabled"].flag ? "This channel is available." : "This channel is off on the server.")
                            Text("Create a one-time code, then send the command below to Josi in \(name).")
                                .font(.caption).foregroundStyle(.secondary)
                            Button(code.isEmpty ? "Create One-Time Code" : "Replace One-Time Code") { mint() }
                                .disabled(model.busy || loading || !channel["enabled"].flag)
                            if !code.isEmpty {
                                Text("link " + code).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                                Text("Expires " + nativeDate(expiresAt) + ". A replacement invalidates the previous code.")
                                    .font(.caption).foregroundStyle(.secondary)
                                Button("Hide Code") { clearCode() }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }
                    ForEach(links, id: \.identifier) { link in
                        GroupBox {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(name + " · " + link["status"].text).font(.headline)
                                    Text("Linked " + nativeDate(link["linkedAt"].text)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if link["status"].text == "active" {
                                    Button("Disconnect…") { disconnecting = link }.disabled(model.busy || loading)
                                }
                            }.padding(8)
                        }
                    }
                }
                if model.isAdministrator, config != .null { serverSettings }
                Button("Refresh") { perform { api, owner, stamp in try await load(api, owner: owner, stamp: stamp) } }
                    .disabled(model.busy || loading)
            }.padding(28)
        }
        .textFieldStyle(.roundedBorder)
        .task(id: "\(provider):\(model.api?.origin.absoluteString ?? ""):\(model.user["id"].text)") {
            let stamp = UUID(); generation = stamp
            channel = .null; config = .null; credentials = [:]; links = []; clearCode(); notice = ""
            guard ["whatsapp", "slack"].contains(provider), let api = model.api else { return }
            let owner = model.user["id"]
            loading = true
            defer { if generation == stamp, !Task.isCancelled { loading = false } }
            do { try await load(api, owner: owner, stamp: stamp) }
            catch is CancellationError {} catch {
                if current(api, owner, stamp) { notice = "\(name) settings are unavailable. Refresh to try again." }
            }
        }
        .task(id: code) {
            guard !code.isEmpty, let deadline, let api = model.api else { return }
            let original = code, owner = model.user["id"], stamp = generation
            let previous = Set(links.filter { $0["status"].text == "active" }.map(\.identifier))
            while !Task.isCancelled, code == original, current(api, owner, stamp) {
                guard ContinuousClock.now < deadline else { clearCode(); return }
                do {
                    try await Task.sleep(for: .seconds(3))
                    guard !Task.isCancelled, current(api, owner, stamp), code == original else { return }
                    if NSApp.isActive && !model.busy {
                        let value = try await api.request("/channels")
                        try Task.checkCancellation()
                        guard current(api, owner, stamp), code == original else { return }
                        adopt(value)
                        if links.contains(where: { $0["status"].text == "active" && !previous.contains($0.identifier) }) {
                            clearCode(); notice = "Your \(name) connection is linked."; return
                        }
                    }
                } catch let error as JosiError where [401, 403].contains(error.status) {
                    if current(api, owner, stamp) { clearCode(); notice = "Sign in again to manage your \(name) link." }
                    return
                } catch { if Task.isCancelled { return } }
            }
        }
        .onDisappear { generation = UUID(); credentials = [:]; clearCode(); disconnecting = .null }
        .confirmationDialog("Disconnect this \(name) link?", isPresented: Binding(get: { disconnecting != .null }, set: { if !$0 { disconnecting = .null } })) {
            let link = disconnecting
            Button("Disconnect", role: .destructive) {
                disconnecting = .null
                perform { api, owner, stamp in
                    let id = try api.uuid(link["id"].text)
                    _ = try await api.request("/channels/links/\(id)", method: "DELETE")
                    guard current(api, owner, stamp) else { return }
                    clearCode(); notice = "Link disconnected."
                    try await load(api, owner: owner, stamp: stamp)
                }
            }
        } message: { Text("This stops Josi delivery through the selected link. The saved conversation remains.") }
    }
    private var serverSettings: some View {
        DisclosureGroup("Server channel settings") {
            VStack(alignment: .leading, spacing: 16) {
                Text(config["enabled"].flag ? "\(name) is on." : "\(name) is off.").font(.headline)
                Text("Credentials are saved in the Vault and never returned to this page. Enter all fields to replace the configuration.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(fields, id: \.key) { field in
                    let value = Binding(get: { credentials[field.key] ?? "" }, set: { credentials[field.key] = $0 })
                    if field.key == "phoneNumberId" {
                        TextField(field.label, text: value).disabled(model.busy || loading)
                    } else {
                        SecureField(field.label, text: value).disabled(model.busy || loading)
                    }
                }
                Button("Save Configuration") {
                    let body = Wire.object(Dictionary(uniqueKeysWithValues: fields.map {
                        ($0.key, Wire.string((credentials[$0.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)))
                    }))
                    credentials = [:]
                    change("config", body: body, message: "Configuration saved. Verify the provider connection before enabling it.")
                }.disabled(model.busy || loading || fields.contains { (credentials[$0.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                if config["probeOk"] == .bool(false) {
                    Text("The last provider check failed. Review the credentials and server connection.").foregroundStyle(.orange)
                }
                HStack {
                    Button("Verify Provider Connection") { change("probe", body: [:], message: "Provider connection verified.") }
                        .disabled(!config["configured"].flag)
                    Button(config["enabled"].flag ? "Turn Off" : "Turn On") {
                        change("enabled", body: ["enabled": .bool(!config["enabled"].flag)], message: "Channel availability updated.")
                    }.disabled(!config["enabled"].flag && config["probeOk"] != .bool(true))
                }.disabled(model.busy || loading)
                Text("Set the provider’s incoming-message URL to this server’s public HTTPS address followed by:")
                    .font(.caption).foregroundStyle(.secondary)
                Text("/channels/\(provider)/webhook").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                if provider == "whatsapp" {
                    Text("Enter the same webhook verification token in Meta.").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.top, 14)
        }
    }
    private func current(_ api: JosiAPI, _ owner: Wire, _ stamp: UUID) -> Bool {
        !Task.isCancelled && model.api === api && model.user["id"] == owner && generation == stamp
    }
    private func clearCode() { code = ""; expiresAt = ""; deadline = nil }
    private func adopt(_ value: Wire) {
        channel = value["channels"].list.first { $0["provider"].text == provider } ?? .null
        links = value["links"].list.filter { $0["provider"].text == provider }
    }
    private func load(_ api: JosiAPI, owner: Wire, stamp: UUID) async throws {
        let value = try await api.request("/channels")
        guard current(api, owner, stamp) else { throw CancellationError() }
        adopt(value)
        if model.isAdministrator {
            let settings = try await api.request("/admin/channels")
            guard current(api, owner, stamp), model.isAdministrator else { throw CancellationError() }
            config = settings["channels"].list.first { $0["provider"].text == provider } ?? .null
        }
    }
    private func perform(_ action: @escaping @MainActor (JosiAPI, Wire, UUID) async throws -> Void) {
        guard ["whatsapp", "slack"].contains(provider), let api = model.api, !model.busy, !loading else { return }
        let owner = model.user["id"], stamp = generation
        notice = ""
        model.run {
            guard current(api, owner, stamp) else { throw CancellationError() }
            try await action(api, owner, stamp)
        }
    }
    private func mint() {
        clearCode()
        perform { api, owner, stamp in
            let value = try await api.request("/channels/\(provider)/link-code", method: "POST", body: [:])
            guard current(api, owner, stamp) else { throw CancellationError() }
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard ProtectedWire.exact(value, ["code", "expiresAt", "instruction"]),
                  ProtectedWire.matches(value["code"], "^[A-Za-z0-9_-]{24}$"),
                  let end = formatter.date(from: value["expiresAt"].text), end > Date(), end.timeIntervalSinceNow <= 600 else {
                throw JosiError(message: "This linking code is unavailable or expired. Create a new one.")
            }
            deadline = .now.advanced(by: .milliseconds(Int(end.timeIntervalSinceNow * 1000)))
            expiresAt = value["expiresAt"].text; code = value["code"].text
        }
    }
    private func change(_ operation: String, body: Wire, message: String) {
        guard model.isAdministrator, ["config", "probe", "enabled"].contains(operation) else { return }
        let expected = config
        perform { api, owner, stamp in
            let settings = try await api.request("/admin/channels")
            guard current(api, owner, stamp), model.isAdministrator else { throw CancellationError() }
            guard settings["channels"].list.first(where: { $0["provider"].text == provider }) == expected else {
                throw JosiError(message: "\(name) settings changed. Refresh before applying this change.")
            }
            _ = try await api.request("/admin/channels/\(provider)/\(operation)", method: "POST", body: body)
            guard current(api, owner, stamp) else { return }
            notice = message
            try await load(api, owner: owner, stamp: stamp)
        }
    }
}
