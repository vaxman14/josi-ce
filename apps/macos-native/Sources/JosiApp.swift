import AppKit
import SwiftUI

@MainActor final class JosiAppDelegate: NSObject, NSApplicationDelegate {
    weak var model: JosiModel?
    func applicationWillFinishLaunching(_ notification: Notification) { JosiFont.register() }
    func applicationDidFinishLaunching(_ notification: Notification) { NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let model, model.vaultRecovery != .null || model.recovery != .null || model.mfaRecovery != .null {
            let alert = NSAlert(); alert.messageText = "Save your recovery information before quitting."
            alert.informativeText = "Finish the recovery step in Josi so you keep access to your account and Vault."
            alert.runModal(); return .terminateCancel
        }
        if model?.busy == true {
            let alert = NSAlert(); alert.messageText = "Let the current operation finish."
            alert.informativeText = "Josi is applying your request. Server changes may still be running."
            alert.runModal(); return .terminateCancel
        }
        if let model, model.desktop.requiresClosure {
            Task {
                do { try await model.desktop.close(); sender.reply(toApplicationShouldTerminate: true) }
                catch {
                    let alert = NSAlert(); alert.messageText = "The separate desktop still needs to close."
                    alert.informativeText = "Open Automation and choose Close Again. Josi retained the desktop and storage handles."
                    alert.runModal(); sender.reply(toApplicationShouldTerminate: false)
                }
            }
            return .terminateLater
        }
        return .terminateNow
    }
    // Closing the window never stops the server: it runs as a system service.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil) }; return true
    }
}

@main struct JosiNativeApp: App {
    @NSApplicationDelegateAdaptor(JosiAppDelegate.self) private var delegate
    @StateObject private var model = JosiModel()
    var body: some Scene {
        Window(JosiFlags.appName, id: "josi") {
            RootView().environmentObject(model)
                .frame(minWidth: 920, minHeight: 660)
                .task {
                    delegate.model = model; model.refreshLocal(); await model.resume()
#if DEBUG
                    JosiDriver.start(model)
#endif
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(3))
                        await model.poll()
                    }
                }
        }
        .defaultSize(width: 1160, height: 800)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                if JosiFlags.serverApp { Button("Server Controls…") { model.openServerControls() } }
                Button("Show \(JosiFlags.appName) in Finder") { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
                Divider()
                Button("New Conversation") { model.run { try await model.newThread() } }
                    .keyboardShortcut("n").disabled(model.screen != .workspace || model.busy)
            }
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .sidebar) {
                Button(model.sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar") { model.toggleSidebar() }
                    .keyboardShortcut("s", modifiers: [.control, .command]).disabled(model.screen != .workspace)
            }
        }
#if JOSI_SERVER_APP
        MenuBarExtra {
            ServerTrayMenu().environmentObject(model)
        } label: {
            Image(nsImage: JosiTray.icon).task { while !Task.isCancelled { model.refreshLocal(); try? await Task.sleep(for: .seconds(15)) } }
        }
#endif
    }
}

struct RootView: View {
    @EnvironmentObject var model: JosiModel
    @AppStorage(JosiSkin.key) private var skin = JosiSkin.plumGold.rawValue
    var body: some View {
        ZStack {
            JosiBackdrop()
            VStack(spacing: 0) {
                switch model.screen {
                case .connect: ConnectionView()
                case .login: LoginView()
                case .setup: SetupView()
                case .workspace: WorkspaceView()
                }
                if !model.error.isEmpty {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(JosiTheme.error)
                        Text(model.error).textSelection(.enabled)
                        Spacer()
                        Button { model.error = "" } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                    }.padding(12).background(JosiTheme.error.opacity(0.09)).accessibilityElement(children: .combine)
                }
                if model.busy {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(model.activity.isEmpty ? "Working…" : model.activity).font(JosiFont.callout)
                        Spacer()
                    }.padding(.horizontal, 16).padding(.vertical, 9).background(JosiFrost())
                }
            }
        }.id(skin).font(JosiFont.body()).foregroundStyle(JosiTheme.text)
        .tint(JosiTheme.gold).preferredColorScheme(.dark).groupBoxStyle(JosiGroupBoxStyle())
        .buttonStyle(JosiOutlineButtonStyle())
        .sheet(isPresented: Binding(get: { model.vaultRecovery != .null || model.mfaRecovery != .null }, set: { _ in })) {
            if model.mfaRecovery != .null { NativeMfaRecovery().environmentObject(model) }
            else { NativeVaultRecovery().environmentObject(model) }
        }
        .sheet(isPresented: $model.showServerControls) { ServerControlsSheet().environmentObject(model) }
    }
}

struct JosiHeading: View {
    var title: String
    var subtitle: String
    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(JosiFont.largeTitle)
                Text(subtitle).foregroundStyle(JosiTheme.lilac)
            }
            Spacer()
        }
    }
}

/// Durable submission returns before the model runs. A failed receipt is a
/// terminal result, even though the original POST succeeded and saved a message.
struct ChatTurnFailure: View {
    @EnvironmentObject var model: JosiModel
    let turn: Wire
    private var code: String { turn["error"]["code"].text }
    private var modelFailure: Bool {
        ["no_model", "not_probed", "cannot_chat", "capped", "provider_error"].contains(code)
    }
    private var detail: String {
        switch code {
        case "no_model": "No model is configured for this server."
        case "not_probed": "The saved model must pass its capability check before it can answer."
        case "cannot_chat": "The saved model did not pass its basic reply check."
        case "capped": "The model cannot run with its current connection or usage settings. Check the subscription or API connection and the model limits."
        case "provider_error": "The model provider could not complete this reply. Check its connection and run the model capability check."
        case "session_expired": "Your sign-in expired before this message could run. Sign in again to continue."
        case "worker_interrupted": "The server stopped before this reply finished."
        case "effect_outcome_unknown", "effect_then_provider_error":
            "Josi could not finish the reply after starting an action. Review the task’s saved actions before asking it to continue."
        case "restricted": "The current permissions do not allow Josi to answer this request."
        default: "The server could not finish this reply. Check server health for more information."
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Josi couldn’t reply", systemImage: "exclamationmark.triangle").font(JosiFont.headline)
            Text(detail).textSelection(.enabled)
            if model.isAdministrator {
                Button(modelFailure ? "Open Model" : "Open Overview") { model.section = modelFailure ? "models" : "overview" }.disabled(model.busy)
            } else if modelFailure {
                Text("Ask your server administrator to check Models.")
            }
        }.foregroundStyle(JosiTheme.error).padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(JosiTheme.error.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct GoalCard: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    var compact = false
    @State private var instruction = ""
    @State private var cancelling = false
    private var setupBlocked: Bool { goal["activity"].text == "Automation needs setup" }
    private var recovery: Bool { setupBlocked || goal["activity"].text == "Progress needs recovery"
        || goal["continuation"]["text"].text == "The last segment did not save a next step or verified result. What should Josi try next?" }

    private var visibleSteps: [Wire] {
        guard compact else { return goal["steps"].list }
        let required = goal["steps"].list.filter { $0["state"].text != "skipped" }
        let active = required.firstIndex { $0["state"].text == "working" }
            ?? required.firstIndex { $0["state"].text != "verified" } ?? max(0, required.count - 1)
        return Array(required.dropFirst(max(0, active - 1)).prefix(4))
    }
    private func stepLabel(_ state: String) -> String {
        ["pending": "Pending", "working": "Working", "blocked": "Waiting", "verified": "Verified", "skipped": "Retired"][state] ?? state
    }
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(goal["title"].text).font(JosiFont.headline)
                    Spacer()
                    JosiStatusBadge(state: goal["state"].text)
                }
                ProgressView(value: Double(goal["verifiedSteps"].integer), total: Double(max(1, goal["totalSteps"].integer))).tint(JosiTheme.gold)
                Text("\(goal["verifiedSteps"].integer)/\(goal["totalSteps"].integer) verified")
                    .font(JosiFont.headline)
                if !goal["activity"].text.isEmpty { Text(goal["activity"].text).foregroundStyle(JosiTheme.lilac) }
                ForEach(visibleSteps, id: \.identifier) { step in
                    HStack(alignment: .top) {
                        Image(systemName: step["state"].text == "verified" ? "checkmark.circle.fill" : step["state"].text == "skipped" ? "minus.circle" : "circle")
                            .foregroundStyle(step["state"].text == "verified" ? JosiTheme.success : Color.secondary)
                        Text(step["title"].text).strikethrough(step["state"].text == "skipped")
                        Spacer()
                        Text(stepLabel(step["state"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    }
                    if !compact, !step["blockedReason"].text.isEmpty {
                        Text(step["blockedReason"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                        if !step["blockedUntil"].text.isEmpty {
                            Text("Next check: " + nativeDate(step["blockedUntil"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                        }
                    }
                    if !compact, !step["dependsOn"].list.isEmpty {
                        Text("After: " + step["dependsOn"].list.map { dependency in
                            goal["steps"].list.first { $0["id"] == dependency }?["title"].text ?? "Unavailable step"
                        }.joined(separator: " · ")).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    }
                    if !compact, ProtectedWire.uuid(step["evidence"]), step["evidence"] == step["taskId"] {
                        NativeTaskReceipt(taskId: step["evidence"].text, revision: goal["revision"].integer, title: "View Saved Verification Task")
                    }
                    if !compact, step["retirement"] != .null {
                        Text("Retired: " + step["retirement"]["reason"].text).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    }
                }
                if compact, goal["totalSteps"].integer > visibleSteps.count {
                    Text("Showing the current part of the plan. All steps are in Tasks.").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                }
                if goal["retiredSteps"].integer > 0 {
                    Text("\(goal["retiredSteps"].integer) retired steps retained in history.").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                }
                if goal["continuation"]["kind"].text == "question" {
                    Text(recovery && !setupBlocked ? "Josi stopped before saving the next step. Your original request is still saved. Continue to recheck the task." : goal["continuation"]["text"].text).font(JosiFont.body(13, weight: .medium))
                    if JosiFlags.localWorkspace, setupBlocked || recovery { Button("Open Automation") { model.section = "automation"; model.run { try await model.loadAutomation() } } }
                }
                if goal["continuation"]["kind"].text == "wait" {
                    Text(goal["continuation"]["reason"].text).foregroundStyle(JosiTheme.lilac)
                    Text("Next check: " + nativeDate(goal["continuation"]["wakeAt"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                }
                if goal["planNeedsReview"].flag { Text("Josi must review the changed plan before new actions.").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac) }
                if !goal["updatedAt"].text.isEmpty {
                    Text("Last saved: " + nativeDate(goal["updatedAt"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                }
                if !compact {
                    if goal["automaticWork"] != .null, !["completed", "cancelled"].contains(goal["state"].text) {
                        let work = goal["automaticWork"]
                        Text("Automatic continuations since verified progress: \(work["segmentsSinceVerifiedProgress"].integer) of \(work["segmentLimit"].integer).")
                            .font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                        if !work["nextCheckAt"].text.isEmpty, ["planning", "working"].contains(goal["state"].text) {
                            Text("Scheduled to continue: " + nativeDate(work["nextCheckAt"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                        }
                    }
                    NativeWorkDetails(goal: goal)
                    TextField(recovery ? "Additional instructions (optional)" : "Instructions for Josi", text: $instruction).textFieldStyle(JosiFieldStyle())
                    HStack {
                        if goal["state"].text != "completed" && goal["state"].text != "cancelled" {
                            Button("Pause") { control("pause") }
                            Button(setupBlocked ? "Check Connection & Continue" : "Continue") { control("resume") }.disabled(!recovery && instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button("Cancel Work…", role: .destructive) { cancelling = true }
                        }
                        if goal["state"].text == "verifying" { Button("Confirm Complete") { control("confirm") } }
                    }.disabled(model.busy)
                    Button("Continue in Chat") { model.run { try await model.selectThread(goal["threadId"].text) } }
                        .disabled(model.busy)
                } else {
                    Button("Open Tasks") { model.section = "tasks"; model.run { try await model.reloadWorkspace() } }.buttonStyle(.link)
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }
        .confirmationDialog("Cancel this work?", isPresented: $cancelling) {
            Button("Cancel Work", role: .destructive) { control("cancel") }
        } message: { Text("Completed actions remain completed. This stops further work on the goal.") }
    }
    private func control(_ action: String) {
        let text = action == "resume" && recovery && instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Recheck the current automation connection and saved action receipts, then continue the original task within existing permissions. Preserve completed work and inspect any uncertain result before further actions." : instruction
        model.run { try await model.control(goal, action: action, instruction: text) }
    }
}

struct TaskManagerView: View {
    @EnvironmentObject var model: JosiModel
    @State private var filter = "active"
    private var failedRuns: [Wire] { model.taskRuns.filter { $0["status"].text == "failed" } }
    private var visibleRuns: [Wire] {
        model.taskRuns.filter { run in
            switch filter {
            case "attention": return run["status"].text == "failed"
            case "history": return ["completed", "failed"].contains(run["status"].text)
            default: return ["queued", "running"].contains(run["status"].text)
            }
        }
    }
    private var visible: [Wire] {
        model.goals.filter { goal in
            let state = goal["state"].text
            switch filter {
            case "attention": return ["needs_instruction", "waiting", "paused"].contains(state)
            case "history": return ["completed", "cancelled"].contains(state)
            default: return !["completed", "cancelled"].contains(state)
            }
        }
    }
    private func filterButton(_ label: String, value: String) -> some View {
        Button { filter = value } label: {
            Text(label).font(JosiFont.body(13, weight: .medium)).frame(maxWidth: .infinity).padding(.vertical, 10)
                .foregroundStyle(filter == value ? JosiTheme.gold : JosiTheme.muted)
                .background(filter == value ? JosiTheme.gold.opacity(0.13) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(filter == value ? JosiTheme.gold.opacity(0.5) : Color.clear))
        }.buttonStyle(.plain)
    }
    private var standaloneTasks: [Wire] {
        let linked = Set(model.goals.flatMap { $0["steps"].list.map { $0["taskId"].text } })
        return model.tasks.filter { task in
            guard !linked.contains(task["id"].text) else { return false }
            let state = task["state"].text
            switch filter {
            case "history": return ["closed", "confirmed", "cancelled", "failed"].contains(state)
            case "attention": return ["held", "awaiting_approval", "awaiting_owner", "failed"].contains(state)
            default: return !["closed", "confirmed", "cancelled", "failed"].contains(state)
            }
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                JosiHeading(title: "Tasks", subtitle: "What Josi is working on, and what needs your attention.")
                NativeTaskDesktopViewer(desktop: model.desktop)
                if JosiFlags.localWorkspace { NativeAutomationConnections() }
                HStack(spacing: 3) {
                    filterButton("Active", value: "active")
                    filterButton("Needs You / Waiting", value: "attention")
                    filterButton("History", value: "history")
                }.padding(4).background(JosiTheme.raised.opacity(0.5), in: RoundedRectangle(cornerRadius: 11)).frame(maxWidth: 620)
                if filter == "active" && !failedRuns.isEmpty {
                    Button("\(failedRuns.count) failed conversation request(s) — Review") { filter = "attention" }
                        .foregroundStyle(JosiTheme.error)
                }
                if visible.isEmpty && standaloneTasks.isEmpty && visibleRuns.isEmpty {
                    Text("No work in this view.").foregroundStyle(JosiTheme.lilac)
                }
                ForEach(visible, id: \.identifier) { GoalCard(goal: $0) }
                if !visibleRuns.isEmpty {
                    Text("Conversation requests").font(JosiFont.title2)
                    ForEach(visibleRuns, id: \.identifier) { run in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(run["thread_title"].text.isEmpty ? "Conversation" : run["thread_title"].text).font(JosiFont.headline)
                                Text(run["status"].text.capitalized + " · " + nativeDate(run["updated_at"].text)).foregroundStyle(JosiTheme.lilac)
                                if run["status"].text == "failed" {
                                    ChatTurnFailure(turn: ["error": ["code": run["error_code"], "retryable": run["error_retryable"]]])
                                }
                                Button("Open Conversation") { model.run { try await model.selectThread(run["thread_id"].text) } }
                                    .disabled(model.busy)
                            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                if !standaloneTasks.isEmpty {
                    Text("Other tasks").font(JosiFont.title2)
                    ForEach(standaloneTasks, id: \.identifier) { task in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(task["title"].text.isEmpty ? task["template_key"].text : task["title"].text).font(JosiFont.headline)
                                    Text(task["state"].text.replacingOccurrences(of: "_", with: " ")).foregroundStyle(JosiTheme.lilac)
                                }
                                Spacer()
                                }
                                NativeTaskReceipt(taskId: task["id"].text, revision: task["attempt_count"].integer,
                                                  updatedAt: task["updated_at"].text)
                            }.padding(8)
                        }
                    }
                }
                Text(model.progressConnection).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                if let refreshed = model.lastRefreshed { Text("Updated \(refreshed.formatted(date: .omitted, time: .standard))").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac) }
            }.padding(28)
        }
    }
}

struct AutomationView: View {
    @EnvironmentObject var model: JosiModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                JosiHeading(title: "Automation", subtitle: "Separate desktops, connected devices and current authority.")
                if model.automationLoading { ProgressView("Checking automation and Vault settings…") }
                if !model.automationError.isEmpty {
                    GroupBox("Connection check needs attention") {
                        Text(model.automationError).foregroundStyle(JosiTheme.gold).textSelection(.enabled)
                        HStack { Button("Open Vault") { model.section = "vault" }; Button("Check Server") { model.section = "overview" } }
                    }
                }
                if model.automation != .null {
                    if !model.automation["blocker"]["message"].text.isEmpty {
                        GroupBox("Before Josi can use the browser") {
                            Text(model.automation["blocker"]["message"].text).textSelection(.enabled)
                            if model.automation["blocker"]["code"].text == "vault_locked" { Button("Open Vault") { model.section = "vault" } }
                            Text("Your task and original instructions stay saved in Tasks.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                        }
                    }
                    ForEach(Array(model.automation["workspaces"].list.enumerated()), id: \.offset) { _, workspace in
                        GroupBox { VStack(alignment: .leading, spacing: 6) {
                            Text(workspace["label"].text).font(JosiFont.headline)
                            Text(workspace["state"].text.replacingOccurrences(of: "_", with: " ").capitalized)
                        }.frame(maxWidth: .infinity, alignment: .leading) }
                    }
                } else if !model.automationLoading && model.automationError.isEmpty {
                    Text("Refresh to check the automation connection.").foregroundStyle(JosiTheme.muted)
                }
                if model.isAdministrator {
                    NativeWorkspaceStorageView(desktop: model.desktop)
                    NativeAuthoritySettings()
                }
                Button("Refresh Automation") { model.run { try await model.loadAutomation() } }.disabled(model.busy)
            }.padding(30)
        }
    }
}
