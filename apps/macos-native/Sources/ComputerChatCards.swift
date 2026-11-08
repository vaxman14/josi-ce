import SwiftUI

/// Trusted status sits beside the conversation. File contents and captured
/// pixels are deliberately absent; they remain in the bounded result path.
struct ComputerChatCards: View {
    @ObservedObject var controller: ComputerController
    let taskIds: Set<String>
    private var proposals: [Wire] { controller.snapshot["proposals"].list.filter { taskIds.contains($0["taskId"].text) } }
    private var requests: [Wire] { Array(controller.snapshot["requests"].list.filter { taskIds.contains($0["taskId"].text) }.suffix(3)) }
    private func computer(_ id: String) -> String {
        controller.snapshot["devices"].list.first { $0["id"].text == id }?["label"].text ?? "Selected Mac"
    }
    private func status(_ request: Wire) -> String {
        switch request["state"].text {
        case "pending": return "Waiting for permission — nothing has run"
        case "approved": return "Approved — waiting for this Mac"
        case "running": return "Running on this Mac"
        case "succeeded": return "Operation finished"
        case "failed": return "Operation failed — inspect its result before retrying"
        case "cancelled": return "Cancelled — completed effects are not undone"
        default: return "Status unavailable"
        }
    }
    var body: some View {
        if !proposals.isEmpty || !requests.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(proposals, id: \.identifier) { proposal in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Label("Permission review · " + computer(proposal["deviceId"].text), systemImage: "lock.shield")
                            Text(proposal["summary"].text).font(.caption).lineLimit(4)
                        }
                        Spacer()
                        Button("Review exact change…") { controller.showPanel = true }
                    }
                }
                ForEach(requests, id: \.identifier) { request in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(computer(request["deviceId"].text) + " · " + request["operation"]["action"].text)
                            Text(status(request)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if ["pending", "approved", "running"].contains(request["state"].text) {
                            Button("Stop", role: .destructive) { Task { await controller.stopDevice(request["deviceId"].text) } }
                        }
                    }
                }
            }.font(.callout).padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
