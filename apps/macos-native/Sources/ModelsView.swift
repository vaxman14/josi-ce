import AppKit
import SwiftUI

struct NativeModelsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var settings: Wire = .null
    @State private var usage: Wire = .null
    @State private var editing: String?
    @State private var cost = ""
    @State private var tokens = ""
    @State private var localOnly = false
    @State private var note = ""
    @State private var loading = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("Models").font(.largeTitle.bold())
                    Spacer()
                    Button("Refresh") { model.run { try await load() } }.disabled(model.busy)
                }
                Text("Configure the models used by this Josi server. Saving a model requires a separate capability check before it becomes active.")
                    .foregroundStyle(.secondary)
                if settings == .null {
                    Text("Current model settings are unavailable. Refresh to load them.")
                } else {
                    provider("primary", title: "Primary model")
                    provider("fallback", title: "Fallback model")
                    GroupBox("Local-only mode") {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle("Only use models running locally", isOn: $localOnly)
                            Text("External providers must be removed or replaced before enabling this setting. Turning it off does not configure or activate an external provider.")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Save Local-Only Setting") {
                                let value = localOnly
                                request("/admin/llm/local-only", method: "PUT", body: ["enabled": .bool(value)])
                            }.disabled(localOnly == settings["localOnly"].flag)
                        }.padding(10)
                    }
                    GroupBox("Monthly installation limits") {
                        VStack(alignment: .leading, spacing: 12) {
                            TextField("Spend cap (USD; blank for no cap)", text: $cost)
                            TextField("Token cap (blank for no cap)", text: $tokens)
                            Text("Use positive limits. Blank explicitly removes a cap. Usage separates provider-reported costs, estimates and subscription calls.")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Save Limits") {
                                do {
                                    let body: Wire = ["monthlyCostUsd": try cap(cost, whole: false),
                                                      "monthlyTokens": try cap(tokens, whole: true)]
                                    request("/admin/llm/caps", method: "PUT", body: body)
                                } catch { model.error = error.localizedDescription }
                            }
                        }.padding(10)
                    }
                    if usage != .null {
                        GroupBox("This month") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("\(usage["summary"]["totalTokens"].integer) tokens · \(usage["summary"]["calls"].integer) calls")
                                Text("Reported: \(amount(usage["summary"]["reportedCostUsd"])) USD · Estimated: \(amount(usage["summary"]["estimatedCostUsd"])) USD")
                                Text("\(usage["summary"]["subscriptionCalls"].integer) subscription calls · \(usage["summary"]["selfHostedCalls"].integer) local calls")
                                ForEach(Array(usage["summary"]["notes"].list.enumerated()), id: \.offset) { _, item in
                                    Text(item.text).font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    ForEach(Array(settings["disabledFeatures"].list.enumerated()), id: \.offset) { _, feature in
                        Text(feature["feature"].text + ": " + feature["reason"].text).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !note.isEmpty { Text(note).foregroundStyle(.secondary) }
            }.padding(30).textFieldStyle(.roundedBorder).disabled(model.busy || loading)
        }
        .task { do { try await load() } catch { model.error = error.localizedDescription } }
        .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            if let role = editing, let api = model.api {
                NativeModelEditor(role: role, initial: settings[role], catalog: settings["providerCatalog"].list,
                                  origin: api.origin.absoluteString, administrator: model.user["id"].text) {
                    editing = nil
                    try await load()
                }.environmentObject(model)
            }
        }
    }
    @ViewBuilder private func provider(_ role: String, title: String) -> some View {
        let saved = settings[role]
        GroupBox(title) {
            VStack(alignment: .leading, spacing: 12) {
                if saved == .null { Text("Not configured") }
                else {
                    Text(settings["providerCatalog"].list.first { $0["kind"] == saved["provider"] }?["label"].text ?? saved["provider"].text).font(.headline)
                    Text(saved["model"].text.isEmpty ? "Provider default model" : saved["model"].text)
                    Text(saved["active"].flag ? "Active · Checked " + nativeDate(saved["probedAt"].text) : "Inactive · Run a capability check before use")
                        .foregroundStyle(saved["active"].flag ? Color.secondary : Color.orange)
                    ForEach(Array(saved["probeSteps"].list.enumerated()), id: \.offset) { _, step in
                        Label(step["label"].text + ": " + step["detail"].text,
                              systemImage: step["passed"].flag ? "checkmark.circle" : "exclamationmark.circle").font(.caption)
                    }
                }
                HStack {
                    Button(saved == .null ? "Configure…" : "Change…") { editing = role }
                    if saved != .null {
                        Button("Check Capabilities…") {
                            let alert = NSAlert()
                            alert.messageText = "Check this model’s capabilities?"
                            alert.informativeText = "This sends small test requests to the configured provider and uses its API billing or subscription quota. A successful check activates this saved model."
                            alert.addButton(withTitle: "Run Check"); alert.addButton(withTitle: "Cancel")
                            if alert.runModal() == .alertFirstButtonReturn {
                                request("/admin/llm/providers/\(role)/probe", method: "POST", body: [:])
                            }
                        }
                        if role == "fallback" {
                            Button("Remove Fallback…") {
                                let alert = NSAlert(); alert.messageText = "Remove the fallback model?"
                                alert.informativeText = "Josi will use its primary model without this fallback."
                                alert.addButton(withTitle: "Remove"); alert.addButton(withTitle: "Cancel")
                                if alert.runModal() == .alertFirstButtonReturn {
                                    request("/admin/llm/providers/fallback", method: "DELETE", body: nil)
                                }
                            }
                        }
                    }
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func load() async throws {
        guard model.isAdministrator, let api = model.api, !loading else { return }
        loading = true; defer { loading = false }
        let user = model.user["id"]
        let next = try await api.request("/admin/llm")
        guard model.api === api, model.user["id"] == user else { return }
        settings = next; localOnly = next["localOnly"].flag
        cost = amount(next["caps"]["monthly_cost_usd"]); tokens = amount(next["caps"]["monthly_tokens"])
        let counts = try await api.request("/admin/llm/usage")
        guard model.api === api, model.user["id"] == user else { return }
        usage = counts
    }
    private func request(_ path: String, method: String, body: Wire?) {
        guard let api = model.api, model.isAdministrator else { return }
        let user = model.user["id"]
        model.run {
            _ = try await api.request(path, method: method, body: body)
            guard model.api === api, model.user["id"] == user else { return }
            note = "Server settings updated."
            try await load()
        }
    }
    private func amount(_ value: Wire) -> String {
        if case .number(let n) = value { return String(format: "%.6f", n).replacingOccurrences(of: "\\.?0+$", with: "", options: .regularExpression) }
        return value.text
    }
    private func cap(_ value: String, whole: Bool) throws -> Wire {
        if value.trimmingCharacters(in: .whitespaces).isEmpty { return .null }
        guard let n = Double(value), n.isFinite, n > 0, n <= 9_007_199_254_740_991, !whole || n.rounded() == n else {
            throw JosiError(message: "Use positive limits, whole numbers for tokens, or leave a field blank for no cap.")
        }
        return .number(n)
    }
}

private struct NativeModelEditor: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    let role: String
    let initial: Wire
    let catalog: [Wire]
    let origin: String
    let administrator: String
    let onSaved: @MainActor () async throws -> Void
    @State private var selected = ""
    @State private var values: [String: String] = [:]
    @State private var external = false
    @State private var discovered: [Wire] = []
    @State private var discoveryNote = ""
    @State private var loaded = false
    private var entry: Wire { catalog.first { $0["kind"].text == selected } ?? .null }
    private var current: Bool {
        model.isAdministrator && model.api?.origin.absoluteString == origin && model.user["id"].text == administrator
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(role == "primary" ? "Primary Model" : "Fallback Model").font(.title2.bold())
                Spacer()
                Button("Close") { clearSecrets(); dismiss() }.disabled(model.busy)
            }.padding()
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Picker("Provider", selection: $selected) {
                        Text("Choose a provider").tag("")
                        ForEach(Array(catalog.enumerated()), id: \.offset) { _, item in
                            Text(item["label"].text).tag(item["kind"].text)
                        }
                    }.onChange(of: selected) { _, next in reset(next) }
                    if entry != .null {
                        ForEach(Array(entry["fields"].list.enumerated()), id: \.offset) { _, field in
                            if field["secret"].flag { SecureField(field["label"].text, text: binding(field["key"].text)) }
                            else { TextField(field["label"].text, text: binding(field["key"].text)) }
                            if !field["help"].text.isEmpty { Text(field["help"].text).font(.caption).foregroundStyle(.secondary) }
                        }
                        if initial["provider"].text == selected && initial["apiKeySet"].flag {
                            Text("A credential is already stored in the Vault. Leave secret fields blank to retain it, or enter replacements.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if entry["baseUrlMode"].text != "none" { TextField("Endpoint", text: binding("baseUrl")) }
                        if selected.hasSuffix("_subscription") {
                            NativeSubscriptionControls(provider: selected, prefix: "/admin/llm/subscription").id(selected)
                        }
                        Button("Find Available Models") { discover() }
                        if !discovered.isEmpty {
                            Picker("Available models", selection: binding("model")) {
                                Text("Choose a model").tag("")
                                if let saved = values["model"], !saved.isEmpty, !discovered.contains(where: { $0["id"].text == saved }) {
                                    Text(saved).tag(saved)
                                }
                                ForEach(Array(discovered.enumerated()), id: \.offset) { _, item in
                                    Text(item["label"].text.isEmpty ? item["id"].text : item["label"].text).tag(item["id"].text)
                                }
                            }
                        }
                        if !discoveryNote.isEmpty { Text(discoveryNote).font(.caption).foregroundStyle(.secondary) }
                        TextField(selected.hasSuffix("_subscription") ? "Model (blank uses subscription default)" : "Model", text: binding("model"))
                        if entry["external"].flag {
                            Toggle("Allow required task content to be sent to this provider", isOn: $external)
                        }
                        Text("Saving deactivates this slot until you explicitly check its capabilities. Existing credentials are never displayed.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Save Model") { save() }.buttonStyle(.borderedProminent)
                            .disabled(!current || entry["external"].flag && !external || !selected.hasSuffix("_subscription") && (values["model"] ?? "").isEmpty)
                    }
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
                }.padding(22).textFieldStyle(.roundedBorder).disabled(model.busy || !current)
            }
        }.frame(width: 680, height: 700).interactiveDismissDisabled(model.busy)
        .onAppear {
            if !loaded { loaded = true; selected = initial["provider"].text; reset(selected) }
        }
        .onDisappear { clearSecrets() }
    }
    private func reset(_ provider: String) {
        values = [:]; discovered = []; discoveryNote = ""; external = false
        let item = catalog.first { $0["kind"].text == provider } ?? .null
        values["baseUrl"] = item["defaultBaseUrl"].text
        if provider == initial["provider"].text {
            values["model"] = initial["model"].text; values["baseUrl"] = initial["baseUrl"].text
            external = initial["externalAcknowledged"].flag
            for field in item["fields"].list where !field["secret"].flag {
                values[field["key"].text] = initial["providerConfig"][field["key"].text].text
            }
        }
    }
    private func binding(_ key: String) -> Binding<String> { Binding(get: { values[key] ?? "" }, set: { values[key] = $0 }) }
    private func clearSecrets() {
        for field in entry["fields"].list where field["secret"].flag { values[field["key"].text] = "" }
    }
    private func bodyFields() -> Wire {
        var fields: [String: Wire] = ["provider": .string(selected), "baseUrl": .string(values["baseUrl"] ?? ""),
            "model": .string(values["model"] ?? ""), "externalAcknowledged": .bool(external)]
        for field in entry["fields"].list { fields[field["key"].text] = .string(values[field["key"].text] ?? "") }
        return .object(fields)
    }
    private func discover() {
        guard current, let api = model.api else { return }
        let request = bodyFields(), provider = selected
        model.run {
            let result = try await api.request("/admin/llm/models", method: "POST", body: request)
            guard current, model.api === api, selected == provider else { return }
            discovered = result["models"].list
            discoveryNote = result["fromCatalog"].flag ? "Josi’s model catalog; the provider did not supply this list." : result["message"].text
        }
    }
    private func save() {
        guard current, let api = model.api else { return }
        let request = bodyFields(); clearSecrets()
        model.run {
            let latest = try await api.request("/admin/llm")
            guard current, model.api === api, latest[role] == initial else {
                throw JosiError(message: "The model settings changed. Close this editor and review the current configuration.")
            }
            _ = try await api.request("/admin/llm/providers/\(role)", method: "PUT", body: request)
            guard current, model.api === api else { return }
            try await onSaved()
        }
    }
}

/// Provider-owned sign-in, shared by setup and administrator settings.
/// Codes stay in view memory; no credential or URL is written to preferences.
struct NativeSubscriptionControls: View {
    @EnvironmentObject var model: JosiModel
    let provider: String
    let prefix: String
    @State private var login: Wire = .null
    @State private var status: Wire = .null
    @State private var code = ""
    @State private var generation = 0
    private var base: String { prefix + (provider == "anthropic_subscription" ? "/claude" : "") }
    private var supported: Bool { ["openai_subscription", "anthropic_subscription"].contains(provider) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in on the connected Josi server using your provider’s subscription. This is separate from an API key.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Start Sign-In") { action("/login", method: "POST", body: [:]) }
                Button("Check Status") { action("/status") }
                Button("Cancel Sign-In") { action("/login/cancel", method: "POST", body: [:]) }
            }
            if status != .null { Text(status["signedIn"].flag ? "Subscription login available" : "Subscription not signed in").font(.headline) }
            if !status["detail"].text.isEmpty {
                Text(status["detail"].text).font(.caption).foregroundStyle(.secondary)
            }
            if !login["challenge"]["userCode"].text.isEmpty {
                Text("One-time code: " + login["challenge"]["userCode"].text).font(.headline).textSelection(.enabled)
            }
            if let url = signInURL {
                Button("Open Provider Sign-In Page") { NSWorkspace.shared.open(url) }
                Text(url.host ?? "").font(.caption).foregroundStyle(.secondary)
            }
            if provider == "anthropic_subscription", login["challenge"] != .null {
                SecureField("Paste the one-time code from the provider", text: $code)
                Button("Submit Sign-In Code") {
                    let value = code; code = ""
                    action("/login/code", method: "POST", body: ["code": .string(value)])
                }.disabled(code.isEmpty || code.utf8.count > 512)
            }
            if !login["state"].text.isEmpty { Text(login["state"].text.replacingOccurrences(of: "_", with: " ")).font(.caption) }
            if !login["message"].text.isEmpty { Text(login["message"].text).font(.caption).foregroundStyle(.secondary) }
            if prefix == "/admin/llm/subscription" && status["signedIn"].flag {
                Button("Sign Out of This Subscription…") {
                    let alert = NSAlert(); alert.messageText = "Sign out of the server’s subscription?"
                    alert.informativeText = "Josi will need a new provider sign-in before this subscription can answer tasks."
                    alert.addButton(withTitle: "Sign Out"); alert.addButton(withTitle: "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn { action("/logout", method: "POST", body: [:]) }
                }
            }
            if provider == "openai_subscription", status["credential"]["state"].text == "leased",
               status["credential"]["expiredLease"].flag || login["state"].text == "failed" {
                Button("Clear Interrupted Sign-In…") {
                    let alert = NSAlert(); alert.messageText = "Clear the interrupted subscription sign-in?"
                    alert.informativeText = "The server must confirm that this sign-in has stopped and its temporary files are removed. If it can, you can sign in again. This does not restart any task."
                    alert.addButton(withTitle: "Clear Sign-In"); alert.addButton(withTitle: "Cancel")
                    if alert.runModal() == .alertFirstButtonReturn { action("/reconcile", method: "POST", body: [:]) }
                }
            }
        }.disabled(model.busy || !supported)
        .task(id: String(generation) + ":" + login["state"].text) {
            let own = generation
            while ["starting", "awaiting_approval", "awaiting_code", "verifying"].contains(login["state"].text) && !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(3))
                    guard !model.busy, let api = model.api else { continue }
                    let user = model.user["id"], result = try await api.request(base + "/login")
                    guard !Task.isCancelled, generation == own, model.api === api, model.user["id"] == user else { return }
                    login = result
                } catch {
                    if !Task.isCancelled { model.error = "Subscription status could not be refreshed. Use Check Status or start sign-in again." }
                    return
                }
            }
        }
        .onDisappear { generation += 1; code = ""; login = .null; status = .null }
    }
    private var signInURL: URL? {
        guard let url = URL(string: login["challenge"]["verificationUrl"].text), url.scheme == "https",
              url.user == nil, url.password == nil, url.port == nil, let host = url.host?.lowercased() else { return nil }
        let domains = provider == "anthropic_subscription" ? ["claude.ai", "claude.com", "anthropic.com"] : ["openai.com"]
        return domains.contains(where: { host == $0 || host.hasSuffix("." + $0) }) ? url : nil
    }
    private func action(_ route: String, method: String = "GET", body: Wire? = nil) {
        guard supported, let api = model.api else { return }
        if method != "GET" { generation += 1 }
        let user = model.user["id"], own = generation
        let expected = status["credential"] == .null ? Wire.null : Wire.object([
            "itemId": status["credential"]["itemId"], "revision": status["credential"]["revision"]
        ])
        model.run {
            let path = route == "/status" && prefix == "/setup/subscription" && provider == "openai_subscription" ? base : base + route
            var submitted = body
            if provider == "openai_subscription", method == "POST", ["/login", "/logout", "/reconcile"].contains(route), expected != .null {
                submitted = ["expected": expected]
            }
            let result = try await api.request(path, method: method, body: submitted)
            guard model.api === api, model.user["id"] == user, generation == own else { return }
            if route == "/status" { status = result["cli"] }
            else if route == "/logout" || route == "/login/cancel" || route == "/reconcile" { login = .null; status = .null; code = "" }
            else { login = result; status = .null }
        }
    }
}
