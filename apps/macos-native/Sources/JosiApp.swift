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
        }.sheet(isPresented: Binding(get: { model.vaultRecovery != .null || model.mfaRecovery != .null }, set: { _ in })) {
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
            Image(nsImage: NSImage(named: "Josi") ?? NSImage())
                .resizable().scaledToFit().frame(width: 68, height: 68)
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
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack {
                    Text("Josi").font(.title.bold())
                    Spacer()
                    Button { model.run { try await model.newThread() } } label: { Image(systemName: "square.and.pencil") }
                        .help("New conversation").disabled(model.busy)
                }.padding(18)
                List {
                    Section {
                        nav("Conversations", icon: "bubble.left.and.bubble.right", section: "chat")
                        nav("Task Manager", icon: "checklist", section: "tasks")
                        nav("Memory", icon: "brain.head.profile", section: "memory")
                        nav("Automation", icon: "macwindow", section: "automation")
                        nav("Vault", icon: "lock.shield", section: "vault")
                        nav("Your Settings", icon: "person.crop.circle", section: "account")
                        nav("Messaging Apps", icon: "paperplane", section: "channels")
                        if model.isAdministrator { nav("Models", icon: "brain", section: "models") }
                        if model.isAdministrator { nav("People", icon: "person.2", section: "people") }
                        if model.isAdministrator { nav("Backups", icon: "externaldrive.badge.timemachine", section: "backups") }
                        nav("Server", icon: "externaldrive.connected.to.line.below", section: "server")
                    }
                    Section("Recent conversations") {
                        ForEach(model.threads, id: \.identifier) { thread in
                            Button {
                                model.run { try await model.selectThread(thread.identifier) }
                            } label: {
                                HStack {
                                    Image(systemName: model.selectedThread == thread.identifier ? "bubble.left.fill" : "bubble.left")
                                    Text(thread["title"].text.isEmpty ? "Conversation" : thread["title"].text).lineLimit(2)
                                }.foregroundStyle(model.selectedThread == thread.identifier ? Color.accentColor : Color.primary)
                            }.buttonStyle(.plain).padding(.vertical, 3)
                        }
                    }
                }.listStyle(.sidebar)
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.signedInName).font(.headline)
                    Text(model.address).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Button("Sign Out") { model.run { try await model.signOut() } }.disabled(model.busy)
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }.navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            switch model.section {
            case "tasks": TaskManagerView()
            case "memory": NativeMemoryView()
            case "server": ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if model.isAdministrator { NativeServerHealth() }
                    ServerControls()
                }.padding(30)
            }
            case "automation": AutomationView()
            case "vault": NativeVaultView()
            case "account": NativeAccountView()
            case "channels": NativeChannelsView()
            case "backups": if model.isAdministrator { NativeBackupsView() }
            case "models": if model.isAdministrator { NativeModelsView() }
            case "people": if model.isAdministrator { NativePeopleView() }
            default: ChatView()
            }
        }
    }
    private func nav(_ title: String, icon: String, section: String) -> some View {
        Button {
            model.section = section
            if section == "automation" { model.run { try await model.loadAutomation() } }
            else if section == "server" { model.refreshLocal() }
            else if ["vault", "backups", "models", "account", "channels", "memory", "people"].contains(section) { /* These views load their own scoped status. */ }
            else { model.run { try await model.reloadWorkspace() } }
        } label: { Label(title, systemImage: icon).foregroundStyle(model.section == section ? Color.accentColor : Color.primary) }
            .buttonStyle(.plain).disabled(model.busy)
    }
}

struct ChatView: View {
    @EnvironmentObject var model: JosiModel
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if model.messages.isEmpty {
                            ContentUnavailableView("What would you like to get done?", systemImage: "bubble.left.and.bubble.right",
                                                   description: Text("Start a conversation. Josi’s progress will appear here as it works."))
                                .padding(.top, 70)
                        }
                        ForEach(model.messages, id: \.identifier) { message in
                            VStack(alignment: .leading, spacing: 7) {
                                Text(message["direction"].text == "in" ? "You" : "Josi")
                                    .font(.caption.bold()).foregroundStyle(.secondary)
                                Text(message["body"].text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(16).background(message["direction"].text == "in" ? Color.accentColor.opacity(0.07) : Color.clear,
                                                       in: RoundedRectangle(cornerRadius: 14))
                                .id(message.identifier)
                        }
                        ForEach(model.chatGoals, id: \.identifier) { GoalCard(goal: $0, compact: true) }
                        if model.turns.contains(where: { ["queued", "running"].contains($0["status"].text) }) {
                            HStack { ProgressView().controlSize(.small); Text("Josi is working…").foregroundStyle(.secondary) }
                        }
                        Color.clear.frame(height: 1).id("latest")
                    }.padding(24).frame(maxWidth: 920).frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.identifier) { _, _ in withAnimation { proxy.scrollTo("latest", anchor: .bottom) } }
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $model.draft).font(.body).frame(minHeight: 65, maxHeight: 140)
                    .scrollContentBackground(.hidden).padding(7)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
                    .disabled(model.pendingMessage)
                HStack {
                    if model.pendingMessage {
                        Text("Delivery is unconfirmed. Retry uses the same message ID.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text(model.progressConnection + " · Work continues on the server when this window closes.").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(model.pendingMessage ? "Retry Delivery" : "Send") { model.run { try await model.send() } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(model.busy || (!model.pendingMessage && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }.padding(18)
        }
    }
}

struct GoalCard: View {
    @EnvironmentObject var model: JosiModel
    let goal: Wire
    var compact = false
    @State private var instruction = ""
    @State private var cancelling = false
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
                    Text(goal["state"].text.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
                }
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
                if goal["continuation"]["kind"].text == "question" { Text(goal["continuation"]["text"].text).font(.callout.bold()) }
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
                    TextField("Instructions for Josi", text: $instruction).textFieldStyle(.roundedBorder)
                    HStack {
                        if goal["state"].text != "completed" && goal["state"].text != "cancelled" {
                            Button("Pause") { control("pause") }
                            Button("Continue") { control("resume") }.disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
    private func control(_ action: String) { model.run { try await model.control(goal, action: action, instruction: instruction) } }
}

struct TaskManagerView: View {
    @EnvironmentObject var model: JosiModel
    @State private var filter = "active"
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
                Picker("Work", selection: $filter) {
                    Text("Active").tag("active"); Text("Needs You / Waiting").tag("attention"); Text("History").tag("history")
                }.pickerStyle(.segmented)
                if visible.isEmpty && standaloneTasks.isEmpty {
                    Text("No work in this view.").foregroundStyle(.secondary)
                }
                ForEach(visible, id: \.identifier) { GoalCard(goal: $0) }
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
                if model.automation["available"].flag {
                    ForEach(Array(model.automation["workspaces"].list.enumerated()), id: \.offset) { _, workspace in
                        GroupBox { VStack(alignment: .leading) { Text(workspace["label"].text).font(.headline); Text(workspace["state"].text) }.frame(maxWidth: .infinity, alignment: .leading).padding(8) }
                    }
                    if model.automation["workspaces"].list.isEmpty { Text("No automation desktop is connected to your account.") }
                } else { Text("Automation control is not connected on this server yet. Your other Josi work can continue.").foregroundStyle(.secondary) }
                if model.isAdministrator {
                    NativeWorkspaceStorageView(desktop: model.desktop)
                    NativeAuthoritySettings()
                }
                Button("Refresh") { model.run { try await model.loadAutomation() } }.disabled(model.busy)
            }.padding(30)
        }
    }
}
