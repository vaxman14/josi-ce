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
                        Text("Last delivery update: " + nativeDate(progress["updatedAt"].text)).foregroundStyle(JosiTheme.lilac)
                    }
                }
                if !message.isEmpty { Text(message).foregroundStyle(JosiTheme.lilac) }
                Text("The saved work above remains current even if its external chat update cannot be delivered.")
                    .foregroundStyle(JosiTheme.lilac)
            }.font(JosiFont.caption).padding(.top, 8)
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
                    Text("Task: " + task["state"].text.replacingOccurrences(of: "_", with: " ")).font(JosiFont.headline)
                    if !task["fail_reason"].text.isEmpty { Text(task["fail_reason"].text) }
                    if !task["next_wake_at"].text.isEmpty { Text("Next check: " + nativeDate(task["next_wake_at"].text)) }
                    if task["template_key"].text == "isolated_automation" {
                        Text("Separate-desktop work keeps its original task and plan step. An operation receipt alone does not verify the requested result.")
                            .foregroundStyle(JosiTheme.lilac)
                    } else if activity["attempts"].list.isEmpty { Text("No saved attempts.").foregroundStyle(JosiTheme.lilac) }
                    ForEach(Array(activity["attempts"].list.enumerated()), id: \.offset) { _, attempt in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(attempt["kind"].text.replacingOccurrences(of: "_", with: " ")).font(JosiFont.headline)
                            Text(attempt["outcome"].text.isEmpty ? "No confirmed outcome recorded." : attempt["outcome"].text)
                            Text(nativeDate(attempt["started_at"].text)).foregroundStyle(JosiTheme.lilac)
                        }
                    }
                    if !activity["approvals"].list.isEmpty { Text("Saved approvals").font(JosiFont.headline) }
                    ForEach(Array(activity["approvals"].list.enumerated()), id: \.offset) { _, approval in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(approval["summary"].text)
                            Text(approval["status"].text.replacingOccurrences(of: "_", with: " ")).foregroundStyle(JosiTheme.lilac)
                            Text(nativeDate(approval["created_at"].text)).foregroundStyle(JosiTheme.lilac)
                        }
                    }
                    if !automationEvents.isEmpty {
                        Text("Saved automation activity").font(JosiFont.headline)
                        ForEach(automationEvents, id: \.identifier) { event in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(automationStatus(event["kind"].text))
                                Text(nativeDate(event["created_at"].text)).foregroundStyle(JosiTheme.lilac)
                            }
                        }
                    }
                    Button("Refresh Saved Activity") { refresh += 1 }.disabled(loading)
                }
                if !error.isEmpty { Text(error).foregroundStyle(JosiTheme.error) }
            }.font(JosiFont.caption).textSelection(.enabled).padding(.top, 8)
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
                        Text(desktop.label).font(JosiFont.headline)
                        Text("Your separate desktop is " + desktop.state + ".").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    }
                    Spacer()
                    Button("Open Desktop Viewer") { model.run { try desktop.show() } }.disabled(model.busy)
                }.padding(8)
            }
        }
    }
}

struct NativeAutomationConnections: View {
    @EnvironmentObject var model: JosiModel
    @State private var expanded = false
    @State private var connections: Wire = .null
    @State private var message = ""
    @State private var checked: Date?
    var body: some View {
        DisclosureGroup("Automation desktops", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                if !message.isEmpty { Text(message).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac) }
                if connections != .null {
                    if connections["workspaces"].list.isEmpty {
                        Text("No separate desktop connection has been reported for your account.").font(JosiFont.caption)
                    }
                    ForEach(Array(connections["workspaces"].list.enumerated()), id: \.offset) { _, workspace in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(workspace["label"].text).font(JosiFont.headline)
                            Text(state(workspace)).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                        }
                    }
                    if connections["controlAvailable"] == .bool(false) {
                        Text(connections["inspectionAvailable"].flag
                             ? "App inspection needs local approval. Sharing a capture also needs permission for the current model. Input is not available yet."
                             : "Connection status is available. Browser and computer control are not connected yet.")
                            .font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    }
                }
                if let checked { Text("Last checked " + checked.formatted(date: .omitted, time: .standard))
                    .font(.caption2).foregroundStyle(JosiTheme.lilac) }
            }.padding(.top, 8)
        }
        .task(id: "\(expanded):\(model.api?.origin.absoluteString ?? ""):\(model.user["id"].text)") {
            connections = .null; checked = nil; message = ""
            guard expanded, let api = model.api else { return }
            let owner = model.user["id"]
            while !Task.isCancelled && expanded && model.api === api && model.user["id"] == owner {
                if NSApp.isActive {
                    do {
                        let result = try await api.request("/assistant/automation/workspaces")
                        try Task.checkCancellation()
                        guard model.api === api, model.user["id"] == owner else { return }
                        guard result["workspaces"].list.count <= 32,
                              result["workspaces"].list.allSatisfy({ item in
                                  item["identity"]["userId"] == owner && ProtectedWire.uuid(item["identity"]["workspaceId"])
                                    && ProtectedWire.text(item["label"], max: 120)
                                    && ["ready", "paused", "needs_local_consent", "offline"].contains(item["state"].text)
                              }) else { throw GuestLinkError.invalid }
                        connections = result; checked = Date()
                        message = result["available"].flag ? "" : "This server does not provide automation connections yet."
                    } catch is CancellationError { return }
                    catch {
                        guard !Task.isCancelled, model.api === api, model.user["id"] == owner else { return }
                        connections = .null; message = "Current desktop connections could not refresh."
                    }
                }
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
            }
        }
    }
    private func state(_ workspace: Wire) -> String {
        switch workspace["state"].text {
        case "ready": return connections["controlAvailable"] == .bool(false) ? "Ready for permitted inspection" : "Ready for permitted work"
        case "paused": return "Paused"
        case "needs_local_consent":
            return connections["controlAvailable"] == .bool(false)
                ? "Companion connected · automation not enabled" : "Waiting for the device owner"
        default: return "Offline"
        }
    }
}
