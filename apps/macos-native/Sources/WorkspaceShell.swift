import AppKit
import SwiftUI

struct WorkspaceView: View {
    @EnvironmentObject var model: JosiModel
    private var initials: String { String(model.signedInName.split(separator: " ").prefix(2).compactMap(\.first)).uppercased() }
    private var collapsed: Bool { model.sidebarCollapsed }
    private var serverLabel: String { model.address.contains("localhost") ? "Local server" : model.address }
    private typealias Item = (title: String, icon: String, section: String)
    private var workspace: [Item] {
        [("Chat", "bubble.left.and.bubble.right", "chat"), ("Tasks", "checklist", "tasks"), ("Approvals", "checkmark.shield", "approvals"),
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
    var body: some View {
        HStack(spacing: 0) {
            sidebar
            VStack(spacing: 0) {
                topBar
                Group {
                    switch model.section {
                    case "tasks": TaskManagerView()
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
        }
    }
    private var topBar: some View {
        HStack(spacing: 10) {
            Text(title).font(JosiFont.display(16)).lineLimit(1)
            Spacer()
            HStack(spacing: 6) {
                Circle().fill(JosiTheme.success).frame(width: 6, height: 6)
                Text(serverLabel).lineLimit(1)
            }.font(JosiFont.body(11, weight: .semibold)).foregroundStyle(JosiTheme.lilac).padding(.horizontal, 10).padding(.vertical, 4)
                .overlay(Capsule().stroke(JosiTheme.border, lineWidth: 1))
        }.padding(.horizontal, 20).frame(height: 54).background(JosiFrost())
            .overlay(alignment: .bottom) { Rectangle().fill(JosiTheme.hairline).frame(height: 1) }
    }
    private var sidebar: some View {
        VStack(spacing: 0) {
            brand
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    group("Workspace", items: workspace)
                    if model.isAdministrator { group("Admin", items: admin) }
                    if !collapsed, !model.threads.isEmpty {
                        header("Recent chats")
                        ForEach(model.threads.prefix(12), id: \.identifier) { thread in
                            Button { model.run { try await model.selectThread(thread.identifier) } } label: {
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
        }.frame(width: collapsed ? 68 : 250).background(JosiFrost())
            .overlay(alignment: .trailing) { Rectangle().fill(JosiTheme.hairline).frame(width: 1) }
    }
    private var brand: some View {
        Group {
            if collapsed {
                VStack(spacing: 8) { JosiMarkTile(); collapseButton }
            } else {
                HStack(spacing: 10) {
                    JosiMarkTile()
                    Text("Josi").font(JosiFont.display(21)).fixedSize()
                    Spacer()
                    Button { model.run { try await model.newThread() } } label: { Image(systemName: "square.and.pencil") }
                        .buttonStyle(JosiIconButtonStyle()).help("New conversation").accessibilityLabel("New conversation").disabled(model.busy)
                    collapseButton
                }
            }
        }.padding(.horizontal, collapsed ? 0 : 16).padding(.top, 44).padding(.bottom, 14)
    }
    private var collapseButton: some View {
        Button { model.toggleSidebar() } label: { Image(systemName: "sidebar.left") }
            .buttonStyle(JosiIconButtonStyle()).help(collapsed ? "Show sidebar" : "Hide sidebar")
            .accessibilityLabel(collapsed ? "Show sidebar" : "Hide sidebar")
    }
    @ViewBuilder private func group(_ title: String, items: [Item]) -> some View {
        if collapsed { Rectangle().fill(JosiTheme.border).frame(height: 1).padding(.vertical, 8).padding(.horizontal, 10) }
        else { header(title) }
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
            model.section = item.section
            if item.section == "automation" { model.run { try await model.loadAutomation() } }
            else if ["chat", "tasks"].contains(item.section) { model.run { try await model.reloadWorkspace() } }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: item.icon).font(.system(size: 15)).frame(width: 20)
                if !collapsed {
                    Text(item.title).lineLimit(1)
                    Spacer(minLength: 0)
                    if badge > 0 { JosiBadge(count: badge) }
                }
            }.font(JosiFont.body(13.5)).padding(.vertical, 8).padding(.horizontal, collapsed ? 0 : 10)
                .frame(maxWidth: .infinity, alignment: collapsed ? .center : .leading)
                .foregroundStyle(selected ? JosiTheme.gold : JosiTheme.lilac)
                .background(selected ? JosiTheme.gold.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? JosiTheme.gold.opacity(0.28) : Color.clear, lineWidth: 1))
                .overlay(alignment: .topTrailing) { if collapsed, badge > 0 { JosiBadge(count: badge).offset(x: -2, y: 2) } }
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(model.busy).help(collapsed ? item.title : "").accessibilityLabel(item.title)
    }
    private var account: some View {
        HStack(spacing: 10) {
            Text(initials).font(JosiFont.body(13, weight: .bold)).foregroundStyle(JosiTheme.onGold).frame(width: 34, height: 34)
                .background(JosiTheme.goldGradient, in: Circle()).help(collapsed ? model.signedInName : "")
            if !collapsed {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.signedInName).font(JosiFont.body(13, weight: .semibold)).lineLimit(1)
                    Text(serverLabel).font(JosiFont.body(11.5)).foregroundStyle(JosiTheme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Button { model.run { try await model.signOut() } } label: { Image(systemName: "rectangle.portrait.and.arrow.right") }
                    .buttonStyle(JosiIconButtonStyle()).help("Sign out").accessibilityLabel("Sign out").disabled(model.busy)
            }
        }.padding(.horizontal, collapsed ? 0 : 14).padding(.vertical, 12).frame(maxWidth: .infinity)
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
