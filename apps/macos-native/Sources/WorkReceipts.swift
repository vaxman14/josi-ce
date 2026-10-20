import AppKit
import SwiftUI

struct NativeWorkChannelProgress: View {
    @EnvironmentObject var model: JosiModel
    let goalId: String
    @State private var expanded = false
    @State private var progress: Wire = .null
    @State private var message = ""
    @State private var loading = false
    var body: some View {
        DisclosureGroup("Chat delivery status", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 7) {
                if loading && progress == .null { ProgressView().controlSize(.small) }
                if progress != .null {
                    Text(status)
                    if !progress["updatedAt"].text.isEmpty {
                        Text("Last delivery update: " + nativeDate(progress["updatedAt"].text)).foregroundStyle(.secondary)
                    }
                }
                if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
                Text("The saved work above remains current even if its external chat update cannot be delivered.")
                    .foregroundStyle(.secondary)
            }.font(.caption).padding(.top, 8)
        }
        .task(id: "\(expanded):\(goalId):\(model.api?.origin.absoluteString ?? ""):\(model.user["id"].text)") {
            progress = .null; message = ""; loading = false
            guard expanded, let api = model.api else { return }
            let owner = model.user["id"]
            while !Task.isCancelled && expanded && model.api === api && model.user["id"] == owner {
                if NSApp.isActive {
                    loading = true
                    do {
                        let id = try api.uuid(goalId)
                        let result = try await api.request("/assistant/work-goals/\(id)/channel-progress")
                        try Task.checkCancellation()
                        guard model.api === api, model.user["id"] == owner else { return }
                        let value = result["progress"]
                        guard value == .null || (value["channel"].text == "telegram"
                            && ["ready", "sending", "sent", "failed", "uncertain", "disabled"].contains(value["state"].text)
                            && ProtectedWire.integer(value["revision"])
                            && ProtectedWire.integer(value["currentRevision"])) else {
                            throw JosiError(message: "Chat delivery status is unavailable.")
                        }
                        progress = value
                        message = value == .null ? "This work has no external chat summary." : ""
                    } catch is CancellationError { return }
                    catch let error as JosiError where error.status == 404 {
                        progress = .null; message = "This server does not provide chat delivery details."; loading = false; return
                    } catch {
                        guard !Task.isCancelled, model.api === api, model.user["id"] == owner else { return }
                        message = "Delivery status could not refresh. Any status shown is from the previous update."
                    }
                    loading = false
                }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }
    private var status: String {
        switch progress["state"].text {
        case "uncertain": return "Telegram delivery could not be confirmed. Josi will not send a duplicate automatically."
        case "failed": return "The Telegram summary could not be updated."
        case "disabled": return "The original Telegram connection is no longer active."
        case "sent" where progress["revision"].integer >= progress["currentRevision"].integer:
            return "The Telegram summary is up to date."
        default: return "The Telegram summary is waiting for its next update."
        }
    }
}

/// Reads the original owned task and its saved activity. A receipt never
/// becomes a retry action or a locally inferred goal completion.
struct NativeTaskReceipt: View {
    @EnvironmentObject var model: JosiModel
    let taskId: String
    let revision: Int
    var title = "Saved task activity"
    var updatedAt = ""
    @State private var expanded = false
    @State private var task: Wire = .null
    @State private var activity: Wire = .null
    @State private var error = ""
    @State private var loading = false
    var body: some View {
        DisclosureGroup(title, isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                if loading { ProgressView().controlSize(.small) }
                if task != .null {
                    Text("Task: " + task["state"].text.replacingOccurrences(of: "_", with: " ")).font(.subheadline.bold())
                    if !task["fail_reason"].text.isEmpty { Text(task["fail_reason"].text) }
                    if !task["next_wake_at"].text.isEmpty { Text("Next check: " + nativeDate(task["next_wake_at"].text)) }
                    if task["template_key"].text == "isolated_automation" {
                        Text("Separate-desktop work keeps its original task and plan step. An operation receipt alone does not verify the requested result.")
                            .foregroundStyle(.secondary)
                    } else if activity["attempts"].list.isEmpty { Text("No saved attempts.").foregroundStyle(.secondary) }
                    ForEach(Array(activity["attempts"].list.enumerated()), id: \.offset) { _, attempt in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(attempt["kind"].text.replacingOccurrences(of: "_", with: " ")).font(.subheadline.bold())
                            Text(attempt["outcome"].text.isEmpty ? "No confirmed outcome recorded." : attempt["outcome"].text)
                            Text(nativeDate(attempt["started_at"].text)).foregroundStyle(.secondary)
                        }
                    }
                    if !activity["approvals"].list.isEmpty { Text("Saved approvals").font(.subheadline.bold()) }
                    ForEach(Array(activity["approvals"].list.enumerated()), id: \.offset) { _, approval in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(approval["summary"].text)
                            Text(approval["status"].text.replacingOccurrences(of: "_", with: " ")).foregroundStyle(.secondary)
                            Text(nativeDate(approval["created_at"].text)).foregroundStyle(.secondary)
                        }
                    }
                    if !automationEvents.isEmpty {
                        Text("Saved automation activity").font(.subheadline.bold())
                        ForEach(automationEvents, id: \.identifier) { event in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(automationStatus(event["kind"].text))
                                Text(nativeDate(event["created_at"].text)).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("Refresh Saved Activity") { refresh += 1 }.disabled(loading)
                }
                if !error.isEmpty { Text(error).foregroundStyle(.orange) }
            }.font(.caption).textSelection(.enabled).padding(.top, 8)
        }
        .task(id: "\(expanded):\(taskId):\(revision):\(updatedAt):\(refresh):\(model.api?.origin.absoluteString ?? ""):\(model.user["id"].text)") {
            task = .null; activity = .null; error = ""; loading = false
            guard expanded, let api = model.api else { return }
            let owner = model.user["id"]
            loading = true
            defer { if !Task.isCancelled { loading = false } }
            do {
                let id = try api.uuid(taskId)
                let saved = try await api.request("/assistant/tasks/\(id)")
                try Task.checkCancellation()
                guard model.api === api, model.user["id"] == owner, saved["task"]["id"].text == id else { return }
                let history = try await api.request("/assistant/tasks/\(id)/activity")
                try Task.checkCancellation()
                guard model.api === api, model.user["id"] == owner else { return }
                task = saved["task"]; activity = history["activity"]
            } catch is CancellationError {} catch {
                if !Task.isCancelled, model.api === api, model.user["id"] == owner {
                    self.error = "This task’s saved activity is unavailable. Refresh or return to its conversation."
                }
            }
        }
    }
    @State private var refresh = 0
    private var automationEvents: [Wire] {
        activity["events"].list.filter {
            ["automation.reserved", "automation.dispatched", "automation.succeeded", "automation.no_effect",
             "automation.uncertain", "automation.cancelled"].contains($0["kind"].text)
        }
    }
    private func automationStatus(_ kind: String) -> String {
        switch kind {
        case "automation.reserved": return "An operation was reserved; it has not been dispatched."
        case "automation.dispatched": return "An operation was dispatched; its result was pending."
        case "automation.succeeded": return "An operation reported success. The requested result still needs verification."
        case "automation.no_effect": return "An operation confirmed that no effect occurred."
        case "automation.uncertain": return "An operation’s outcome is uncertain. It needs reconciliation before further input."
        case "automation.cancelled": return "An operation was cancelled before dispatch."
        default: return "Automation status unavailable."
        }
    }
}

struct NativeTaskDesktopViewer: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var desktop: NativeWorkspaceController
    var body: some View {
        if ["running", "paused"].contains(desktop.state) {
            GroupBox {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(desktop.label).font(.headline)
                        Text("Your separate desktop is " + desktop.state + ".").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Open Desktop Viewer") { model.run { try desktop.show() } }.disabled(model.busy)
                }.padding(8)
            }
        }
    }
}
