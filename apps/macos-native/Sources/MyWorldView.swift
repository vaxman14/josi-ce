import AppKit
import SwiftUI

/// My World: everything about the person, in the Vault, fed by chat. The plain
/// facts show at once; a secret field is set through a secure box and shown again
/// only behind the person's password, on this screen, never in a conversation.
/// The "Josi knows" list is the person's to correct.
struct NativeMyWorldView: View {
    @EnvironmentObject var model: JosiModel
    @State private var world: Wire = .null
    @State private var loading = false
    @State private var error = ""
    @State private var note = ""
    @State private var filter = "all"
    @State private var adding = false
    @State private var addKind = "vehicle"
    @State private var addLabel = ""
    @State private var addValues: [String: String] = [:]
    @State private var password = ""
    @State private var knowsDraft = ""
    @State private var secretTarget: SecretTarget?
    @State private var revealed: Revealed?
    struct SecretTarget: Identifiable { let id = UUID(); let item: String; let key: String; let field: String; let itemLabel: String }
    struct Revealed: Identifiable { let id = UUID(); let title: String; let value: String }

    private var kinds: [Wire] { world["kinds"].list }
    private func spec(_ kind: String) -> Wire { kinds.first { $0["kind"].text == kind } ?? .null }
    private func label(_ spec: Wire, _ key: String) -> String {
        if let field = spec["fields"].list.first(where: { $0["key"].text == key }) { return field["label"].text }
        if let date = spec["dates"].list.first(where: { $0["key"].text == key }) { return date["label"].text }
        return key
    }
    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("My World").font(JosiFont.title2)
                    NativeLeanNote(text: "Who am I? Everything about you, kept in your Vault. Josi fills it in from conversation; secrets never pass through her.")
                }
                Spacer()
                Button(adding ? "Close" : "Add…") { adding.toggle() }.buttonStyle(JosiOutlineButtonStyle())
                Button("Refresh") { Task { await load() } }.buttonStyle(JosiOutlineButtonStyle())
            }
            NativeLeanStatus(loading: loading, error: error, note: note)
            if world == .null {
                if !loading { NativeLeanNote(text: "Your World has not loaded.") }
            } else {
                if adding { addCard }
                Picker("Show", selection: $filter) {
                    Text("Everything").tag("all")
                    ForEach(kinds, id: \.self["kind"].text) { Text($0["plural"].text).tag($0["kind"].text) }
                }.pickerStyle(.segmented).labelsHidden()
                let items = world["items"].list.filter { filter == "all" || $0["kind"].text == filter }
                if items.isEmpty {
                    JosiCard {
                        Text("Nothing here yet").font(JosiFont.headline)
                        NativeLeanNote(text: "Tell Josi about your life (“I just bought a 2026 Ford Explorer”, “Dana is my daughter”) or use Add. Secret fields, like a plate or a card number, are typed into a protected box, never into the chat.")
                    }
                }
                ForEach(items, id: \.identifier) { itemCard($0) }
                knowsCard
            }
        }
        .task { await load() }
        .onDisappear { password = "" }
        .sheet(item: $secretTarget) { target in
            MyWorldSecretSheet(target: target) { value in
                perform("\(target.field) saved.") { api in
                    _ = try await api.request("/my-world/items/\(try api.uuid(target.item))/secrets/\(target.key)", method: "PUT", body: ["value": .string(value)])
                }
            }.preferredColorScheme(.dark)
        }
        .sheet(item: $revealed) { shown in
            VStack(alignment: .leading, spacing: 14) {
                Text(shown.title).font(JosiFont.title3)
                Text(shown.value).font(.system(.title3, design: .monospaced)).textSelection(.enabled)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(JosiTheme.card, in: RoundedRectangle(cornerRadius: 10))
                NativeLeanNote(text: "Shown on this screen only. Josi never says it aloud or puts it in a conversation.")
                HStack {
                    Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(shown.value, forType: .string) }
                        .buttonStyle(JosiOutlineButtonStyle())
                    Spacer()
                    Button("Done") { revealed = nil }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).keyboardShortcut(.defaultAction)
                }
            }.padding(24).frame(width: 460).background(JosiTheme.deep).preferredColorScheme(.dark)
        }
    }

    private var addCard: some View {
        JosiCard {
            Text("Add to your World").font(JosiFont.headline)
            Picker("What kind of thing", selection: $addKind) {
                ForEach(kinds, id: \.self["kind"].text) { Text($0["label"].text).tag($0["kind"].text) }
            }.onChange(of: addKind) { addValues = [:] }
            TextField("Name, for example “2026 Ford Explorer” or “Dana”", text: $addLabel).textFieldStyle(JosiFieldStyle())
            let current = spec(addKind)
            ForEach(current["fields"].list.filter { !$0["secret"].flag }, id: \.self["key"].text) { field in
                VStack(alignment: .leading, spacing: 4) {
                    Text(field["label"].text).font(JosiFont.callout)
                    TextField(field["hint"].text, text: binding(field["key"].text)).textFieldStyle(JosiFieldStyle())
                }
            }
            ForEach(current["dates"].list, id: \.self["key"].text) { date in
                VStack(alignment: .leading, spacing: 4) {
                    Text(date["label"].text).font(JosiFont.callout)
                    TextField("YYYY-MM-DD", text: binding("date:" + date["key"].text)).textFieldStyle(JosiFieldStyle())
                }
            }
            let secretNames = current["fields"].list.filter { $0["secret"].flag }.map { $0["label"].text }
            if !secretNames.isEmpty {
                NativeLeanNote(text: "Secret fields (\(secretNames.joined(separator: ", "))) are set after saving, each in its own protected box.")
            }
            HStack {
                Button("Save", action: saveNew).buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Cancel") { adding = false; addValues = [:]; addLabel = "" }.buttonStyle(JosiOutlineButtonStyle())
            }
        }
    }
    private func binding(_ key: String) -> Binding<String> { Binding(get: { addValues[key] ?? "" }, set: { addValues[key] = $0 }) }

    private func itemCard(_ item: Wire) -> some View {
        let kindSpec = spec(item["kind"].text), name = item["label"].text, id = item.identifier
        let set = Set(item["secretsSet"].list.map(\.text))
        let secretKeys = item["secretKeys"].list.map(\.text)
        let unlocked = world["unlocked"].flag
        return JosiCard {
            HStack {
                Text(name).font(JosiFont.headline)
                Spacer()
                Text(kindSpec["label"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
            }
            ForEach(pairs(item["fields"]) + pairs(item["dates"]), id: \.0) { key, value in
                HStack(alignment: .top) {
                    Text(label(kindSpec, key)).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    Spacer()
                    Text(value).font(JosiFont.callout).textSelection(.enabled).multilineTextAlignment(.trailing)
                }
            }
            ForEach(secretKeys, id: \.self) { key in
                let field = label(kindSpec, key), isSet = set.contains(key)
                HStack {
                    Text(field + (isSet ? " · set, secret" : " · not set")).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    Spacer()
                    if isSet && unlocked {
                        Button("Show") { reveal(id, key: key, title: "\(field) for \(name)") }.buttonStyle(JosiOutlineButtonStyle())
                    }
                    Button(isSet ? "Replace…" : "Set…") {
                        if safeKey(key) { secretTarget = SecretTarget(item: id, key: key, field: field, itemLabel: name) }
                    }.buttonStyle(JosiOutlineButtonStyle())
                    if isSet {
                        Button("Clear") {
                            guard safeKey(key), nativeConfirm("Clear \(field)?", detail: "The saved value is removed from your World.", button: "Clear") else { return }
                            perform("") { api in _ = try await api.request("/my-world/items/\(try api.uuid(id))/secrets/\(key)", method: "DELETE") }
                        }.buttonStyle(JosiOutlineButtonStyle())
                    }
                }
            }
            if !unlocked, secretKeys.contains(where: set.contains) { unlockRow }
            HStack {
                Text("Updated " + Self.date(item["updatedAt"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                Spacer()
                Button("Remove…") {
                    guard nativeConfirm("Remove \(name) from your World?", detail: "Its facts, its secret fields and what Josi knows about it are removed.", button: "Remove") else { return }
                    perform("Removed \(name).") { api in _ = try await api.request("/my-world/items/\(try api.uuid(id))", method: "DELETE") }
                }.buttonStyle(JosiOutlineButtonStyle()).foregroundStyle(JosiTheme.error)
            }
        }
    }
    private var unlockRow: some View {
        HStack {
            SecureField("Your Josi password", text: $password).textFieldStyle(JosiFieldStyle()).onSubmit(unlock)
            Button("Unlock for Five Minutes", action: unlock).buttonStyle(JosiGoldButtonStyle(fullWidth: false))
        }
    }
    private var knowsCard: some View {
        JosiCard {
            Text("Josi knows").font(JosiFont.headline)
            NativeLeanNote(text: "What Josi knows from your World, in her own words. She reads this every time you talk; only you change it, here or by asking. Secret values are never in it.")
            let lines = world["memory"].list
            if lines.isEmpty { Text("Nothing yet.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            ForEach(lines, id: \.identifier) { line in
                HStack(alignment: .top) {
                    Text(line["content"].text).font(JosiFont.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Forget") {
                        let id = line.identifier
                        perform("") { api in _ = try await api.request("/my-world/memory/\(try api.uuid(id))", method: "DELETE") }
                    }.buttonStyle(JosiOutlineButtonStyle())
                }
            }
            HStack {
                TextField("Something Josi should know, in a sentence", text: $knowsDraft).textFieldStyle(JosiFieldStyle()).onSubmit(addKnows)
                Button("Add", action: addKnows).buttonStyle(JosiOutlineButtonStyle())
            }
        }
    }

    private func pairs(_ value: Wire) -> [(String, String)] {
        guard case .object(let map) = value else { return [] }
        return map.keys.sorted().compactMap { key in
            switch map[key] {
            case .string(let text)?: return text.isEmpty ? nil : (key, text)
            case .number(let n)?: return (key, n.rounded() == n ? String(Int(n)) : String(n))
            case .bool(let b)?: return (key, b ? "Yes" : "No")
            default: return nil
            }
        }
    }
    /// Field keys go into the path as they are, so only plain ones are used.
    private func safeKey(_ key: String) -> Bool {
        let ok = !key.isEmpty && key.count <= 64 && key.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-" }
        if !ok { error = "That field can’t be changed here. Ask Josi instead." }
        return ok
    }
    private static func date(_ iso: String) -> String {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func load() async {
        guard let api = model.api else { return }
        loading = true; defer { loading = false }
        do {
            let result = try await api.request("/my-world")
            guard model.api === api else { return }
            world = result; error = ""
            if !kinds.contains(where: { $0["kind"].text == addKind }), let first = kinds.first { addKind = first["kind"].text }
        } catch { self.error = nativeRouteMissing(error) ? "This server doesn’t have My World yet. Update it to the latest Josi." : error.localizedDescription }
    }
    private func perform(_ done: String, _ action: @escaping (JosiAPI) async throws -> Void) {
        guard let api = model.api else { return }
        note = ""; error = ""
        Task {
            do { try await action(api); note = done } catch { self.error = error.localizedDescription }
            await load()
        }
    }
    private func saveNew() {
        let name = addLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { error = "Give it a name."; return }
        var fields: [String: Wire] = [:], dates: [String: Wire] = [:]
        for (key, raw) in addValues {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines); guard !value.isEmpty else { continue }
            if key.hasPrefix("date:") { dates[String(key.dropFirst(5))] = .string(value) } else { fields[key] = .string(value) }
        }
        let kind = addKind
        perform("Added \(name) to your World.") { api in
            _ = try await api.request("/my-world/items", method: "POST", body: ["kind": .string(kind), "label": .string(name), "fields": .object(fields), "dates": .object(dates)])
        }
        adding = false; addValues = [:]; addLabel = ""
    }
    private func unlock() {
        let secret = password; password = ""
        guard !secret.isEmpty else { error = "Enter your password to show secret fields."; return }
        perform("Unlocked. Secret fields can be shown for five minutes.") { api in
            _ = try await api.request("/vault/unlock", method: "POST", body: ["password": .string(secret)])
        }
    }
    private func reveal(_ id: String, key: String, title: String) {
        guard safeKey(key), let api = model.api else { return }
        Task {
            do {
                let result = try await api.request("/my-world/items/\(try api.uuid(id))/secrets/\(key)/reveal", method: "POST", body: [:])
                revealed = Revealed(title: title, value: result["value"].text)
            } catch { self.error = error.localizedDescription; await load() }
        }
    }
    private func addKnows() {
        let text = knowsDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 3 else { return }
        knowsDraft = ""
        perform("") { api in _ = try await api.request("/my-world/memory", method: "POST", body: ["content": .string(text)]) }
    }
}

/// One secret value for a World item, typed here and sent straight to the Vault.
struct MyWorldSecretSheet: View {
    @Environment(\.dismiss) private var dismiss
    let target: NativeMyWorldView.SecretTarget
    let save: (String) -> Void
    @State private var value = ""
    @State private var show = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(target.field) for \(target.itemLabel)").font(JosiFont.title3)
            NativeLeanNote(text: "Typed here, sealed into your World. Josi never sees it, and it is shown again only on this page behind your password.")
            HStack(spacing: 8) {
                Group { if show { TextField("", text: $value) } else { SecureField("", text: $value) } }
                    .labelsHidden().textFieldStyle(JosiFieldStyle()).onSubmit(go).accessibilityLabel(target.field)
                Button("Paste") { if let text = NSPasteboard.general.string(forType: .string) { value = text.trimmingCharacters(in: .whitespacesAndNewlines) } }
                    .buttonStyle(JosiOutlineButtonStyle())
                Button(show ? "Hide" : "Show") { show.toggle() }.buttonStyle(JosiOutlineButtonStyle())
            }
            HStack {
                Spacer()
                Button("Cancel") { value = ""; dismiss() }.buttonStyle(JosiOutlineButtonStyle()).keyboardShortcut(.cancelAction)
                Button("Save", action: go).buttonStyle(JosiGoldButtonStyle(fullWidth: false)).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 480).background(JosiTheme.deep)
            .onDisappear { value = "" }
    }
    private func go() {
        let typed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return }
        value = ""; dismiss(); save(typed)
    }
}
