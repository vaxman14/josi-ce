import SwiftUI

func nativeDate(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date.formatted(date: .abbreviated, time: .shortened) }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)?.formatted(date: .abbreviated, time: .shortened) ?? value
}

func nativeLines(_ value: String) -> [Wire] {
    value.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }.map(Wire.string)
}

struct NativeWorkDetails: View {
    let goal: Wire
    var body: some View {
        DisclosureGroup("Outcome, memory and activity") {
            VStack(alignment: .leading, spacing: 18) {
                Text("Finished means").font(.headline)
                ForEach(Array(goal["criteria"].list.enumerated()), id: \.offset) { _, item in
                    Text("• " + item.text).textSelection(.enabled)
                }
                if goal["ownerCheckpoint"] != .null {
                    GroupBox("Your saved correction") {
                        WorkNotes(notes: goal["ownerCheckpoint"])
                        Text("Josi keeps your correction separate from its own progress notes.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                GroupBox("Latest progress notes") { WorkNotes(notes: goal["checkpoint"]) }
                NativeWorkChannelProgress(goalId: goal.identifier)
                WorkMemoryControls(goal: goal)
                if !["completed", "cancelled"].contains(goal["state"].text) {
                    WorkOutcomeEditor(goal: goal)
                    if goal["retiredSteps"] != .null && goal["totalSteps"].integer > 1 { WorkRetirementEditor(goal: goal) }
                }
                WorkHistory(goal: goal, kind: "events", title: "Activity history")
                WorkHistory(goal: goal, kind: "plans", title: "Plan history")
                WorkHistory(goal: goal, kind: "outcomes", title: "Outcome history")
            }.padding(.top, 12)
        }
    }
}

struct WorkNotes: View {
    let notes: Wire
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(["decisions", "facts", "assumptions"], id: \.self) { key in
                if !notes[key].list.isEmpty {
                    Text(key == "facts" ? "Reported facts" : key.capitalized).font(.subheadline.bold())
                    ForEach(Array(notes[key].list.enumerated()), id: \.offset) { _, item in Text("• " + item.text).textSelection(.enabled) }
                }
            }
            if !notes["nextAction"].text.isEmpty { Text("Next action: " + notes["nextAction"].text).textSelection(.enabled) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
    }
}

struct RevisionNotice: View {
    let current: Wire
    @Binding var reviewed: Wire
    var body: some View {
        if current != reviewed {
            VStack(alignment: .leading, spacing: 8) {
                Text("Work changed while you were editing. Your edit is still here. Review the latest saved work above.")
                Button("I Reviewed the Change — Keep My Edit") { reviewed = current }
            }.font(.callout).foregroundStyle(.orange)
        }
    }
}

struct WorkMemoryControls: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    @State private var editing = false
    @State private var clearing = false
    @State private var revision: Wire = .null
    @State private var decisions = ""
    @State private var facts = ""
    @State private var assumptions = ""
    @State private var nextAction = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Work memory").font(.headline)
            Text("Notes help Josi continue. They cannot change permissions or Cardinal Rules. Keep secrets in the Vault.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button(goal["ownerCheckpoint"] == .null ? "Correct Notes" : "Edit Your Correction") { edit() }
                Button(goal["checkpointPinned"].flag ? "Unpin" : "Pin for Future Work") {
                    change(goal["checkpointPinned"].flag ? "unpin" : "pin")
                }
                Button("Clear Saved Notes…") { clearing = true }
            }.disabled(model.busy)
            if editing {
                RevisionNotice(current: goal["revision"], reviewed: $revision)
                TextField("Decisions — one per line", text: $decisions, axis: .vertical).lineLimit(2...6)
                TextField("Reported facts — one per line", text: $facts, axis: .vertical).lineLimit(2...6)
                TextField("Assumptions — one per line", text: $assumptions, axis: .vertical).lineLimit(2...6)
                TextField("Next action", text: $nextAction, axis: .vertical).lineLimit(2...4)
                Text("Up to 12 items per list.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Save Correction") { change("correct") }
                        .disabled(model.busy || revision != goal["revision"] || nextAction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel Edit") { editing = false }.disabled(model.busy)
                }
            }
        }.textFieldStyle(.roundedBorder)
        .confirmationDialog("Clear saved work notes?", isPresented: $clearing) {
            Button("Clear Notes and Correction", role: .destructive) { change("forget") }
        } message: {
            Text("The task, evidence and original conversation remain. Later work may save new progress notes.")
        }
    }
    private func edit() {
        let source = goal["ownerCheckpoint"] == .null ? goal["checkpoint"] : goal["ownerCheckpoint"]
        decisions = source["decisions"].list.map(\.text).joined(separator: "\n")
        facts = source["facts"].list.map(\.text).joined(separator: "\n")
        assumptions = source["assumptions"].list.map(\.text).joined(separator: "\n")
        nextAction = source["nextAction"].text; revision = goal["revision"]; editing = true
    }
    private func change(_ action: String) {
        var fields: [String: Wire] = ["action": .string(action)]
        if action == "correct" {
            guard revision == goal["revision"] else { return }
            fields["checkpoint"] = ["decisions": .array(nativeLines(decisions)), "facts": .array(nativeLines(facts)),
                                    "assumptions": .array(nativeLines(assumptions)), "nextAction": .string(nextAction)]
        }
        let snapshot = goal, body = fields
        model.run { try await model.changeGoal(snapshot, endpoint: "memory", fields: body); editing = false }
    }
}

struct WorkOutcomeEditor: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    @State private var editing = false
    @State private var revision: Wire = .null
    @State private var outcome = ""
    @State private var criteria = ""
    @State private var reason = ""
    @State private var continueWork = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Change Requested Outcome") {
                outcome = goal["title"].text; criteria = goal["criteria"].list.map(\.text).joined(separator: "\n")
                reason = ""; revision = goal["revision"]; continueWork = goal["state"].text != "paused"; editing = true
            }.disabled(model.busy)
            if editing {
                RevisionNotice(current: goal["revision"], reviewed: $revision)
                TextField("Requested outcome", text: $outcome, axis: .vertical).lineLimit(2...4)
                TextField("Finished means — one criterion per line", text: $criteria, axis: .vertical).lineLimit(3...8)
                TextField("What changed, and what should Josi do next?", text: $reason, axis: .vertical).lineLimit(2...5)
                Toggle("Let Josi review the plan and continue within existing permissions", isOn: $continueWork)
                Text("Completed work and original steps stay saved. Actions already sent may still finish.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button(continueWork ? "Save and Continue" : "Save Paused") {
                        let snapshot = goal
                        let body: [String: Wire] = ["outcome": .string(outcome), "criteria": .array(nativeLines(criteria)),
                                                    "reason": .string(reason), "continueWork": .bool(continueWork)]
                        model.run { try await model.changeGoal(snapshot, endpoint: "outcome", fields: body); editing = false }
                    }.disabled(model.busy || revision != goal["revision"] || [outcome, criteria, reason].contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                    Button("Cancel Edit") { editing = false }.disabled(model.busy)
                }
            }
        }.textFieldStyle(.roundedBorder)
    }
}

struct WorkRetirementEditor: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    @State private var editing = false
    @State private var revision: Wire = .null
    @State private var step = ""
    @State private var reason = ""
    @State private var continueWork = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Retire an Obsolete Step") {
                revision = goal["revision"]; step = ""; reason = ""
                continueWork = goal["state"].text != "paused"; editing = true
            }.disabled(model.busy)
            if editing {
                RevisionNotice(current: goal["revision"], reviewed: $revision)
                Picker("Step no longer required", selection: $step) {
                    Text("Choose a step").tag("")
                    ForEach(goal["steps"].list.filter { !["verified", "skipped"].contains($0["state"].text) }, id: \.identifier) { item in
                        Text(item["title"].text).tag(item.identifier)
                    }
                }
                TextField("Why is this step obsolete?", text: $reason, axis: .vertical).lineLimit(2...5)
                Toggle("Let Josi review the plan and continue within existing permissions", isOn: $continueWork)
                Text("The step stays in history and stops counting as required work. Uncertain actions must be resolved first.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Retire Step and Retain History") {
                        let snapshot = goal
                        let body: [String: Wire] = ["stepId": .string(step), "reason": .string(reason), "continueWork": .bool(continueWork)]
                        model.run { try await model.changeGoal(snapshot, endpoint: "retire-step", fields: body); editing = false }
                    }.disabled(model.busy || revision != goal["revision"] || step.isEmpty || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel Edit") { editing = false }.disabled(model.busy)
                }
            }
        }.textFieldStyle(.roundedBorder)
    }
}

struct WorkHistory: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    let kind: String
    let title: String
    @State private var expanded = false
    @State private var records: [Wire] = []
    @State private var before = 0
    @State private var loading = false
    @State private var error = ""
    private var revisionKey: String { kind == "events" ? "sequence" : kind == "plans" ? "plan_revision" : "outcome_revision" }
    private var oldest: Int { records.map { $0[revisionKey].integer }.filter { $0 > 0 }.min() ?? 0 }
    var body: some View {
        DisclosureGroup(title, isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(records.enumerated()), id: \.offset) { _, item in
                    GroupBox {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(kind == "events" ? item["summary"].text : kind == "plans" ? item["reason"].text : item["outcome"].text)
                                .textSelection(.enabled)
                            Text(nativeDate(item["created_at"].text)).font(.caption).foregroundStyle(.secondary)
                            if kind == "plans" {
                                ForEach(Array(item["steps"].list.enumerated()), id: \.offset) { _, step in
                                    Text("• " + step["title"].text).strikethrough(step["state"].text == "skipped")
                                }
                            }
                            if kind == "outcomes" {
                                Text(item["reason"].text).foregroundStyle(.secondary)
                                ForEach(Array(item["criteria"].list.enumerated()), id: \.offset) { _, criterion in Text("• " + criterion.text) }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(7)
                    }
                }
                if loading { ProgressView().controlSize(.small) }
                if !error.isEmpty { Text(error).foregroundStyle(.orange) }
                if !loading && records.isEmpty && error.isEmpty { Text("No saved entries.").foregroundStyle(.secondary) }
                HStack {
                    Button("Older") { before = oldest }.disabled(loading || oldest <= 1)
                    Button("Latest") { before = 0 }.disabled(loading || before == 0)
                }
            }.padding(.top, 10)
        }
        .task(id: "\(expanded):\(goal.identifier):\(goal["revision"].integer):\(before)") {
            guard expanded, let api = model.api, ["events", "plans", "outcomes"].contains(kind) else { return }
            loading = true; error = ""
            defer { loading = false }
            do {
                let id = try api.uuid(goal.identifier)
                let suffix = before > 0 ? "?before=\(before)" : kind == "events" ? "?after=\(max(0, goal["revision"].integer - 50))" : ""
                let result = try await api.request("/assistant/work-goals/\(id)/\(kind)\(suffix)")
                try Task.checkCancellation()
                guard model.api === api else { return }
                records = result[kind].list
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
        }
    }
}
