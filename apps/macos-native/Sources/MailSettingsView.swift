import AppKit
import SwiftUI

private struct NativeSmtpDraft: Equatable {
    var copy = false
    var host = ""
    var port = "587"
    var security = "starttls"
    var username = ""
    var password = ""
    var passwordSet = false
    var clearPassword = false
    var fromName = "Josi"
    var fromAddress = ""
    init(_ value: Wire = .null, communications: Bool = false) {
        copy = communications && (value == .null || value["copyFromSystem"].flag)
        if value != .null {
            host = value["host"].text; username = value["username"].text
            if value["port"] != .null { port = String(value["port"].integer) }
            if !value["security"].text.isEmpty { security = value["security"].text }
            passwordSet = value["passwordSet"].flag
            fromName = value["fromName"].text; fromAddress = value["fromAddress"].text
        }
    }
    var body: Wire? {
        guard fromAddress.range(of: "^[^\\s@<>,;]+@[^\\s@<>,;]+$", options: .regularExpression) != nil,
              fromAddress.count <= 254, fromName.count <= 120, username.count <= 320, host.count <= 253,
              password.utf16.count <= 4096, !clearPassword || password.isEmpty,
              copy || !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let number = Int(port), (1...65535).contains(number),
              ["starttls", "tls", "none"].contains(security) else { return nil }
        return ["copyFromSystem": .bool(copy), "host": .string(host), "port": .number(Double(number)),
                "security": .string(security), "username": .string(username), "password": .string(password),
                "clearPassword": .bool(clearPassword), "fromName": .string(fromName), "fromAddress": .string(fromAddress)]
    }
}

struct NativeMailSettingsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var saved: Wire = .null
    @State private var system = NativeSmtpDraft()
    @State private var communications = NativeSmtpDraft(communications: true)
    @State private var originalSystem = NativeSmtpDraft()
    @State private var originalCommunications = NativeSmtpDraft(communications: true)
    @State private var testKind = "system"
    @State private var recipient = ""
    @State private var delivery: Wire = .null
    @State private var showDelivery = false
    @State private var visible = false
    @State private var generation = 0
    @State private var note = ""
    private var dirty: Bool { system != originalSystem || communications != originalCommunications }
    private var testProfile: Wire { saved["profiles"].list.first { $0["kind"].text == testKind } ?? .null }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("Email Delivery").font(.largeTitle.bold())
                    Spacer()
                    Button("Reload Saved Settings") {
                        guard !dirty || confirm("Discard unsaved email changes?", "Reloading replaces the form with the server’s saved settings.", "Reload") else { return }
                        model.run { try await load() }
                    }
                }
                Text("System email handles sign-in and password recovery. Communications email sends Josi’s work messages. Passwords are kept in the server’s Vault.")
                    .foregroundStyle(.secondary)
                if saved == .null {
                    Text("Email settings have not loaded.").foregroundStyle(.secondary)
                } else {
                    profile("System email", draft: $system, communicationProfile: false)
                    profile("Communications email", draft: $communications, communicationProfile: true)
                    Button("Save Both Email Profiles") { save() }
                        .buttonStyle(.borderedProminent).disabled(!dirty || system.body == nil || communications.body == nil)
                    Text("Saving does not send email or report delivery as verified. Use the explicit test below after saving.")
                        .font(.caption).foregroundStyle(.secondary)
                    GroupBox("Send a test message") {
                        VStack(alignment: .leading, spacing: 12) {
                            Picker("Saved profile", selection: $testKind) {
                                Text("System").tag("system"); Text("Communications").tag("communications")
                            }
                            TextField("Recipient email address", text: $recipient)
                            Button("Send One Test Email") { test() }
                                .disabled(dirty || testProfile == .null || recipient.range(of: "^[^\\s@<>,;]+@[^\\s@<>,;]+$", options: .regularExpression) == nil || recipient.count > 254)
                            Text(dirty ? "Save or reload your changes before sending a test." : "Sends one fixed test message to this address. Check its inbox to confirm delivery.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(10)
                    }
                    DisclosureGroup("Recent delivery status", isExpanded: $showDelivery) {
                        VStack(alignment: .leading, spacing: 10) {
                            Button("Refresh Delivery Status") { model.run { try await loadDelivery() } }
                            if delivery != .null {
                                Text("\(delivery["counts"]["sent"].integer) sent · \(delivery["counts"]["failed"].integer) failed · \(delivery["counts"]["quarantined"].integer) quarantined")
                                Text("Up to 200 work-message delivery records. Subjects and message contents are private. Test messages are reported above.")
                                    .font(.caption).foregroundStyle(.secondary)
                                ForEach(delivery["deliveries"].list, id: \.identifier) { item in
                                    HStack(alignment: .top) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(item["recipient"].text)
                                            Text("Requested by " + item["initiated_by"].text).font(.caption).foregroundStyle(.secondary)
                                            Text(item["sent_at"].text.isEmpty ? item["queued_at"].text : item["sent_at"].text)
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text(item["status"].text.replacingOccurrences(of: "_", with: " ").capitalized)
                                        if !item["error_category"].text.isEmpty {
                                            Text(item["error_category"].text.replacingOccurrences(of: "_", with: " ")).foregroundStyle(.secondary)
                                        }
                                    }
                                    Divider()
                                }
                            }
                        }.padding(.top, 10)
                    }.onChange(of: showDelivery) { _, expanded in
                        if expanded { model.run { try await loadDelivery() } } else { delivery = .null }
                    }
                    DisclosureGroup("Remove email configuration") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Removing system email also removes communications email if it uses the system server. Previously saved messages and delivery history remain.")
                                .font(.caption).foregroundStyle(.secondary)
                            ForEach(Array(saved["profiles"].list.enumerated()), id: \.offset) { _, row in
                                Button("Remove " + row["kind"].text.capitalized + " Profile…") { remove(row["kind"].text) }.disabled(dirty)
                            }
                        }.padding(.top, 10)
                    }
                }
                if !note.isEmpty { Text(note).foregroundStyle(.secondary) }
            }.padding(30).textFieldStyle(.roundedBorder).disabled(model.busy)
        }
        .task { visible = true; do { try await load() } catch { model.error = error.localizedDescription } }
        .onDisappear {
            visible = false; generation += 1; system.password = ""; communications.password = ""
            saved = .null; delivery = .null; recipient = ""
        }
    }
    @ViewBuilder private func profile(_ title: String, draft: Binding<NativeSmtpDraft>, communicationProfile: Bool) -> some View {
        GroupBox(title) {
            VStack(alignment: .leading, spacing: 12) {
                if communicationProfile {
                    Toggle("Use the system email server and login", isOn: draft.copy)
                        .onChange(of: draft.copy.wrappedValue) { _, copy in
                            if copy { communications.password = ""; communications.clearPassword = false }
                        }
                    if draft.copy.wrappedValue {
                        Text("Uses the system credential directly from the Vault. Saving removes any separate communications password.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !draft.copy.wrappedValue {
                    TextField("SMTP server", text: draft.host)
                    TextField("Port", text: draft.port)
                    Picker("Connection security", selection: draft.security) {
                        Text("STARTTLS").tag("starttls"); Text("TLS").tag("tls"); Text("None").tag("none")
                    }
                    TextField("Username", text: draft.username)
                    SecureField(draft.passwordSet.wrappedValue ? "Replacement password; blank keeps saved password" : "Password", text: draft.password)
                        .disabled(draft.clearPassword.wrappedValue)
                    Toggle("Clear the saved password", isOn: draft.clearPassword)
                        .onChange(of: draft.clearPassword.wrappedValue) { _, clear in
                            if clear { draft.password.wrappedValue = "" }
                        }
                    Text("Changing the server or account requires entering its password again, or explicitly clearing it.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                TextField("From name", text: draft.fromName)
                TextField("From email address", text: draft.fromAddress)
                if communicationProfile {
                    Button("Use the System Sender") {
                        communications.fromName = system.fromName; communications.fromAddress = system.fromAddress
                    }
                }
            }.padding(10)
        }
    }
    private func current(_ api: JosiAPI, _ owner: Wire, _ revision: Int) -> Bool {
        visible && model.api === api && model.user["id"] == owner && model.isAdministrator && generation == revision && !Task.isCancelled
    }
    private func apply(_ value: Wire) {
        saved = value
        system = NativeSmtpDraft(value["profiles"].list.first { $0["kind"].text == "system" } ?? .null)
        communications = NativeSmtpDraft(value["profiles"].list.first { $0["kind"].text == "communications" } ?? .null, communications: true)
        originalSystem = system; originalCommunications = communications
    }
    private func load() async throws {
        guard let api = model.api, model.isAdministrator else { return }
        let owner = model.user["id"], revision = generation
        let value = try await api.request("/admin/mail/smtp")
        guard current(api, owner, revision) else { return }; apply(value)
    }
    private func loadDelivery() async throws {
        guard let api = model.api, model.isAdministrator, showDelivery else { return }
        let owner = model.user["id"], revision = generation
        let value = try await api.request("/admin/mail")
        guard current(api, owner, revision), showDelivery else { return }; delivery = value
    }
    private func save() {
        guard let api = model.api, model.isAdministrator, let sys = system.body, let comms = communications.body, saved != .null else { return }
        let owner = model.user["id"], revision = generation
        let body: Wire = ["system": sys, "communications": comms, "expected": saved["versions"]]
        system.password = ""; communications.password = ""; note = ""
        model.run {
            guard current(api, owner, revision) else { return }
            let result = try await api.request("/admin/mail/smtp", method: "PUT", body: body)
            guard current(api, owner, revision) else { return }
            apply(result); note = "Email settings saved. No email was sent."
        }
    }
    private func test() {
        guard let api = model.api, model.isAdministrator, !dirty, testProfile != .null, ["system", "communications"].contains(testKind) else { return }
        let owner = model.user["id"], revision = generation, kind = testKind
        let body: Wire = ["to": .string(recipient), "configurationVersion": testProfile["configurationVersion"]]
        note = "Sending one test message…"
        model.run {
            guard current(api, owner, revision) else { return }
            do {
                let result = try await api.request("/admin/mail/smtp/" + kind + "/test", method: "POST", body: body)
                guard current(api, owner, revision) else { return }
                note = result["accepted"].flag ? "The server accepted the message. Check the recipient’s inbox to confirm delivery." : "The test could not be confirmed."
            } catch {
                if current(api, owner, revision) { note = "The test was not confirmed. Check the recipient’s inbox before deciding whether to send another." }
                throw error
            }
        }
    }
    private func remove(_ kind: String) {
        guard ["system", "communications"].contains(kind), let api = model.api, model.isAdministrator, !dirty else { return }
        let detail = kind == "system" ? "This removes the system email server and password. A communications profile that uses it is removed too. Password-reset email will stop until reconfigured."
            : "This removes communications email configuration and its separate password. System password-reset email remains configured."
        guard confirm("Remove \(kind) email?", detail, "Remove Profile") else { return }
        let owner = model.user["id"], revision = generation, expected = saved["versions"]
        model.run {
            guard current(api, owner, revision) else { return }
            let result = try await api.request("/admin/mail/smtp/" + kind, method: "DELETE", body: ["expected": expected])
            guard current(api, owner, revision) else { return }
            apply(result); note = "Email profile removed."
        }
    }
    private func confirm(_ title: String, _ detail: String, _ button: String) -> Bool {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: button); alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}
