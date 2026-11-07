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
    @State private var place = "mac"
    private static let words: [String: (String, String)] = [
        "host_checks": ("Checking this Mac", "A quick look to make sure everything Josi needs is here."),
        "owner": ("First, who are you?", "This is the account that runs this Josi. You can invite other people later."),
        "domain": ("Where will you use Josi?", "This decides which devices can reach her. You can change it later."),
        "llm": ("Pick Josi’s brain", "The AI model she thinks with. Your subscription or your own key both work."),
        "smtp": ("Email, if you want it", "Lets Josi send invitations and password resets. You can skip this for now."),
        "security": ("Your folders", "Choose whether people here may give Josi access to folders."),
        "telemetry": ("Help improve Josi", "Completely optional, and it never includes your conversations."),
        "review": ("Almost there", "One last look at what you chose."),
        "": ("All set", "Josi is ready when you are."),
    ]
    private var stepNote: String {
        let steps = model.setup["steps"].list
        guard let at = steps.firstIndex(where: { $0["id"].text == step }) else { return "" }
        return "Step \(at + 1) of \(steps.count)"
    }
    var step: String { model.setup["nextStep"].text }
    var providerEntry: Wire { model.setup["providerCatalog"].list.first { $0["kind"].text == provider } ?? .null }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                JosiHeading(title: Self.words[step]?.0 ?? "Set up Josi", subtitle: Self.words[step]?.1 ?? "")
                if !stepNote.isEmpty { Text(stepNote).font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
                HStack {
                    ForEach(Array(model.setup["steps"].list.enumerated()), id: \.offset) { _, item in
                        Label(item["title"].text, systemImage: item["done"].flag ? "checkmark.circle.fill" : "circle")
                            .font(JosiFont.caption).foregroundStyle(item["id"].text == step ? Color.accentColor : Color.secondary)
                    }
                }
                if model.recovery != .null {
                    recoveryView
                } else {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 18) {
                            stepForm
                        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if model.setupReview != .null {
                        GroupBox("Setup review") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(model.setupReview["items"].list.enumerated()), id: \.offset) { _, item in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item["label"].text).font(JosiFont.headline)
                                        Text(item["statusLabel"].text).foregroundStyle(item["blocking"].flag ? JosiTheme.error : Color.secondary)
                                        if !item["verification"]["detail"].text.isEmpty { Text(item["verification"]["detail"].text).font(JosiFont.caption) }
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
        }.textFieldStyle(JosiFieldStyle()).disabled(model.busy)
            .onChange(of: step) { _, _ in clearFields(); model.setupCheck = .null }
            .onChange(of: provider) { _, _ in
                values = [:]; discovered = []; externalAcknowledged = false
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
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
            } else {
                field("Your name", "displayName"); field("Username", "username"); field("Email", "email")
                Text("You sign in with your username or email. Password resets go to that email.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                field("Password — at least 12 characters", "password", secret: true)
                Button("Create Account") {
                    submit(["displayName": value("displayName"), "email": value("email"), "username": value("username"),
                            "password": value("password"), "timezone": .string(TimeZone.current.identifier)])
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
            }
        case "domain":
            Picker("Where", selection: $place) {
                Text("Just this Mac").tag("mac"); Text("Home or office network").tag("network"); Text("My own domain").tag("domain")
            }.pickerStyle(.segmented).labelsHidden()
            switch place {
            case "mac":
                Text("Josi answers on this Mac only. It’s the simplest start, and nothing is reachable from outside.").foregroundStyle(JosiTheme.lilac)
            case "network":
                field("This Mac’s address on your network", "lanAddress", fallback: Self.localAddress)
                Text("Phones and computers on the same Wi-Fi or network reach Josi here. Nothing is reachable from the internet.").foregroundStyle(JosiTheme.lilac)
            default:
                field("Your domain", "publicDomain")
                Text("For example josi.yourname.com. Reach Josi from anywhere, with HTTPS.").foregroundStyle(JosiTheme.lilac)
                Picker("HTTPS", selection: binding("tlsMode", fallback: "bundled_caddy")) {
                    Text("Josi sets it up for me (recommended)").tag("bundled_caddy"); Text("I run my own reverse proxy").tag("external_proxy")
                }
                field("Email for certificate notices", "acmeEmail")
                Text("Before you continue: point your domain’s DNS at this server, and open ports 80 and 443. Josi can’t get a certificate until both are done.")
                    .font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
            }
            Button("Continue") { submitPlace() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
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
                .font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
            HStack {
                Button("Save and Test") {
                    submit(["system": ["host": value("host"), "port": .number(Double(values["port"] ?? "587") ?? 587),
                                       "security": value("security", fallback: "starttls"), "username": value("username"),
                                       "password": value("password"), "fromName": value("fromName", fallback: "Josi"), "fromAddress": value("fromAddress")],
                            "communications": ["copyFromSystem": .bool(true), "fromName": "Josi", "fromAddress": value("fromAddress")],
                            "testTo": value("testTo")])
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Skip for Now") { submit(["skip": .bool(true)]) }
            }
        case "security":
            Toggle("Allow people to choose folders for Josi to read", isOn: $enabled)
            Text("Each person still needs to approve their own folders.").foregroundStyle(JosiTheme.lilac)
            next(["folderMappingEnabled": .bool(enabled)])
        case "telemetry":
            Toggle("Send anonymous usage counts", isOn: $enabled)
            Text("Optional. Does not include conversations, credentials or business content.").foregroundStyle(JosiTheme.lilac)
            next(["enabled": .bool(enabled)])
        case "review":
            Text("Review your saved settings below before continuing.")
            next([:])
        case "":
            Button("Finish Setup") { model.run { try await model.finishSetup() } }
                .buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(!model.setupReview["canComplete"].flag)
        default:
            Text("This server requires a setup step this app does not yet support. Update Josi to continue.")
        }
    }
    private var providerForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.setupCheck != .null, model.setupCheck["status"].text != "passed" {
                VStack(alignment: .leading, spacing: 6) {
                    Label("The model did not pass its check", systemImage: "exclamationmark.triangle").font(JosiFont.headline).foregroundStyle(JosiTheme.error)
                    Text(model.setupCheck["detail"].text.nonempty ?? "Nothing was activated. Check the key and model, then try again.").textSelection(.enabled)
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(JosiTheme.error.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
            }
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
            if ["openai_subscription", "anthropic_subscription"].contains(provider) {
                NativeSubscriptionControls(provider: provider, prefix: "/setup/subscription").id(provider)
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
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
            }
        }
    }
    private var recoveryView: some View {
        GroupBox("Save your Vault recovery key") {
            VStack(alignment: .leading, spacing: 16) {
                Text("Keep this key somewhere safe outside Josi. It can recover your Vault if the installation key is lost.")
                Toggle("Show recovery key", isOn: $showRecovery)
                if showRecovery { Text(model.recovery["key"].text).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                Text("Fingerprint: \(model.recovery["fingerprint"].text)").foregroundStyle(JosiTheme.lilac)
                Button("Save Recovery Key…") {
                    do {
                        if try NativeRecoveryFile.save(key: model.recovery["key"].text,
                            fingerprint: model.recovery["fingerprint"].text) { recoverySaved = true }
                    } catch { model.error = "The recovery key could not be saved. Choose another location." }
                }
                Toggle("I have saved my recovery key", isOn: $recoverySaved)
                Button("Continue") {
                    model.run { try await model.confirmRecovery(); showRecovery = false; recoverySaved = false }
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(!recoverySaved)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    /// This Mac's address on the local network, as a starting suggestion.
    private static var localAddress: String {
        Host.current().addresses.first { $0.contains(".") && !$0.hasPrefix("127.") && !$0.hasPrefix("169.254.") } ?? ""
    }
    private static func hostOnly(_ text: String) -> String {
        let host = text.trimmingCharacters(in: .whitespaces).lowercased().replacing(/^[a-z]+:\/\//, with: "")
        return String(host.prefix { $0 != "/" })
    }
    private func submitPlace() {
        if place == "mac" { submit(["domain": "localhost", "tlsMode": "bundled_caddy", "acmeEmail": ""]); return }
        let host = Self.hostOnly(values[place == "network" ? "lanAddress" : "publicDomain"] ?? (place == "network" ? Self.localAddress : ""))
        if place == "network" {
            guard !host.isEmpty else { model.error = "Enter this Mac’s address on your network."; return }
            submit(["domain": .string(host), "tlsMode": "bundled_caddy", "acmeEmail": ""]); return
        }
        guard host.contains("."), host.contains(where: \.isLetter) else { model.error = "Enter a domain name, like josi.yourname.com."; return }
        submit(["domain": .string(host), "tlsMode": value("tlsMode", fallback: "bundled_caddy"), "acmeEmail": value("acmeEmail")])
    }
    private func binding(_ key: String, fallback: String = "") -> Binding<String> {
        Binding(get: { values[key] ?? fallback }, set: { values[key] = $0 })
    }
    private func field(_ title: String, _ key: String, secret: Bool = false, fallback: String = "") -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(JosiFont.callout)
            if secret { SecureField(title, text: binding(key, fallback: fallback)).labelsHidden() }
            else { TextField(title, text: binding(key, fallback: fallback)).labelsHidden() }
        }
    }
    private func value(_ key: String, fallback: String = "") -> Wire { .string(values[key] ?? fallback) }
    private func next(_ body: Wire) -> some View { Button("Continue") { submit(body) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)) }
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
    private func clearFields() { values = [:]; enabled = false; externalAcknowledged = false; discovered = [] }
}
