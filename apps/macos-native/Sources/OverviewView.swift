import SwiftUI

private enum NativeHealthState {
    case working, attention, unavailable, unconfigured
    var label: String {
        switch self {
        case .working: "Working"
        case .attention: "Needs attention"
        case .unavailable: "Unavailable"
        case .unconfigured: "Not configured"
        }
    }
    var color: Color {
        switch self {
        case .working: JosiTheme.success
        case .attention, .unavailable: JosiTheme.error
        case .unconfigured: JosiTheme.muted
        }
    }
}

private struct NativeHealthCheck: Identifiable {
    let label: String
    let state: NativeHealthState
    let detail: String
    var section = ""
    var id: String { label }
}

struct NativeOverviewView: View {
    @EnvironmentObject var model: JosiModel
    @State private var assistant: Wire = .null
    @State private var checklist: Wire = .null
    @State private var update: Wire = .null
    @State private var checks: [NativeHealthCheck] = []
    @State private var checkedAt: Date?
    @State private var loading = true
    @State private var checklistMissing = false
    @State private var error = ""
    @State private var actionError = ""
    @State private var generation = 0

    /// Where each step is done in this app. Server copy for the rest explains
    /// itself; the steps with no page here simply have no button.
    private let destinations = ["backup_taken": "backups", "model": "models", "smtp": "connections",
                                "users": "people", "connectors": "connections"]
    private var steps: [Wire] { checklist["items"].list.filter { ["outstanding", "failed"].contains($0["state"].text) } }
    private var putAside: [Wire] { checklist["items"].list.filter { $0["state"].text == "dismissed" } }
    private var problems: Int { checks.filter { $0.state == .attention || $0.state == .unavailable }.count }

    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                JosiHeading(title: "Overview", subtitle: "How this server is doing, and what still needs you.")
                Button(loading ? "Checking…" : "Check Again") { model.run { await load() } }
                    .buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy || loading)
            }
            NativeLeanStatus(loading: loading && checks.isEmpty, error: error)
            hero
            gettingStarted
            systemChecks
            NativeServerHealth()
        }
        .task { await markSeen(); await load() }
        .onDisappear { generation += 1 }
    }

    private var hero: some View {
        JosiCard {
            HStack(alignment: .firstTextBaseline) {
                Text(checks.isEmpty ? "Checking this server" : problems == 0 ? "No essential problems" : problems == 1 ? "1 thing needs attention" : "\(problems) things need attention")
                    .font(JosiFont.title2)
                Spacer()
                if !checks.isEmpty { JosiPill(text: problems == 0 ? "Healthy" : "Attention", color: problems == 0 ? JosiTheme.success : JosiTheme.error) }
            }
            HStack(spacing: 18) {
                stat("Conversations", assistant["counts"]["threads"])
                stat("Messages", assistant["counts"]["messages"])
                stat("Tasks", assistant["counts"]["tasks"])
                stat("Open", assistant["counts"]["openTasks"])
            }
            versionLine
            if let checkedAt {
                Text("Last checked " + checkedAt.formatted(date: .abbreviated, time: .shortened)).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
            }
        }
    }
    @ViewBuilder private var versionLine: some View {
        if !update["currentVersion"].text.isEmpty {
            HStack(spacing: 8) {
                Text("Version " + update["currentVersion"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                if update["updateAvailable"].flag, !update["availableVersion"].text.isEmpty {
                    JosiPill(text: "Version \(update["availableVersion"].text) available", color: JosiTheme.gold)
                }
            }
        }
    }
    private func stat(_ label: String, _ value: Wire) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
            Text(value == .null ? "-" : value.integer.formatted()).font(JosiFont.title2)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var gettingStarted: some View {
        if checklistMissing {
            EmptyView()
        } else if checklist != .null {
            NativeLeanTitle(text: "Getting started")
            if !actionError.isEmpty { NativeLeanNote(text: actionError, color: JosiTheme.error) }
            if steps.isEmpty {
                NativeLeanNote(text: "Everything on the list is settled.")
            } else {
                NativeLeanNote(text: "\(checklist["progress"]["done"].integer) of \(checklist["progress"]["total"].integer) settled. These are the things only you can do.")
                ForEach(steps, id: \.self["key"].text) { step($0) }
            }
            if !putAside.isEmpty {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(putAside, id: \.self["key"].text) { item in
                            HStack {
                                Text(item["label"].text).font(JosiFont.callout)
                                Spacer()
                                Button("Put Back") { act("/admin/launch-checklist/restore/\(item["key"].text)") }
                                    .buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
                            }
                        }
                    }.padding(.top, 6)
                } label: { Text("Put aside (\(putAside.count))").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac) }
            }
        }
    }
    private func step(_ item: Wire) -> some View {
        let key = item["key"].text, failed = item["state"].text == "failed"
        return JosiCard {
            HStack {
                Text(item["label"].text).font(JosiFont.headline)
                Spacer()
                JosiPill(text: failed ? "Not working" : "To do", color: failed ? JosiTheme.error : JosiTheme.gold)
            }
            NativeLeanNote(text: item["why"].text)
            if !item["detail"].text.isEmpty { NativeLeanNote(text: item["detail"].text, color: JosiTheme.muted) }
            // The server's note for email predates this app's mail settings.
            if item["href"] == .null, key != "smtp", !item["insteadOfScreen"].text.isEmpty {
                NativeLeanNote(text: item["insteadOfScreen"].text, color: JosiTheme.muted)
            }
            HStack {
                if key == "master_key_backup" {
                    Button("I Have Copied It Somewhere Safe") { act("/admin/launch-checklist/master-key-backed-up") }
                        .buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                    Button("Open Vault") { model.section = "vault" }.buttonStyle(JosiOutlineButtonStyle())
                } else if let section = destinations[key] {
                    Button("Do This") { model.section = section }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                }
                if item["dismissible"].flag, !failed {
                    Button("Skip") { act("/admin/launch-checklist/dismiss/\(key)") }.buttonStyle(JosiOutlineButtonStyle())
                }
            }.disabled(model.busy)
        }
    }
    @ViewBuilder private var systemChecks: some View {
        if !checks.isEmpty {
            NativeLeanTitle(text: "System checkup")
            JosiCard {
                ForEach(Array(checks.enumerated()), id: \.element.id) { index, check in
                    if index > 0 { Divider().overlay(JosiTheme.hairline) }
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(check.label).font(JosiFont.callout)
                            NativeLeanNote(text: check.detail, color: JosiTheme.muted)
                        }
                        Spacer(minLength: 8)
                        if check.state != .working, !check.section.isEmpty {
                            Button("Review") { model.section = check.section }.buttonStyle(JosiOutlineButtonStyle())
                        }
                        JosiPill(text: check.state.label, color: check.state.color)
                    }
                }
            }
        }
    }

    private func fetch(_ api: JosiAPI, _ route: String) async -> (value: Wire?, missing: Bool) {
        do { return (try await api.request(route), false) }
        catch { return (nil, nativeRouteMissing(error)) }
    }
    /// An older server without a route is not a fault, so it is not shown as one.
    private func older(_ check: NativeHealthCheck, missing: Bool) -> NativeHealthCheck {
        missing ? NativeHealthCheck(label: check.label, state: .unconfigured, detail: "This server does not report this yet.") : check
    }
    /// Marking the list seen is what stops sign-in sending the owner back to it.
    private func markSeen() async {
        guard model.isAdministrator, let api = model.api else { return }
        _ = try? await api.request("/admin/launch-checklist/seen", method: "POST", body: [:])
    }
    private func load() async {
        guard model.isAdministrator, let api = model.api else { loading = false; return }
        generation += 1
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        loading = true; error = ""
        defer { if generation == started { loading = false } }
        var missing = false
        var launch: Wire?
        do { launch = try await api.request("/admin/launch-checklist") }
        catch { missing = nativeRouteMissing(error) }
        let overview = await fetch(api, "/admin/assistant")
        let llm = await fetch(api, "/admin/llm")
        let backups = await fetch(api, "/ops/admin/backups")
        let vault = await fetch(api, "/admin/vault")
        let version = await fetch(api, "/admin/doctor/update")
        guard current() else { return }
        checklistMissing = missing
        if let launch { checklist = launch }
        assistant = overview.value ?? .null
        update = version.value ?? .null
        if overview.value == nil, !overview.missing { error = "The server or its database did not answer. Other checks may be incomplete." }
        checks = [
            older(databaseCheck(overview.value), missing: overview.missing), older(modelCheck(llm.value), missing: llm.missing),
            older(backupCheck(backups.value), missing: backups.missing), older(vaultCheck(vault.value), missing: vault.missing),
            older(setupCheck(launch), missing: missing),
        ]
        checkedAt = Date()
    }
    private func databaseCheck(_ value: Wire?) -> NativeHealthCheck {
        NativeHealthCheck(label: "Server and database", state: value == nil ? .unavailable : .working,
                          detail: value == nil ? "The core check failed." : "Josi can read this server's data.")
    }
    private func modelCheck(_ value: Wire?) -> NativeHealthCheck {
        guard let value else { return NativeHealthCheck(label: "AI model", state: .unavailable, detail: "Model status could not be read.", section: "models") }
        let primary = value["primary"]
        if primary == .null { return NativeHealthCheck(label: "AI model", state: .unconfigured, detail: "Choose and test a model before using Josi.", section: "models") }
        let ready = primary["active"].flag && !primary["probedAt"].text.isEmpty
        return NativeHealthCheck(label: "AI model", state: ready ? .working : .attention,
                                 detail: ready ? "The active model passed its test." : "The selected model still needs a successful test.", section: "models")
    }
    private func backupCheck(_ value: Wire?) -> NativeHealthCheck {
        guard let value else { return NativeHealthCheck(label: "Backups", state: .unavailable, detail: "Backup history could not be read.", section: "backups") }
        let complete = value["backups"].list.contains { $0["state"].text == "complete" }
        return NativeHealthCheck(label: "Backups", state: complete ? .working : .unconfigured,
                                 detail: complete ? "At least one backup completed." : "Backups are optional and none have been made.", section: "backups")
    }
    private func vaultCheck(_ value: Wire?) -> NativeHealthCheck {
        guard let value else { return NativeHealthCheck(label: "Master Vault", state: .unavailable, detail: "Vault health could not be read.", section: "vault") }
        let status = value["status"], failures = status["recentFailures"].integer
        if !status["initialized"].flag {
            return NativeHealthCheck(label: "Master Vault", state: .unconfigured, detail: "Set up the Master Vault and keep its recovery key offline.", section: "vault")
        }
        if status["locked"].flag {
            return NativeHealthCheck(label: "Master Vault", state: .attention, detail: "The Master Vault is locked, so credential jobs are stopped.", section: "vault")
        }
        return NativeHealthCheck(label: "Master Vault", state: failures > 0 ? .attention : .working,
                                 detail: failures > 0 ? "\(failures) credential jobs were blocked in the last 24 hours." : "The Master Vault is available.", section: "vault")
    }
    private func setupCheck(_ value: Wire?) -> NativeHealthCheck {
        guard let value else { return NativeHealthCheck(label: "Security and setup", state: .unavailable, detail: "Setup requirements could not be read.") }
        if value["complete"].flag { return NativeHealthCheck(label: "Security and setup", state: .working, detail: "The setup list is complete.") }
        return NativeHealthCheck(label: "Security and setup", state: value["reminders"].list.isEmpty ? .unconfigured : .attention,
                                 detail: "\(value["progress"]["done"].integer) of \(value["progress"]["total"].integer) setup items are settled.")
    }
    private func act(_ route: String) {
        guard let api = model.api else { return }
        let owner = model.user["id"]
        actionError = ""
        model.run {
            do {
                _ = try await api.request(route, method: "POST", body: [:])
                guard model.api === api, model.user["id"] == owner else { return }
            } catch {
                guard model.api === api else { return }
                actionError = error.localizedDescription
            }
            await load()
        }
    }
}
