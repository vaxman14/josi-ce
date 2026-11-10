import AppKit
import SwiftUI

/// A credential card Josi opened in conversation: the fields the server's
/// catalogue names, secure where the value is a secret. Save performs the route
/// with this person's own session; the typed values go nowhere else, and the
/// conversation learns only that it was saved.
struct CredentialCardSheet: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    let proposal: Wire
    @State private var texts: [String: String] = [:]
    @State private var secrets: [String: String] = [:]
    @State private var shown: Set<String> = []
    @State private var confirmed: Set<String> = []
    @State private var problem = ""
    @State private var working = false
    private var card: Wire { proposal["card"] }
    private var fields: [Wire] { card["fields"].list }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                JosiMarkTile(size: 28)
                Text(card["title"].text.isEmpty ? proposal["title"].text : card["title"].text).font(JosiFont.title3)
            }
            if !card["intro"].text.isEmpty {
                Text(card["intro"].text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if card["kind"].text == "account_connection" {
                let name = ["google": "Google", "microsoft": "Microsoft", "dropbox": "Dropbox", "box": "Box"][card["provider"].text] ?? card["provider"].text
                Button("Sign in with \(name)") { signIn() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(working)
                NativeLeanNote(text: "Your browser opens \(name)'s own sign-in page. Josi never sees your password. Come back here when it says you're done.")
            } else if fields.isEmpty {
                Text("This card has nothing to fill in. Ask Josi to open it again.").foregroundStyle(JosiTheme.error)
            }
            ForEach(fields, id: \.self["key"].text) { field in fieldView(field) }
            if !card["help"]["text"].text.isEmpty || helpURL != nil {
                VStack(alignment: .leading, spacing: 4) {
                    if !card["help"]["text"].text.isEmpty {
                        Text(card["help"]["text"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let helpURL, let host = helpURL.host {
                        Button("Open \(host)") { NSWorkspace.shared.open(helpURL) }.buttonStyle(.link).font(JosiFont.caption)
                    }
                }
            }
            if !problem.isEmpty { Text(problem).font(JosiFont.callout).foregroundStyle(JosiTheme.error).fixedSize(horizontal: false, vertical: true) }
            Text("What you paste goes to this Josi’s Vault only. Josi never sees it, and it never appears in the conversation.")
                .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Decline") { decline() }.buttonStyle(JosiOutlineButtonStyle())
                Spacer()
                Button("Not Now") { clear(); dismiss() }.buttonStyle(JosiOutlineButtonStyle()).keyboardShortcut(.cancelAction)
                if card["kind"].text != "account_connection" {
                    Button("Save", action: save).buttonStyle(JosiGoldButtonStyle(fullWidth: false)).keyboardShortcut(.defaultAction)
                        .disabled(fields.isEmpty)
                }
            }.disabled(working)
        }
        .padding(24).frame(width: 560).background(JosiTheme.deep)
        .onDisappear { clear() }
    }
    private var helpURL: URL? {
        guard let url = URL(string: card["help"]["url"].text), url.scheme == "https" else { return nil }
        return url
    }
    private func label(_ field: Wire) -> String { field["label"].text + (field["required"].flag ? "" : " (optional)") }
    @ViewBuilder private func fieldView(_ field: Wire) -> some View {
        let key = field["key"].text
        switch field["type"].text {
        case "confirm":
            Toggle(field["label"].text, isOn: Binding(get: { confirmed.contains(key) },
                                                     set: { on in if on { confirmed.insert(key) } else { confirmed.remove(key) } }))
                .toggleStyle(.checkbox)
        case "secret":
            VStack(alignment: .leading, spacing: 5) {
                Text(label(field)).font(JosiFont.callout)
                HStack(spacing: 8) {
                    let value = Binding(get: { secrets[key] ?? "" }, set: { secrets[key] = $0 })
                    Group {
                        if shown.contains(key) { TextField("", text: value) } else { SecureField("", text: value) }
                    }
                    .labelsHidden().textFieldStyle(JosiFieldStyle()).onSubmit(save)
                    .accessibilityLabel(field["label"].text)
                    Button("Paste") {
                        if let pasted = NSPasteboard.general.string(forType: .string) {
                            secrets[key] = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    }.buttonStyle(JosiOutlineButtonStyle())
                    Button(shown.contains(key) ? "Hide" : "Show") {
                        if shown.contains(key) { shown.remove(key) } else { shown.insert(key) }
                    }.buttonStyle(JosiOutlineButtonStyle())
                }
                if !field["help"].text.isEmpty { Text(field["help"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            }
        default:
            VStack(alignment: .leading, spacing: 5) {
                Text(label(field)).font(JosiFont.callout)
                TextField(field["placeholder"].text, text: Binding(get: { texts[key] ?? "" }, set: { texts[key] = $0 }))
                    .labelsHidden().textFieldStyle(JosiFieldStyle()).onSubmit(save)
                    .accessibilityLabel(field["label"].text)
                if !field["help"].text.isEmpty { Text(field["help"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            }
        }
    }
    private func save() {
        guard !working, !fields.isEmpty else { return }
        var values: [String: Wire] = [:]
        for field in fields {
            let key = field["key"].text, required = field["required"].flag
            switch field["type"].text {
            case "confirm":
                if required && !confirmed.contains(key) { problem = "Please confirm: " + field["label"].text; return }
                values[key] = .bool(confirmed.contains(key))
            case "secret":
                let value = (secrets[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if required && value.isEmpty { problem = field["label"].text + " is required."; return }
                values[key] = .string(value)
            default:
                let value = (texts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if required && value.isEmpty { problem = field["label"].text + " is required."; return }
                values[key] = .string(value)
            }
        }
        problem = ""; working = true
        Task {
            defer { working = false }
            do {
                try await model.saveCredentialCard(proposal, values: values)
                clear(); dismiss()
            } catch {
                // The secret boxes empty after a failure, as on Windows; the route's own words stay.
                secrets = [:]; problem = error.localizedDescription
            }
        }
    }
    private func signIn() {
        problem = ""; working = true
        Task {
            defer { working = false }
            do { try await model.startAccountCard(proposal); dismiss() } catch { problem = error.localizedDescription }
        }
    }
    private func decline() {
        clear(); dismiss()
        model.run { try await model.decideSettingsChange(proposal, approve: false) }
    }
    private func clear() { secrets = [:]; shown = [] }
}
