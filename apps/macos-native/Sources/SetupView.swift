import AppKit
import SwiftUI

struct SetupView: View {
    @EnvironmentObject var model: JosiModel
    @State private var values: [String: String] = [:]
    @State private var provider = ""
    @State private var enabled = false
    @State private var externalAcknowledged = false
    @State private var recoverySaved = false
    @State private var showRecovery = false
    @State private var discovered: [Wire] = []
    @State private var subscription: Wire = .null
    var step: String { model.setup["nextStep"].text }
    var providerEntry: Wire { model.setup["providerCatalog"].list.first { $0["kind"].text == provider } ?? .null }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                JosiHeading(title: "Set up Josi", subtitle: "Everything stays inside the app. Your server determines the next step.")
                HStack {
                    ForEach(Array(model.setup["steps"].list.enumerated()), id: \.offset) { _, item in
                        Label(item["title"].text, systemImage: item["done"].flag ? "checkmark.circle.fill" : "circle")
                            .font(.caption).foregroundStyle(item["id"].text == step ? Color.accentColor : Color.secondary)
                    }
                }
                if model.recovery != .null {
                    recoveryView
                } else {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 18) {
                            Text(model.setup["steps"].list.first { $0["id"].text == step }?["title"].text ?? "Finish setup")
                                .font(.title2.bold())
                            stepForm
                        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if model.setupReview != .null {
                        GroupBox("Setup review") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(model.setupReview["items"].list.enumerated()), id: \.offset) { _, item in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item["label"].text).font(.headline)
                                        Text(item["statusLabel"].text).foregroundStyle(item["blocking"].flag ? Color.orange : Color.secondary)
                                        if !item["verification"]["detail"].text.isEmpty { Text(item["verification"]["detail"].text).font(.caption) }
                                    }
                                }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                HStack {
                    Button("Refresh Setup") { model.run { try await model.loadSetup() } }
                    Button("Disconnect") { clearFields(); model.disconnect() }
                }
            }.padding(32).frame(maxWidth: 900).frame(maxWidth: .infinity)
        }.textFieldStyle(.roundedBorder).disabled(model.busy)
            .onChange(of: step) { _, _ in clearFields() }
            .onChange(of: provider) { _, _ in
                values = [:]; discovered = []; subscription = .null; externalAcknowledged = false
                if !providerEntry["defaultBaseUrl"].text.isEmpty { values["baseUrl"] = providerEntry["defaultBaseUrl"].text }
            }
    }
    @ViewBuilder private var stepForm: some View {
        switch step {
        case "host_checks":
            ForEach(Array(model.hostChecks.enumerated()), id: \.offset) { _, check in
                Label(check["label"].text, systemImage: check["status"].text == "pass" ? "checkmark.circle" : "exclamationmark.triangle")
            }
            next([:])
        case "owner":
            if model.setup["ownerExists"].flag {
                Text("Sign in to resume your existing owner account.")
                field("Username or email", "identifier")
                field("Password", "password", secret: true)
                Button("Sign In and Continue") {
                    submit(["resumeOwner": .bool(true), "identifier": value("identifier"), "password": value("password")])
                }.buttonStyle(.borderedProminent)
            } else {
                field("Your name", "displayName"); field("Email", "email"); field("Username", "username")
                field("Password — at least 12 characters", "password", secret: true)
                Button("Create Account") {
                    submit(["displayName": value("displayName"), "email": value("email"), "username": value("username"),
                            "password": value("password"), "timezone": .string(TimeZone.current.identifier)])
                }.buttonStyle(.borderedProminent)
            }
        case "domain":
            field("Server address or domain", "domain")
            Picker("HTTPS", selection: binding("tlsMode", fallback: "bundled_caddy")) {
                Text("Bundled Caddy").tag("bundled_caddy"); Text("My own reverse proxy").tag("external_proxy")
            }
            field("Certificate notification email", "acmeEmail")
            next(["domain": value("domain"), "tlsMode": value("tlsMode", fallback: "bundled_caddy"), "acmeEmail": value("acmeEmail")])
        case "llm":
            providerForm
        case "smtp":
            field("SMTP server", "host")
            field("Port", "port", fallback: "587")
            Picker("Security", selection: binding("security", fallback: "starttls")) {
                Text("STARTTLS").tag("starttls"); Text("TLS").tag("tls"); Text("None").tag("none")
            }
            field("Username", "username"); field("Password", "password", secret: true)
            field("From name", "fromName", fallback: "Josi"); field("From address", "fromAddress")
            field("Send a test email to", "testTo")
            Text("Save and Test sends one email to the address above. Your mail password is saved in the server’s Vault.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Save and Test") {
                    submit(["system": ["host": value("host"), "port": .number(Double(values["port"] ?? "587") ?? 587),
                                       "security": value("security", fallback: "starttls"), "username": value("username"),
                                       "password": value("password"), "fromName": value("fromName", fallback: "Josi"), "fromAddress": value("fromAddress")],
                            "communications": ["copyFromSystem": .bool(true), "fromName": "Josi", "fromAddress": value("fromAddress")],
                            "testTo": value("testTo")])
                }.buttonStyle(.borderedProminent)
                Button("Skip for Now") { submit(["skip": .bool(true)]) }
            }
        case "security":
            Toggle("Allow people to choose folders for Josi to read", isOn: $enabled)
            Text("Each person still needs to approve their own folders.").foregroundStyle(.secondary)
            next(["folderMappingEnabled": .bool(enabled)])
        case "telemetry":
            Toggle("Send anonymous usage counts", isOn: $enabled)
            Text("Optional. Does not include conversations, credentials or business content.").foregroundStyle(.secondary)
            next(["enabled": .bool(enabled)])
        case "review":
            Text("Review your saved settings below before continuing.")
            next([:])
        case "":
            Button("Finish Setup") { model.run { try await model.finishSetup() } }
                .buttonStyle(.borderedProminent).disabled(!model.setupReview["canComplete"].flag)
        default:
            Text("This server requires a setup step this app does not yet support. Update Josi to continue.")
        }
    }
    private var providerForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Provider", selection: $provider) {
                Text("Choose a provider").tag("")
                ForEach(Array(model.setup["providerCatalog"].list.enumerated()), id: \.offset) { _, entry in
                    Text(entry["label"].text).tag(entry["kind"].text)
                }
            }
            ForEach(Array(providerEntry["fields"].list.enumerated()), id: \.offset) { _, entry in
                field(entry["label"].text, entry["key"].text, secret: entry["secret"].flag)
            }
            if providerEntry["baseUrlMode"].text != "none" && !provider.isEmpty { field("Endpoint", "baseUrl") }
            if provider == "openai_subscription" {
                HStack {
                    Button("Sign In with ChatGPT…") { subscriptionAction("POST") }
                    Button("Check Sign-In") { subscriptionAction("GET") }
                }
                if !subscription["challenge"]["userCode"].text.isEmpty {
                    Text("One-time code: \(subscription["challenge"]["userCode"].text)").font(.headline).textSelection(.enabled)
                    Button("Open Sign-In Page") {
                        guard let url = URL(string: subscription["challenge"]["verificationUrl"].text),
                              url.scheme == "https", url.user == nil, url.password == nil else { return }
                        let alert = NSAlert(); alert.messageText = "Open provider sign-in?"
                        alert.informativeText = url.host ?? ""; alert.addButton(withTitle: "Open"); alert.addButton(withTitle: "Cancel")
                        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
                    }
                }
                if !subscription["state"].text.isEmpty { Text(subscription["state"].text.replacingOccurrences(of: "_", with: " ")).foregroundStyle(.secondary) }
                Text(subscription["message"].text).font(.caption)
            }
            if !provider.isEmpty {
                Button("Find Available Models") {
                    let body = credentials()
                    model.run {
                        guard let api = model.api else { return }
                        let result = try await api.request("/setup/models", method: "POST", body: body)
                        guard model.api === api else { return }; discovered = result["models"].list
                    }
                }
                if !discovered.isEmpty {
                    Picker("Available models", selection: binding("model")) {
                        Text("Choose a model").tag("")
                        ForEach(Array(discovered.enumerated()), id: \.offset) { _, item in
                            Text(item["label"].text.isEmpty ? item["id"].text : item["label"].text).tag(item["id"].text)
                        }
                    }
                }
                field(provider.hasSuffix("_subscription") ? "Model (blank uses your subscription default)" : "Model", "model")
                if providerEntry["external"].flag {
                    Toggle("Allow task content to be sent to this provider", isOn: $externalAcknowledged)
                }
                Button("Save and Check Model") {
                    var body = credentials()
                    if case .object(var fields) = body {
                        fields["model"] = value("model"); fields["externalAcknowledged"] = .bool(externalAcknowledged)
                        body = .object(fields)
                    }
                    submit(body)
                }.buttonStyle(.borderedProminent)
            }
        }
    }
    private var recoveryView: some View {
        GroupBox("Save your Vault recovery key") {
            VStack(alignment: .leading, spacing: 16) {
                Text("Keep this key somewhere safe outside Josi. It can recover your Vault if the installation key is lost.")
                Toggle("Show recovery key", isOn: $showRecovery)
                if showRecovery { Text(model.recovery["key"].text).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                Text("Fingerprint: \(model.recovery["fingerprint"].text)").foregroundStyle(.secondary)
                Button("Save Recovery Key…") {
                    do {
                        if try NativeRecoveryFile.save(key: model.recovery["key"].text,
                            fingerprint: model.recovery["fingerprint"].text) { recoverySaved = true }
                    } catch { model.error = "The recovery key could not be saved. Choose another location." }
                }
                Toggle("I have saved my recovery key", isOn: $recoverySaved)
                Button("Continue") {
                    model.run { try await model.confirmRecovery(); showRecovery = false; recoverySaved = false }
                }.buttonStyle(.borderedProminent).disabled(!recoverySaved)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func binding(_ key: String, fallback: String = "") -> Binding<String> {
        Binding(get: { values[key] ?? fallback }, set: { values[key] = $0 })
    }
    private func field(_ title: String, _ key: String, secret: Bool = false, fallback: String = "") -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.callout)
            if secret { SecureField(title, text: binding(key, fallback: fallback)).labelsHidden() }
            else { TextField(title, text: binding(key, fallback: fallback)).labelsHidden() }
        }
    }
    private func value(_ key: String, fallback: String = "") -> Wire { .string(values[key] ?? fallback) }
    private func next(_ body: Wire) -> some View { Button("Continue") { submit(body) }.buttonStyle(.borderedProminent) }
    private func submit(_ body: Wire) {
        let submittedStep = step
        // Clear credential fields before waiting on the request.
        for key in ["password", "apiKey"] + providerEntry["fields"].list.filter({ $0["secret"].flag }).map({ $0["key"].text }) {
            values[key] = nil
        }
        model.run { try await model.setupStep(submittedStep, body: body) }
    }
    private func credentials() -> Wire {
        var fields: [String: Wire] = ["provider": .string(provider), "baseUrl": value("baseUrl")]
        for field in providerEntry["fields"].list { fields[field["key"].text] = value(field["key"].text) }
        return .object(fields)
    }
    private func subscriptionAction(_ method: String) {
        model.run {
            guard let api = model.api else { return }
            let result = try await api.request("/setup/subscription/login", method: method, body: method == "POST" ? [:] : nil)
            guard model.api === api else { return }; subscription = result
        }
    }
    private func clearFields() { values = [:]; enabled = false; externalAcknowledged = false; discovered = []; subscription = .null }
}
