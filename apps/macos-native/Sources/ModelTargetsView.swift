import SwiftUI

struct NativeModelTargetsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var candidates: [Wire] = []
    @State private var selected = ""
    @State private var workspace = ""
    @State private var visible = false
    @State private var loadedOrigin = ""
    @State private var loadedOwner = ""
    @State private var loaded = false
    private var registry: Wire { model.automationSettings["targets"] }
    private var workspaces: [Wire] {
        let values = registry["applications"].list + registry["models"].list
        return values.enumerated().filter { index, entry in
            !values.prefix(index).contains { $0["identity"] == entry["identity"] }
        }.map { $0.element["identity"] }
    }
    private var selection: Wire? {
        guard visible, loadedOrigin == model.api?.origin.absoluteString, loadedOwner == model.user["id"].text,
              let candidate = candidates.first(where: { $0["candidateId"].text == selected }),
              let identity = workspaces.first(where: { $0["workspaceId"].text == workspace }),
              identity["userId"] == model.user["id"], !registry["reconciliationRequired"].flag else { return nil }
        if registry["models"].list.contains(where: { $0["identity"] == identity
            && $0["candidate"]["configurationDigest"] == candidate["configurationDigest"] }) { return nil }
        return ["kind": "automation.target.register", "identity": identity, "candidate": candidate, "expected": registry["reference"]]
    }
    var body: some View {
        GroupBox("Models allowed to receive automation content") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Register an exact model configuration here, then add its transmission permission and limits. App-viewing permission alone does not allow sending the app’s contents to a model.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Refresh Configured Models") { model.run { try await load() } }
                if loaded && candidates.isEmpty {
                    Text("No eligible model is available. Activate a tested model with an explicit model name in Models. ChatGPT subscriptions are supported; Claude subscriptions cannot receive automation captures yet.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !candidates.isEmpty {
                    Picker("Configured model", selection: $selected) {
                        Text("Choose a model").tag("")
                        ForEach(Array(candidates.enumerated()), id: \.offset) { _, candidate in
                            Text(candidate["role"].text.capitalized + ": " + candidate["providerId"].text + " / " + candidate["model"].text)
                                .tag(candidate["candidateId"].text)
                        }
                    }
                    Picker("Separate workspace", selection: $workspace) {
                        Text("Choose a workspace").tag("")
                        ForEach(Array(workspaces.enumerated()), id: \.offset) { _, identity in
                            Text(identity["workspaceId"].text).tag(identity["workspaceId"].text)
                        }
                    }
                    if workspaces.isEmpty {
                        Text("Register an app from your separate desktop first to identify its workspace.").font(.caption)
                    }
                }
                if let change = selection {
                    let candidate = change["candidate"]
                    Text(candidate["baseUrl"] == .null ? "Endpoint: provider default" : "Endpoint: " + candidate["baseUrl"].text)
                        .font(.caption).textSelection(.enabled)
                    Text("Saved model version: " + candidate["configurationVersion"].text).font(.caption).foregroundStyle(.secondary)
                    Text("Saving changes the Vault’s authority version and closes any open development desktop. Reopen it after configuring permissions.")
                        .font(.caption).foregroundStyle(.secondary)
                    NativeProtectedChange(title: "Register This Model Destination…", change: change,
                        onSaved: { selected = "" },
                        checkSelection: {
                            guard visible, selection == change else { throw JosiError(message: "The selected model or workspace changed. Review the current destination.") }
                        }, requiredDevice: change["identity"]["deviceId"].text)
                } else if !selected.isEmpty && !workspace.isEmpty {
                    Text("This configuration is already registered, or the selection changed. Use its saved target below or refresh the available models.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array(registry["models"].list.enumerated()), id: \.offset) { _, target in
                    Divider()
                    Text(target["candidate"]["providerId"].text + " / " + target["candidate"]["model"].text).font(.headline)
                    Text("Workspace: " + target["identity"]["workspaceId"].text).font(.caption).textSelection(.enabled)
                    Text("Saved model version: " + target["candidate"]["configurationVersion"].text).font(.caption)
                }
                Text("Changing the saved model configuration requires registering its new destination. Existing grants do not move to it. A fallback needs its own permission.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(10).disabled(model.busy)
        }
        .task { visible = true; do { try await load() } catch { model.error = error.localizedDescription } }
        .onDisappear { visible = false; candidates = []; selected = ""; workspace = ""; loaded = false }
    }
    private func load() async throws {
        guard let api = model.api, model.isAdministrator else { return }
        let owner = model.user["id"]
        let result = try await api.request("/admin/automation/model-target-candidates")
        guard visible, model.api === api, model.user["id"] == owner, !Task.isCancelled else { return }
        candidates = result["candidates"].list; selected = ""; loaded = true
        loadedOrigin = api.origin.absoluteString; loadedOwner = owner.text
    }
}
