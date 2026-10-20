import AppKit
import SwiftUI

struct NativeTelegramView: View {
    @EnvironmentObject var model: JosiModel
    @State private var status: Wire = .null
    @State private var config: Wire = .null
    @State private var links: [Wire] = []
    @State private var health: Wire = .null
    @State private var minted: Wire = .null
    @State private var codeDeadline: ContinuousClock.Instant?
    @State private var token = ""
    @State private var filesEnabled = false
    @State private var limitMB = "20"
    @State private var loading = false
    @State private var notice = ""
    @State private var generation = UUID()
    @State private var removal: Wire = .null

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                JosiHeading(title: "Telegram", subtitle: "Use your Josi account from your own Telegram chat.")
                if loading { ProgressView().controlSize(.small) }
                if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
                if status != .null { ownLinks }
                if model.isAdministrator, config != .null { administration }
                Button("Refresh") { perform { api, owner, stamp in try await load(api, owner: owner, stamp: stamp) } }
                    .disabled(model.busy || loading)
            }.padding(28)
        }
        .textFieldStyle(.roundedBorder)
        .task(id: "\(model.api?.origin.absoluteString ?? ""):\(model.user["id"].text)") {
            let stamp = UUID(); generation = stamp
            status = .null; config = .null; minted = .null; token = ""; notice = ""
            guard let api = model.api else { return }
            let owner = model.user["id"]
            loading = true
            defer { if generation == stamp, !Task.isCancelled { loading = false } }
            do { try await load(api, owner: owner, stamp: stamp) }
            catch is CancellationError {} catch {
                if current(api, owner, stamp) { notice = "Telegram settings are unavailable. Refresh to try again." }
            }
        }
        .task(id: minted["code"].text) {
            guard minted != .null, let deadline = codeDeadline, let api = model.api else { return }
            let code = minted["code"], owner = model.user["id"], stamp = generation
            while !Task.isCancelled, minted["code"] == code, current(api, owner, stamp) {
                guard ContinuousClock.now < deadline else { minted = .null; codeDeadline = nil; return }
                do {
                    try await Task.sleep(for: .seconds(3))
                    guard !Task.isCancelled, current(api, owner, stamp), minted["code"] == code else { return }
                    if NSApp.isActive && !model.busy {
                        let value = try await api.request("/telegram")
                        try Task.checkCancellation()
                        guard current(api, owner, stamp), minted["code"] == code else { return }
                        status = value
                        if value["links"].list.contains(where: { $0["status"].text == "active" }) {
                            minted = .null; codeDeadline = nil; notice = "Your Telegram chat is linked."; return
                        }
                    }
                } catch let error as JosiError where [401, 403].contains(error.status) {
                    if current(api, owner, stamp) { minted = .null; codeDeadline = nil; notice = "Sign in again to manage your Telegram link." }
                    return
                } catch { if Task.isCancelled { return } }
            }
        }
        .onDisappear {
            generation = UUID(); token = ""; minted = .null; codeDeadline = nil; removal = .null
        }
        .confirmationDialog("Disconnect Telegram?", isPresented: Binding(get: { removal != .null }, set: { if !$0 { removal = .null } })) {
            let selected = removal
            Button(selected["kind"].text == "bot" ? "Remove Bot from This Server" : "Disconnect This Link", role: .destructive) {
                removal = .null
                if selected["kind"].text == "bot" { adminChange(path: "", method: "DELETE", body: [:], message: "The bot was removed.") }
                else { revoke(selected) }
            }
        } message: {
            Text(removal["kind"].text == "bot"
                 ? "This removes the stored bot token and webhook. Telegram delivery stops for this server. Conversations remain saved."
                 : "This stops future Josi delivery through the selected Telegram link. Its conversation remains saved.")
        }
    }

    private var ownLinks: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox("Your Telegram chat") {
                VStack(alignment: .leading, spacing: 12) {
                    Text(status["channel"]["enabled"].flag
                         ? "Messages you send to the linked bot become your private Josi conversation. Work started there can show its saved progress in Telegram."
                         : "Telegram is off on this server. An administrator can configure and enable the bot below.")
                    Text(status["channel"]["attachmentsEnabled"].flag ? "Files are accepted within this server’s limits." : "This server does not accept files through Telegram.")
                        .font(.caption).foregroundStyle(.secondary)
                    if status["channel"]["enabled"].flag && !status["links"].list.contains(where: { $0["status"].text == "active" }) {
                        Button(minted == .null ? "Create One-Time Link" : "Replace One-Time Link") { mint() }
                            .disabled(model.busy || loading)
                    }
                    if minted != .null {
                        if let destination = telegramLink {
                            Button("Open Link in Telegram") {
                                guard let deadline = codeDeadline, ContinuousClock.now < deadline else { minted = .null; return }
                                NSWorkspace.shared.open(destination)
                            }.disabled(model.busy)
                        }
                        Text("/start " + minted["code"].text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        Text("Send this to @" + status["channel"]["botUsername"].text + ". Expires " + nativeDate(minted["expiresAt"].text) + ".")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("This code is shown once. A replacement invalidates the previous code.").font(.caption).foregroundStyle(.secondary)
                        Button("Hide Code") { minted = .null; codeDeadline = nil }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            ForEach(status["links"].list, id: \.identifier) { link in
                GroupBox {
                    HStack {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(link["telegramUsername"].text.isEmpty ? "Your chat " + link["chatId"].text : "@" + link["telegramUsername"].text).font(.headline)
                            Text(link["status"].text == "active" ? "Linked " + nativeDate(link["linkedAt"].text) : "Disconnected").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if link["status"].text == "active" {
                            Button("Disconnect…") { removal = ["kind": "own", "id": link["id"]] }.disabled(model.busy)
                        }
                    }.padding(8)
                }
            }
        }
    }

    private var administration: some View {
        DisclosureGroup("Server bot settings") {
            VStack(alignment: .leading, spacing: 18) {
                Text(config["enabled"].flag ? "Telegram is on." : "Telegram is off.").font(.headline)
                if !config["botUsername"].text.isEmpty { Text("Bot: @" + config["botUsername"].text) }
                Text("Use the bot token provided by Telegram’s BotFather. The token is saved in the Vault and never displayed again.")
                    .font(.caption).foregroundStyle(.secondary)
                SecureField(config["tokenSet"].flag ? "Replacement bot token" : "Bot token", text: $token)
                    .disabled(model.busy || loading)
                Button("Save and Verify Bot") {
                    let value = token.trimmingCharacters(in: .whitespacesAndNewlines); token = ""
                    adminChange(path: "/token", body: ["token": .string(value)], message: "Bot verified and saved. Register delivery, then turn Telegram on.")
                }.disabled(model.busy || loading || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if config["tokenSet"].flag {
                    if config["probeOk"] == .bool(false) { Text("The last bot verification failed. Check the token or server connection.").foregroundStyle(.orange) }
                    HStack {
                        Button("Verify Bot Connection") { adminChange(path: "/probe", body: [:], message: "Bot connection checked.") }
                        Button(config["enabled"].flag ? "Turn Telegram Off" : "Turn Telegram On") {
                            adminChange(path: "/enabled", body: ["enabled": .bool(!config["enabled"].flag)], message: "Telegram availability updated.")
                        }.disabled(!config["enabled"].flag && config["probeOk"] != .bool(true))
                    }.disabled(model.busy || loading)
                    Text(config["webhookUrl"].text.isEmpty ? "Incoming delivery is not registered." : "Incoming delivery: " + config["webhookUrl"].text)
                        .font(.caption).textSelection(.enabled)
                    Text("Register delivery after this server’s public HTTPS address works. This tells Telegram where to deliver messages.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Register Incoming Delivery") { adminChange(path: "/webhook", body: [:], message: "Incoming delivery registered.") }
                        .disabled(model.busy || loading)
                }
                Divider()
                Toggle("Accept files from Telegram", isOn: $filesEnabled).disabled(model.busy || loading)
                TextField("Maximum file size in MiB (1–20)", text: $limitMB).disabled(model.busy || loading)
                Button("Save File Settings") {
                    guard let limit = Int(limitMB), (1...20).contains(limit) else { return }
                    adminChange(path: "/attachments", body: ["enabled": .bool(filesEnabled), "maxBytes": .number(Double(limit * 1024 * 1024))],
                                message: "Telegram file settings saved.")
                }.disabled(model.busy || loading || (Int(limitMB).map { !(1...20).contains($0) } ?? true))
                healthAndLinks
                Button("Remove Bot…", role: .destructive) { removal = ["kind": "bot"] }
                    .disabled(model.busy || loading || !config["tokenSet"].flag)
            }.padding(.top, 14)
        }
    }

    private var healthAndLinks: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            Text("Delivery in the last seven days").font(.headline)
            Text("Sent \(health["outbound"]["sent"].integer) · Failed \(health["outbound"]["failed"].integer) · Pending \(health["outbound"]["pending"].integer)")
                .font(.caption)
            ForEach(Array(health["errors"].list.enumerated()), id: \.offset) { _, item in
                Text(item["category"].text.replacingOccurrences(of: "_", with: " ") + ": \(item["count"].integer)").font(.caption)
            }
            DisclosureGroup("Linked accounts (\(links.count))") {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Administration shows link metadata only. Chat identifiers and messages are not shown here.").font(.caption).foregroundStyle(.secondary)
                    ForEach(links, id: \.identifier) { link in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Account " + link["owner_user_id"].text).font(.caption).textSelection(.enabled)
                                Text(link["status"].text + " · " + nativeDate(link["linked_at"].text)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if link["status"].text == "active" {
                                Button("Revoke…") { removal = ["kind": "admin", "id": link["id"]] }.disabled(model.busy)
                            }
                        }
                    }
                }.padding(.top, 8)
            }
        }
    }

    private func current(_ api: JosiAPI, _ owner: Wire, _ stamp: UUID) -> Bool {
        !Task.isCancelled && model.api === api && model.user["id"] == owner && generation == stamp
    }
    private func load(_ api: JosiAPI, owner: Wire, stamp: UUID) async throws {
        let own = try await api.request("/telegram")
        guard current(api, owner, stamp) else { throw CancellationError() }
        status = own
        if model.isAdministrator {
            let saved = try await api.request("/admin/telegram")
            let users = try await api.request("/admin/telegram/links")
            let delivery = try await api.request("/admin/telegram/health")
            guard current(api, owner, stamp), model.isAdministrator else { throw CancellationError() }
            config = saved["telegram"]; links = users["links"].list; health = delivery
            filesEnabled = config["attachmentsEnabled"].flag
            limitMB = String(max(1, min(20, config["maxAttachmentBytes"].integer / (1024 * 1024))))
        }
    }
    private func perform(_ action: @escaping @MainActor (JosiAPI, Wire, UUID) async throws -> Void) {
        guard let api = model.api, !model.busy, !loading else { return }
        let owner = model.user["id"], stamp = generation
        notice = ""
        model.run {
            guard current(api, owner, stamp) else { throw CancellationError() }
            try await action(api, owner, stamp)
        }
    }
    private func mint() {
        minted = .null; codeDeadline = nil
        perform { api, owner, stamp in
            let value = try await api.request("/telegram/link-code", method: "POST", body: [:])
            guard current(api, owner, stamp), ProtectedWire.exact(value, ["code", "deepLink", "expiresAt"]),
                  ProtectedWire.matches(value["code"], "^[A-Za-z0-9_-]{27}$") else { throw CancellationError() }
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let fractional = formatter.date(from: value["expiresAt"].text)
            formatter.formatOptions = [.withInternetDateTime]
            guard let end = fractional ?? formatter.date(from: value["expiresAt"].text), end > Date(), end.timeIntervalSinceNow <= 900 else {
                throw JosiError(message: "The linking code expired. Create a new link.")
            }
            codeDeadline = .now.advanced(by: .milliseconds(Int(end.timeIntervalSinceNow * 1000)))
            minted = value
        }
    }
    private var telegramLink: URL? {
        let bot = status["channel"]["botUsername"].text, code = minted["code"].text
        guard bot.range(of: "^[A-Za-z0-9_]{5,32}$", options: .regularExpression) != nil,
              code.range(of: "^[A-Za-z0-9_-]{27}$", options: .regularExpression) != nil,
              let url = URL(string: "https://t.me/\(bot)?start=\(code)"),
              minted["deepLink"].text == url.absoluteString else { return nil }
        return url
    }
    private func revoke(_ choice: Wire) {
        perform { api, owner, stamp in
            let id = try api.uuid(choice["id"].text), admin = choice["kind"].text == "admin"
            guard !admin || model.isAdministrator else { throw CancellationError() }
            _ = try await api.request((admin ? "/admin/telegram/links/" : "/telegram/links/") + id, method: "DELETE")
            guard current(api, owner, stamp) else { return }
            minted = .null; codeDeadline = nil
            notice = "Telegram link disconnected."
            try await load(api, owner: owner, stamp: stamp)
        }
    }
    private func adminChange(path: String, method: String = "POST", body: [String: Wire], message: String) {
        guard model.isAdministrator, ["", "/token", "/probe", "/enabled", "/webhook", "/attachments"].contains(path) else { return }
        let expected = config
        perform { api, owner, stamp in
            let latest = try await api.request("/admin/telegram")
            guard current(api, owner, stamp), model.isAdministrator else { throw CancellationError() }
            guard latest["telegram"] == expected else { throw JosiError(message: "Telegram settings changed. Refresh before applying this change.") }
            _ = try await api.request("/admin/telegram" + path, method: method, body: .object(body))
            guard current(api, owner, stamp) else { return }
            notice = message
            try await load(api, owner: owner, stamp: stamp)
        }
    }
}
