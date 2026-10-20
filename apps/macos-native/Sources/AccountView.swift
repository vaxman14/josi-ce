import AppKit
import SwiftUI

private let personalActions = [
    ("email_send", "Sending email"),
    ("calendar_write", "Changing calendar events"),
    ("contacts_write", "Changing contacts"),
    ("task_management", "Managing tasks"),
]
private let personalLevels = [
    ("always_ask", "Always ask"),
    ("risky_only", "Ask for risky or destructive actions"),
    ("automatic", "Allow routine actions"),
]

struct NativeAccountView: View {
    @EnvironmentObject var model: JosiModel
    @State private var levels: [String: Wire] = [:]
    @State private var status: Wire = .null
    @State private var setup: Wire = .null
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var code = ""
    @State private var note = ""
    @State private var loading = false
    @State private var visible = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("Your Settings").font(.largeTitle.bold())
                    Spacer()
                    Button("Refresh") { model.run { try await load() } }
                }
                Text(model.signedInName + " · " + model.address).foregroundStyle(.secondary)
                GroupBox("Routine action approvals") {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("These choices apply to existing email, calendar, contact and task tools. Browser and computer access use the separate Automation permissions.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(personalActions, id: \.0) { action, label in
                            if let current = levels[action] {
                                let selected = current["managedPolicy"].flag ? current["level"].text : current["userChoice"].text
                                Picker(label, selection: Binding(get: { selected }, set: { saveLevel(action, value: $0) })) {
                                    ForEach(personalLevels, id: \.0) { key, name in
                                        if allowed(key, policy: current) { Text(name).tag(key) }
                                    }
                                }
                                if current["managedPolicy"].flag {
                                    Text("Administrator limit: " + levelName(current["adminCeiling"].text)).font(.caption).foregroundStyle(.secondary)
                                }
                            } else { Text(label + ": unavailable").foregroundStyle(.secondary) }
                        }
                        Text("Existing mandatory approvals remain in effect. These preferences cannot override Cardinal Rules or administrator restrictions.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(10)
                }
                GroupBox("Authenticator sign-in") {
                    VStack(alignment: .leading, spacing: 14) {
                        if status == .null { Text("Refresh to load authentication settings.") }
                        else if status["enabled"].flag {
                            Text("Enabled · \(status["recoveryCodesRemaining"].integer) recovery codes remain").font(.headline)
                            SecureField("Current password to disable the authenticator", text: $password).textContentType(.password)
                            Button("Disable Authenticator…") {
                                let alert = NSAlert(); alert.messageText = "Disable authenticator sign-in?"
                                alert.informativeText = "This removes the extra sign-in factor and its remaining recovery codes."
                                alert.addButton(withTitle: "Disable"); alert.addButton(withTitle: "Cancel")
                                if alert.runModal() == .alertFirstButtonReturn {
                                    let secret = password; password = ""
                                    perform("/auth/mfa/disable", body: ["password": .string(secret)])
                                }
                            }.disabled(password.isEmpty)
                        } else if setup != .null {
                            Text("Scan this code in your authenticator app, or enter the manual key. Then enter its six-digit code.")
                            if let image = qrImage { Image(nsImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 220, height: 220) }
                            DisclosureGroup("Manual setup key") { Text(setup["secret"].text).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                            SecureField("Six-digit authenticator code", text: $code).textContentType(.oneTimeCode)
                            HStack {
                                Button("Enable Authenticator") {
                                    let value = code; code = ""
                                    perform("/auth/mfa/enable", body: ["code": .string(value)])
                                }.buttonStyle(.borderedProminent).disabled(code.count != 6 || !code.utf8.allSatisfy { (48...57).contains($0) })
                                Button("Close Setup") { setup = .null; code = "" }
                            }
                        } else {
                            Text("Require a code from an authenticator when you sign in. The authenticator secret is held by the server’s Vault.")
                            Button("Set Up Authenticator") { perform("/auth/mfa/setup", body: [:]) }
                        }
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox("Confirm your identity") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Some existing task and account operations require a recent password confirmation. Protected rule and permission changes still use their own exact review.")
                            .font(.caption).foregroundStyle(.secondary)
                        SecureField("Current password", text: $confirmPassword).textContentType(.password)
                        Button("Confirm Password") {
                            let secret = confirmPassword; confirmPassword = ""
                            perform("/assistant/step-up", body: ["password": .string(secret)])
                        }.disabled(confirmPassword.isEmpty)
                    }.padding(10)
                }
                if !note.isEmpty { Text(note).foregroundStyle(.secondary) }
            }.padding(30).textFieldStyle(.roundedBorder).disabled(model.busy || loading)
        }
        .task { visible = true; do { try await load() } catch { model.error = error.localizedDescription } }
        .onDisappear { visible = false; setup = .null; code = ""; password = ""; confirmPassword = "" }
    }
    private func load() async throws {
        guard let api = model.api, !loading else { return }
        let user = model.user["id"]; loading = true; defer { loading = false }
        let mfa = try await api.request("/auth/mfa")
        guard visible, model.api === api, model.user["id"] == user else { return }; status = mfa
        for (action, _) in personalActions {
            let value = try await api.request("/assistant/approval-levels/" + action)
            guard visible, model.api === api, model.user["id"] == user else { return }; levels[action] = value
        }
    }
    private func levelName(_ value: String) -> String { personalLevels.first { $0.0 == value }?.1 ?? "Unavailable" }
    private func allowed(_ value: String, policy: Wire) -> Bool {
        guard policy["managedPolicy"].flag else { return true }
        guard let ceiling = personalLevels.firstIndex(where: { $0.0 == policy["adminCeiling"].text }),
              let rank = personalLevels.firstIndex(where: { $0.0 == value }) else { return false }
        return rank <= ceiling
    }
    private func saveLevel(_ action: String, value: String) {
        guard let api = model.api, let current = levels[action], allowed(value, policy: current) else { return }
        let user = model.user["id"]
        model.run {
            let result = try await api.request("/assistant/approval-levels/" + action, method: "PUT", body: ["level": .string(value)])
            guard visible, model.api === api, model.user["id"] == user else { return }; levels[action] = result
        }
    }
    private var qrImage: NSImage? {
        let raw = setup["qrDataUrl"].text, prefix = "data:image/png;base64,"
        guard raw.hasPrefix(prefix), raw.utf8.count <= 256 * 1024,
              let data = Data(base64Encoded: String(raw.dropFirst(prefix.count))),
              let image = NSImage(data: data), image.size.width > 0, image.size.height > 0,
              image.size.width <= 1024, image.size.height <= 1024 else { return nil }
        return image
    }
    private func perform(_ path: String, body: Wire) {
        guard let api = model.api else { return }
        let user = model.user["id"]
        model.run {
            let result = try await api.request(path, method: "POST", body: body)
            guard model.api === api, model.user["id"] == user else { return }
            if path == "/auth/mfa/enable" {
                let codes = result["recoveryCodes"].list
                guard result["enabled"].flag, codes.count == 10,
                      codes.allSatisfy({ ProtectedWire.matches($0, "^[A-F0-9]{6}-[A-F0-9]{6}$") }) else {
                    setup = .null
                    throw JosiError(message: "The final authenticator response could not be verified. Refresh sign-in settings before another attempt; do not assume recovery codes were saved.")
                }
                // Store this one-time response at app scope before any refresh
                // or view disappearance can discard the user's recovery copy.
                model.mfaRecovery = ["codes": .array(codes), "server": .string(api.origin.absoluteString),
                                     "account": .string(model.signedInName)]
                setup = .null; status = ["enabled": .bool(true), "recoveryCodesRemaining": .number(Double(codes.count))]
            } else if path == "/auth/mfa/setup" {
                guard visible, ProtectedWire.matches(result["secret"], "^[A-Z2-7]{16,128}$") else {
                    throw JosiError(message: "Authenticator setup was interrupted. Start setup again.")
                }
                setup = result; note = ""
            } else if path == "/assistant/step-up" {
                if visible { note = "Password confirmed for this session’s existing sensitive operations." }
            } else {
                setup = .null; status = result; note = "Authenticator sign-in disabled."
            }
        }
    }
}

struct NativeMfaRecovery: View {
    @EnvironmentObject var model: JosiModel
    @State private var shown = false
    @State private var confirmed = false
    @State private var note = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Save your sign-in recovery codes").font(.title2.bold())
            Text("Each code works once if your authenticator is unavailable. Keep them in a safe place; Josi will not display them again.")
            Toggle("Show recovery codes", isOn: $shown)
            if shown {
                Text(model.mfaRecovery["codes"].list.map(\.text).joined(separator: "\n"))
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
            }
            Button("Save Private Recovery File…") { export() }
            Toggle("I have stored these recovery codes safely", isOn: $confirmed)
            if !note.isEmpty { Text(note).font(.caption).foregroundStyle(.secondary) }
            Button("Done") { model.mfaRecovery = .null }.buttonStyle(.borderedProminent).disabled(!confirmed)
        }.padding(28).frame(width: 560).interactiveDismissDisabled()
    }
    private func export() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "Josi-sign-in-recovery.txt"
        panel.title = "Save your one-time sign-in recovery codes"
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            let value = model.mfaRecovery
            let text = "Josi sign-in recovery codes\nAccount: \(value["account"].text)\nServer: \(value["server"].text)\n\nEach code works once. Keep this file private.\n\n"
                + value["codes"].list.map(\.text).joined(separator: "\n") + "\n"
            let file = try NativePrivateExport(destination: destination)
            try file.write(Data(text.utf8)); try file.finish()
            note = "Saved with private file permissions. Confirm that you have stored it safely."
        } catch { note = "The recovery file could not be saved. Choose another location." }
    }
}
