import AppKit
import SwiftUI

private let contactSyncIntervals = [(300, "Every 5 minutes"), (900, "Every 15 minutes"), (1800, "Every 30 minutes"),
                                    (3600, "Every hour"), (86400, "Once a day")]

struct NativeContactsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var contacts: [Wire] = []
    @State private var origins: [Wire] = []
    @State private var review: [Wire] = []
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var loaded = false
    @State private var unavailable = false
    @State private var syncAvailable = true
    @State private var error = ""
    @State private var syncError = ""
    @State private var note = ""
    @State private var generation = 0

    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                JosiHeading(title: "Contacts", subtitle: "Private to you, like your conversations.")
                Button("Refresh") { model.run { await load() } }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            }
            NativeLeanStatus(loading: !loaded && error.isEmpty && !unavailable, error: error, note: note)
            if unavailable {
                NativeLeanNote(text: "This server does not offer contacts yet. Update the server to use them.")
            } else {
                addCard
                if syncAvailable { syncCard }
                if loaded {
                    if contacts.isEmpty {
                        JosiCard {
                            Text("No contacts yet").font(JosiFont.headline)
                            NativeLeanNote(text: "Add one above and Josi can use it in your work.")
                        }
                    }
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(contacts, id: \.identifier) { contactRow($0) }
                    }
                }
            }
        }
        .task {
            while !Task.isCancelled {
                if NSApp.isActive && !model.busy { await load() }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .onDisappear { generation += 1 }
    }

    private var addCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Add a contact")
            TextField("Name", text: $name)
            HStack {
                TextField("Email", text: $email).textContentType(.emailAddress)
                TextField("Phone", text: $phone).textContentType(.telephoneNumber)
            }
            Button("Add Contact") { add() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                .disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }.textFieldStyle(JosiFieldStyle())
    }
    private var syncCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Synced accounts")
            if !syncError.isEmpty { NativeLeanNote(text: syncError, color: JosiTheme.error) }
            if origins.isEmpty {
                NativeLeanNote(text: "No account is syncing contacts. Contacts already imported stay when you stop syncing.")
            }
            ForEach(Array(origins.enumerated()), id: \.element.identifier) { index, origin in
                if index > 0 { Divider().overlay(JosiTheme.hairline) }
                originRow(origin)
            }
            if !review.isEmpty {
                Divider().overlay(JosiTheme.hairline)
                Text("Possible duplicates").font(JosiFont.headline)
                NativeLeanNote(text: "Nothing has been merged. Josi only joins records on its own when they are the same record from the same account.")
                ForEach(Array(review.enumerated()), id: \.offset) { _, item in NativeLeanNote(text: item["reason"].text, color: JosiTheme.muted) }
            }
        }
    }
    private func originRow(_ origin: Wire) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(sourceLabel(origin["provider"].text) + " · " + origin["sourceAccount"].text).font(JosiFont.callout).lineLimit(1)
                Spacer()
                JosiPill(text: statusLabel(origin["status"].text), color: origin["status"].text == "error" ? JosiTheme.error : JosiTheme.lilac)
            }
            Text(lastSync(origin)).font(JosiFont.caption).foregroundStyle(origin["status"].text == "error" ? JosiTheme.error : JosiTheme.muted)
            if origin["status"].text == "disconnected" {
                NativeLeanNote(text: "The contacts it brought are still here, and nothing was changed at the provider.", color: JosiTheme.muted)
                Button("Restart Import Sync") {
                    guard let api = model.api, let id = try? api.uuid(origin["connectionId"].text) else { return }
                    act("/contacts/sync/\(id)", method: "PUT", body: ["mode": "import_only"])
                }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            } else {
                HStack {
                    Button("Sync Now") {
                        guard let api = model.api, let id = try? api.uuid(origin.identifier) else { return }
                        act("/contacts/sync/\(id)/run", body: [:])
                    }.buttonStyle(JosiOutlineButtonStyle())
                    Button("Stop Syncing") {
                        guard let api = model.api, let id = try? api.uuid(origin.identifier) else { return }
                        act("/contacts/sync/\(id)/stop", body: [:])
                    }.buttonStyle(JosiOutlineButtonStyle())
                    Spacer()
                    Picker("How often", selection: Binding(get: { origin["intervalSeconds"].integer }, set: { seconds in
                        guard let api = model.api, let id = try? api.uuid(origin.identifier) else { return }
                        act("/contacts/sync/\(id)/interval", method: "PUT", body: ["seconds": .number(Double(seconds))])
                    })) {
                        ForEach(contactSyncIntervals, id: \.0) { seconds, label in Text(label).tag(seconds) }
                    }.labelsHidden().frame(maxWidth: 180).accessibilityLabel("How often to sync")
                }.disabled(model.busy)
            }
        }
    }
    private func contactRow(_ contact: Wire) -> some View {
        JosiCard {
            HStack {
                Text(contact["name"].text.isEmpty ? "Unnamed" : contact["name"].text).font(JosiFont.headline).lineLimit(1)
                Spacer()
                if !contact["source"].text.isEmpty, contact["source"].text != "josi" {
                    Text(sourceLabel(contact["source"].text) + (contact["source_account"].text.isEmpty ? "" : " · " + contact["source_account"].text))
                        .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).lineLimit(1)
                }
            }
            if !contact["email"].text.isEmpty { NativeLeanNote(text: contact["email"].text) }
            if !contact["phone"].text.isEmpty { NativeLeanNote(text: contact["phone"].text) }
            if contact["conflict_state"].text == "both_changed" {
                NativeLeanNote(text: "This changed here and at the provider since the last sync. Nothing was overwritten.", color: JosiTheme.gold)
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        do {
            let result = try await api.request("/assistant/contacts")
            guard current() else { return }
            contacts = result["contacts"].list; loaded = true; unavailable = false; error = ""
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { unavailable = true }
            else if !loaded { self.error = error.localizedDescription }
            return
        }
        do {
            let result = try await api.request("/contacts/sync")
            guard current() else { return }
            origins = result["origins"].list; syncAvailable = true; syncError = ""
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { syncAvailable = false }
            else { syncError = "Contact sync status could not be loaded. Refresh to try again." }
        }
    }
    private func add() {
        guard let api = model.api else { return }
        let owner = model.user["id"]
        let body: Wire = ["name": .string(name), "email": .string(email), "phone": .string(phone)]
        error = ""; note = ""
        model.run {
            do {
                _ = try await api.request("/assistant/contacts", method: "POST", body: body)
                guard model.api === api, model.user["id"] == owner else { return }
                name = ""; email = ""; phone = ""
                note = "Contact added."
                await load()
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
        }
    }
    private func act(_ route: String, method: String = "POST", body: Wire) {
        guard let api = model.api else { return }
        let owner = model.user["id"]
        syncError = ""
        model.run {
            do {
                let result = try await api.request(route, method: method, body: body)
                guard model.api === api, model.user["id"] == owner else { return }
                if case .array(let items) = result["needsReview"] { review = items }
            } catch {
                guard model.api === api else { return }
                syncError = error.localizedDescription
            }
            await load()
        }
    }
    private func sourceLabel(_ value: String) -> String {
        ["google": "Google", "microsoft": "Microsoft", "device": "Your phone", "josi": "Added here"][value] ?? value.capitalized
    }
    private func statusLabel(_ value: String) -> String {
        ["idle": "Syncing", "syncing": "Syncing now", "error": "Not working", "paused": "Paused", "disconnected": "Stopped"][value] ?? value.capitalized
    }
    private func lastSync(_ origin: Wire) -> String {
        let mode = origin["syncMode"].text == "two_way" ? "Two-way" : "Import only"
        let when = origin["lastSyncAt"].text.isEmpty ? "Not synced yet" : "Last synced " + nativeDate(origin["lastSyncAt"].text)
        let problem = origin["status"].text == "error" ? errorLabel(origin["lastErrorCategory"].text) : ""
        return [mode, when, problem].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func errorLabel(_ value: String) -> String {
        ["revoked": "Access was withdrawn", "expired": "The stored permission expired", "insufficient_scope": "A permission was removed",
         "rate_limited": "The provider is asking Josi to slow down", "provider_error": "The provider had a problem",
         "network": "The provider could not be reached"][value] ?? ""
    }
}
