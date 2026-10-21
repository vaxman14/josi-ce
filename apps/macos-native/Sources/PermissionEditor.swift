import SwiftUI

struct PermissionEditSnapshot: Identifiable {
    let id = UUID()
    let policy: Wire
    let reference: Wire
    let origin: String
    let administrator: String
    var targets: Wire = .null
}

/// Only the selected settings change. Identities, targets and grant IDs retain
/// their exact Vault values, including revisions and prior usage accounting.
private struct PermissionGrantDraft: Identifiable {
    let original: Wire
    var id: String { original["id"].text }
    var mode: String
    var task: String
    var expiry: Date
    var duration: String
    var actions: String
    var bytes: String
    var unlimitedDuration: Bool
    var unlimitedActions: Bool
    var unlimitedBytes: Bool
    var removed = false

    init(_ value: Wire) {
        original = value; mode = value["mode"]["kind"].text; task = value["mode"]["taskId"].text
        expiry = Self.dateFormat.date(from: value["mode"]["expiresAt"].text) ?? Date().addingTimeInterval(3600)
        let limits = value["limits"]
        // Preserve millisecond precision in existing limits; the form names
        // the unit explicitly and never rounds an existing restriction up.
        func limit(_ key: String, fallback: String) -> String {
            if case .number(let value) = limits[key] { return String(format: "%.0f", value) }
            return fallback
        }
        duration = limit("maxTaskDurationMs", fallback: "3600000")
        actions = limit("maxActionsPerTask", fallback: "100")
        bytes = limit("maxBytesPerTask", fallback: "10485760")
        unlimitedDuration = limits != .null && limits["maxTaskDurationMs"] == .null
        unlimitedActions = limits != .null && limits["maxActionsPerTask"] == .null
        unlimitedBytes = limits != .null && limits["maxBytesPerTask"] == .null
    }
    static var dateFormat: ISO8601DateFormatter {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format
    }
    private func amount(_ text: String, unlimited: Bool) -> Wire? {
        if unlimited { return .null }
        guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }),
              let value = Int(text), value >= 0, value <= 9_007_199_254_740_991 else { return nil }
        return .number(Double(value))
    }
    var rule: Wire? {
        guard case .object(var value) = original else { return nil }
        switch mode {
        case "deny", "ask":
            value["mode"] = ["kind": .string(mode)]; value["limits"] = .null
        case "standing", "task", "until":
            guard let duration = amount(duration, unlimited: unlimitedDuration),
                  let actions = amount(actions, unlimited: unlimitedActions),
                  let bytes = amount(bytes, unlimited: unlimitedBytes) else { return nil }
            if mode == "task" {
                guard ProtectedWire.uuid(.string(task)) else { return nil }
                value["mode"] = ["kind": "task", "taskId": .string(task)]
            } else if mode == "until" {
                let previous = original["mode"]["expiresAt"]
                let expires = Self.dateFormat.date(from: previous.text) == expiry
                    ? previous : .string(Self.dateFormat.string(from: expiry))
                value["mode"] = ["kind": "until", "expiresAt": expires]
            } else { value["mode"] = ["kind": "standing"] }
            value["limits"] = ["maxTaskDurationMs": duration, "maxActionsPerTask": actions, "maxBytesPerTask": bytes]
        default: return nil
        }
        return .object(value)
    }
}

struct NativePermissionEditor: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    let snapshot: PermissionEditSnapshot
    @State private var enabled: Bool
    @State private var unmatched: String
    @State private var grants: [PermissionGrantDraft]
    @State private var validated: Wire = .null
    @State private var validationMessage = ""
    @State private var target = ""
    @State private var action = "computer.observe"
    @State private var modelTarget = ""
    @State private var browserTarget = ""
    @State private var browserAction = "browser.observe"
    @State private var browserOrigin = ""
    @State private var networkOrigin = ""
    @State private var networkClass = "public"

    init(snapshot: PermissionEditSnapshot) {
        self.snapshot = snapshot
        _enabled = State(initialValue: snapshot.policy["enabled"].flag)
        _unmatched = State(initialValue: snapshot.policy["unmatched"].text)
        _grants = State(initialValue: snapshot.policy["rules"].list.map(PermissionGrantDraft.init))
    }
    private var current: Bool {
        model.api?.origin.absoluteString == snapshot.origin
            && model.user["id"].text == snapshot.administrator
            && model.isAdministrator
            && model.automationSettings["permissions"]["reference"] == snapshot.reference
            && (snapshot.reference == .null || model.automationSettings["permissions"]["enforcementCurrent"].flag
                && !model.automationSettings["permissions"]["reconciliationRequired"].flag)
            && model.automationSettings["targets"]["reference"] == snapshot.targets["reference"]
            && !model.automationSettings["targets"]["reconciliationRequired"].flag
    }
    private var applications: [Wire] {
        snapshot.targets["applications"].list.filter { $0["identity"] == snapshot.policy["identity"] }
    }
    private var modelTargets: [Wire] {
        snapshot.targets["models"].list.filter { $0["identity"] == snapshot.policy["identity"] }
    }
    private var browserTargets: [Wire] {
        snapshot.targets["browsers"].list.filter { $0["identity"] == snapshot.policy["identity"] }
    }
    private func exactOrigin(_ origin: String) -> Bool {
        guard !origin.isEmpty, origin.utf8.count <= 2048,
              origin.range(of: "[\\s\\\\*]", options: .regularExpression) == nil,
              let parts = URLComponents(string: origin), ["https", "http"].contains(parts.scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.path.isEmpty, parts.query == nil, parts.fragment == nil else { return false }
        return parts.string == origin
    }
    private var draft: Wire? {
        guard case .object(var policy) = snapshot.policy else { return nil }
        let active = grants.filter { !$0.removed }
        let rules = active.compactMap(\.rule)
        guard rules.count == active.count else { return nil }
        policy["enabled"] = .bool(enabled); policy["unmatched"] = .string(unmatched); policy["rules"] = .array(rules)
        return .object(policy)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Edit Automation Permissions").font(.title2.bold())
                Spacer()
                Button("Close") { dismiss() }.disabled(model.busy)
            }.padding()
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("These permissions apply to one person, server, device and separate workspace. Cardinal Rules always restrict them.")
                    DisclosureGroup("Exact scope") {
                        ForEach(["userId", "serverId", "deviceId", "workspaceId"], id: \.self) { field in
                            Text(field.replacingOccurrences(of: "Id", with: "") + ": " + snapshot.policy["identity"][field].text)
                        }
                    }.font(.caption).textSelection(.enabled)
                    if !current {
                        Text("The saved permissions or connection changed. Close this editor and open the current settings before saving.")
                            .foregroundStyle(.orange)
                    }
                    Toggle("Enable automation within these permissions", isOn: $enabled)
                    Picker("When no rule matches", selection: $unmatched) {
                        Text("Deny").tag("deny")
                        Text("Ask for instructions").tag("ask")
                    }
                    Text("Deny and Ask take precedence over matching grants. Limits count the original task, including retries; editing a grant retains its previous usage.")
                        .font(.caption).foregroundStyle(.secondary)
                    if !applications.isEmpty {
                        GroupBox("Add an app permission") {
                            VStack(alignment: .leading, spacing: 10) {
                                Picker("Registered app", selection: $target) {
                                    Text("Choose an app").tag("")
                                    ForEach(Array(applications.enumerated()), id: \.offset) { _, app in
                                        Text(app["candidate"]["label"].text + " · " + String(app["applicationId"].text.prefix(8)))
                                            .tag(app["applicationId"].text)
                                    }
                                }
                                Picker("Action", selection: $action) {
                                    Text("Observe app windows").tag("computer.observe")
                                    Text("Interact with the app").tag("computer.interact")
                                    Text("Launch the app").tag("application.launch")
                                    Text("Close the app").tag("application.close")
                                }
                                Button("Add Rule") {
                                    guard current, let app = applications.first(where: { $0["applicationId"].text == target }),
                                          grants.filter({ !$0.removed }).count < 100 else { return }
                                    let rule: Wire = ["id": .string(UUID().uuidString.lowercased()), "action": .string(action),
                                        "scope": ["kind": "application", "applicationId": app["applicationId"],
                                                  "installationRevision": app["installationRevision"]],
                                        "mode": ["kind": "ask"], "limits": .null]
                                    grants.append(PermissionGrantDraft(rule))
                                }.disabled(!current || target.isEmpty || grants.filter({ !$0.removed }).count >= 100)
                                Text("New rules start with Ask. Choose an allowance and explicit limits below. Saving permissions does not make an unfinished executor available.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(8)
                        }
                    }
                    if !browserTargets.isEmpty {
                        GroupBox("Add a browser permission") {
                            VStack(alignment: .leading, spacing: 10) {
                                Picker("Registered browser profile", selection: $browserTarget) {
                                    Text("Choose a profile").tag("")
                                    ForEach(Array(browserTargets.enumerated()), id: \.offset) { _, profile in
                                        Text(profile["candidate"]["family"].text.capitalized + " · " + profile["candidate"]["label"].text)
                                            .tag(profile["profileId"].text)
                                    }
                                }
                                TextField("Exact site, for example https://example.com", text: $browserOrigin).textFieldStyle(.roundedBorder)
                                Picker("Operation", selection: $browserAction) {
                                    Text("Observe").tag("browser.observe")
                                    Text("Navigate").tag("browser.navigate")
                                    Text("Fill").tag("browser.fill")
                                    Text("Click or scroll (may change site data)").tag("browser.click")
                                    Text("Submit").tag("browser.submit")
                                    Text("Download").tag("browser.download")
                                    Text("Upload").tag("browser.upload")
                                }
                                Button("Add Browser Rule") {
                                    guard current, exactOrigin(browserOrigin),
                                          let profile = browserTargets.first(where: { $0["profileId"].text == browserTarget }),
                                          grants.filter({ !$0.removed }).count < 100 else { return }
                                    let rule: Wire = ["id": .string(UUID().uuidString.lowercased()), "action": .string(browserAction),
                                        "scope": ["kind": "browser", "browser": profile["candidate"]["family"],
                                                  "profileId": profile["profileId"], "origin": .string(browserOrigin)],
                                        "mode": ["kind": "ask"], "limits": .null]
                                    grants.append(PermissionGrantDraft(rule))
                                }.disabled(!current || browserTarget.isEmpty || !exactOrigin(browserOrigin) || grants.filter({ !$0.removed }).count >= 100)
                                Text("Use an exact site origin without a path or wildcard. New rules start with Ask. Network access, content sharing and unsupported operations need their own checks.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(8)
                        }
                    }
                    GroupBox("Add a network permission") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Exact destination, for example https://example.com", text: $networkOrigin)
                                .textFieldStyle(.roundedBorder)
                            Picker("Destination network", selection: $networkClass) {
                                Text("Public internet").tag("public")
                                Text("Private network").tag("private")
                                Text("This automation host (loopback)").tag("loopback")
                            }
                            Button("Add Network Rule") {
                                guard current, exactOrigin(networkOrigin), ["public", "private", "loopback"].contains(networkClass),
                                      grants.filter({ !$0.removed }).count < 100 else { return }
                                let rule: Wire = ["id": .string(UUID().uuidString.lowercased()), "action": "network.connect",
                                    "scope": ["kind": "network", "origin": .string(networkOrigin), "networkClass": .string(networkClass)],
                                    "mode": ["kind": "ask"], "limits": .null]
                                grants.append(PermissionGrantDraft(rule))
                            }.disabled(!current || !exactOrigin(networkOrigin) || grants.filter({ !$0.removed }).count >= 100)
                            Text("Use a destination without a path or wildcard. The connection must match both the destination and its actual network. New rules start with Ask; choose limits below.")
                                .font(.caption).foregroundStyle(.secondary)
                            Text("Network permission does not grant browser input, file transfers, credentials or model sharing. Guest networking is still being connected; saving this rule does not turn it on.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(8)
                    }
                    if !modelTargets.isEmpty {
                        GroupBox("Add a model transmission permission") {
                            VStack(alignment: .leading, spacing: 10) {
                                Picker("Registered model configuration", selection: $modelTarget) {
                                    Text("Choose a model").tag("")
                                    ForEach(Array(modelTargets.enumerated()), id: \.offset) { _, target in
                                        Text(target["candidate"]["providerId"].text + " / " + target["candidate"]["model"].text
                                             + " · " + String(target["configurationId"].text.prefix(8)))
                                            .tag(target["configurationId"].text)
                                    }
                                }
                                Button("Add Transmission Rule") {
                                    guard current, let target = modelTargets.first(where: { $0["configurationId"].text == modelTarget }),
                                          grants.filter({ !$0.removed }).count < 100 else { return }
                                    let rule: Wire = ["id": .string(UUID().uuidString.lowercased()), "action": "model.transmit",
                                        "scope": ["kind": "model", "configurationId": target["configurationId"],
                                                  "configurationRevision": target["configurationRevision"]],
                                        "mode": ["kind": "ask"], "limits": .null]
                                    grants.append(PermissionGrantDraft(rule))
                                }.disabled(!current || modelTarget.isEmpty || grants.filter({ !$0.removed }).count >= 100)
                                Text("This rule starts with Ask. Choose explicit per-task limits below. Observation access and transmission access are checked separately.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(8)
                        }
                    }
                    ForEach($grants) { $grant in
                        grantEditor($grant)
                    }
                    if grants.isEmpty { Text("This policy has no grants. Its unmatched-action setting applies.") }
                    if let draft {
                        Button("Check Changes") {
                            guard current, let api = model.api else { return }
                            let proposed = draft
                            validated = .null; validationMessage = ""
                            model.run {
                                let response = try await api.request("/admin/automation/permissions/validate",
                                    method: "POST", body: ["policy": proposed])
                                guard model.api === api, current else { return }
                                if response["validation"]["valid"].flag && response["validation"]["policy"] == proposed {
                                    validated = proposed
                                    validationMessage = "The settings are supported. Review the exact changes before saving them to the Vault."
                                } else { validationMessage = "These settings are not supported. Correct the fields before saving." }
                            }
                        }.disabled(model.busy || !current || draft == snapshot.policy)
                        if validated == draft, current, draft != snapshot.policy {
                            NativeProtectedChange(title: "Review and Save Permissions…",
                                change: ["kind": "automation.policy.replace", "policy": draft, "expected": snapshot.reference],
                                onSaved: { dismiss() })
                        }
                    } else {
                        Text("Enter whole nonnegative limits and choose a task for a task-only grant. Zero is an explicit limit; unlimited must be selected.")
                            .foregroundStyle(.orange)
                    }
                    if !validationMessage.isEmpty { Text(validationMessage).font(.callout).foregroundStyle(.secondary) }
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
                }.padding().disabled(model.busy)
            }
        }
        .frame(width: 730, height: 720)
        .interactiveDismissDisabled(model.busy)
        .onChange(of: draft) { _, _ in validated = .null; validationMessage = "" }
    }
    @ViewBuilder private func grantEditor(_ binding: Binding<PermissionGrantDraft>) -> some View {
        let grant = binding.wrappedValue
        GroupBox(grant.original["action"].text.replacingOccurrences(of: ".", with: " · ")) {
            VStack(alignment: .leading, spacing: 12) {
                if let app = applications.first(where: { $0["applicationId"] == grant.original["scope"]["applicationId"] }) {
                    Text(app["candidate"]["label"].text).font(.headline)
                    Text(app["candidate"]["bundlePath"].text).font(.caption).textSelection(.enabled)
                }
                if let target = modelTargets.first(where: { $0["configurationId"] == grant.original["scope"]["configurationId"] }) {
                    Text(target["candidate"]["providerId"].text + " / " + target["candidate"]["model"].text).font(.headline)
                    Text("Saved configuration: " + target["candidate"]["configurationVersion"].text).font(.caption)
                }
                if let profile = browserTargets.first(where: { $0["profileId"] == grant.original["scope"]["profileId"] }) {
                    Text(profile["candidate"]["family"].text.capitalized + " · " + profile["candidate"]["label"].text).font(.headline)
                    Text("Extension version: " + profile["candidate"]["extensionVersion"].text).font(.caption)
                }
                Text(permissionScope(grant.original["scope"])).textSelection(.enabled)
                Toggle("Remove this rule", isOn: binding.removed)
                if grant.removed {
                    Text("Removing a denial can widen access. The exact before-and-after review will show this removal.")
                        .font(.caption).foregroundStyle(.orange)
                } else {
                    Picker("Permission", selection: binding.mode) {
                        Text("Deny").tag("deny")
                        Text("Ask each time").tag("ask")
                        Text("Only one task").tag("task")
                        Text("Until a chosen time").tag("until")
                        Text("Standing permission").tag("standing")
                    }
                    if grant.mode == "task" {
                        Picker("Task", selection: binding.task) {
                            Text("Choose a task").tag("")
                            if !grant.task.isEmpty && !model.tasks.contains(where: { $0["id"].text == grant.task }) {
                                Text("Saved task: " + grant.task).tag(grant.task)
                            }
                            if snapshot.policy["identity"]["userId"] == model.user["id"] {
                                ForEach(model.tasks, id: \.identifier) { task in
                                    Text(task["title"].text.isEmpty ? task.identifier : task["title"].text).tag(task.identifier)
                                }
                            }
                        }
                    }
                    if grant.mode == "until" {
                        DatePicker("Permission expires", selection: binding.expiry, displayedComponents: [.date, .hourAndMinute])
                        Text("The time is shown in this Mac’s time zone. An expired grant cannot authorize work.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if ["standing", "task", "until"].contains(grant.mode) {
                        limitEditor("Task duration (milliseconds)", value: binding.duration, unlimited: binding.unlimitedDuration)
                        limitEditor("Actions per task", value: binding.actions, unlimited: binding.unlimitedActions)
                        limitEditor("Bytes per task", value: binding.bytes, unlimited: binding.unlimitedBytes)
                    }
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func limitEditor(_ label: String, value: Binding<String>, unlimited: Binding<Bool>) -> some View {
        HStack {
            TextField(label, text: value).textFieldStyle(.roundedBorder).disabled(unlimited.wrappedValue)
            Toggle("Unlimited", isOn: unlimited).fixedSize()
        }
    }
}
