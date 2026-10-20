import AppKit
import SwiftUI
import Darwin

@MainActor enum NativeRecoveryFile {
    /// The owner selects the export. The recovery key has no automatic local
    /// store; the temporary export file is private from its first byte.
    static func save(key: String, fingerprint: String) throws -> Bool {
        guard !key.isEmpty else { throw JosiError(message: "The recovery key is unavailable.") }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Josi-Vault-Recovery.txt"
        guard panel.runModal() == .OK, let destination = panel.url else { return false }
        let directory = open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw JosiError(message: "Choose an accessible folder for your recovery copy.") }
        defer { Darwin.close(directory) }
        let temporary = ".josi-recovery-" + UUID().uuidString.lowercased()
        let descriptor = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw JosiError(message: "The private recovery copy could not be created.") }
        defer { Darwin.close(descriptor); unlinkat(directory, temporary, 0) }
        var bytes = Data("Josi Vault recovery key\n\n\(key)\n\nFingerprint: \(fingerprint)\n".utf8)
        defer { bytes.resetBytes(in: bytes.startIndex..<bytes.endIndex) }
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw JosiError(message: "The recovery copy could not be written.") }
            offset += count
        }
        guard fsync(descriptor) == 0, renameat(directory, temporary, directory, destination.lastPathComponent) == 0 else {
            throw JosiError(message: "The recovery copy could not be saved. Choose another location.")
        }
        return true
    }
}

struct NativeVaultRecovery: View {
    @EnvironmentObject var model: JosiModel
    @State private var show = false
    @State private var saved = false
    @State private var error = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Save Your Vault Recovery Key").font(.title2.bold())
            Text("Keep this recovery copy somewhere safe outside Josi. Losing both it and the installation key makes your Vault unrecoverable. This key will not be shown again.")
            Text("Fingerprint: " + model.vaultRecovery["fingerprint"].text).font(.caption).textSelection(.enabled)
            Toggle("Show recovery key", isOn: $show)
            if show { Text(model.vaultRecovery["recoveryKey"].text).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
            Button("Save Recovery Key…") {
                do { if try NativeRecoveryFile.save(key: model.vaultRecovery["recoveryKey"].text,
                    fingerprint: model.vaultRecovery["fingerprint"].text) { saved = true; error = "" } }
                catch { self.error = error.localizedDescription }
            }
            Toggle("I have saved my recovery key", isOn: $saved)
            Button("Done") { model.vaultRecovery = .null }.buttonStyle(.borderedProminent).disabled(!saved)
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
        }.padding(28).frame(width: 590).interactiveDismissDisabled()
    }
}

struct NativeVaultView: View {
    @EnvironmentObject var model: JosiModel
    @State private var tab = "personal"
    @State private var personal: Wire = .null
    @State private var status: Wire = .null
    @State private var inventory: Wire = .null
    @State private var migration: Wire = .null
    @State private var password = ""
    @State private var recovery = ""
    @State private var kind = "password"
    @State private var service = ""
    @State private var slot = "primary"
    @State private var label = ""
    @State private var value = ""
    @State private var note = ""
    @State private var generation = 0
    private let kinds = ["password", "api_key", "oauth_token", "secure_note", "recovery_code", "certificate", "private_key", "other"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("Vault").font(.largeTitle.bold())
                    Spacer()
                    Button("Refresh") { model.run { try await load() } }.disabled(model.busy)
                }
                Text("The Vault is the source of truth for credentials and permanent rules. Saved secret values are never returned to this screen.")
                    .foregroundStyle(.secondary)
                if model.isAdministrator {
                    Picker("Vault controls", selection: $tab) {
                        Text("My Credentials").tag("personal")
                        Text("Master Vault").tag("master")
                    }.pickerStyle(.segmented).disabled(model.busy)
                }
                if tab == "master", model.isAdministrator { masterView }
                else { personalView }
                if !note.isEmpty { Text(note).font(.callout).foregroundStyle(.secondary) }
            }.padding(30).frame(maxWidth: 900).frame(maxWidth: .infinity)
        }
        .task {
            while !Task.isCancelled {
                if !model.busy && NSApp.isActive {
                    do { try await load() }
                    catch is CancellationError { return }
                    catch { if !Task.isCancelled { model.error = error.localizedDescription } }
                }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .onDisappear { generation += 1; password = ""; recovery = ""; value = ""; personal = .null; status = .null; inventory = .null; migration = .null }
        .onChange(of: tab) { _, _ in password = ""; recovery = ""; value = ""; note = "" }
    }
    @ViewBuilder private var personalView: some View {
        if personal == .null {
            Text("Credential access is unavailable. Refresh to load current Vault status.").foregroundStyle(.secondary)
        } else if !personal["status"]["initialized"].flag {
            Text("The super administrator must initialize the Master Vault first.")
        } else if personal["status"]["locked"].flag {
            Text("The Master Vault is locked. Credential-dependent work needs the administrator to unlock it.")
        } else if !personal["box"]["unlocked"].flag {
            GroupBox("Unlock your credential list for five minutes") {
                VStack(alignment: .leading, spacing: 12) {
                    SecureField("Your Josi password", text: $password).textContentType(.password)
                    Button("Unlock") { perform("/vault/unlock", body: ["password": .string(password)]) }
                        .disabled(model.busy || password.isEmpty)
                }.textFieldStyle(.roundedBorder).padding(10)
            }
        } else {
            GroupBox("Store a credential") {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Type", selection: $kind) {
                        ForEach(kinds, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                    }
                    TextField("Service", text: $service)
                    TextField("Account or slot", text: $slot)
                    TextField("Label", text: $label)
                    SecureField("Secret", text: $value)
                    Button("Save Encrypted") { saveCredential() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || service.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.isEmpty)
                }.textFieldStyle(.roundedBorder).padding(10).disabled(model.busy)
            }
            GroupBox("Saved credentials") {
                VStack(alignment: .leading, spacing: 12) {
                    if personal["box"]["items"].list.isEmpty { Text("No saved credentials.") }
                    ForEach(personal["box"]["items"].list, id: \.identifier) { item in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item["label"].text).font(.headline)
                                Text(item["service"].text + " · " + item["slot"].text).font(.caption).foregroundStyle(.secondary)
                                Text("Updated " + nativeDate(item["updatedAt"].text)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Check") {
                                guard let api = model.api, let id = try? api.uuid(item.identifier) else { return }
                                perform("/vault/items/\(id)/test", body: [:], success: "Encrypted value integrity verified. Provider access was not tested.")
                            }
                            Button("Delete…", role: .destructive) {
                                guard let api = model.api, let id = try? api.uuid(item.identifier) else { return }
                                guard confirm("Delete \(item["label"].text)?",
                                    detail: "This removes the saved credential from your Vault. Connections that use it may stop working.", button: "Delete Credential") else { return }
                                perform("/vault/items/\(id)", method: "DELETE", body: nil, success: "Credential deleted.")
                            }
                        }.disabled(model.busy)
                        Divider()
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }
        }
    }
    @ViewBuilder private var masterView: some View {
        if status == .null {
            Text("Master Vault status is unavailable. Refresh before changing it.")
        } else {
            GroupBox("Master Vault status") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(!status["initialized"].flag ? "Not initialized" : status["locked"].flag ? "Locked" : "Available").font(.headline)
                    Text("\(status["boxes"].integer) user boxes · \(status["items"].integer) credentials · Key version \(status["keyVersion"].integer)")
                    if status["recoveryFingerprint"] != .null {
                        Text("Recovery fingerprint: " + status["recoveryFingerprint"].text).font(.caption).textSelection(.enabled)
                    }
                    Text("\(status["recentFailures"].integer) credential failures in the last 24 hours").font(.caption)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }
            GroupBox(status["initialized"].flag ? "Emergency lock" : "Initialize Master Vault") {
                VStack(alignment: .leading, spacing: 12) {
                    Text(status["initialized"].flag
                         ? "Locking blocks new use of saved credentials. Work already sent to a service may finish."
                         : "Create the Vault and save its one-time recovery key before continuing.")
                    SecureField("Administrator password", text: $password).textContentType(.password)
                    if status["initialized"].flag {
                        Button(status["locked"].flag ? "Unlock Master Vault" : "Lock Master Vault") {
                            perform("/admin/vault/lock", method: "PUT", body: ["password": .string(password), "locked": .bool(!status["locked"].flag)])
                        }.disabled(model.busy || password.isEmpty)
                    } else {
                        Button("Initialize and Show Recovery Key") {
                            perform("/admin/vault/initialize", body: ["password": .string(password)], initialization: true)
                        }.disabled(model.busy || password.isEmpty)
                    }
                }.textFieldStyle(.roundedBorder).padding(10)
            }
            if status["initialized"].flag {
                GroupBox("Upgrade stored credentials") {
                    VStack(alignment: .leading, spacing: 12) {
                        if inventory != .null {
                            Text("\(inventory["sources"].list.reduce(0) { $0 + $1["legacyFields"].integer }) credentials still use older encryption.")
                        }
                        Text("Migrate while the original installation key is available. Existing permissions stay unchanged.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Check and Migrate Credentials") {
                            perform("/admin/vault/migration", body: ["password": .string(password)], isMigration: true)
                        }.disabled(model.busy || password.isEmpty || status["locked"].flag)
                        if migration != .null {
                            Text("\(migration["migrated"].integer) migrated · \(migration["checked"].integer) already current · \(migration["failed"].integer) need attention")
                            Text(migration["legacyMigrationComplete"].flag
                                 ? "Stored credentials migrated. Provider access and recovery were not tested."
                                 : "Unlock affected boxes or repair unavailable credentials, then run migration again.").font(.caption)
                        }
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox("Offline recovery") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Use after restoring or replacing the installation key. Recovery preserves the Vault key; automation authority must still be reconciled.")
                        SecureField("Vault recovery key", text: $recovery)
                        Button("Recover Master Vault…") {
                            guard confirm("Recover the Master Vault?",
                                detail: "Use this recovery key to restore access with the current installation key. Permanent automation rules and enrolled devices still require recovery reconciliation.", button: "Recover Vault") else { return }
                            perform("/admin/vault/recover", body: ["password": .string(password), "recoveryKey": .string(recovery)])
                        }.disabled(model.busy || password.isEmpty || recovery.isEmpty)
                    }.textFieldStyle(.roundedBorder).padding(10)
                }
            }
        }
    }
    private func load() async throws {
        guard let api = model.api else { return }
        let user = model.user["id"], admin = model.isAdministrator
        let started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == user }
        // Master health stays reachable even if the user's box cannot open.
        if admin {
            do {
                let state = try await api.request("/admin/vault")
                guard current() else { return }; status = state["status"]
                let migration = try await api.request("/admin/vault/migration")
                guard current() else { return }; inventory = migration
            } catch {
                guard current() else { return }
                status = .null; inventory = .null; personal = .null; throw error
            }
        }
        do {
            let result = try await api.request("/vault")
            guard current() else { return }; personal = result
            if !result["box"]["unlocked"].flag { value = "" }
        } catch {
            guard current() else { return }; personal = .null
            if tab == "personal" { throw error }
        }
    }
    private func perform(_ route: String, method: String = "POST", body: Wire?,
                         success: String = "Vault updated.", initialization: Bool = false, isMigration: Bool = false) {
        guard let api = model.api else { return }
        let user = model.user["id"]
        generation += 1; password = ""; recovery = ""; value = ""; note = ""
        model.run {
            let result = try await api.request(route, method: method, body: body)
            guard model.api === api, model.user["id"] == user else { return }
            if initialization {
                guard !result["recoveryKey"].text.isEmpty, !result["fingerprint"].text.isEmpty else {
                    throw JosiError(message: "The recovery response was not confirmed. Inspect Vault status before retrying.")
                }
                model.vaultRecovery = result
            }
            if isMigration { migration = result }
            note = success
            try await load()
        }
    }
    private func saveCredential() {
        let name = service.trimmingCharacters(in: .whitespacesAndNewlines)
        let account = slot.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.count <= 80, account.count <= 120, label.count <= 160 else {
            model.error = "Use a shorter service, account or label."; return
        }
        if let existing = personal["box"]["items"].list.first(where: { $0["service"].text == name && $0["slot"].text == account }) {
            guard confirm("Replace \(existing["label"].text)?",
                detail: "This service and account already have a saved credential. Saving replaces that secret.", button: "Replace Credential") else { return }
        }
        perform("/vault/items", body: ["kind": .string(kind), "service": .string(name), "slot": .string(account),
            "label": .string(label), "value": .string(value)], success: "Credential saved in the Vault.")
    }
    private func confirm(_ title: String, detail: String, button: String) -> Bool {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: button)
        return alert.runModal() == .alertSecondButtonReturn
    }
}
