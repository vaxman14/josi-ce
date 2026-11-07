import SwiftUI

private let personalLayers = [("soul", "Soul", "Who your assistant is to you."),
                              ("user", "About me", "What it should know about you."),
                              ("agents_user", "Working style", "How it should behave.")]

struct NativeSettingsView: View {
    @EnvironmentObject var model: JosiModel
    @AppStorage(JosiSkin.key) private var skin = JosiSkin.plumGold.rawValue

    var body: some View {
        NativeLeanPage {
            JosiHeading(title: "Settings", subtitle: "Your account, how Josi works with you, and how the app looks.")
            NativeAccountView()
            NativePasskeysView()
            NativeLeanTitle(text: "Personalization")
            NativePersonalizationSection()
            NativeMemoryView()
            NativeLeanTitle(text: "Usage")
            NativeUsageSection()
            NativeLeanTitle(text: "Appearance")
            JosiCard {
                Picker("Look", selection: $skin) {
                    ForEach(JosiSkin.allCases) { Text($0.label).tag($0.rawValue) }
                }.font(JosiFont.callout)
            }
        }
    }
}

/// One personal file: its text, what saving it actually did, and its history.
private struct NativeProfileEditor: View {
    @EnvironmentObject var model: JosiModel
    let kind: String
    let title: String
    let blurb: String
    let profile: Wire
    let presets: [Wire]
    let effective: Wire
    let narrowed: [Wire]
    let reload: @MainActor () async -> Void
    @State private var draft = ""
    @State private var versions: [Wire] = []
    @State private var ignored: [Wire] = []
    @State private var attempts: [Wire] = []
    @State private var notice = ""
    @State private var saved = false
    @State private var error = ""
    @State private var open = false

    var body: some View {
        JosiCard {
            DisclosureGroup(isExpanded: $open) {
                VStack(alignment: .leading, spacing: 12) {
                    explanation
                    TextEditor(text: $draft).font(JosiFont.body(13)).scrollContentBackground(.hidden).padding(8).frame(height: 200)
                        .background(JosiTheme.deep, in: RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).stroke(JosiTheme.border, lineWidth: 1))
                        .accessibilityLabel("Your " + title.lowercased() + " file")
                    if !error.isEmpty { NativeLeanNote(text: error, color: JosiTheme.error) }
                    HStack(spacing: 12) {
                        Button("Save") { save() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(model.busy)
                        if saved { JosiPill(text: "Saved") }
                        if profile["version"].integer > 0 {
                            Text("Version \(profile["version"].integer)").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                        }
                    }
                    if kind == "soul", !presets.isEmpty { presetRow }
                    results
                    if !versions.isEmpty { history }
                    if kind == "agents_user", case .object(let values) = effective, !values.isEmpty { inForce(values) }
                }.padding(.top, 10)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(JosiFont.headline)
                    Text(blurb).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                }
            }
        }
        .onAppear { draft = profile["content"].text; ignored = profile["ignored"].list }
        .onChange(of: profile["version"].integer) { _, _ in draft = profile["content"].text }
        .task(id: "\(kind) \(profile["version"].integer) \(open)") { await loadVersions() }
    }
    private var explanation: some View {
        HStack(alignment: .top, spacing: 18) {
            list("This can", profile["explanation"]["can"].list)
            list("This cannot", profile["explanation"]["cannot"].list)
        }
    }
    private func list(_ heading: String, _ lines: [Wire]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(heading).font(JosiFont.body(13, weight: .semibold))
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in NativeLeanNote(text: line.text, color: JosiTheme.muted) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var presetRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Start from a preset").font(JosiFont.body(13, weight: .semibold))
            HStack {
                ForEach(presets, id: \.self["key"].text) { preset in
                    Button(preset["name"].text) { draft = preset["content"].text }
                        .buttonStyle(JosiOutlineButtonStyle()).help(preset["describes"].text)
                }
            }
            NativeLeanNote(text: "A preset fills in the file above. Edit it afterwards, or write your own.", color: JosiTheme.muted)
        }
    }
    @ViewBuilder private var results: some View {
        if !notice.isEmpty { NativeLeanNote(text: notice, color: JosiTheme.gold) }
        if !attempts.isEmpty {
            Text("Lines that read like instructions").font(JosiFont.body(13, weight: .semibold))
            ForEach(Array(attempts.enumerated()), id: \.offset) { _, item in
                NativeLeanNote(text: "\"\(item["phrase"].text)\" was kept as personality and changed nothing.", color: JosiTheme.muted)
            }
        }
        if !ignored.isEmpty {
            Text("Lines that did nothing").font(JosiFont.body(13, weight: .semibold))
            ForEach(Array(ignored.enumerated()), id: \.offset) { _, item in
                NativeLeanNote(text: item["field"].text + ": " + item["explanation"].text, color: JosiTheme.muted)
            }
        }
    }
    private var history: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Earlier versions").font(JosiFont.body(13, weight: .semibold))
            ForEach(versions.prefix(8), id: \.self["version"].integer) { version in
                HStack {
                    Text("Version \(version["version"].integer) · \(nativeDate(version["created_at"].text))")
                        .font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    Spacer()
                    Button("Restore") { restore(version["version"].integer) }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
                }
            }
        }
    }
    private func inForce(_ values: [String: Wire]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("What is actually in force").font(JosiFont.body(13, weight: .semibold))
            NativeLeanNote(text: "Your choices, after your administrator's policy is applied.", color: JosiTheme.muted)
            ForEach(values.keys.sorted(), id: \.self) { key in
                let required = narrowed.contains { $0.text == key }
                NativeLeanNote(text: key + ": " + plain(values[key] ?? .null) + (required ? " (your administrator requires this)" : ""),
                               color: required ? JosiTheme.gold : JosiTheme.lilac)
            }
        }
    }
    private func plain(_ value: Wire) -> String {
        switch value {
        case .string(let text): return text
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return number.formatted()
        default: return ""
        }
    }
    private func loadVersions() async {
        guard open, let api = model.api else { return }
        let result = try? await api.request("/persona/profiles/\(kind)/versions")
        guard !Task.isCancelled, model.api === api else { return }
        versions = result?["versions"].list ?? []
    }
    private func save() {
        guard let api = model.api else { return }
        let owner = model.user["id"], content = draft
        error = ""; saved = false; notice = ""
        model.run {
            do {
                let result = try await api.request("/persona/profiles/\(kind)", method: "PUT", body: ["content": .string(content)])
                guard model.api === api, model.user["id"] == owner else { return }
                ignored = result["ignored"].list; attempts = result["authorityAttempts"].list
                notice = result["notice"].text; saved = true
                await reload()
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
        }
    }
    private func restore(_ version: Int) {
        guard let api = model.api,
              nativeConfirm("Restore version \(version)?", detail: "Your conversations and memories are not touched.", button: "Restore") else { return }
        let owner = model.user["id"]
        error = ""; saved = false
        model.run {
            do {
                _ = try await api.request("/persona/profiles/\(kind)/reset", method: "POST", body: ["toVersion": .number(Double(version))])
                guard model.api === api, model.user["id"] == owner else { return }
                await reload()
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
        }
    }
}

private struct NativePersonalizationSection: View {
    @EnvironmentObject var model: JosiModel
    @State private var boundary = ""
    @State private var profiles: Wire = .null
    @State private var effective: Wire = .null
    @State private var narrowed: [Wire] = []
    @State private var presets: [Wire] = []
    @State private var onboarding: Wire = .null
    @State private var preview = ""
    @State private var previewFailure = ""
    @State private var previewing = false
    @State private var unavailable = false
    @State private var error = ""
    @State private var generation = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !boundary.isEmpty { NativeLeanNote(text: boundary) }
            NativeLeanStatus(loading: profiles == .null && error.isEmpty && !unavailable, error: error)
            if unavailable {
                NativeLeanNote(text: "This server does not offer personalization yet. Update the server to use it.")
            } else if profiles != .null {
                if onboarding["needed"].flag { onboardingCard }
                ForEach(personalLayers, id: \.0) { kind, title, blurb in
                    NativeProfileEditor(kind: kind, title: title, blurb: blurb, profile: profiles[kind], presets: presets,
                                        effective: effective, narrowed: narrowed) { await load() }
                }
                previewCard
            }
        }
        .task { await load() }
        .onDisappear { generation += 1 }
    }
    private var onboardingCard: some View {
        JosiCard {
            Text("Set up your assistant").font(JosiFont.headline)
            if !onboarding["note"].text.isEmpty { NativeLeanNote(text: onboarding["note"].text) }
            ForEach(presets, id: \.self["key"].text) { preset in
                Button { finishOnboarding(skip: false, preset: preset["key"].text) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(preset["name"].text)
                        Text(preset["describes"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(JosiOutlineButtonStyle(fullWidth: true))
            }
            Button("Skip and Use the Default") { finishOnboarding(skip: true, preset: nil) }.buttonStyle(JosiOutlineButtonStyle())
        }.disabled(model.busy)
    }
    private var previewCard: some View {
        JosiCard {
            Button(previewing ? "Asking…" : "Hear How It Sounds") { runPreview() }
                .buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy || previewing)
            if !preview.isEmpty {
                Text("Josi would say:").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                Text(preview).font(JosiFont.body()).textSelection(.enabled)
            }
            if !previewFailure.isEmpty { NativeLeanNote(text: previewFailure) }
        }
    }
    private func load() async {
        guard let api = model.api else { return }
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        do {
            let result = try await api.request("/persona/profiles")
            guard current() else { return }
            profiles = result["profiles"]; effective = result["effectivePolicy"]
            narrowed = result["narrowedByPolicy"].list; error = ""; unavailable = false
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { unavailable = true }
            else { self.error = "Your personalization could not be loaded. Reopen this page to try again." }
            return
        }
        let schema = try? await api.request("/persona/schema")
        let choices = try? await api.request("/persona/presets")
        let firstRun = try? await api.request("/persona/onboarding")
        guard current() else { return }
        boundary = schema?["boundary"].text ?? ""
        presets = choices?["presets"].list ?? []
        onboarding = firstRun ?? .null
    }
    private func finishOnboarding(skip: Bool, preset: String?) {
        guard let api = model.api else { return }
        var fields: [String: Wire] = ["skip": .bool(skip)]
        if let preset { fields["preset"] = .string(preset) }
        let body = Wire.object(fields)
        model.run {
            do { _ = try await api.request("/persona/onboarding", method: "POST", body: body) }
            catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription; return
            }
            guard model.api === api else { return }
            onboarding = .null
            await load()
        }
    }
    private func runPreview() {
        guard let api = model.api else { return }
        previewing = true; preview = ""; previewFailure = ""
        model.run {
            defer { previewing = false }
            do {
                let result = try await api.request("/persona/preview/live", method: "POST", body: [:])
                guard model.api === api else { return }
                if result["available"].flag { preview = result["reply"].text }
                else { previewFailure = result["reason"].text }
            } catch {
                guard model.api === api else { return }
                // This route explains itself in a field api.request does not read.
                previewFailure = (error as? JosiError)?.status == 503
                    ? "A preview needs a model that is set up and has passed its test." : error.localizedDescription
            }
        }
    }
}

private struct NativeUsageSection: View {
    @EnvironmentObject var model: JosiModel
    @State private var status: Wire = .null
    @State private var unavailable = false
    @State private var error = ""
    @State private var generation = 0
    private var usage: Wire { status["usage"] }
    private var cap: Wire { status["cap"] }
    private var capColor: Color {
        !cap["allowed"].flag ? JosiTheme.error : cap["status"].text == "ok" ? JosiTheme.success : JosiTheme.gold
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            NativeLeanStatus(loading: status == .null && error.isEmpty && !unavailable, error: error)
            if unavailable {
                NativeLeanNote(text: "This server does not report usage yet. Update the server to see it.")
            } else if status != .null {
                NativeLeanNote(text: "Your own usage this month (\(usage["month"].text)).")
                HStack(alignment: .top, spacing: 12) {
                    tile("Tokens", amount(usage["totalTokens"]).formatted(.number.precision(.fractionLength(0))),
                         usage["calls"].integer == 1 ? "1 request" : "\(usage["calls"].integer) requests")
                    tile("Provider charges", dollars(usage["reportedCostUsd"]), "As reported by the provider")
                    tile("Estimated", dollars(usage["estimatedCostUsd"]), "Worked out locally, not a bill")
                }
                if usage["selfHostedCalls"].integer > 0 {
                    NativeLeanNote(text: "\(usage["selfHostedCalls"].integer) of these went to a model on your own hardware, with no provider charge. Hardware and electricity are not counted here.")
                }
                JosiCard {
                    HStack {
                        Text("Budget").font(JosiFont.headline)
                        Spacer()
                        JosiPill(text: cap["status"].text.replacingOccurrences(of: "_", with: " ").capitalized, color: capColor)
                    }
                    NativeLeanNote(text: cap["message"].text)
                }
                ForEach(Array(usage["notes"].list.enumerated()), id: \.offset) { _, line in NativeLeanNote(text: line.text, color: JosiTheme.muted) }
            }
        }
        .task {
            guard let api = model.api else { return }
            let owner = model.user["id"], started = generation
            do {
                let result = try await api.request("/llm/status")
                guard !Task.isCancelled, generation == started, model.api === api, model.user["id"] == owner else { return }
                status = result
            } catch {
                guard !Task.isCancelled, generation == started, model.api === api else { return }
                if nativeRouteMissing(error) { unavailable = true } else { self.error = error.localizedDescription }
            }
        }
        .onDisappear { generation += 1 }
    }
    private func tile(_ label: String, _ value: String, _ detail: String) -> some View {
        JosiCard {
            Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
            Text(value).font(JosiFont.title2)
            Text(detail).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
        }
    }
    private func amount(_ value: Wire) -> Double { if case .number(let number) = value { return number }; return 0 }
    private func dollars(_ value: Wire) -> String { "$" + amount(value).formatted(.number.precision(.fractionLength(2))) }
}

/// Passkeys for this account. Adding one happens on the server's own page.
struct NativePasskeysView: View {
    @EnvironmentObject var model: JosiModel
    @State private var keys: [Wire] = []
    @State private var available = false
    @State private var password = ""
    @State private var note = ""
    var body: some View {
        JosiCard {
            Text("Passkeys").font(JosiFont.title3)
            Text("Sign in with Touch ID or a security key instead of your password. No code needed.").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            ForEach(keys, id: \.identifier) { key in
                HStack { Image(systemName: "key"); Text(key["name"].text.isEmpty ? "Passkey" : key["name"].text); Spacer() }.font(JosiFont.callout)
            }
            if available {
                SecureField("Your password", text: $password).textContentType(.password).textFieldStyle(JosiFieldStyle())
                Button("Add a Passkey") { add() }.disabled(password.isEmpty || model.busy)
            } else {
                Text("Passkeys need this server’s address to be HTTPS on a name, or localhost.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
            }
            if !note.isEmpty { Text(note).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac) }
        }.padding(.horizontal, 30).task { await load() }
    }
    private func load() async {
        guard let api = model.api, let value = try? await api.request("/auth/passkeys"), model.api === api else { return }
        available = value["available"].flag; keys = value["passkeys"].list
    }
    private func add() {
        guard let api = model.api else { return }
        let secret = password, state = UUID().uuidString.lowercased(), before = keys.count
        password = ""; note = ""
        model.run {
            let ticket = try await api.request("/auth/passkey/native/enrol", method: "POST", body: [
                "password": .string(secret), "name": .string(Host.current().localizedName ?? "This Mac"), "state": .string(state)])
            guard let url = URL(string: ticket["url"].text) else { throw JosiError(message: "The server didn’t return a passkey page.") }
            try await NativeSignIn.addPasskey(start: url, state: state)
            await load()
            note = keys.count > before ? "Passkey added." : "The server didn’t confirm the new passkey. Try again."
        }
    }
}
