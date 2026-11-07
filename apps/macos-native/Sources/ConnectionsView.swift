import AppKit
import SwiftUI

/// The beta connects Google and Microsoft for mail and calendar. Everything else
/// the server knows about stays off this page.
private let connectionProviders = [("google", "Google"), ("microsoft", "Microsoft 365")]
private let connectionCapabilities = [".mail.", ".calendar."]
private let connectionDocs = "https://github.com/vaxman14/josi-ce/blob/main/docs/"

private func connectionProblem(_ category: String) -> String {
    ["revoked": "Access was withdrawn at the provider. Reconnect to restore it.",
     "expired": "The stored access expired and could not be renewed. Reconnect.",
     "insufficient_scope": "A permission Josi needs was not granted. Reconnect and approve it.",
     "rate_limited": "The provider is rate limiting Josi. This usually clears on its own.",
     "provider_error": "The provider returned an error. If it persists, reconnect.",
     "network": "Josi could not reach the provider."][category] ?? "Something went wrong with this connection."
}

/// Why a handshake did not finish. The server answers with a reason code.
private func handshakeProblem(_ reason: String) -> String {
    switch reason {
    case "declined": return "You cancelled at the provider, so nothing was connected."
    case "consumed", "unknown", "expired": return "That sign-in had already been used or had expired. Start again."
    case "session_mismatch": return "That sign-in was started by a different session. Start again here."
    case "wrong_provider": return "That sign-in did not match the provider it was started for."
    case "revoked": return "The provider refused the connection. Check the client ID and secret under Server setup."
    default: return reason.contains(" ") ? reason : "The connection could not be completed. Try again."
    }
}

/// Pasting one provider's OAuth client. The secret lives only in this field
/// until it is saved, and the server never sends it back.
private struct NativeOAuthClientCard: View {
    @EnvironmentObject var model: JosiModel
    let label: String
    let howTo: String
    let client: Wire
    let suggested: String
    let save: @MainActor (_ clientId: String, _ secret: String, _ redirect: String) async throws -> Void
    @State private var clientId = ""
    @State private var secret = ""
    @State private var error = ""
    @State private var note = ""
    private var redirect: String { client["redirectUri"].text.isEmpty ? suggested : client["redirectUri"].text }
    private var trimmedId: String { clientId.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        JosiCard {
            HStack {
                Text(label).font(JosiFont.headline)
                Spacer()
                JosiPill(text: client["configured"].flag ? "Configured" : "Not set up",
                         color: client["configured"].flag ? JosiTheme.success : JosiTheme.muted)
            }
            NativeLeanNote(text: howTo)
            Button("How to Set This Up") {
                if let url = URL(string: connectionDocs) { NSWorkspace.shared.open(url) }
            }.buttonStyle(JosiOutlineButtonStyle())
            VStack(alignment: .leading, spacing: 5) {
                Text("Redirect URL").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                HStack {
                    Text(redirect).font(JosiFont.callout).textSelection(.enabled).lineLimit(2)
                    Spacer()
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(redirect, forType: .string)
                    }.buttonStyle(JosiOutlineButtonStyle())
                }
            }
            TextField("Client ID", text: $clientId)
            SecureField(client["configured"].flag ? "Client secret (stored, enter a new one to replace it)" : "Client secret", text: $secret)
            if !error.isEmpty { NativeLeanNote(text: error, color: JosiTheme.error) }
            if !note.isEmpty { NativeLeanNote(text: note, color: JosiTheme.success) }
            Button("Save") { submit() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                .disabled(model.busy || trimmedId.isEmpty || secret.isEmpty || redirect.isEmpty)
        }
        .textFieldStyle(JosiFieldStyle())
        .onAppear { clientId = client["clientId"].text }
        .onChange(of: client["clientId"].text) { _, value in clientId = value }
        .onDisappear { secret = "" }
    }
    private func submit() {
        let id = trimmedId, value = secret, uri = redirect
        error = ""; note = ""
        model.run {
            do {
                try await save(id, value, uri)
                secret = ""
                note = "\(label) saved."
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct NativeConnectionsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var providers: [Wire] = []
    @State private var admin: Wire = .null
    @State private var connecting = false
    @State private var loaded = false
    @State private var unavailable = false
    @State private var adminUnavailable = false
    @State private var adminError = ""
    @State private var error = ""
    @State private var note = ""
    @State private var generation = 0

    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                JosiHeading(title: "Connections", subtitle: "Your own mail and calendar accounts, connected by you.")
                Button("Refresh") { model.run { await load() } }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            }
            NativeLeanStatus(loading: !loaded && error.isEmpty && !unavailable, error: error, note: note)
            if unavailable {
                NativeLeanNote(text: "This server does not offer connections yet. Update the server to use them.")
            } else if loaded {
                ForEach(connectionProviders, id: \.0) { provider, label in
                    let view = providers.first { $0["provider"].text == provider } ?? .null
                    let accounts = view["connections"].list.filter { $0 != .null }
                    if accounts.isEmpty { emptyCard(view, provider: provider, label: label) }
                    ForEach(accounts, id: \.identifier) { accountCard($0, provider: provider, label: label) }
                }
            }
            if model.isAdministrator { serverSetup }
        }
        .task {
            while !Task.isCancelled {
                if NSApp.isActive && !model.busy { await load() }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .onDisappear { generation += 1 }
    }

    private func emptyCard(_ view: Wire, provider: String, label: String) -> some View {
        JosiCard {
            HStack {
                Text(label).font(JosiFont.headline)
                Spacer()
                JosiPill(text: view["available"].flag ? "Not connected" : "Not set up", color: JosiTheme.muted)
            }
            if view["available"].flag {
                NativeLeanNote(text: "\(label) asks once for the permissions Josi supports. Each one stays off here until you turn it on.")
                Button(connecting ? "Waiting for your browser…" : "Connect \(label)") { connect(provider) }
                    .buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(model.busy || connecting)
            } else {
                NativeLeanNote(text: model.isAdministrator
                               ? "Add your own \(label) client under Server setup below, then you can connect an account."
                               : "An administrator has to set up \(label) on this server before anyone can connect.")
            }
        }
    }
    private func accountCard(_ account: Wire, provider: String, label: String) -> some View {
        let active = account["status"].text == "active"
        let capabilities = account["capabilities"].list.filter { item in
            connectionCapabilities.contains { item["key"].text.contains($0) }
        }
        return JosiCard {
            HStack {
                Text(label).font(JosiFont.headline)
                Spacer()
                JosiPill(text: active ? "Connected" : "Needs reconnecting", color: active ? JosiTheme.success : JosiTheme.error)
            }
            if !account["account"].text.isEmpty { NativeLeanNote(text: account["account"].text) }
            if !account["errorCategory"].text.isEmpty {
                NativeLeanNote(text: connectionProblem(account["errorCategory"].text), color: JosiTheme.error)
            }
            if account["needsPermissionUpgrade"].flag || !active {
                NativeLeanNote(text: active ? "This account was connected before Josi asked for its current permissions. Upgrade once, then use the switches below."
                                            : "Reconnect this account to keep using it.")
                Button(active ? "Upgrade Permissions" : "Reconnect") { connect(provider, connection: account.identifier) }
                    .buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy || connecting)
            }
            ForEach(capabilities, id: \.self["key"].text) { capability in
                Divider().overlay(JosiTheme.hairline)
                capabilityRow(capability, connection: account.identifier)
            }
            Divider().overlay(JosiTheme.hairline)
            HStack {
                Button("Disconnect…") { disconnect(account, label: label) }.buttonStyle(JosiOutlineButtonStyle())
                Button("Add Another Account") { connect(provider) }.buttonStyle(JosiOutlineButtonStyle())
            }.disabled(model.busy || connecting)
        }
    }
    private func capabilityRow(_ capability: Wire, connection: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(capability["label"].text).font(JosiFont.callout)
                Spacer()
                if capability["state"].text == "blocked_by_admin" {
                    JosiPill(text: "Off by administrator", color: JosiTheme.muted)
                } else if capability["needsConsent"].flag {
                    JosiPill(text: "Needs a permission upgrade", color: JosiTheme.muted)
                } else {
                    Toggle(capability["label"].text, isOn: Binding(get: { capability["state"].text == "on" },
                                                                   set: { toggle(capability, connection: connection, on: $0) }))
                        .toggleStyle(.switch).labelsHidden().disabled(model.busy)
                }
            }
            // What a write permission allows, before it can be switched on.
            if capability["kind"].text == "write", !capability["consequence"].text.isEmpty {
                NativeLeanNote(text: capability["consequence"].text, color: JosiTheme.muted)
            }
            if !capability["adminNote"].text.isEmpty { NativeLeanNote(text: capability["adminNote"].text, color: JosiTheme.muted) }
        }
    }
    @ViewBuilder private var serverSetup: some View {
        NativeLeanTitle(text: "Server setup").padding(.top, 10)
        NativeLeanNote(text: "Each person connects their own account, but this server needs your own OAuth client for each provider first. The secret is encrypted on the server and never shown again.")
        if !adminError.isEmpty { NativeLeanNote(text: adminError, color: JosiTheme.error) }
        if adminUnavailable {
            NativeLeanNote(text: "This server does not offer client setup yet. Update the server to use it.")
        } else if admin == .null {
            if adminError.isEmpty { ProgressView().controlSize(.small) }
        } else if !admin["registration"]["available"].flag {
            JosiCard {
                Text("A public address is needed first").font(JosiFont.headline)
                NativeLeanNote(text: admin["registration"]["reason"].text)
                NativeLeanNote(text: "Current address: " + admin["registration"]["detectedOrigin"].text, color: JosiTheme.muted)
                ForEach(connectionProviders, id: \.0) { provider, label in
                    let client = clientStatus(provider)
                    HStack {
                        Text(label).font(JosiFont.callout)
                        Spacer()
                        JosiPill(text: client["configured"].flag ? "Configured" : "Not set up",
                                 color: client["configured"].flag ? JosiTheme.success : JosiTheme.muted)
                    }
                }
            }
        } else {
            NativeOAuthClientCard(label: "Google client", howTo: "In Google Cloud Console, create an OAuth client of type Web application, add the redirect URL below, and paste its ID and secret here.",
                                  client: clientStatus("google"), suggested: suggestedRedirect("google")) { id, secret, uri in
                try await saveClient("google", id: id, secret: secret, redirect: uri)
            }
            NativeOAuthClientCard(label: "Microsoft client", howTo: "In the Microsoft Entra admin center, register an app, add the redirect URL below as a Web platform, and paste its client ID and a client secret here.",
                                  client: clientStatus("microsoft"), suggested: suggestedRedirect("microsoft")) { id, secret, uri in
                try await saveClient("microsoft", id: id, secret: secret, redirect: uri)
            }
        }
        // This page carries its own Email Delivery heading.
        NativeMailSettingsView()
    }

    private func clientStatus(_ provider: String) -> Wire {
        admin["clients"].list.first { $0["provider"].text == provider } ?? .null
    }
    private func suggestedRedirect(_ provider: String) -> String {
        admin["suggestedRedirectUris"].list.first { $0["provider"].text == provider }?["uri"].text ?? ""
    }
    private func load() async {
        guard let api = model.api else { return }
        let owner = model.user["id"], started = generation, administrator = model.isAdministrator
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        do {
            let result = try await api.request("/connections")
            guard current() else { return }
            providers = result["providers"].list; loaded = true; unavailable = false; error = ""
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { unavailable = true }
            else if !loaded { self.error = error.localizedDescription }
        }
        guard administrator else { return }
        do {
            let result = try await api.request("/admin/connectors")
            guard current() else { return }
            admin = result; adminUnavailable = false; adminError = ""
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { adminUnavailable = true }
            else if admin == .null { adminError = error.localizedDescription }
        }
    }
    /// Consent happens in the browser, which has no Josi session. So the app
    /// starts the handshake with its own session, the browser hands the code back
    /// on josi://, and the app finishes it with that same session. This runs
    /// outside model.run because it waits on the person for as long as they need.
    private func connect(_ provider: String, connection: String? = nil) {
        guard let api = model.api, !connecting else { return }
        let owner = model.user["id"]
        var fields: [String: Wire] = ["native": .bool(true)]
        if let connection { fields["connectionId"] = .string(connection) }
        let body = Wire.object(fields)
        connecting = true; error = ""; note = ""
        Task {
            defer { connecting = false }
            do {
                let result = try await api.request("/connections/\(provider)/start", method: "POST", body: body)
                guard model.api === api, model.user["id"] == owner else { return }
                // The address comes from the server, so only a plain https page is opened.
                guard let url = URL(string: result["url"].text), url.scheme == "https", url.host != nil, url.user == nil,
                      let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "state" })?.value else {
                    throw JosiError(message: "The server did not return a usable sign-in address.")
                }
                let code: String
                do { code = try await NativeSignIn.browser(start: url) }
                catch is CancellationError { return }
                catch { throw JosiError(message: handshakeProblem("declined")) }
                guard model.api === api, model.user["id"] == owner else { return }
                let done = try await api.request("/connections/\(provider)/native/complete", method: "POST",
                                                 body: ["state": .string(state), "code": .string(code)])
                guard model.api === api, model.user["id"] == owner else { return }
                note = done["account"].text.isEmpty ? "Connected." : "Connected \(done["account"].text)."
                await load()
            } catch is CancellationError {
            } catch {
                guard model.api === api else { return }
                self.error = (error as? JosiError)?.status == 409 ? handshakeProblem(error.localizedDescription) : error.localizedDescription
            }
        }
    }
    private func toggle(_ capability: Wire, connection: String, on: Bool) {
        guard let api = model.api, let id = try? api.uuid(connection) else { return }
        let owner = model.user["id"], key = capability["key"].text
        error = ""; note = ""
        model.run {
            do {
                _ = try await api.request("/connections/\(id)/capabilities/\(key)", method: "PUT", body: ["enabled": .bool(on)])
                guard model.api === api, model.user["id"] == owner else { return }
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
            await load()
        }
    }
    private func disconnect(_ account: Wire, label: String) {
        guard let api = model.api, let id = try? api.uuid(account.identifier) else { return }
        let name = account["account"].text.isEmpty ? label : account["account"].text
        guard nativeConfirm("Disconnect \(name)?", detail: "Josi deletes its copy of this account's access and stops using it. Nothing in the account is changed.", button: "Disconnect") else { return }
        let owner = model.user["id"]
        error = ""; note = ""
        model.run {
            do {
                let result = try await api.request("/connections/\(id)", method: "DELETE")
                guard model.api === api, model.user["id"] == owner else { return }
                note = result["note"].text.isEmpty ? "Disconnected." : result["note"].text
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
            await load()
        }
    }
    private func saveClient(_ provider: String, id: String, secret: String, redirect: String) async throws {
        guard let api = model.api, model.isAdministrator else { return }
        _ = try await api.request("/admin/connectors/clients/\(provider)", method: "PUT",
            body: ["clientId": .string(id), "clientSecret": .string(secret), "redirectUri": .string(redirect)])
        guard model.api === api else { return }
        await load()
    }
}
