import AppKit
import SwiftUI

/// Who may connect each developer service (GitHub, Netlify, Supabase, Notion and
/// the rest), and who has. Each person connects with their own token; the
/// administrator never enters or sees anyone's credential.
struct NativeDeveloperServicesView: View {
    @EnvironmentObject var model: JosiModel
    @State private var view: Wire = .null
    @State private var open: String?
    @State private var mode: [String: String] = [:]
    @State private var chosen: [String: Set<String>] = [:]
    @State private var notes: [String: String] = [:]
    @State private var loading = false
    @State private var error = ""
    @State private var note = ""
    private static let modes = [("not_allowed", "Not allowed"), ("everyone", "Everyone"), ("specific_users", "Specific people")]
    var body: some View {
        NativeLeanPage {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Developer Services").font(JosiFont.title2)
                    NativeLeanNote(text: "Each person connects their own developer accounts under Connections with their own token. What you decide here is who may. You never enter or see anyone's credential.")
                }
                Spacer()
                Button("Refresh") { Task { await load() } }.buttonStyle(JosiOutlineButtonStyle())
            }
            NativeLeanStatus(loading: loading, error: error, note: note)
            ForEach(view["services"].list, id: \.self["service"].text) { service($0) }
        }.task { await load() }
    }
    private func service(_ row: Wire) -> some View {
        let id = row["service"].text, expanded = open == id
        let attention = row["connections"].list.contains { $0["lastCheckOk"] == .bool(false) }
        return JosiCard {
            Button { open = expanded ? nil : id } label: {
                HStack {
                    Text(row["label"].text).font(JosiFont.headline)
                    Spacer()
                    Text((Self.modes.first { $0.0 == row["mode"].text }?.1 ?? row["mode"].text) + (attention ? " · needs attention" : ""))
                        .font(JosiFont.caption).foregroundStyle(attention ? JosiTheme.error : JosiTheme.muted)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").foregroundStyle(JosiTheme.muted)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
            if expanded {
                NativeLeanNote(text: row["capability"].text)
                Picker("Who may connect this", selection: Binding(get: { mode[id] ?? row["mode"].text }, set: { mode[id] = $0 })) {
                    ForEach(Self.modes, id: \.0) { Text($0.1).tag($0.0) }
                }.pickerStyle(.segmented)
                if (mode[id] ?? row["mode"].text) == "specific_users" {
                    ForEach(view["people"].list, id: \.identifier) { person in
                        Toggle(person["username"].text + "  ·  " + person["email"].text, isOn: Binding(
                            get: { (chosen[id] ?? Set(row["allowedUserIds"].list.map(\.text))).contains(person.identifier) },
                            set: { on in
                                var set = chosen[id] ?? Set(row["allowedUserIds"].list.map(\.text))
                                if on { set.insert(person.identifier) } else { set.remove(person.identifier) }
                                chosen[id] = set
                            })).toggleStyle(.checkbox)
                    }
                }
                TextField("Reason to show anyone who can't connect it (optional)", text: Binding(get: { notes[id] ?? row["note"].text }, set: { notes[id] = $0 }))
                    .textFieldStyle(JosiFieldStyle())
                NativeLeanNote(text: row["summary"].text)
                Button("Save Who May Connect") { save(row) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Text("Who has connected").font(JosiFont.callout)
                if row["connections"].list.isEmpty {
                    NativeLeanNote(text: row["mode"].text == "not_allowed" ? "Nobody may, so this says nothing about whether anyone wants it." : "They may; nobody has yet.")
                }
                ForEach(row["connections"].list, id: \.self["userId"].text) { c in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c["username"].text).font(JosiFont.callout)
                            Text(c["accountLabel"].text.isEmpty ? "account not named" : c["accountLabel"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                            if c["lastCheckOk"] == .bool(false) { Text(c["lastError"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.error) }
                        }
                        Spacer()
                        Text(c["lastCheckOk"] == .bool(false) ? "Needs attention" : c["status"].text.capitalized).font(JosiFont.caption)
                    }
                }
            }
        }
    }
    private func load() async {
        guard let api = model.api else { return }
        loading = true; defer { loading = false }
        do { view = try await api.request("/admin/developer-services"); error = "" } catch { self.error = error.localizedDescription }
    }
    private func save(_ row: Wire) {
        guard let api = model.api else { return }
        let id = row["service"].text, chosenMode = mode[id] ?? row["mode"].text
        let users = chosenMode == "specific_users" ? Array(chosen[id] ?? Set(row["allowedUserIds"].list.map(\.text))) : []
        let body: Wire = ["mode": .string(chosenMode), "note": .string(notes[id] ?? row["note"].text), "userIds": .array(users.map { .string($0) })]
        Task {
            do {
                _ = try await api.request("/admin/developer-services/\(id)", method: "PUT", body: body)
                note = row["label"].text + " permissions saved."; error = ""; await load()
            } catch { self.error = error.localizedDescription }
        }
    }
}

/// Outside services Josi doesn't know (a booking system, a CRM, something built
/// in-house), connected one action at a time. Josi calls only the actions that
/// are switched on, and only the address given here.
struct NativeCustomApisView: View {
    @EnvironmentObject var model: JosiModel
    @State private var connections: [Wire]?
    @State private var loading = false
    @State private var error = ""
    @State private var note = ""
    @State private var editing: String?          // "new" or a connection id
    @State private var adding: String?
    @State private var importing: String?
    @State private var form = ConnectionForm()
    @State private var action = ActionForm()
    @State private var document = ""
    @State private var preview: Wire = .null
    @State private var picked: Set<String> = []
    struct ConnectionForm { var name = "", slug = "", url = "https://", auth = "bearer", header = "X-API-Key", user = "", secret = "", password = "", test = "/" }
    struct ActionForm { var id = "", summary = "", method = "GET", path = "/", query = "", body = false }

    var body: some View {
        NativeLeanPage {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Custom APIs").font(JosiFont.title2)
                    NativeLeanNote(text: "Connect a service Josi doesn't know about and say, one action at a time, exactly what Josi may ask it. Josi never calls anything you haven't listed, and never any address other than the one you give.")
                }
                Spacer()
                Button("Refresh") { Task { await load() } }.buttonStyle(JosiOutlineButtonStyle())
            }
            NativeLeanStatus(loading: loading, error: error, note: note)
            if let connections {
                if editing == "new" { connectionForm(nil) }
                else {
                    Button(connections.isEmpty ? "Connect an API" : "Connect Another API") { form = ConnectionForm(); editing = "new" }
                        .buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                }
                if connections.isEmpty && editing != "new" {
                    JosiCard { NativeLeanNote(text: "Nothing is connected. Josi can't reach any outside service through this page until you add one, test it, and switch on the actions you want.") }
                }
                ForEach(connections, id: \.identifier) { card($0) }
            }
        }.task { await load() }
    }
    private func card(_ c: Wire) -> some View {
        let id = c.identifier, tested = c["lastCheckOk"] == .bool(true), enabled = c["enabled"].flag
        let endpoints = c["endpoints"].list
        return JosiCard {
            HStack {
                Text(c["name"].text).font(JosiFont.headline)
                Spacer()
                Text(enabled ? "Available to Josi" : "Not available to Josi").font(JosiFont.caption).foregroundStyle(enabled ? JosiTheme.success : JosiTheme.muted)
            }
            NativeLeanNote(text: "Address: \(c["baseUrl"].text) · Josi only ever calls \(c["host"].text) · Short name: \(c["slug"].text) · Credential: \(c["credentialMask"].text)")
            if !c["lastErrorCategory"].text.isEmpty { Text(c["lastErrorCategory"].text.replacingOccurrences(of: "_", with: " ")).font(JosiFont.caption).foregroundStyle(JosiTheme.error) }
            HStack {
                Button("Test Connection") { perform(c["name"].text + " answered.") { api in _ = try await api.request("/admin/custom-apis/\(try api.uuid(id))/test", method: "POST", body: [:]) } }
                Button(enabled ? "Make Unavailable to Josi" : "Make Available to Josi") {
                    perform(enabled ? "Josi can no longer use this API." : "Josi may now use the actions you switched on.") { api in
                        _ = try await api.request("/admin/custom-apis/\(try api.uuid(id))/\(enabled ? "disable" : "enable")", method: "POST", body: [:])
                    }
                }.disabled(!enabled && !tested)
                Button(editing == id ? "Cancel Edit" : "Edit") {
                    if editing == id { editing = nil } else {
                        form = ConnectionForm(name: c["name"].text, slug: c["slug"].text, url: c["baseUrl"].text, auth: c["authKind"].text,
                                              header: c["authHeader"].text.isEmpty ? "X-API-Key" : c["authHeader"].text, test: c["testPath"].text)
                        editing = id
                    }
                }
                Button("Remove…") {
                    guard nativeConfirm("Remove \(c["name"].text)?", detail: "The connection and all its actions are removed.", button: "Remove") else { return }
                    perform("\(c["name"].text) and its actions were removed.") { api in _ = try await api.request("/admin/custom-apis/\(try api.uuid(id))", method: "DELETE") }
                }
            }.buttonStyle(JosiOutlineButtonStyle())
            if !enabled && !tested { NativeLeanNote(text: "Josi offers an API only after it has answered a test. Test it first.") }
            if editing == id { connectionForm(c) }
            HStack {
                Text("What Josi may ask it (\(endpoints.filter { $0["enabled"].flag }.count) of \(endpoints.count) switched on)").font(JosiFont.callout)
                Spacer()
                Button(adding == id ? "Cancel" : "Add an Action") { action = ActionForm(); adding = adding == id ? nil : id }
                Button(importing == id ? "Cancel Import" : "Import OpenAPI") { importing = importing == id ? nil : id; preview = .null; picked = [] }
            }.buttonStyle(JosiOutlineButtonStyle())
            if endpoints.isEmpty { NativeLeanNote(text: "Nothing is listed, so Josi can ask this API for nothing at all.") }
            ForEach(endpoints, id: \.identifier) { endpoint($0) }
            if adding == id { actionForm(id) }
            if importing == id { importForm(c) }
        }
    }
    private func endpoint(_ e: Wire) -> some View {
        let id = e.identifier, on = e["enabled"].flag
        let parameters = e["parameters"].list.map { $0["name"].text + ($0["required"].flag ? "" : " (optional)") }
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(e["operationId"].text).font(JosiFont.callout.weight(.medium))
                Spacer()
                Text(e["capability"].text.capitalized + " · " + (on ? "Switched on" : "Switched off")).font(JosiFont.caption).foregroundStyle(on ? JosiTheme.success : JosiTheme.muted)
            }
            Text(e["summary"].text).font(JosiFont.callout)
            Text(e["method"].text + " " + e["pathTemplate"].text).font(.system(.caption, design: .monospaced)).foregroundStyle(JosiTheme.muted).textSelection(.enabled)
            Text((parameters.isEmpty ? "Takes no parameters." : "Accepts: " + parameters.joined(separator: ", ") + ".") + (e["acceptsBody"].flag ? " Sends a block of details." : ""))
                .font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
            HStack {
                Button(on ? "Switch Off" : "Switch On") { perform("") { api in _ = try await api.request("/admin/custom-apis/endpoints/\(try api.uuid(id))/\(on ? "disable" : "enable")", method: "POST", body: [:]) } }
                Button("Remove") { perform("") { api in _ = try await api.request("/admin/custom-apis/endpoints/\(try api.uuid(id))", method: "DELETE") } }
            }.buttonStyle(JosiOutlineButtonStyle())
        }.padding(12).overlay(RoundedRectangle(cornerRadius: 10).stroke(JosiTheme.hairline, lineWidth: 1))
    }
    @ViewBuilder private func connectionForm(_ existing: Wire?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(existing == nil ? "Connect an API" : "Edit this connection").font(JosiFont.headline)
            field("Name (what people see, for example “Our booking system”)", $form.name)
            if existing == nil { field("Short name for the assistant (lowercase, digits, underscores; blank makes one)", $form.slug) }
            field("Address (https:// only; private or internal addresses are refused)", $form.url)
            Picker("Authentication", selection: $form.auth) {
                Text("Bearer token").tag("bearer"); Text("API key in a header").tag("api_key"); Text("Username and password").tag("basic")
            }.pickerStyle(.segmented)
            if form.auth == "api_key" { field("Header name", $form.header) }
            if form.auth == "basic" {
                field("Username", $form.user)
                secret(existing == nil ? "Password" : "Password (blank keeps the stored one)", $form.password)
            } else {
                secret((form.auth == "bearer" ? "Token" : "API key") + (existing == nil ? " (encrypted; nobody can read it back)" : " (blank keeps the stored one)"), $form.secret)
            }
            field("Test path (a path Josi can GET, often /health or /me)", $form.test)
            HStack {
                Button(existing == nil ? "Add Connection" : "Save") { saveConnection(existing) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Cancel") { form.secret = ""; form.password = ""; editing = nil }.buttonStyle(JosiOutlineButtonStyle())
            }
        }.padding(14).background(JosiTheme.card.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
    }
    private func actionForm(_ connection: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add an action").font(JosiFont.headline)
            NativeLeanNote(text: "The method decides whether Josi asks first: anything other than GET or HEAD waits for the person to approve it.")
            field("Action id (lowercase letters, digits and underscores)", $action.id)
            field("What it does (the words the assistant reads and you review)", $action.summary)
            Picker("Method", selection: $action.method) { ForEach(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], id: \.self) { Text($0).tag($0) } }.pickerStyle(.segmented)
            field("Path under the address, with {placeholders}", $action.path)
            field("Query parameters (comma separated; anything else is dropped)", $action.query)
            if !["GET", "HEAD"].contains(action.method) { Toggle("This action sends a block of details (a JSON body)", isOn: $action.body).toggleStyle(.checkbox) }
            HStack {
                Button("Add, Switched Off") { addAction(connection) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Cancel") { adding = nil }.buttonStyle(JosiOutlineButtonStyle())
            }
        }.padding(14).background(JosiTheme.card.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
    }
    private func importForm(_ c: Wire) -> some View {
        let id = c.identifier
        return VStack(alignment: .leading, spacing: 10) {
            Text("Import from an OpenAPI document").font(JosiFont.headline)
            NativeLeanNote(text: "Paste the JSON form of an OpenAPI 3 document. Nothing is saved until you choose from the list, and everything chosen arrives switched off. Josi ignores addresses in the document and only ever calls \(c["host"].text).")
            TextEditor(text: $document).font(.system(.caption, design: .monospaced)).frame(minHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(JosiTheme.border, lineWidth: 1))
            Button("Read the Document") {
                let text = document
                perform("") { api in
                    let result = try await api.request("/admin/custom-apis/\(try api.uuid(id))/endpoints/import", method: "POST", body: ["document": .string(text)])
                    preview = result; picked = []
                }
            }.buttonStyle(JosiOutlineButtonStyle())
            if preview != .null {
                let servers = preview["declaredServers"].list.map(\.text)
                if !servers.isEmpty { NativeLeanNote(text: "That document names \(servers.joined(separator: ", ")) as its address. Josi ignored it and will use \(c["baseUrl"].text).") }
                Text("\(preview["proposals"].list.count) action(s) found. Choose the ones Josi may use.").font(JosiFont.callout)
                ForEach(preview["proposals"].list, id: \.self["operationId"].text) { p in
                    let op = p["operationId"].text
                    Toggle("\(op): \(p["summary"].text)   (\(p["method"].text) \(p["pathTemplate"].text))", isOn: Binding(
                        get: { picked.contains(op) }, set: { if $0 { picked.insert(op) } else { picked.remove(op) } })).toggleStyle(.checkbox)
                }
                ForEach(preview["skipped"].list, id: \.self["path"].text) { s in
                    Text("Not usable: \(s["method"].text) \(s["path"].text): \(s["reason"].text)").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                }
                Button("Import Chosen Actions, Switched Off") {
                    let text = document, ops = Array(picked)
                    guard !ops.isEmpty else { return }
                    perform("\(ops.count) action(s) imported, all switched off.") { api in
                        _ = try await api.request("/admin/custom-apis/\(try api.uuid(id))/endpoints/import", method: "POST",
                                                  body: ["document": .string(text), "operations": .array(ops.map { .string($0) })])
                        importing = nil; preview = .null
                    }
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(picked.isEmpty)
            }
        }.padding(14).background(JosiTheme.card.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
    }
    private func field(_ label: String, _ value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac); TextField("", text: value).textFieldStyle(JosiFieldStyle()) }
    }
    private func secret(_ label: String, _ value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac); SecureField("", text: value).textFieldStyle(JosiFieldStyle()) }
    }
    private func load() async {
        guard let api = model.api else { return }
        loading = true; defer { loading = false }
        do { connections = try await api.request("/admin/custom-apis")["connections"].list; error = "" }
        catch { self.error = nativeRouteMissing(error) ? "This server doesn't have Custom APIs." : error.localizedDescription }
    }
    private func perform(_ done: String, _ work: @escaping (JosiAPI) async throws -> Void) {
        guard let api = model.api else { return }
        error = ""; note = ""
        Task {
            do { try await work(api); note = done } catch { self.error = error.localizedDescription }
            await load()
        }
    }
    private func saveConnection(_ existing: Wire?) {
        let name = form.name.trimmingCharacters(in: .whitespaces), url = form.url.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, url.hasPrefix("https://") else { error = "Enter a name and an https:// address."; return }
        var body: [String: Wire] = ["name": .string(name), "baseUrl": .string(url), "authKind": .string(form.auth), "testPath": .string(form.test.trimmingCharacters(in: .whitespaces))]
        if existing == nil { body["slug"] = .string(form.slug.trimmingCharacters(in: .whitespaces)) }
        if form.auth == "api_key" { body["authHeader"] = .string(form.header.trimmingCharacters(in: .whitespaces)) }
        if form.auth == "basic" {
            if !form.user.isEmpty || !form.password.isEmpty || existing == nil { body["username"] = .string(form.user); body["password"] = .string(form.password) }
        } else if !form.secret.isEmpty || existing == nil { body["secret"] = .string(form.secret) }
        form.secret = ""; form.password = ""
        let id = existing?.identifier
        perform(existing == nil ? "Added. Test it, then switch on the actions Josi may use." : "Saved. Changing the address or the credential means testing it again.") { api in
            if let id { _ = try await api.request("/admin/custom-apis/\(try api.uuid(id))", method: "PATCH", body: .object(body)) }
            else { _ = try await api.request("/admin/custom-apis", method: "POST", body: .object(body)) }
            editing = nil
        }
    }
    private func addAction(_ connection: String) {
        let path = action.path, summary = action.summary.trimmingCharacters(in: .whitespaces)
        guard action.id.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil, !summary.isEmpty, path.hasPrefix("/"), !path.hasPrefix("//") else {
            error = "Check the action id, description and path."; return
        }
        let placeholders = path.matches(of: /\{([a-zA-Z][a-zA-Z0-9_]*)\}/).map { String($0.output.1) }
        let query = action.query.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let parameters: [Wire] = placeholders.map { ["name": .string($0), "in": "path", "required": .bool(true), "description": ""] }
            + query.map { ["name": .string($0), "in": "query", "required": .bool(false), "description": ""] }
        let read = ["GET", "HEAD"].contains(action.method)
        let body: Wire = ["operationId": .string(action.id), "summary": .string(summary), "method": .string(action.method), "pathTemplate": .string(path),
                          "parameters": .array(parameters), "acceptsBody": .bool(!read && action.body)]
        perform("Added, and switched off. Switch it on when you're happy with it.") { api in
            _ = try await api.request("/admin/custom-apis/\(try api.uuid(connection))/endpoints", method: "POST", body: body)
            adding = nil
        }
    }
}
