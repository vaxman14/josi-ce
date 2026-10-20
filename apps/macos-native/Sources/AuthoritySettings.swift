import SwiftUI

private let scopeNames = ["userId": "People", "serverId": "Servers", "deviceId": "Devices",
                          "workspaceId": "Automation workspaces", "taskId": "Tasks"]

struct NativeAuthoritySettings: View {
    @EnvironmentObject var model: JosiModel
    @State private var tab = "rules"
    @State private var editing = false
    @State private var selected: Wire = .null
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Automation Settings").font(.title2.bold())
            Text("The Vault holds the authoritative rules, permission policies and protected device records. Only the super admin can change them.")
                .foregroundStyle(.secondary)
            Picker("Settings", selection: $tab) {
                Text("Cardinal Rules").tag("rules")
                Text("Permissions").tag("permissions")
                Text("Devices").tag("devices")
            }.pickerStyle(.segmented).disabled(model.busy)
            if model.automationSettings == .null {
                Text("Current Vault settings are unavailable. Refresh before making a change.").foregroundStyle(.orange)
            } else if tab == "rules" {
                Text(model.automationCatalog["guidance"].text.isEmpty
                     ? "Specify the exact action, scope, restriction and what happens when required facts are unavailable."
                     : model.automationCatalog["guidance"].text)
                authorityWarning(model.automationSettings["rules"])
                ForEach(Array(model.automationSettings["rules"]["document"]["rules"].list.enumerated()), id: \.offset) { _, item in
                    GroupBox("Permanent rule") {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(item["definition"]["label"].text).font(.headline)
                            Text(item["definition"]["wording"].text).textSelection(.enabled)
                            Text("Definition version \(item["source"]["version"].integer)").font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }
                }
                HStack {
                    Text("Saved drafts").font(.headline)
                    Spacer()
                    Button("New Rule") { selected = .null; editing = true }
                        .disabled(model.busy || model.automationCatalog == .null)
                }
                ForEach(Array(model.automationSettings["drafts"].list.enumerated()), id: \.offset) { _, draft in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(draft["document"]["draft"]["label"].text).font(.headline)
                            Text("Version \(draft["reference"]["version"].integer) · Inactive draft").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Open Draft") {
                            guard editableRule(draft["document"]["draft"], catalog: model.automationCatalog) else {
                                model.error = "This draft uses fields this app cannot edit safely. It remains unchanged in the Vault."
                                return
                            }
                            selected = draft; editing = true
                        }.disabled(model.busy)
                    }
                }
                if editing, model.automationCatalog != .null {
                    NativeRuleEditor(initial: selected, catalog: model.automationCatalog) { saved in
                        selected = saved
                        try await model.loadAutomation()
                    }
                    .id(selected == .null ? "new" : selected["reference"]["recordId"].text + ":" + String(selected["reference"]["version"].integer))
                }
            } else if tab == "permissions" {
                authorityWarning(model.automationSettings["permissions"])
                Text("Every grant belongs to an exact person, server, device and separate workspace. Cardinal Rules restrict all grants.")
                    .foregroundStyle(.secondary)
                let policies = model.automationSettings["permissions"]["document"]["policies"].list
                if policies.isEmpty { Text("No automation grants are active.") }
                ForEach(Array(policies.enumerated()), id: \.offset) { _, policy in
                    GroupBox(policy["enabled"].flag ? "Enabled policy" : "Disabled policy") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(["userId", "serverId", "deviceId", "workspaceId"], id: \.self) { key in
                                Text("\(scopeNames[key] ?? key): \(policy["identity"][key].text)").textSelection(.enabled)
                            }
                            Text("Unmatched actions: " + (policy["unmatched"].text == "deny" ? "Deny" : "Ask for instructions"))
                            ForEach(policy["rules"].list, id: \.identifier) { rule in
                                Divider()
                                Text(rule["action"].text.replacingOccurrences(of: ".", with: " · ")).font(.headline)
                                Text(permissionScope(rule["scope"])).textSelection(.enabled)
                                Text(permissionMode(rule["mode"])).foregroundStyle(.secondary)
                                if rule["limits"] != .null {
                                    Text("Per task: \(limit(rule["limits"]["maxActionsPerTask"])) actions · \(limit(rule["limits"]["maxBytesPerTask"])) bytes")
                                        .font(.caption)
                                    Text(rule["limits"]["maxTaskDurationMs"] == .null ? "No duration limit in this grant"
                                         : "Task duration limit: \(rule["limits"]["maxTaskDurationMs"].integer / 1000) seconds").font(.caption)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }
                }
                Text("Native permission changes and protected confirmation are not available in this checkpoint. Existing restrictions remain in force.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                let devices = model.automationSettings["devices"]
                if devices["reconciliationRequired"].flag { Text("Vault recovery must be reconciled before devices can approve changes.").foregroundStyle(.orange) }
                if devices["devices"].list.isEmpty { Text("No protected confirmation devices are enrolled.") }
                ForEach(Array(devices["devices"].list.enumerated()), id: \.offset) { _, device in
                    GroupBox(device["label"].text) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(device["revokedAt"] == .null ? "Enrolled" : "Revoked").font(.headline)
                            Text(device["identity"]["serverOrigin"].text)
                            Text("Enrolled " + nativeDate(device["enrolledAt"].text)).font(.caption)
                            DisclosureGroup("Verify device identity") {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Device: " + device["identity"]["deviceId"].text)
                                    Text("Signing key: " + device["signingFingerprint"].text)
                                    Text("Hardware key: " + device["wrappingFingerprint"].text)
                                }.font(.caption).textSelection(.enabled)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }
                }
                Text("Enrollment alone grants no browser or computer access. Native enrollment and revocation controls are not available in this checkpoint.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder private func authorityWarning(_ value: Wire) -> some View {
        if value != .null && (value["reconciliationRequired"].flag || !value["enforcementCurrent"].flag) {
            Text("This policy needs recovery reconciliation or revalidation before it can authorize work.").foregroundStyle(.orange)
        }
    }
    private func limit(_ value: Wire) -> String { value == .null ? "unlimited" : String(value.integer) }
}

private func editableRule(_ rule: Wire, catalog: Wire) -> Bool {
    guard case .object(let object) = rule,
          Set(object.keys) == Set(["schemaVersion", "label", "wording", "actions", "scope", "restriction", "onUnavailable"]),
          rule["schemaVersion"] == .number(1),
          case .object(let scopes) = rule["scope"],
          Set(scopes.keys) == Set(catalog["scopeKeys"].list.map(\.text)),
          case .object(let restriction) = rule["restriction"] else { return false }
    let actions = rule["actions"]
    guard actions == .string("*") || {
        guard case .array(let values) = actions else { return false }
        return values.allSatisfy { catalog["actions"].list.contains($0) }
    }() else { return false }
    for value in scopes.values {
        if value == .string("*") { continue }
        guard case .object(let selector) = value, Set(selector.keys) == ["ids"],
              case .array(let ids) = selector["ids"], ids.allSatisfy({ if case .string = $0 { return true }; return false })
        else { return false }
    }
    return (rule["restriction"]["kind"].text == "deny" && Set(restriction.keys) == ["kind"]
        || rule["restriction"]["kind"].text == "maximum_task_duration" && Set(restriction.keys) == ["kind", "seconds"])
        && ["deny", "pause"].contains(rule["onUnavailable"].text)
}

private func permissionMode(_ mode: Wire) -> String {
    switch mode["kind"].text {
    case "deny": return "Denied"
    case "ask": return "Ask each time"
    case "task": return "Only task " + mode["taskId"].text
    case "until": return "Allowed until " + nativeDate(mode["expiresAt"].text)
    case "standing": return "Standing permission within this exact scope"
    default: return "Unknown permission mode — refresh current settings."
    }
}
private func permissionScope(_ scope: Wire) -> String {
    switch scope["kind"].text {
    case "browser": return scope["browser"].text + ": " + scope["origin"].text + " · Profile " + scope["profileId"].text
    case "network": return scope["origin"].text + " · " + scope["networkClass"].text + " network"
    case "file": return "Folder " + scope["rootId"].text + ": /" + scope["segments"].list.map(\.text).joined(separator: "/") + (scope["descendants"].flag ? " and descendants" : "")
    case "application": return "Application " + scope["applicationId"].text + " · Installation " + scope["installationRevision"].text
    case "runtime": return "Runtime " + scope["runtimeId"].text + " · Sandbox " + scope["sandboxId"].text
    case "credential": return "Vault item " + scope["itemId"].text + " → " + permissionScope(scope["destination"])
    case "model": return "Model configuration " + scope["configurationId"].text
    case "workspace": return "This automation workspace"
    default: return "Unsupported scope. It has not been changed."
    }
}

struct NativeRuleEditor: View {
    @EnvironmentObject var model: JosiModel
    let initial: Wire
    let catalog: Wire
    let saved: @MainActor (Wire) async throws -> Void
    @State private var label: String
    @State private var wording: String
    @State private var allActions: Bool
    @State private var actions: Set<String>
    @State private var scopes: [String: String]
    @State private var restriction: String
    @State private var seconds: String
    @State private var unavailable: String
    @State private var password = ""
    @State private var mfa = ""
    @State private var check: Wire = .null
    @State private var preview: Wire = .null
    @State private var checkedDraft: Wire = .null
    @State private var previewedDraft: Wire = .null
    init(initial: Wire, catalog: Wire, saved: @escaping @MainActor (Wire) async throws -> Void) {
        self.initial = initial; self.catalog = catalog; self.saved = saved
        let rule = initial["document"]["draft"]
        _label = State(initialValue: rule["label"].text)
        _wording = State(initialValue: rule["wording"].text)
        _allActions = State(initialValue: rule["actions"].text == "*")
        _actions = State(initialValue: Set(rule["actions"].list.map(\.text)))
        _scopes = State(initialValue: Dictionary(uniqueKeysWithValues: catalog["scopeKeys"].list.map { key in
            (key.text, rule["scope"][key.text].text == "*" ? "*" : rule["scope"][key.text]["ids"].list.map(\.text).joined(separator: ", "))
        }))
        _restriction = State(initialValue: rule["restriction"]["kind"].text)
        _seconds = State(initialValue: rule["restriction"]["seconds"] == .null ? "" : String(rule["restriction"]["seconds"].integer))
        _unavailable = State(initialValue: rule["onUnavailable"].text)
    }
    private var draft: Wire {
        let scope: [String: Wire] = Dictionary(uniqueKeysWithValues: catalog["scopeKeys"].list.map { key in
            let value = scopes[key.text] ?? ""
            return (key.text, value == "*" ? .string("*") : .object(["ids": .array(value.split(separator: ",")
                .map { Wire.string($0.trimmingCharacters(in: .whitespacesAndNewlines)) }.filter { !$0.text.isEmpty })]))
        })
        return ["schemaVersion": .number(1), "label": .string(label), "wording": .string(wording),
                "actions": allActions ? "*" : .array(actions.sorted().map(Wire.string)), "scope": .object(scope),
                "restriction": restriction == "maximum_task_duration"
                    ? ["kind": .string(restriction), "seconds": Int(seconds).map { Wire.number(Double($0)) } ?? .null]
                    : ["kind": .string(restriction)], "onUnavailable": .string(unavailable)]
    }
    private var unchanged: Bool {
        guard initial != .null else { return false }
        var value = initial["document"]["draft"]
        if case .object(var object) = value, case .array(let list) = object["actions"] {
            object["actions"] = .array(list.sorted { $0.text < $1.text }); value = .object(object)
        }
        return value == draft
    }
    private var report: Wire {
        checkedDraft == draft ? check["report"] : unchanged ? initial["document"]["tested"]["report"] : .null
    }
    var body: some View {
        GroupBox(initial == .null ? "New rule draft" : "Edit rule draft") {
            VStack(alignment: .leading, spacing: 16) {
                TextField("Rule name", text: $label)
                TextField("Your exact wording", text: $wording, axis: .vertical).lineLimit(3...8)
                GroupBox("Actions covered") {
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle("Every supported action", isOn: $allActions)
                        if !allActions {
                            ForEach(catalog["actions"].list.map(\.text), id: \.self) { action in
                                Toggle(action.replacingOccurrences(of: ".", with: " · "), isOn: Binding(
                                    get: { actions.contains(action) }, set: { if $0 { actions.insert(action) } else { actions.remove(action) } }))
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                GroupBox("Where the rule applies") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(catalog["scopeKeys"].list.map(\.text), id: \.self) { key in
                            Picker(scopeNames[key] ?? key, selection: Binding(
                                get: { scopes[key] == "*" ? "all" : (scopes[key] ?? "").isEmpty ? "" : "selected" },
                                set: { scopes[key] = $0 == "all" ? "*" : $0 == "selected" ? " " : "" })) {
                                    Text("Choose explicitly").tag(""); Text("All").tag("all"); Text("Exact identities").tag("selected")
                            }
                            if scopes[key] != "*" && !(scopes[key] ?? "").isEmpty {
                                TextField("Identity IDs, separated by commas", text: Binding(get: { scopes[key] ?? "" }, set: { scopes[key] = $0.isEmpty ? " " : $0 }))
                            }
                        }
                    }.padding(8)
                }
                Picker("Restriction", selection: $restriction) {
                    Text("Choose explicitly").tag(""); Text("Block matching actions").tag("deny")
                    Text("Limit original task duration").tag("maximum_task_duration")
                }
                if restriction == "maximum_task_duration" { TextField("Maximum seconds, including retries", text: $seconds) }
                Picker("When required facts cannot be verified", selection: $unavailable) {
                    Text("Choose explicitly").tag(""); Text("Deny the action").tag("deny"); Text("Pause and ask").tag("pause")
                }
                HStack {
                    Button("Test Validity") { perform("check") }
                    Button("Preview Model Review") { perform("preview") }.disabled(!unchanged)
                }
                if report != .null {
                    GroupBox(report["status"].text == "passed" ? "Structured checks passed" : "The rule needs changes") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(report["issues"].list.enumerated()), id: \.offset) { _, issue in Text(issue["message"].text) }
                            if checkedDraft == draft { Text(check["meaning"].text).textSelection(.enabled) }
                            Text("\(report["cases"].list.filter { $0["passed"].flag }.count)/\(report["cases"].list.count) simulations passed")
                                .font(.caption).foregroundStyle(.secondary)
                            Text("These checks do not guarantee every real-world action can be enforced. Unsupported actions remain blocked.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }
                }
                if unchanged, initial["document"]["tested"] != .null {
                    let review = initial["document"]["tested"]["review"]
                    GroupBox("Saved model advice") {
                        VStack(alignment: .leading, spacing: 8) {
                            if review["status"].text == "available" {
                                Text(review["assessment"]["clarity"].text == "clear" ? "Meaning appears clear" : "Clarification suggested").font(.headline)
                                Text(review["assessment"]["summary"].text)
                                ForEach(Array((review["assessment"]["concerns"].list + review["assessment"]["suggestions"].list).enumerated()), id: \.offset) { _, item in Text("• " + item.text) }
                            } else { Text(review["message"].text) }
                            Text("The model advises you. It cannot approve or activate this rule.").font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8).textSelection(.enabled)
                    }
                }
                if previewedDraft == draft && preview != .null {
                    GroupBox("Exact content and destination for model review") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(preview["reviewer"]["providerId"].text + " · " + preview["reviewer"]["model"].text).font(.headline)
                            if preview["reviewer"]["external"].flag { Text("External provider").foregroundStyle(.orange) }
                            ForEach(["wording", "structuredMeaning", "guidance"], id: \.self) { key in Text(preview["input"][key].text) }
                            Text(preview["reason"].text).foregroundStyle(.secondary)
                            Text("Nothing has been sent to the model yet.").font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8).textSelection(.enabled)
                    }
                }
                Divider()
                Text("Verify this administrator action").font(.headline)
                SecureField("Administrator password", text: $password).textContentType(.password)
                SecureField("Authenticator code, if enabled", text: $mfa)
                HStack {
                    Button("Save Draft to Vault") { perform("save") }.disabled(password.isEmpty)
                    if previewedDraft == draft && preview != .null {
                        Button("Send Preview and Test Rule") { perform("test") }
                            .disabled(password.isEmpty || !unchanged || !preview["canTransmit"].flag)
                    }
                }
                Text("Saving a draft or requesting model advice never makes a rule permanent. Permanent approval requires the protected native confirmation, which is not connected in this checkpoint.")
                    .font(.caption).foregroundStyle(.secondary)
            }.textFieldStyle(.roundedBorder).padding(12).disabled(model.busy)
        }
        .onChange(of: draft) { _, _ in check = .null; preview = .null; checkedDraft = .null; previewedDraft = .null }
        .onDisappear { password = ""; mfa = ""; preview = .null; check = .null }
    }
    private func perform(_ operation: String) {
        guard let api = model.api, model.isAdministrator else { return }
        let current = draft, expected = initial["reference"], exactPreview = preview
        let credential = password, code = mfa
        password = ""; mfa = ""
        model.run {
            switch operation {
            case "check":
                let result = try await api.request("/admin/automation/rules/validate", method: "POST", body: ["draft": current])
                guard model.api === api else { return }; check = result; checkedDraft = current
            case "save":
                var fields: [String: Wire] = ["draft": current, "password": .string(credential), "mfaCode": .string(code)]
                if expected != .null { fields["expected"] = expected }
                let result = try await api.request("/admin/automation/rules/save", method: "POST", body: .object(fields))
                guard model.api === api else { return }; try await saved(result["draft"])
            case "preview":
                guard unchanged else { return }
                let id = try api.uuid(expected["recordId"].text)
                let result = try await api.request("/admin/automation/rules/\(id)/review-preview", method: "POST", body: ["expected": expected])
                guard model.api === api else { return }; preview = result; previewedDraft = current
            case "test":
                guard unchanged, previewedDraft == current, exactPreview["canTransmit"].flag else { return }
                let id = try api.uuid(expected["recordId"].text), reviewer = exactPreview["reviewer"]
                let identity: Wire = ["providerId": reviewer["providerId"], "model": reviewer["model"], "configurationVersion": reviewer["configurationVersion"]]
                let result = try await api.request("/admin/automation/rules/\(id)/test", method: "POST",
                    body: ["expected": expected, "approvedReviewInputDigest": exactPreview["inputDigest"],
                           "reviewerIdentity": identity, "password": .string(credential), "mfaCode": .string(code)])
                guard model.api === api else { return }; try await saved(result["draft"])
            default: break
            }
        }
    }
}
