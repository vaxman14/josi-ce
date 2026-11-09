import SwiftUI

/// The popup for a settings change Josi prepared. A sensitive one stays open
/// until the server accepts the password.
struct SettingsChangeSheet: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    let proposal: Wire
    @State private var password = ""
    @State private var problem = ""
    @State private var working = false
    private var administrator: Bool { proposal["scope"].text == "administrator" }
    private var sensitive: Bool { proposal["sensitive"].flag }
    /// A member asking the owner to allow a developer service.
    private var request: Bool { proposal["area"].text == "member_connector_request" }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) { JosiMarkTile(size: 28); Text(request ? "\(proposal["proposer"].text) asks to connect a service" : "Josi proposes a settings change").font(JosiFont.title3) }
            Text(proposal["title"].text).font(JosiFont.headline)
            Text(proposal["summary"].text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Text(request ? "Approving lets them connect it with their own token. You can take it back any time by asking Josi."
                 : ((administrator ? "An administrator setting for this installation." : "Your own setting.")
                 + (sensitive ? " This is a sensitive change; the administrator is told by email when a member makes one." : "")
                 + " Nothing changes until you approve. You can also find it under Approvals."))
                .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).fixedSize(horizontal: false, vertical: true)
            if sensitive {
                Text("Confirm your account password").font(JosiFont.callout)
                SecureField("Your account password", text: $password).labelsHidden().textFieldStyle(JosiFieldStyle()).onSubmit(approve)
            }
            if !problem.isEmpty { Text(problem).font(JosiFont.callout).foregroundStyle(JosiTheme.error) }
            HStack {
                Button("Decide Later") { dismiss() }.buttonStyle(JosiOutlineButtonStyle()).keyboardShortcut(.cancelAction)
                Spacer()
                Button("Decline") { decide(false) }.buttonStyle(JosiOutlineButtonStyle())
                Button(administrator ? "Approve and Apply" : "Approve", action: approve)
                    .buttonStyle(JosiGoldButtonStyle(fullWidth: false)).keyboardShortcut(.defaultAction)
            }.disabled(working)
        }.padding(24).frame(width: 520).background(JosiTheme.deep)
    }
    private func approve() {
        guard !sensitive || !password.isEmpty else { problem = "Enter your password to approve this."; return }
        decide(true)
    }
    private func decide(_ yes: Bool) {
        let secret = sensitive && yes ? password : nil
        password = ""; problem = ""; working = true
        Task {
            defer { working = false }
            do { try await model.decideSettingsChange(proposal, approve: yes, password: secret); dismiss() }
            catch { problem = error.localizedDescription }
        }
    }
}

/// The settings changes Josi prepared, on the Approvals page.
struct SettingsChangeList: View {
    @EnvironmentObject var model: JosiModel
    var changes: [Wire]
    var policy: Wire
    var reload: () async -> Void
    var body: some View {
        if !changes.isEmpty {
            NativeLeanTitle(text: "Settings changes, cards and requests")
            NativeLeanNote(text: "Asked for in conversation. Nothing changes until it is approved or filled in here or in the popup.")
            ForEach(changes, id: \.identifier) { change in
                JosiCard {
                    Text(change["title"].text).font(JosiFont.headline)
                    NativeLeanNote(text: change["summary"].text, color: JosiTheme.text)
                    if change["sensitive"].flag { Text("Sensitive").font(JosiFont.caption).foregroundStyle(JosiTheme.gold) }
                    if !change["canApprove"].flag, change["state"].text == "proposed" {
                        NativeLeanNote(text: change["scope"].text == "administrator" ? "Waiting for the super-admin." : "Waiting for the super-admin’s consent.")
                    }
                    HStack {
                        if change["canApprove"].flag {
                            Button(change["area"].text == "credential_card" ? "Fill In…" : "Review…") { model.settingsProposal = change }
                                .buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                        }
                        if change["canDeny"].flag {
                            Button("Decline") { model.run { try await model.decideSettingsChange(change, approve: false); await reload() } }
                                .buttonStyle(JosiOutlineButtonStyle())
                        }
                    }
                }
            }
        }
        if policy["superAdmin"].flag {
            JosiCard {
                Toggle("Settings changes by members wait for me before their Josi applies them", isOn: Binding(
                    get: { policy["policy"].text == "super_admin" },
                    set: { on in
                        model.run {
                            _ = try await model.api?.request("/settings-changes/policy", method: "PUT", body: ["memberSettingsChanges": .string(on ? "super_admin" : "self")])
                            await reload()
                        }
                    }))
                NativeLeanNote(text: "Off: each person approves changes to their own settings. On: every member change waits for your approval first.")
            }
        }
    }
}
