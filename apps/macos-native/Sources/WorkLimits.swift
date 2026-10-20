import SwiftUI

struct NativeWorkLimits: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    @State private var editing = false
    @State private var revision: Wire = .null
    @State private var limited = false
    @State private var runs = ""
    @State private var timed = false
    @State private var deadline = Date()
    private var saved: Wire { goal["automaticWork"] }
    private var valid: Bool { !limited || Int(runs).map { (0...10000).contains($0) } == true }
    var body: some View {
        if saved["runsUsed"] != .null {
            GroupBox("Work limits") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("\(saved["runsUsed"].integer) background runs used · "
                         + (saved["runLimit"] == .null ? "No goal-specific run limit" : "Total allowed: \(saved["runLimit"].integer)"))
                    Text(saved["deadline"] == .null ? "No goal-specific deadline." : "Deadline: " + nativeDate(saved["deadline"].text))
                    Text("Runs include queued and interrupted background work. Progress and Resume do not reset the count. These limits stop new background work; actions already sent may finish. Account limits and tool permissions still apply.")
                        .font(.caption).foregroundStyle(.secondary)
                    if editing {
                        RevisionNotice(current: goal["revision"], reviewed: $revision)
                        Toggle("Set a total background-run limit", isOn: $limited)
                        if limited { TextField("Total runs allowed — 0 to 10,000", text: $runs).textFieldStyle(.roundedBorder) }
                        Toggle("Set a background-work deadline", isOn: $timed)
                        if timed { DatePicker("Deadline in your local time", selection: $deadline) }
                        Text("Saving keeps paused work paused. If a limit was reached, save a larger allowance, then resume with instructions.")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("Save Limits") { save() }.disabled(model.busy || revision != goal["revision"] || !valid)
                            Button("Cancel Edit") { editing = false }.disabled(model.busy)
                        }
                    } else {
                        Button("Edit Work Limits") { edit() }.disabled(model.busy)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
        }
    }
    private func edit() {
        revision = goal["revision"]
        limited = saved["runLimit"] != .null
        runs = String(limited ? saved["runLimit"].integer : min(10000, saved["runsUsed"].integer + 12))
        timed = saved["deadline"] != .null
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        deadline = parser.date(from: saved["deadline"].text) ?? Date().addingTimeInterval(3600)
        editing = true
    }
    private func save() {
        guard valid, revision == goal["revision"] else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let snapshot = goal, body: [String: Wire] = [
            "runLimit": limited ? .number(Double(Int(runs)!)) : .null,
            "deadline": timed ? .string(formatter.string(from: deadline)) : .null,
        ]
        model.run { try await model.changeGoal(snapshot, endpoint: "limits", fields: body); editing = false }
    }
}
