import SwiftUI

/// Token inspection posts to the connected server, never a URL supplied by
/// the invitation. This view does not open a browser or persist its secrets.
struct NativePasswordSetupView: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var token = ""
    @State private var inspected: Wire = .null
    @State private var password = ""
    @State private var confirmation = ""
    @State private var identifier = ""
    @State private var note = ""
    @State private var visible = false
    @State private var revision = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Invitation or password reset").font(.title2.bold())
            Text(model.address).font(.caption).foregroundStyle(.secondary)
            if inspected == .null {
                Text("Paste the one-time link or code you received for this server.")
                SecureField("Invitation or reset link", text: $input)
                Button("Check Link") { inspect() }.disabled(input.isEmpty || input.utf8.count > 4096)
                Divider()
                Text("Need a reset link?").font(.headline)
                TextField("Username or email", text: $identifier)
                Button("Request Reset Email") { requestReset() }.disabled(identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || identifier.count > 254)
                Text("Email delivery must be configured on the server. Your administrator can also issue a reset link in People.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Set a password for \(inspected["username"].text)").font(.headline)
                Text(inspected["email"].text).foregroundStyle(.secondary)
                SecureField("New password (at least 12 characters)", text: $password).textContentType(.newPassword)
                SecureField("Repeat new password", text: $confirmation).textContentType(.newPassword)
                Button("Save Password") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(password.utf16.count < 12 || password.utf16.count > 1024 || password != confirmation)
                Text("Saving ends existing sign-ins. Sign in normally afterward; any enabled authenticator is still required.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Use Another Link") { clear() }
            }
            if !note.isEmpty { Text(note).foregroundStyle(.secondary) }
            HStack { Spacer(); Button("Close") { clear(); dismiss() } }
        }.padding(28).frame(width: 540).textFieldStyle(.roundedBorder).disabled(model.busy)
            .onAppear { visible = true }
            .onDisappear { visible = false; clear(); identifier = "" }
    }
    private func clear() {
        revision += 1; input = ""; token = ""; inspected = .null; password = ""; confirmation = ""
    }
    private func current(_ api: JosiAPI, _ captured: Int) -> Bool {
        visible && model.api === api && model.screen == .login && model.mfaChallenge.isEmpty
            && captured == revision && !Task.isCancelled
    }
    private func parsedToken(_ value: String, api: JosiAPI) throws -> String {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern = "^[A-Za-z0-9_-]{43}$"
        if value.range(of: pattern, options: .regularExpression) != nil { return value }
        guard value.utf8.count <= 4096, let link = URLComponents(string: value),
              let origin = URLComponents(url: api.origin, resolvingAgainstBaseURL: false),
              link.scheme == origin.scheme, link.host?.lowercased() == origin.host?.lowercased(),
              (link.port ?? (link.scheme == "https" ? 443 : 80)) == (origin.port ?? (origin.scheme == "https" ? 443 : 80)),
              link.user == nil, link.password == nil, link.fragment == nil, link.path == "/set-password",
              link.queryItems?.count == 1, let item = link.queryItems?.first, item.name == "token",
              let result = item.value, result.range(of: pattern, options: .regularExpression) != nil else {
            throw JosiError(message: "Use a valid invitation or reset link for the server shown here. If its address differs, reconnect to the address in the link first.")
        }
        return result
    }
    private func inspect() {
        guard let api = model.api else { return }
        let captured = revision, value = input; input = ""; note = ""
        model.run {
            let selected = try parsedToken(value, api: api)
            guard current(api, captured) else { return }
            let result = try await api.request("/auth/token/inspect", method: "POST", body: ["token": .string(selected)])
            guard current(api, captured) else { return }
            guard ["invite", "reset"].contains(result["purpose"].text), !result["username"].text.isEmpty else {
                throw JosiError(message: "This link could not be verified.")
            }
            token = selected; inspected = result
        }
    }
    private func save() {
        guard let api = model.api, !token.isEmpty, password == confirmation, password.utf16.count >= 12, password.utf16.count <= 1024 else { return }
        let captured = revision, selected = token, secret = password
        password = ""; confirmation = ""; note = ""
        model.run {
            guard current(api, captured) else { return }
            let result = try await api.request("/auth/set-password", method: "POST",
                                               body: ["token": .string(selected), "password": .string(secret), "signIn": .bool(false)])
            guard current(api, captured) else { return }
            guard result["passwordChanged"].flag else {
                // Older servers may have created a session. Close it instead
                // of treating password recovery as an authenticator bypass.
                _ = try await api.request("/auth/logout", method: "POST", body: [:])
                try await api.primeCSRF()
                clear(); note = "The server completed password recovery. Close this panel and sign in normally."
                return
            }
            clear(); note = "Password saved. Close this panel and sign in with your new password."
        }
    }
    private func requestReset() {
        guard let api = model.api else { return }
        let captured = revision, value = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        note = ""
        model.run {
            guard current(api, captured) else { return }
            _ = try await api.request("/auth/forgot-password", method: "POST", body: ["identifier": .string(value)])
            guard current(api, captured) else { return }
            note = "If the account exists and email delivery is configured, a reset link is on its way."
        }
    }
}
