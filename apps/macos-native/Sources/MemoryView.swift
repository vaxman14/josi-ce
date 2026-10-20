import SwiftUI

struct NativeMemoryView: View {
    @EnvironmentObject var model: JosiModel
    @State private var memories: [Wire] = []
    @State private var suggestions: [Wire] = []
    @State private var savedMode = ""
    @State private var mode = "manual"
    @State private var added = ""
    @State private var loading = false
    @State private var notice = ""
    @State private var generation = UUID()
    @State private var deleting: Wire = .null
    @State private var source: Wire = .null
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                JosiHeading(title: "Memory", subtitle: "Review what Josi remembers and the lessons it proposes.")
                Text("Memories help future work. They cannot change permissions or Cardinal Rules. Keep credentials in the Vault.")
                    .font(.callout).foregroundStyle(.secondary)
                if loading { ProgressView().controlSize(.small) }
                if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
                GroupBox("Learning preferences") {
                    VStack(alignment: .leading, spacing: 12) {
                        Picker("New memories", selection: $mode) {
                            Text("Review suggestions").tag("manual")
                            Text("Remember conversation facts automatically").tag("automatic")
                            Text("Do not learn new memories").tag("off")
                        }.disabled(model.busy || loading)
                        Text("Lessons from completed work always require your review. These settings do not clear existing memories or unfinished work and its saved progress.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Save Learning Preference") {
                            let desired = mode, expected = savedMode
                            perform { api, owner, stamp in
                                let current = try await api.request("/persona/settings")
                                try requireCurrent(api, owner, stamp)
                                guard current["settings"]["memory_mode"].text == expected else { throw changed() }
                                _ = try await api.request("/persona/settings", method: "PUT", body: ["memoryMode": .string(desired)])
                                try requireCurrent(api, owner, stamp)
                                notice = "Learning preference saved."; try await load(api, owner, stamp)
                            }
                        }.disabled(model.busy || loading || savedMode.isEmpty || savedMode == mode)
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                if !suggestions.isEmpty {
                    Text("Proposed memories and lessons").font(.title2.bold())
                    ForEach(suggestions, id: \.identifier) { item in
                        NativeMemorySuggestion(item: item, busy: model.busy || loading,
                            source: { source = item }, decide: { accept, content, expected in
                                mutate(expected, suggestions: true, suffix: "/decide", method: "POST",
                                       body: ["accept": .bool(accept), "content": .string(content)])
                            })
                    }
                }
                Text("Saved memories").font(.title2.bold())
                TextField("Something Josi should remember", text: $added, axis: .vertical).lineLimit(2...5)
                    .textFieldStyle(.roundedBorder).disabled(model.busy || loading)
                Button("Add Memory") {
                    let content = added.trimmingCharacters(in: .whitespacesAndNewlines)
                    perform { api, owner, stamp in
                        _ = try await api.request("/persona/memories", method: "POST", body: ["content": .string(content)])
                        try requireCurrent(api, owner, stamp)
                        added = ""; notice = "Memory saved."; try await load(api, owner, stamp)
                    }
                }.disabled(model.busy || loading || added.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || added.utf16.count > 2000)
                if memories.isEmpty && !loading { Text("No saved memories.").foregroundStyle(.secondary) }
                ForEach(memories, id: \.identifier) { item in
                    NativeSavedMemory(item: item, busy: model.busy || loading,
                        source: { source = item }, remove: { deleting = item },
                        change: { expected, body in mutate(expected, body: body) })
                }
                Button("Refresh") { perform { api, owner, stamp in try await load(api, owner, stamp) } }.disabled(model.busy || loading)
            }.padding(28)
        }
        .task(id: "\(model.api?.origin.absoluteString ?? ""):\(model.user["id"].text)") {
            let stamp = UUID(); generation = stamp
            memories = []; suggestions = []; savedMode = ""; added = ""; notice = ""
            guard let api = model.api else { return }
            let owner = model.user["id"]
            loading = true
            defer { if generation == stamp, !Task.isCancelled { loading = false } }
            do { try await load(api, owner, stamp) }
            catch is CancellationError {} catch {
                if generation == stamp, !Task.isCancelled { notice = "Saved memory could not load. Refresh to try again." }
            }
        }
        .onDisappear { generation = UUID(); added = ""; source = .null; deleting = .null }
        .confirmationDialog("Delete this saved memory?", isPresented: Binding(get: { deleting != .null }, set: { if !$0 { deleting = .null } })) {
            let item = deleting
            Button("Delete Memory", role: .destructive) { deleting = .null; mutate(item, method: "DELETE") }
        } message: { Text("This deletes the saved memory. Its source conversation, task and backups remain.") }
        .sheet(isPresented: Binding(get: { source != .null }, set: { if !$0 { source = .null } })) {
            NativeMemorySource(source: source) { self.source = .null }.environmentObject(model)
        }
    }
    private func changed() -> JosiError { JosiError(message: "Saved memory changed. Refresh and review it before applying your edit.") }
    private func requireCurrent(_ api: JosiAPI, _ owner: Wire, _ stamp: UUID) throws {
        guard !Task.isCancelled, model.api === api, model.user["id"] == owner, generation == stamp else { throw CancellationError() }
    }
    private func load(_ api: JosiAPI, _ owner: Wire, _ stamp: UUID) async throws {
        let saved = try await api.request("/persona/memories")
        let pending = try await api.request("/persona/suggestions")
        let settings = try await api.request("/persona/settings")
        try requireCurrent(api, owner, stamp)
        let value = settings["settings"]["memory_mode"].text
        guard ["manual", "automatic", "off"].contains(value) else { throw changed() }
        let previousMode = savedMode
        memories = saved["memories"].list; suggestions = pending["suggestions"].list; savedMode = value
        if previousMode.isEmpty || mode == previousMode { mode = value }
    }
    private func perform(_ action: @escaping @MainActor (JosiAPI, Wire, UUID) async throws -> Void) {
        guard let api = model.api, !model.busy, !loading else { return }
        let owner = model.user["id"], stamp = generation
        notice = ""
        model.run { try requireCurrent(api, owner, stamp); try await action(api, owner, stamp) }
    }
    private func mutate(_ expected: Wire, suggestions pending: Bool = false, suffix: String = "",
                        method: String = "PUT", body: Wire = [:]) {
        perform { api, owner, stamp in
            let collection = pending ? "suggestions" : "memories", id = try api.uuid(expected["id"].text)
            let latest = try await api.request("/persona/\(collection)")
            try requireCurrent(api, owner, stamp)
            guard latest[collection].list.first(where: { $0["id"] == expected["id"] }) == expected else { throw changed() }
            _ = try await api.request("/persona/\(collection)/\(id)\(suffix)", method: method, body: body)
            try requireCurrent(api, owner, stamp)
            notice = pending ? "Your memory decision was saved." : "Saved memory updated."
            try await load(api, owner, stamp)
        }
    }
}

struct NativeMemorySuggestion: View {
    let item: Wire
    let busy: Bool
    let source: () -> Void
    let decide: (Bool, String, Wire) -> Void
    @State private var draft = ""
    @State private var reviewed: Wire = .null
    var body: some View {
        GroupBox(item["work_goal_id"] == .null ? "Proposed memory" : "Lesson from completed work") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Review and correct this proposal", text: $draft, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder)
                if reviewed != item {
                    Text("The saved proposal changed. Your edit is still here. Review the current wording below.").foregroundStyle(.orange)
                    Text(item["content"].text).textSelection(.enabled)
                    Button("I Reviewed It — Keep My Edit") { reviewed = item }
                }
                if ProtectedWire.uuid(item["work_goal_id"]) { Button("View Source Work") { source() } }
                HStack {
                    Button("Keep This Memory") { decide(true, draft, reviewed) }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 2000)
                    Button("Discard Proposal") { decide(false, "", reviewed) }
                }.disabled(reviewed != item)
                Text("Edits are saved only when you keep the memory.").font(.caption).foregroundStyle(.secondary)
            }.padding(8).disabled(busy)
        }
        .onAppear { if reviewed == .null { reviewed = item; draft = item["content"].text } }
    }
}

struct NativeSavedMemory: View {
    let item: Wire
    let busy: Bool
    let source: () -> Void
    let remove: () -> Void
    let change: (Wire, Wire) -> Void
    @State private var editing = false
    @State private var draft = ""
    @State private var reviewed: Wire = .null
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Text(item["content"].text).textSelection(.enabled)
                Text(item["provenance"].text).font(.caption).foregroundStyle(.secondary)
                if !item["confirmed_at"].text.isEmpty {
                    Text("Confirmed " + nativeDate(item["confirmed_at"].text)).font(.caption).foregroundStyle(.secondary)
                }
                if editing {
                    TextField("Correct memory", text: $draft, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
                    if reviewed != item {
                        Text("This memory changed. Review the current wording above before saving.").foregroundStyle(.orange)
                        Button("I Reviewed It — Keep My Edit") { reviewed = item }
                    }
                    HStack {
                        Button("Save Correction") { change(reviewed, ["content": .string(draft)]) }
                            .disabled(reviewed != item || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 2000)
                        Button("Cancel Edit") { editing = false; draft = "" }
                    }
                } else {
                    HStack {
                        Button("Correct") { reviewed = item; draft = item["content"].text; editing = true }
                        Button(item["pinned"].flag ? "Unpin" : "Pin") { change(item, ["pinned": .bool(!item["pinned"].flag)]) }
                        Button("Delete…", role: .destructive) { remove() }
                    }
                }
                if ProtectedWire.uuid(item["work_goal_id"]) { Button("View Source Work") { source() } }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8).disabled(busy)
        }
        .onChange(of: item) { _, next in
            if editing && next["content"].text == draft { editing = false; draft = "" }
        }
    }
}

struct NativeMemorySource: View {
    @EnvironmentObject var model: JosiModel
    let source: Wire
    let close: () -> Void
    @State private var goal: Wire = .null
    @State private var error = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("Source work").font(.title2.bold()); Spacer(); Button("Close") { close() } }
            if !error.isEmpty { Text(error).foregroundStyle(.orange) }
            if goal != .null {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(goal["title"].text).font(.headline)
                        Text("\(goal["verifiedSteps"].integer)/\(goal["totalSteps"].integer) steps verified · " + goal["state"].text)
                        Text("Finished means").font(.headline)
                        ForEach(Array(goal["criteria"].list.enumerated()), id: \.offset) { _, criterion in Text("• " + criterion.text) }
                        ForEach(goal["steps"].list, id: \.identifier) { step in
                            Text((step["state"].text == "verified" ? "✓ " : "• ") + step["title"].text)
                        }
                        Text("Lesson source revision: \(source["work_goal_revision"].integer) · Current saved revision: \(goal["revision"].integer)")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Open Original Conversation") {
                            model.run { try await model.selectThread(goal["threadId"].text); close() }
                        }.disabled(model.busy)
                    }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if error.isEmpty { ProgressView() }
        }.padding(24).frame(width: 660, height: 540)
        .task(id: source["work_goal_id"].text) {
            guard let api = model.api else { return }
            let owner = model.user["id"]
            do {
                let id = try api.uuid(source["work_goal_id"].text)
                let value = try await api.request("/assistant/work-goals/\(id)")
                try Task.checkCancellation()
                guard model.api === api, model.user["id"] == owner, value["goal"]["goalId"].text == id else { return }
                goal = value["goal"]
            } catch is CancellationError {} catch { self.error = "The original work is unavailable on this server." }
        }
    }
}
