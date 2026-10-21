import AppKit
import SwiftUI

@MainActor final class JosiAppDelegate: NSObject, NSApplicationDelegate {
    weak var model: JosiModel?
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
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first?.makeKeyAndOrderFront(nil) }; return true
    }
}

@main struct JosiNativeApp: App {
    @NSApplicationDelegateAdaptor(JosiAppDelegate.self) private var delegate
    @StateObject private var model = JosiModel()
    var body: some Scene {
        Window("Josi", id: "josi") {
            RootView().environmentObject(model)
                .frame(minWidth: 920, minHeight: 660)
                .task {
                    delegate.model = model; model.refreshLocal()
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
                Button("Server Controls…") { model.section = "server" }
                    .disabled(model.screen != .workspace)
                Button("Show Josi in Finder") { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
            }
            CommandGroup(replacing: .newItem) {
                Button("New Conversation") { model.run { try await model.newThread() } }
                    .keyboardShortcut("n").disabled(model.screen != .workspace || model.busy)
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: JosiModel
    var body: some View {
        VStack(spacing: 0) {
            switch model.screen {
            case .connect: ConnectionView()
            case .login: LoginView()
            case .setup: SetupView()
            case .workspace: WorkspaceView()
            }
            if !model.error.isEmpty {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                    Text(model.error).textSelection(.enabled)
                    Spacer()
                    Button { model.error = "" } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }.padding(12).background(.orange.opacity(0.09)).accessibilityElement(children: .combine)
            }
            if model.busy {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(model.activity.isEmpty ? "Working…" : model.activity).font(.callout)
                    Spacer()
                }.padding(.horizontal, 16).padding(.vertical, 9).background(.bar)
            }
        }.background(JosiTheme.background).foregroundStyle(JosiTheme.text)
        .tint(JosiTheme.orange).preferredColorScheme(.dark).groupBoxStyle(JosiGroupBoxStyle())
        .sheet(isPresented: Binding(get: { model.vaultRecovery != .null || model.mfaRecovery != .null }, set: { _ in })) {
            if model.mfaRecovery != .null { NativeMfaRecovery().environmentObject(model) }
            else { NativeVaultRecovery().environmentObject(model) }
        }
    }
}

struct JosiHeading: View {
    var title: String
    var subtitle: String
    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.largeTitle.bold())
                Text(subtitle).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

struct ConnectionView: View {
    @EnvironmentObject var model: JosiModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                JosiHeading(title: "Welcome to Josi", subtitle: "Your conversations, your work, your Mac.")
                HStack(alignment: .top, spacing: 24) {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 18) {
                            Label("On this Mac", systemImage: "desktopcomputer").font(.title2.bold())
                            Text(model.receipt.installed
                                 ? "Your existing server is available here. Its accounts and data stay with it."
                                 : "Set up a server here, or restore the data retained by your previous installation.")
                                .foregroundStyle(.secondary)
                            if model.receipt.installed {
                                Text("Version \(model.receipt.version)").font(.caption).foregroundStyle(.secondary)
                                Button("Open Josi") { model.run { try await model.connect(model.receipt.address, local: true) } }
                                    .buttonStyle(.borderedProminent)
                            } else {
                                Button("Set Up on This Mac…") { model.run { try await model.operate("install") } }
                                    .buttonStyle(.borderedProminent).disabled(!NativeServer.canManage)
                            }
                            ServerControls(compact: true)
                        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GroupBox {
                        VStack(alignment: .leading, spacing: 18) {
                            Label("On another computer", systemImage: "network").font(.title2.bold())
                            Text("Connect to your Josi server and use the same account, conversations and work.")
                                .foregroundStyle(.secondary)
                            TextField("https://josi.example.com", text: $model.address)
                                .textFieldStyle(.roundedBorder).onSubmit { connect() }
                            Button("Connect") { connect() }.buttonStyle(.borderedProminent)
                                .disabled(model.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Text("Remote connections use HTTPS. Localhost is supported for a server on this Mac.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Text("Closing this window leaves your server running for your other devices.")
                    .font(.callout).foregroundStyle(.secondary)
            }.padding(36).frame(maxWidth: 1100)
        }.disabled(model.busy)
    }
    private func connect() { model.run { try await model.connect(model.address) } }
}

struct ServerControls: View {
    @EnvironmentObject var model: JosiModel
    var compact = false
    @State private var pendingOperation: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !compact {
                JosiHeading(title: "Server on this Mac", subtitle: "Manage local hosting without leaving Josi.")
                Text(model.receipt.installed ? "\(model.receipt.address) · \(model.receipt.version)" : "Local server is not installed.")
            }
            if model.receipt.installed {
                HStack {
                    Button("Start") { operate("start") }
                    Button("Stop…") { pendingOperation = "stop" }
                    Button("Restart…") { pendingOperation = "restart" }
                }
                HStack {
                    Button("Update Server…") { pendingOperation = "install" }
                    Button("Repair…") { pendingOperation = "recover-latest" }
                }
            }
            Button("Refresh Status") { model.refreshLocal() }
            if !compact {
                Text("Updates use the existing recovery-copy and migration process. macOS will ask for administrator authorization.")
                    .foregroundStyle(.secondary)
                Button("Open Uninstaller…") {
                    let target = URL(fileURLWithPath: "/Applications/Uninstall Josi.app")
                    if FileManager.default.fileExists(atPath: target.path) { NSWorkspace.shared.openApplication(at: target, configuration: .init()) }
                    else { model.error = "Install the complete Josi package to add its uninstaller." }
                }
                if !NativeServer.canManage { Text("Install the signed app in Applications to enable server changes.").foregroundStyle(.secondary) }
            }
        }
        .disabled(model.busy || !NativeServer.canManage)
        .confirmationDialog("Apply this local server change?", isPresented: Binding(get: { pendingOperation != nil }, set: { if !$0 { pendingOperation = nil } })) {
            Button("Continue") { if let operation = pendingOperation { pendingOperation = nil; operate(operation) } }
            Button("Cancel", role: .cancel) { pendingOperation = nil }
        } message: {
            Text(pendingOperation == "stop" ? "Connected devices will lose access until you start the server again."
                 : "Josi will use the existing server installation. Keep the app open until the operation finishes.")
        }
    }
    private func operate(_ operation: String) { model.run { try await model.operate(operation) } }
}

struct LoginView: View {
    @EnvironmentObject var model: JosiModel
    @State private var identifier = ""
    @State private var password = ""
    @State private var code = ""
    @State private var passwordSetup = false
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            JosiHeading(title: "Sign in to Josi", subtitle: model.address)
            if model.mfaChallenge.isEmpty {
                TextField("Username or email", text: $identifier).textContentType(.username)
                SecureField("Password", text: $password).textContentType(.password).onSubmit { submit() }
                Button("Invitation or password reset…") { password = ""; passwordSetup = true }
            } else {
                Text("Enter your verification or recovery code.")
                SecureField("Verification code", text: $code).onSubmit { submit() }
            }
            HStack {
                Button("Back") { password = ""; code = ""; model.disconnect() }
                Spacer()
                Button(model.mfaChallenge.isEmpty ? "Sign In" : "Verify") { submit() }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.textFieldStyle(.roundedBorder).padding(36).frame(maxWidth: 580).frame(maxWidth: .infinity, maxHeight: .infinity)
            .disabled(model.busy)
            .sheet(isPresented: $passwordSetup) { NativePasswordSetupView().environmentObject(model) }
    }
    private func submit() {
        if model.mfaChallenge.isEmpty {
            let value = password; password = ""
            model.run { try await model.signIn(identifier: identifier, password: value) }
        } else {
            let value = code; code = ""
            model.run { try await model.verifyMFA(value) }
        }
    }
}

struct WorkspaceView: View {
    @EnvironmentObject var model: JosiModel
    private var initials: String { String(model.signedInName.split(separator: " ").prefix(2).compactMap(\.first)) }
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    JosiMark(size: 38)
                    Text("Josi").font(.system(size: 25, weight: .semibold)).fixedSize()
                    Spacer()
                    Button { model.run { try await model.newThread() } } label: { Image(systemName: "square.and.pencil").font(.title3) }
                        .buttonStyle(.plain).help("New conversation").accessibilityLabel("New conversation").disabled(model.busy)
                }.padding(.horizontal, 18).padding(.top, 28).padding(.bottom, 18)
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        nav("Conversations", icon: "bubble.left.and.bubble.right", section: "chat")
                        nav("Task Manager", icon: "checklist", section: "tasks")
                        nav("Memory", icon: "brain.head.profile", section: "memory")
                        nav("Automation", icon: "macwindow", section: "automation")
                        nav("Vault", icon: "lock.shield", section: "vault")
                        nav("Your Settings", icon: "person.crop.circle", section: "account")
                        nav("Messaging Apps", icon: "paperplane", section: "channels")
                        if model.isAdministrator { nav("Models", icon: "square.3.layers.3d", section: "models") }
                        if model.isAdministrator { nav("People", icon: "person.2", section: "people") }
                        if model.isAdministrator { nav("Email Delivery", icon: "envelope", section: "mail-settings") }
                        if model.isAdministrator { nav("Backups", icon: "externaldrive.badge.timemachine", section: "backups") }
                        nav("Server", icon: "server.rack", section: "server")
                        Divider().padding(.vertical, 12)
                        Text("Recent conversations").font(.caption).foregroundStyle(JosiTheme.muted).padding(.horizontal, 12).padding(.bottom, 5)
                        ForEach(model.threads, id: \.identifier) { thread in
                            Button { model.run { try await model.selectThread(thread.identifier) } } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "bubble.left").frame(width: 22)
                                    Text(thread["title"].text.isEmpty ? "Conversation" : thread["title"].text).lineLimit(1)
                                    Spacer(minLength: 0)
                                }.font(.callout).padding(.horizontal, 12).padding(.vertical, 9)
                                    .foregroundStyle(model.selectedThread == thread.identifier ? JosiTheme.text : JosiTheme.muted)
                            }.buttonStyle(.plain).disabled(model.busy)
                        }
                    }.padding(.horizontal, 12)
                }
                Divider()
                HStack(spacing: 10) {
                    Text(initials).font(.callout.bold()).frame(width: 36, height: 36).background(JosiTheme.raised, in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.signedInName).font(.callout.weight(.semibold)).lineLimit(1)
                        Text(model.address.contains("localhost") ? "Local server" : model.address).font(.caption).foregroundStyle(JosiTheme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button { model.run { try await model.signOut() } } label: { Image(systemName: "rectangle.portrait.and.arrow.right") }
                        .buttonStyle(.plain).help("Sign out").accessibilityLabel("Sign out").disabled(model.busy)
                }.padding(16)
            }.frame(minWidth: 250, maxWidth: 250).background(JosiTheme.sidebar).navigationSplitViewColumnWidth(250)
                .toolbar(removing: .sidebarToggle)
        } detail: {
            Group {
                switch model.section {
                case "tasks": TaskManagerView()
                case "memory": NativeMemoryView()
                case "server": ScrollView { VStack(alignment: .leading, spacing: 28) {
                    if model.isAdministrator { NativeServerHealth() }; ServerControls()
                }.padding(30) }
                case "automation": AutomationView()
                case "vault": NativeVaultView()
                case "account": NativeAccountView()
                case "channels": NativeChannelsView()
                case "backups": if model.isAdministrator { NativeBackupsView() }
                case "models": if model.isAdministrator { NativeModelsView() }
                case "people": if model.isAdministrator { NativePeopleView() }
                case "mail-settings": if model.isAdministrator { NativeMailSettingsView() }
                default: ChatView()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(JosiTheme.background)
        }
    }
    private func nav(_ title: String, icon: String, section: String) -> some View {
        Button {
            model.section = section
            if section == "automation" { model.run { try await model.loadAutomation() } }
            else if section == "server" { model.refreshLocal() }
            else if ["chat", "tasks"].contains(section) { model.run { try await model.reloadWorkspace() } }
        } label: {
            HStack(spacing: 12) { Image(systemName: icon).font(.system(size: 18)).frame(width: 23); Text(title).lineLimit(1); Spacer(minLength: 0) }
                .font(.system(size: 14, weight: model.section == section ? .medium : .regular))
                .padding(.horizontal, 12).padding(.vertical, 10)
                .foregroundStyle(model.section == section ? JosiTheme.orange : JosiTheme.muted)
                .background(model.section == section ? JosiTheme.orange.opacity(0.15) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(model.busy)
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
            Label("Josi couldn’t reply", systemImage: "exclamationmark.triangle").font(.headline)
            Text(detail).textSelection(.enabled)
            if model.isAdministrator {
                Button(modelFailure ? "Open Models" : "Open Server") {
                    model.section = modelFailure ? "models" : "server"
                    if !modelFailure { model.refreshLocal() }
                }.disabled(model.busy)
            } else if modelFailure {
                Text("Ask your server administrator to check Models.")
            }
        }.foregroundStyle(.orange).padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
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
                    Text(goal["title"].text).font(.headline)
                    Spacer()
                    JosiStatusBadge(state: goal["state"].text)
                }
                ProgressView(value: Double(goal["verifiedSteps"].integer), total: Double(max(1, goal["totalSteps"].integer))).tint(JosiTheme.orange)
                Text("\(goal["verifiedSteps"].integer)/\(goal["totalSteps"].integer) verified")
                    .font(.subheadline.bold())
                if !goal["activity"].text.isEmpty { Text(goal["activity"].text).foregroundStyle(.secondary) }
                ForEach(visibleSteps, id: \.identifier) { step in
                    HStack(alignment: .top) {
                        Image(systemName: step["state"].text == "verified" ? "checkmark.circle.fill" : step["state"].text == "skipped" ? "minus.circle" : "circle")
                            .foregroundStyle(step["state"].text == "verified" ? Color.green : Color.secondary)
                        Text(step["title"].text).strikethrough(step["state"].text == "skipped")
                        Spacer()
                        Text(stepLabel(step["state"].text)).font(.caption).foregroundStyle(.secondary)
                    }
                    if !compact, !step["blockedReason"].text.isEmpty {
                        Text(step["blockedReason"].text).font(.caption).foregroundStyle(.secondary)
                        if !step["blockedUntil"].text.isEmpty {
                            Text("Next check: " + nativeDate(step["blockedUntil"].text)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !compact, !step["dependsOn"].list.isEmpty {
                        Text("After: " + step["dependsOn"].list.map { dependency in
                            goal["steps"].list.first { $0["id"] == dependency }?["title"].text ?? "Unavailable step"
                        }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                    if !compact, ProtectedWire.uuid(step["evidence"]), step["evidence"] == step["taskId"] {
                        NativeTaskReceipt(taskId: step["evidence"].text, revision: goal["revision"].integer, title: "View Saved Verification Task")
                    }
                    if !compact, step["retirement"] != .null {
                        Text("Retired: " + step["retirement"]["reason"].text).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if compact, goal["totalSteps"].integer > visibleSteps.count {
                    Text("Showing the current part of the plan. All steps are in Task Manager.").font(.caption).foregroundStyle(.secondary)
                }
                if goal["retiredSteps"].integer > 0 {
                    Text("\(goal["retiredSteps"].integer) retired steps retained in history.").font(.caption).foregroundStyle(.secondary)
                }
                if goal["continuation"]["kind"].text == "question" {
                    Text(recovery && !setupBlocked ? "Josi stopped before saving the next step. Your original request is still saved. Continue to recheck the task." : goal["continuation"]["text"].text).font(.callout.weight(.medium))
                    if setupBlocked || recovery { Button("Open Automation") { model.section = "automation"; model.run { try await model.loadAutomation() } } }
                }
                if goal["continuation"]["kind"].text == "wait" {
                    Text(goal["continuation"]["reason"].text).foregroundStyle(.secondary)
                    Text("Next check: " + nativeDate(goal["continuation"]["wakeAt"].text)).font(.caption).foregroundStyle(.secondary)
                }
                if goal["planNeedsReview"].flag { Text("Josi must review the changed plan before new actions.").font(.caption).foregroundStyle(.secondary) }
                if !goal["updatedAt"].text.isEmpty {
                    Text("Last saved: " + nativeDate(goal["updatedAt"].text)).font(.caption).foregroundStyle(.secondary)
                }
                if !compact {
                    if goal["automaticWork"] != .null, !["completed", "cancelled"].contains(goal["state"].text) {
                        let work = goal["automaticWork"]
                        Text("Automatic continuations since verified progress: \(work["segmentsSinceVerifiedProgress"].integer) of \(work["segmentLimit"].integer).")
                            .font(.caption).foregroundStyle(.secondary)
                        if !work["nextCheckAt"].text.isEmpty, ["planning", "working"].contains(goal["state"].text) {
                            Text("Scheduled to continue: " + nativeDate(work["nextCheckAt"].text)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    NativeWorkDetails(goal: goal)
                    TextField(recovery ? "Additional instructions (optional)" : "Instructions for Josi", text: $instruction).textFieldStyle(.roundedBorder)
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
                    Button("Open Task Manager") { model.section = "tasks"; model.run { try await model.reloadWorkspace() } }.buttonStyle(.link)
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
            Text(label).font(.callout.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 10)
                .foregroundStyle(filter == value ? JosiTheme.orange : JosiTheme.muted)
                .background(filter == value ? JosiTheme.orange.opacity(0.13) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(filter == value ? JosiTheme.orange.opacity(0.5) : Color.clear))
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
                JosiHeading(title: "Task Manager", subtitle: "What Josi is working on, and what needs your attention.")
                NativeTaskDesktopViewer(desktop: model.desktop)
                NativeAutomationConnections()
                HStack(spacing: 3) {
                    filterButton("Active", value: "active")
                    filterButton("Needs You / Waiting", value: "attention")
                    filterButton("History", value: "history")
                }.padding(4).background(JosiTheme.raised.opacity(0.5), in: RoundedRectangle(cornerRadius: 11)).frame(maxWidth: 620)
                if filter == "active" && !failedRuns.isEmpty {
                    Button("\(failedRuns.count) failed conversation request(s) — Review") { filter = "attention" }
                        .foregroundStyle(.orange)
                }
                if visible.isEmpty && standaloneTasks.isEmpty && visibleRuns.isEmpty {
                    Text("No work in this view.").foregroundStyle(.secondary)
                }
                ForEach(visible, id: \.identifier) { GoalCard(goal: $0) }
                if !visibleRuns.isEmpty {
                    Text("Conversation requests").font(.title2.bold())
                    ForEach(visibleRuns, id: \.identifier) { run in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(run["thread_title"].text.isEmpty ? "Conversation" : run["thread_title"].text).font(.headline)
                                Text(run["status"].text.capitalized + " · " + nativeDate(run["updated_at"].text)).foregroundStyle(.secondary)
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
                    Text("Other tasks").font(.title2.bold())
                    ForEach(standaloneTasks, id: \.identifier) { task in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(task["title"].text.isEmpty ? task["template_key"].text : task["title"].text).font(.headline)
                                    Text(task["state"].text.replacingOccurrences(of: "_", with: " ")).foregroundStyle(.secondary)
                                }
                                Spacer()
                                }
                                NativeTaskReceipt(taskId: task["id"].text, revision: task["attempt_count"].integer,
                                                  updatedAt: task["updated_at"].text)
                            }.padding(8)
                        }
                    }
                }
                Text(model.progressConnection).font(.caption).foregroundStyle(.secondary)
                if let refreshed = model.lastRefreshed { Text("Updated \(refreshed.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary) }
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
                        Text(model.automationError).foregroundStyle(JosiTheme.orange).textSelection(.enabled)
                        HStack { Button("Open Vault") { model.section = "vault" }; Button("Check Server") { model.section = "server" } }
                    }
                }
                if model.automation != .null {
                    if !model.automation["blocker"]["message"].text.isEmpty {
                        GroupBox("Before Josi can use the browser") {
                            Text(model.automation["blocker"]["message"].text).textSelection(.enabled)
                            if model.automation["blocker"]["code"].text == "vault_locked" { Button("Open Vault") { model.section = "vault" } }
                            Text("Your task and original instructions stay saved in Task Manager.").font(.caption).foregroundStyle(JosiTheme.muted)
                        }
                    }
                    ForEach(Array(model.automation["workspaces"].list.enumerated()), id: \.offset) { _, workspace in
                        GroupBox { VStack(alignment: .leading, spacing: 6) {
                            Text(workspace["label"].text).font(.headline)
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
