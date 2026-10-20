import AppKit
import SwiftUI

/// Administrator metadata only. Member conversations, files and credentials
/// are never loaded by this page.
struct NativePeopleView: View {
    @EnvironmentObject var model: JosiModel
    @State private var people: [Wire] = []
    @State private var grants: [Wire] = []
    @State private var sessions: [Wire] = []
    @State private var defaultBytes: Wire = .null
    @State private var email = ""
    @State private var username = ""
    @State private var name = ""
    @State private var link = ""
    @State private var linkLabel = ""
    @State private var note = ""
    @State private var visible = false
    @State private var loading = false
    @State private var showSessions = false
    @State private var generation = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("People").font(.largeTitle.bold())
                    Spacer()
                    Button("Refresh") { model.run { try await load() } }
                }
                Text("Manage accounts on this server. Each person keeps their own conversations, tasks and connected files.")
                    .foregroundStyle(.secondary)
                GroupBox("Add a member") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Email", text: $email)
                        TextField("Username", text: $username)
                        TextField("Display name (optional)", text: $name)
                        Button("Create Invitation") { invite() }.disabled(!validNewPerson)
                        Text("Creates a member account. Share the invitation yourself; this button does not send an email.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(10)
                }
                if !link.isEmpty {
                    GroupBox(linkLabel) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("This one-time link sets the account password. Share it only with that person. They can use “Invitation or password reset” in the Josi sign-in screen.")
                            Text(link).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            Button("Hide Link") { link = ""; linkLabel = "" }
                        }.padding(10)
                    }
                }
                ForEach(people, id: \.identifier) { person in
                    NativePersonCard(person: person, grant: grants.first { $0["user_id"] == person["id"] } ?? .null,
                                     defaultBytes: defaultBytes, isSelf: person["id"] == model.user["id"],
                                     change: { patch in update(person, patch: patch) },
                                     storage: { original, patch in updateStorage(person, original: original, patch: patch) },
                                     reset: { reset(person) }, revoke: { revokeAll(person) })
                }
                DisclosureGroup("Active sign-ins", isExpanded: $showSessions) {
                    VStack(alignment: .leading, spacing: 12) {
                        Button("Refresh Sign-ins") { model.run { try await loadSessions() } }
                        Text("The server returns up to 500 current sign-ins. Ending your own sign-in requires signing in again.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(sessions, id: \.identifier) { session in
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(session["username"].text).font(.headline)
                                    Text(session["user_agent"].text.isEmpty ? "Unknown client" : session["user_agent"].text)
                                        .font(.caption).lineLimit(3)
                                    Text("Address: \(session["ip"].text.isEmpty ? "Unavailable" : session["ip"].text)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    Text("Last active: \(session["last_seen_at"].text)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("End Sign-in…") { revoke(session) }
                            }
                            Divider()
                        }
                    }.padding(.top, 10)
                }.onChange(of: showSessions) { _, value in
                    if value { model.run { try await loadSessions() } } else { sessions = [] }
                }
                if !note.isEmpty { Text(note).foregroundStyle(.secondary) }
            }.padding(30).textFieldStyle(.roundedBorder).disabled(model.busy || loading)
        }
        .task { visible = true; do { try await load() } catch { model.error = error.localizedDescription } }
        .onDisappear { visible = false; generation += 1; link = ""; linkLabel = ""; sessions = []; email = ""; username = ""; name = "" }
    }
    private var validNewPerson: Bool {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return address.count <= 254 && address.contains("@") && !address.contains(where: \.isWhitespace)
            && !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && username.count <= 80 && name.count <= 120
    }
    private func current(_ api: JosiAPI, _ owner: Wire, _ revision: Int) -> Bool {
        visible && model.api === api && model.user["id"] == owner && model.isAdministrator && generation == revision && !Task.isCancelled
    }
    private func load() async throws {
        guard let api = model.api, model.isAdministrator, !loading else { return }
        let owner = model.user["id"], revision = generation
        loading = true; defer { loading = false }
        let accounts = try await api.request("/admin/users")
        let access = try await api.request("/storage/admin/capabilities")
        let policy = try await api.request("/storage/admin/policy")
        guard current(api, owner, revision) else { return }
        people = accounts["users"].list; grants = access["users"].list
        defaultBytes = policy["policy"]["max_total_bytes_per_user"]
    }
    private func loadSessions() async throws {
        guard let api = model.api, model.isAdministrator, showSessions else { return }
        let owner = model.user["id"], revision = generation
        let result = try await api.request("/admin/sessions")
        guard current(api, owner, revision), showSessions else { return }
        sessions = result["sessions"].list
    }
    private func perform(_ work: @escaping @MainActor (JosiAPI, Wire, Int) async throws -> Void) {
        guard let api = model.api, model.isAdministrator else { return }
        let owner = model.user["id"], revision = generation
        model.run {
            guard current(api, owner, revision) else { return }
            do {
                try await work(api, owner, revision)
                guard current(api, owner, revision) else { return }
                try await load()
                if showSessions { try await loadSessions() }
            } catch let error as JosiError where error.status == 401 && model.api === api {
                try await model.signOut()
            }
        }
    }
    private func requirePerson(_ api: JosiAPI, _ original: Wire) async throws {
        let id = try api.uuid(original["id"].text)
        let response = try await api.request("/admin/users")
        guard let fresh = response["users"].list.first(where: { $0["id"].text == id }),
              ["id", "username", "email", "display_name", "role", "status"].allSatisfy({ fresh[$0] == original[$0] }) else {
            throw JosiError(message: "This account changed. Refresh People and review it before saving.")
        }
    }
    private func showLink(_ value: Wire, label: String) throws {
        guard let url = URLComponents(string: value.text), ["http", "https"].contains(url.scheme ?? ""),
              url.host != nil, url.user == nil, url.password == nil, url.path == "/set-password", url.fragment == nil,
              url.queryItems?.count == 1, let item = url.queryItems?.first, item.name == "token",
              let token = item.value, token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw JosiError(message: "The account was created or updated, but its returned link is invalid. Review the server’s public address before issuing a new reset link.")
        }
        link = value.text; linkLabel = label
    }
    private func invite() {
        guard validNewPerson else { return }
        let body: Wire = ["email": .string(email.trimmingCharacters(in: .whitespacesAndNewlines)),
                          "username": .string(username.trimmingCharacters(in: .whitespacesAndNewlines)), "displayName": .string(name)]
        link = ""; linkLabel = ""
        perform { api, owner, revision in
            let result = try await api.request("/admin/users", method: "POST", body: body)
            guard current(api, owner, revision) else { return }
            email = ""; username = ""; name = ""
            try showLink(result["inviteLink"], label: "Invitation · expires in seven days")
        }
    }
    private func update(_ person: Wire, patch: Wire) {
        perform { api, owner, revision in
            try await requirePerson(api, person)
            guard current(api, owner, revision) else { return }
            _ = try await api.request("/admin/users/" + api.uuid(person["id"].text), method: "PATCH", body: patch)
            guard current(api, owner, revision) else { return }; note = "Account updated."
        }
    }
    private func updateStorage(_ person: Wire, original: Wire, patch: Wire) {
        perform { api, owner, revision in
            try await requirePerson(api, person)
            let fresh = try await api.request("/storage/admin/capabilities")
            guard let row = fresh["users"].list.first(where: { $0["user_id"] == person["id"] }),
                  ["may_map_local", "may_map_cloud", "may_index", "max_files", "max_bytes"].allSatisfy({ row[$0] == original[$0] }) else {
                throw JosiError(message: "Folder access changed. Refresh and review its current settings.")
            }
            guard current(api, owner, revision) else { return }
            _ = try await api.request("/storage/admin/capabilities/" + api.uuid(person["id"].text), method: "PUT", body: patch)
            guard current(api, owner, revision) else { return }; note = "Folder access updated."
        }
    }
    private func reset(_ person: Wire) {
        guard confirm("Issue a password reset for \(person["username"].text)?", "This replaces any earlier unused password-reset link for this account. No email will be sent.", button: "Issue Reset") else { return }
        link = ""; linkLabel = ""
        perform { api, owner, revision in
            try await requirePerson(api, person)
            guard current(api, owner, revision) else { return }
            let result = try await api.request("/admin/users/" + api.uuid(person["id"].text) + "/reset-link", method: "POST", body: [:])
            guard current(api, owner, revision) else { return }
            try showLink(result["link"], label: "Password reset · expires in one hour")
        }
    }
    private func revokeAll(_ person: Wire) {
        guard confirm("End all sign-ins for \(person["username"].text)?", "This signs them out of Josi on every connected device.", button: "End All Sign-ins") else { return }
        perform { api, owner, revision in
            try await requirePerson(api, person)
            guard current(api, owner, revision) else { return }
            if person["id"] == owner && model.desktop.requiresClosure { try await model.desktop.close() }
            guard current(api, owner, revision) else { return }
            let result = try await api.request("/admin/users/" + api.uuid(person["id"].text) + "/sessions", method: "DELETE")
            guard current(api, owner, revision) else { return }
            note = "\(result["revoked"].integer) sign-in(s) ended."
            if person["id"] == owner { try await model.signOut() }
        }
    }
    private func revoke(_ session: Wire) {
        guard confirm("End this sign-in for \(session["username"].text)?", "That client will need to sign in again.", button: "End Sign-in") else { return }
        perform { api, owner, revision in
            let fresh = try await api.request("/admin/sessions")
            guard fresh["sessions"].list.contains(where: { $0["id"] == session["id"] && $0["user_id"] == session["user_id"] }),
                  current(api, owner, revision) else { throw JosiError(message: "This sign-in is no longer current. Refresh the list.") }
            _ = try await api.request("/admin/sessions/" + api.uuid(session["id"].text), method: "DELETE")
            guard current(api, owner, revision) else { return }; note = "Sign-in ended."
        }
    }
    private func confirm(_ title: String, _ detail: String, button: String) -> Bool {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: button); alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

private struct NativePersonCard: View {
    let person: Wire
    let grant: Wire
    let defaultBytes: Wire
    let isSelf: Bool
    let change: (Wire) -> Void
    let storage: (Wire, Wire) -> Void
    let reset: () -> Void
    let revoke: () -> Void
    @State private var editing = false
    @State private var original: Wire = .null
    @State private var email = ""
    @State private var username = ""
    @State private var name = ""
    @State private var access: Wire = .null
    @State private var local = false
    @State private var cloud = false
    @State private var index = false
    @State private var bytes = ""
    @State private var files = ""

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(person["display_name"].text.isEmpty ? person["username"].text : person["display_name"].text).font(.headline)
                    Spacer()
                    Text(person["role"].text == "super_admin" ? "Super administrator" : "Member")
                    Text(person["status"].text.capitalized).foregroundStyle(.secondary)
                }
                Text(person["email"].text).foregroundStyle(.secondary)
                DisclosureGroup("Account and folder access", isExpanded: $editing) {
                    VStack(alignment: .leading, spacing: 12) {
                        if accountChanged { Text("The account changed. Close and reopen these controls to review the current values.").foregroundStyle(.orange) }
                        TextField("Username", text: $username)
                        TextField("Email", text: $email)
                        TextField("Display name", text: $name)
                        Button("Save Account") { change(["username": .string(username), "email": .string(email), "displayName": .string(name)]) }
                            .disabled(accountChanged || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || username.count > 80
                                      || !email.contains("@") || email.count > 254 || name.count > 120)
                        HStack {
                            Button("Password Reset…", action: reset).disabled(person["status"].text != "active")
                            Button("End All Sign-ins…", action: revoke)
                            if !isSelf {
                                Button(person["status"].text == "active" ? "Disable Account…" : "Enable Account…") { setStatus() }
                            }
                        }
                        if access != .null && person["status"].text == "active" {
                            Divider()
                            Text("Folder access").font(.headline)
                            Toggle("Map local folders", isOn: $local)
                            Toggle("Map cloud folders", isOn: $cloud)
                            Toggle("Index and search connected files", isOn: $index)
                            Text("\(grant["mappings"].integer) mapped folder(s). Removing indexing access purges derived searchable content.")
                                .font(.caption).foregroundStyle(.secondary)
                            TextField("Storage override in GiB; blank uses server default", text: $bytes)
                            Text(defaultBytes == .null ? "Server storage default unavailable." : "Current server default: \(size(defaultBytes)) GiB")
                                .font(.caption).foregroundStyle(.secondary)
                            TextField("File-count override; blank uses server default", text: $files)
                            if storageChanged { Text("Folder permissions changed. Close and reopen these controls before saving.").foregroundStyle(.orange) }
                            Button("Save Folder Access") { saveAccess() }.disabled(storageChanged || limits == nil)
                        }
                    }.padding(.top, 12)
                }.onChange(of: editing) { _, value in if value { beginEdit() } }
            }.padding(10)
        }
    }
    private var accountChanged: Bool {
        ["id", "username", "email", "display_name", "role", "status"].contains { original[$0] != person[$0] }
    }
    private var storageChanged: Bool {
        ["may_map_local", "may_map_cloud", "may_index", "max_files", "max_bytes"].contains { access[$0] != grant[$0] }
    }
    private func size(_ value: Wire) -> String {
        if value == .null { return "" }
        // PostgreSQL bigint values may be JSON strings. An unreadable saved
        // value must not turn into a blank/reset override when saving access.
        let number: Double
        if case .number(let n) = value { number = n }
        else if value.text.range(of: "^[0-9]+$", options: .regularExpression) != nil,
                let n = Double(value.text) { number = n }
        else { return "Unavailable" }
        guard number.isFinite, number >= 0, number <= 9_007_199_254_740_991 else { return "Unavailable" }
        return String(number / 1_073_741_824)
    }
    private var limits: (Wire, Wire)? {
        let b = bytes.trimmingCharacters(in: .whitespacesAndNewlines), f = files.trimmingCharacters(in: .whitespacesAndNewlines)
        var byteValue: Wire = .null, fileValue: Wire = .null
        if !b.isEmpty {
            guard let n = Double(b), n.isFinite, n >= 0, n * 1_073_741_824 <= 9_007_199_254_740_991 else { return nil }
            byteValue = .number((n * 1_073_741_824).rounded())
        }
        if !f.isEmpty {
            guard let n = Int(f), n >= 0, n <= 2_147_483_647 else { return nil }
            fileValue = .number(Double(n))
        }
        return (byteValue, fileValue)
    }
    private func beginEdit() {
        original = person; access = grant
        email = person["email"].text; username = person["username"].text; name = person["display_name"].text
        local = grant["may_map_local"].flag; cloud = grant["may_map_cloud"].flag; index = grant["may_index"].flag
        bytes = size(grant["max_bytes"]); files = grant["max_files"] == .null ? "" : String(grant["max_files"].integer)
    }
    private func saveAccess() {
        guard let (maximumBytes, maximumFiles) = limits, !storageChanged else { return }
        if access["may_index"].flag && !index {
            let alert = NSAlert(); alert.messageText = "Remove indexing access?"
            alert.informativeText = "This disables indexing on the member’s mapped folders and deletes their derived searchable content."
            alert.addButton(withTitle: "Remove Access"); alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        storage(access, ["mayMapLocal": .bool(local), "mayMapCloud": .bool(cloud), "mayIndex": .bool(index),
                         "maxBytes": maximumBytes, "maxFiles": maximumFiles])
    }
    private func setStatus() {
        guard !isSelf, ["active", "disabled"].contains(person["status"].text) else { return }
        let disable = person["status"].text == "active"
        let alert = NSAlert(); alert.messageText = "\(disable ? "Disable" : "Enable") \(person["username"].text)?"
        alert.informativeText = disable ? "This prevents sign-in and ends their current sessions. Their account and saved work remain." : "This allows the account to sign in again."
        alert.addButton(withTitle: disable ? "Disable" : "Enable"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { change(["status": .string(disable ? "disabled" : "active")]) }
    }
}
