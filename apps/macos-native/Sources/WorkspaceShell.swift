import AppKit
import SwiftUI

struct WorkspaceView: View {
    @EnvironmentObject var model: JosiModel
    private var initials: String { String(model.signedInName.split(separator: " ").prefix(2).compactMap(\.first)).uppercased() }
    private var serverLabel: String { model.address.contains("localhost") ? "Local server" : model.address }
    private typealias Item = (title: String, icon: String, section: String)
    private var workspace: [Item] {
        [("My World", "globe.americas", "my-world"), ("Chat", "bubble.left.and.bubble.right", "chat"), ("Tasks", "checklist", "tasks"), ("Approvals", "checkmark.shield", "approvals"),
         ("Email", "envelope", "email"), ("Calendar", "calendar", "calendar"), ("Contacts", "person.crop.circle", "contacts"),
         ("Vault", "lock.shield", "vault"), ("Connections", "link", "connections"), ("Settings", "gearshape", "settings")]
    }
    private var admin: [Item] {
        var items: [Item] = [("Overview", "square.grid.2x2", "overview"), ("People", "person.2", "people"),
                             ("Backups", "externaldrive.badge.timemachine", "backups")]
        if JosiFlags.serverApp { items += [("Model", "square.3.layers.3d", "models"), ("Network & address", "globe", "network")] }
        return items
    }
    private var title: String {
        if model.section == "chat" { return model.threads.first { $0.identifier == model.selectedThread }?["title"].text.nonempty ?? "Chat" }
        return (workspace + admin).first { $0.section == model.section }?.title ?? "Josi"
    }
    private var chat: Bool { !["my-world", "tasks", "approvals", "email", "calendar", "contacts", "vault", "connections", "settings", "overview", "people", "backups", "models", "network", "automation", "channels"].contains(model.section) }
    private var status: String {
        switch model.ghost.state {
        case .listening: "listening…"
        case .thinking: "thinking…"
        case .speaking: "speaking…"
        case .online: "online"
        }
    }
    var body: some View {
        ZStack(alignment: .leading) {
            VStack(spacing: 0) {
                topBar
                Group {
                    switch model.section {
                    case "tasks": TaskManagerView()
                    case "my-world": NativeMyWorldView()
                    case "approvals": NativeApprovalsView()
                    case "email": NativeEmailView()
                    case "calendar": NativeCalendarView()
                    case "contacts": NativeContactsView()
                    case "vault": NativeVaultView()
                    case "connections": NativeConnectionsView()
                    case "settings": NativeSettingsView()
                    case "overview": if model.isAdministrator { NativeOverviewView() }
                    case "people": if model.isAdministrator { NativePeopleView() }
                    case "backups": if model.isAdministrator { NativeBackupsView() }
                    case "models": if model.isAdministrator, JosiFlags.serverApp { NativeModelsView() }
                    case "network": if model.isAdministrator, JosiFlags.serverApp { NativeNetworkView() }
                    case "automation": if JosiFlags.localWorkspace { AutomationView() }
                    case "channels": if JosiFlags.channels { NativeChannelsView() }
                    default: ChatView()
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if model.menuOpen {
                Color.black.opacity(0.45).ignoresSafeArea().onTapGesture { model.showMenu(false) }.transition(.opacity)
                menu.transition(.move(edge: .leading))
            }
            // Esc closes whatever slid in.
            if model.menuOpen || model.historyOpen {
                Button("") { if model.menuOpen { model.showMenu(false) } else { model.showHistory(false) } }
                    .keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
        .sheet(isPresented: Binding(get: { model.settingsProposal != .null }, set: { if !$0 { model.settingsProposal = .null } })) {
            if model.settingsProposal["area"].text == "credential_card" {
                CredentialCardSheet(proposal: model.settingsProposal).environmentObject(model).preferredColorScheme(.dark)
            } else {
                SettingsChangeSheet(proposal: model.settingsProposal).environmentObject(model).preferredColorScheme(.dark)
            }
        }
    }
    private var topBar: some View {
        HStack(spacing: 12) {
            Button { model.showMenu(true) } label: { Image(systemName: "line.3.horizontal") }
                .buttonStyle(JosiIconButtonStyle()).help("Menu").accessibilityLabel("Menu")
            JosiMarkTile()
            VStack(alignment: .leading, spacing: 1) {
                Text(chat ? "Josi" : title).font(JosiFont.display(16)).lineLimit(1)
                Text(status).font(JosiFont.body(11.5)).foregroundStyle(model.ghost.state == .online ? JosiTheme.muted : JosiTheme.gold)
            }
            Spacer()
            if chat {
                if !model.chatGoals.isEmpty {
                    Button(model.chatGoals.count == 1 ? "1 task" : "\(model.chatGoals.count) tasks") { model.showHistory(true) }.buttonStyle(JosiChipStyle())
                }
                if !model.modelName.isEmpty { Text(model.modelName).font(JosiFont.caption).foregroundStyle(JosiTheme.muted).lineLimit(1) }
                Button { model.showHistory(true) } label: { Image(systemName: "clock.arrow.circlepath") }
                    .buttonStyle(JosiIconButtonStyle()).help("Chat history").accessibilityLabel("Chat history")
                    .overlay(alignment: .topTrailing) { if model.messages.count >= 2 { JosiBadge(count: model.messages.count).offset(x: 6, y: -6).allowsHitTesting(false) } }
            } else {
                HStack(spacing: 6) {
                    Circle().fill(JosiTheme.success).frame(width: 6, height: 6)
                    Text(serverLabel).lineLimit(1)
                }.font(JosiFont.body(11, weight: .semibold)).foregroundStyle(JosiTheme.lilac).padding(.horizontal, 10).padding(.vertical, 4)
                    .overlay(Capsule().stroke(JosiTheme.border, lineWidth: 1))
            }
        }.padding(.leading, 84).padding(.trailing, 18).frame(height: 58)
    }
    /// Slides in over the stage. Esc, a click outside it, or picking an item closes it.
    private var menu: some View {
        VStack(spacing: 0) {
            brand
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    group("Workspace", items: workspace)
                    if model.isAdministrator { group("Admin", items: admin) }
                    if !model.threads.isEmpty {
                        header("Recent chats")
                        ForEach(model.threads.prefix(12), id: \.identifier) { thread in
                            Button { model.showMenu(false); model.section = "chat"; model.run { try await model.selectThread(thread.identifier) } } label: {
                                Text(thread["title"].text.isEmpty ? "Conversation" : thread["title"].text).lineLimit(1)
                                    .font(JosiFont.body(13)).frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10).padding(.vertical, 7).contentShape(Rectangle())
                                    .foregroundStyle(model.section == "chat" && model.selectedThread == thread.identifier ? JosiTheme.text : JosiTheme.muted)
                            }.buttonStyle(.plain).disabled(model.busy)
                        }
                    }
                }.padding(.horizontal, 10).padding(.bottom, 10)
            }
            account
        }.frame(width: 340).frame(maxHeight: .infinity).background(JosiTheme.deep)
            .overlay(alignment: .trailing) { Rectangle().fill(JosiTheme.hairline).frame(width: 1) }
            .ignoresSafeArea()
    }
    private var brand: some View {
        HStack(spacing: 10) {
            JosiMarkTile()
            Text("Josi").font(JosiFont.display(21)).fixedSize()
            Spacer()
            Button { model.showMenu(false); model.section = "chat"; model.run { try await model.newThread() } } label: { Image(systemName: "square.and.pencil") }
                .buttonStyle(JosiIconButtonStyle()).help("New conversation").accessibilityLabel("New conversation").disabled(model.busy)
            Button { model.showMenu(false) } label: { Image(systemName: "xmark") }
                .buttonStyle(JosiIconButtonStyle()).help("Close menu").accessibilityLabel("Close menu")
        }.padding(.horizontal, 16).padding(.top, 44).padding(.bottom, 14)
    }
    @ViewBuilder private func group(_ title: String, items: [Item]) -> some View {
        header(title)
        ForEach(items, id: \.section) { nav($0) }
    }
    private func header(_ title: String) -> some View {
        Text(title.uppercased()).font(JosiFont.body(11, weight: .semibold)).kerning(0.9).foregroundStyle(JosiTheme.muted)
            .padding(.horizontal, 10).padding(.top, 12).padding(.bottom, 6)
    }
    private func nav(_ item: Item) -> some View {
        let selected = model.section == item.section
        let badge = item.section == "approvals" ? model.approvalsWaiting : 0
        return Button {
            model.showMenu(false)
            model.section = item.section
            if item.section == "automation" { model.run { try await model.loadAutomation() } }
            else if ["chat", "tasks"].contains(item.section) { model.run { try await model.reloadWorkspace() } }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: item.icon).font(.system(size: 15)).frame(width: 20)
                Text(item.title).lineLimit(1)
                Spacer(minLength: 0)
                if badge > 0 { JosiBadge(count: badge) }
            }.font(JosiFont.body(13.5)).padding(.vertical, 8).padding(.horizontal, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(selected ? JosiTheme.gold : JosiTheme.lilac)
                .background(selected ? JosiTheme.gold.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? JosiTheme.gold.opacity(0.28) : Color.clear, lineWidth: 1))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(model.busy).accessibilityLabel(item.title)
    }
    private var account: some View {
        HStack(spacing: 10) {
            Text(initials).font(JosiFont.body(13, weight: .bold)).foregroundStyle(JosiTheme.onGold).frame(width: 34, height: 34)
                .background(JosiTheme.goldGradient, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(model.signedInName).font(JosiFont.body(13, weight: .semibold)).lineLimit(1)
                Text(serverLabel).font(JosiFont.body(11.5)).foregroundStyle(JosiTheme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button { model.showMenu(false); model.run { try await model.signOut() } } label: { Image(systemName: "rectangle.portrait.and.arrow.right") }
                .buttonStyle(JosiIconButtonStyle()).help("Sign out").accessibilityLabel("Sign out").disabled(model.busy)
        }.padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity)
            .overlay(alignment: .top) { Rectangle().fill(JosiTheme.hairline).frame(height: 1) }
    }
}

struct JosiBadge: View {
    var count: Int
    var body: some View {
        Text("\(count)").font(JosiFont.body(10, weight: .semibold)).foregroundStyle(.white).padding(.horizontal, 6).padding(.vertical, 1)
            .background(JosiTheme.error, in: Capsule()).accessibilityLabel("\(count) waiting")
    }
}

struct JosiIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.frame(width: 30, height: 30).foregroundStyle(JosiTheme.lilac)
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(JosiTheme.border, lineWidth: 1)).contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
