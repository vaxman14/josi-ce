import SwiftUI

struct NativeServerHealth: View {
    @EnvironmentObject var model: JosiModel
    @State private var diagnosis: Wire = .null
    @State private var available: Bool?
    @State private var message = ""
    @State private var error = ""
    @State private var generation = 0
    private var checks: [Wire] {
        let values = diagnosis["checks"].list
        return values.filter { $0["state"].text == "fail" }
            + values.filter { $0["state"].text == "warn" }
            + values.filter { !["fail", "warn"].contains($0["state"].text) }
    }
    var body: some View {
        GroupBox("Connected server health") {
            VStack(alignment: .leading, spacing: 14) {
                Text(model.api?.origin.absoluteString ?? "").textSelection(.enabled)
                HStack {
                    Text(available == false ? "Diagnostics unavailable"
                         : diagnosis == .null ? "No current diagnosis"
                         : diagnosis["healthy"].flag ? "No failed checks" : "Needs attention").font(.headline)
                    Spacer()
                    Button("Run System Check") {
                        model.run { try await load(check: true) }
                    }.disabled(model.busy)
                }
                if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
                if !error.isEmpty { Text(error).foregroundStyle(.orange) }
                if diagnosis != .null {
                    Text("Checked " + nativeDate(diagnosis["checkedAt"].text)).font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                        DisclosureGroup {
                            Text(check["detail"].text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                        } label: {
                            HStack {
                                Image(systemName: check["state"].text == "pass" ? "checkmark.circle" : "exclamationmark.triangle")
                                    .foregroundStyle(check["state"].text == "pass" ? Color.green : Color.orange)
                                Text(check["label"].text)
                                Spacer()
                                Text(check["state"].text == "pass" ? "Working" : check["state"].text == "warn" ? "Attention" : "Needs repair")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Text("Local service changes use the controls below. For a server on another Mac, use Josi’s local controls on that Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(12)
        }.task { try? await load() }.onDisappear { generation += 1; diagnosis = .null }
    }
    private func load(check: Bool = false) async throws {
        guard model.isAdministrator, let api = model.api else { return }
        generation += 1; let started = generation
        let user = model.user["id"]
        error = ""
        do {
            let result = try await api.request(check ? "/admin/doctor/check" : "/admin/doctor",
                method: check ? "POST" : "GET", body: check ? [:] : nil)
            guard !Task.isCancelled, generation == started, model.api === api, model.user["id"] == user else { return }
            available = check || result["available"].flag
            diagnosis = check ? result : result["diagnosis"]
            message = check ? "" : result["message"].text
        } catch {
            guard !Task.isCancelled, generation == started, model.api === api else { return }
            available = nil; diagnosis = .null; message = ""; self.error = error.localizedDescription
        }
    }
}
