import AppKit
import ServiceManagement
import SwiftUI

/// What the owner must decide about work on this Mac, as cards above the chat
/// bar: approving this Mac once, and each PC Control request waiting for them.
struct PcRequestCards: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject private var pc = PcExecutor.shared
    @State private var asking: [String: String] = [:]     // request id → the choice waiting for the password
    @State private var password = ""
    @State private var problem = ""
    @State private var working = false
    private static let everyday: Set<String> = ["desktop.view", "explorer.view", "folder.read", "folder.write", "file.rename", "file.move",
                                                "app.launch", "app.view", "app.control", "app.close", "browser.view", "browser.fill"]
    var body: some View {
        if model.canControlPc, pc.needsApproval || !pc.requests.isEmpty || pc.browserDiscovery != nil || pc.browserHelperNeedsApproval {
            ScrollView {
                VStack(spacing: 10) {
                    if pc.needsApproval { approveCard }
                    if let found = pc.browserDiscovery { browserCard(found) }
                    if pc.browserHelperNeedsApproval {
                        card {
                            Text("Let Josi reach your browser").font(JosiFont.headline)
                            NativeLeanNote(text: "Josi's browser helper is waiting for your OK in System Settings > General > Login Items & Extensions. Turn on Josi there, then turn on the Josi extension in Safari > Settings > Extensions.")
                            HStack {
                                Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }.buttonStyle(JosiOutlineButtonStyle())
                                Button("Turn On Josi in Safari") { PcBrowserBridge.openSafariExtensionSettings() }.buttonStyle(JosiOutlineButtonStyle())
                            }
                        }
                    }
                    ForEach(pc.requests, id: \.identifier) { requestCard($0) }
                }
            }.frame(maxHeight: 300).padding(.horizontal, 26).frame(maxWidth: 830)
        }
    }
    private var approveCard: some View {
        card {
            Text("Approve this Mac for Josi").font(JosiFont.headline)
            NativeLeanNote(text: pc.keyChanged
                ? "This Mac's computer-control key changed. Remove its old identity under PC Control, then approve it again."
                : "Computer control is on, but this Mac hasn't been approved yet. One approval with your password binds it to your account; it grants no permissions by itself.")
            if !pc.keyChanged {
                Button("Approve with Mac Administrator", action: approveAsAdministrator).buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(working)
                HStack {
                    SecureField("Or your Josi password", text: $password).textFieldStyle(JosiFieldStyle()).onSubmit(approveMac)
                    Button("Approve This Mac", action: approveMac).buttonStyle(JosiOutlineButtonStyle()).disabled(password.isEmpty || working)
                }
            }
            if !problem.isEmpty, asking.isEmpty { Text(problem).font(JosiFont.caption).foregroundStyle(JosiTheme.error) }
        }
    }
    private func browserCard(_ found: PcBrowserBridge.Discovery) -> some View {
        card {
            Text("\(found.browser) wants to link with Josi").font(JosiFont.headline)
            NativeLeanNote(text: "Allowing lets Josi see the sites and titles of this browser's tabs and work in a tab you attach, each time with your PC Control permission. Nothing on a page is read until you ask.")
            HStack {
                Button("Allow \(found.browser)") { PcBrowserBridge.shared.allowDiscovered() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Not Now") { PcBrowserBridge.shared.ignoreDiscovered() }.buttonStyle(JosiOutlineButtonStyle())
            }
        }
    }
    private func requestCard(_ request: Wire) -> some View {
        let id = request.identifier, high = request["highRisk"].flag
        let requirements = request["requirements"].list
        let command = requirements.first { $0["action"].text == "command.run" && $0["scope"]["kind"].text == "command" }
        let site = requirements.count == 1 && requirements[0]["scope"]["kind"].text == "browser" ? requirements[0] : nil
        let everyday = !requirements.isEmpty && requirements.allSatisfy { Self.everyday.contains($0["action"].text) }
        return card {
            Text("Josi is asking").font(JosiFont.caption).foregroundStyle(JosiTheme.gold)
            Text(request["description"].text).font(JosiFont.headline).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(requirements.enumerated()), id: \.offset) { _, requirement in
                let application = requirement["scope"]["application"].text
                Text(requirement["action"].text + ": " + requirement["scope"]["target"].text + (application.isEmpty ? "" : " · " + (application as NSString).lastPathComponent))
                    .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).textSelection(.enabled)
            }
            if high { Text("High risk: your password confirms it.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            if let choice = asking[id] {
                HStack {
                    SecureField("Your Josi password", text: $password).textFieldStyle(JosiFieldStyle()).onSubmit { decide(request, choice) }
                    Button("Confirm") { decide(request, choice) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(password.isEmpty || working)
                    Button("Cancel") { asking[id] = nil; password = ""; problem = "" }.buttonStyle(JosiOutlineButtonStyle())
                }
                if !problem.isEmpty { Text(problem).font(JosiFont.caption).foregroundStyle(JosiTheme.error) }
            } else {
                HStack(spacing: 8) {
                    Button("Allow Once") { choose(request, "once", needsPassword: high) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                    if site != nil { Button("Always Allow on This Site") { choose(request, "site", needsPassword: high) }.buttonStyle(JosiOutlineButtonStyle()) }
                    if command != nil { Button("Always Allow This Shell Here") { choose(request, "shell", needsPassword: true) }.buttonStyle(JosiOutlineButtonStyle()) }
                    else if everyday { Button("Allow Everyday Things") { choose(request, "everyday", needsPassword: true) }.buttonStyle(JosiOutlineButtonStyle()) }
                    Spacer()
                    Button("Deny") { send(request, approve: false) }.buttonStyle(JosiOutlineButtonStyle())
                }.disabled(working)
            }
        }
    }
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) { content() }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(JosiTheme.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(JosiTheme.gold.opacity(0.45), lineWidth: 1))
    }
    private func choose(_ request: Wire, _ choice: String, needsPassword: Bool) {
        problem = ""
        if needsPassword { asking = [request.identifier: choice]; password = "" } else { decide(request, choice) }
    }
    private func approveMac() {
        guard let api = model.api, !password.isEmpty else { return }
        let secret = password; password = ""; working = true; problem = ""
        Task {
            defer { working = false }
            do { try await pc.approve(api, owner: model.user["id"].text, password: secret) } catch { problem = error.localizedDescription }
        }
    }
    private func approveAsAdministrator() {
        guard let api = model.api else { return }
        working = true; problem = ""
        Task {
            defer { working = false }
            do {
                if !(try await pc.approveAsAdministrator(api, owner: model.user["id"].text)) { problem = "Not approved. You can use your Josi password instead." }
            } catch { problem = error.localizedDescription }
        }
    }
    private func send(_ request: Wire, approve: Bool) {
        guard let api = model.api else { return }
        working = true
        Task {
            defer { working = false }
            _ = try? await api.request("/admin/pc-control/requests/\(try api.uuid(request.identifier))/decision", method: "POST", body: ["approve": .bool(approve)])
            pc.dropRequest(request.identifier)
        }
    }
    private func decide(_ request: Wire, _ choice: String) {
        guard let api = model.api else { return }
        let secret = password; password = ""; working = true; problem = ""
        let high = request["highRisk"].flag
        let requirements = request["requirements"].list
        Task {
            defer { working = false }
            do {
                let decision: Wire = high || choice == "shell" ? ["approve": .bool(true), "password": .string(secret)] : ["approve": .bool(true)]
                switch choice {
                case "site":
                    let r = requirements[0], scope = r["scope"]
                    var policy: [String: Wire] = ["action": r["action"], "mode": "always",
                                                  "scope": ["kind": "browser", "target": scope["target"], "application": scope["application"], "profile": scope["profile"]]]
                    if high { policy["password"] = .string(secret) }
                    _ = try await api.request("/admin/pc-control/policies", method: "PUT", body: .object(policy))
                case "shell":
                    let scope = requirements.first { $0["action"].text == "command.run" }!["scope"]
                    _ = try await api.request("/admin/pc-control/policies", method: "PUT", body: ["action": "command.run", "mode": "always", "password": .string(secret),
                                                                                                   "scope": ["kind": "command", "target": scope["target"], "application": scope["application"]]])
                case "everyday":
                    _ = try await api.request("/admin/pc-control/full-control", method: "PUT", body: ["enabled": .bool(true), "password": .string(secret)])
                default: break
                }
                do { _ = try await api.request("/admin/pc-control/requests/\(try api.uuid(request.identifier))/decision", method: "POST", body: decision) }
                catch where choice != "once" { /* A saved permission already covers it. */ }
                asking = [:]
                pc.dropRequest(request.identifier); pc.resume()
            } catch { problem = error.localizedDescription }
        }
    }
}

extension PcExecutor {
    func dropRequest(_ id: String) { setRequests(requests.filter { $0.identifier != id }) }
}

/// The strip that floats at the top of the screen while Josi works on this Mac,
/// over every app, with Take Over, Pause, Resume and Stop always within reach.
@MainActor final class PcControlBar {
    static let shared = PcControlBar()
    private var panel: NSPanel?
    func update() {
        let pc = PcExecutor.shared
        guard pc.showsControls else { panel?.orderOut(nil); return }
        if panel == nil {
            let made = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 64), styleMask: [.nonactivatingPanel, .borderless],
                               backing: .buffered, defer: false)
            made.isFloatingPanel = true; made.level = .statusBar; made.hidesOnDeactivate = false
            made.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            made.isOpaque = false; made.backgroundColor = .clear; made.hasShadow = true
            made.sharingType = .none   // Josi's own screenshots never include the bar.
            made.contentView = NSHostingView(rootView: PcControlStrip().preferredColorScheme(.dark))
            panel = made
        }
        if let panel, let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: frame.midX - 320, y: frame.maxY - 76))
            panel.orderFrontRegardless()
        }
    }
}

struct PcControlStrip: View {
    @ObservedObject private var pc = PcExecutor.shared
    private var status: String {
        pc.pendingStop ? "Stopped · You are in control" : pc.paused ? "Paused · You are in control" : pc.takenOver ? "You are in control"
            : !pc.browserActivity.isEmpty && !pc.busy ? "Josi is working in \(pc.browserLinked ?? "the browser")"
            : !pc.busy && pc.terminals == 0 ? "Ready · You are in control" : pc.onScreen ? "Josi is using this Mac" : "Josi is working in the background"
    }
    private var detail: String {
        pc.pendingStop ? "Computer control is stopped." : pc.paused ? "Choose Resume when you're ready." : pc.takenOver ? "Screen work stopped. Josi reads again before her next step."
            : !pc.browserActivity.isEmpty && !pc.busy ? pc.browserActivity
            : !pc.busy ? (pc.terminals > 0 ? "\(pc.terminals) terminal\(pc.terminals == 1 ? "" : "s") open." : "Ready when you ask Josi to work.")
            : pc.onScreen ? "\(pc.activity) · Move your mouse or type to take over." : pc.activity
    }
    var body: some View {
        HStack(spacing: 12) {
            JosiMark(size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(status).font(JosiFont.body(13, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                Text(detail).font(JosiFont.body(11)).foregroundStyle(JosiTheme.lilac).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button("Take Over") { pc.takeOver() }.disabled(!pc.busy || !pc.onScreen)
            Button("Pause") { pc.pause() }.disabled(pc.paused || pc.pendingStop)
            Button("Resume") { pc.resume() }.disabled(!(pc.paused || pc.takenOver) || pc.pendingStop)
            Button("Stop") { pc.stop() }.disabled(pc.pendingStop)
        }
        .buttonStyle(JosiOutlineButtonStyle()).controlSize(.small)
        .padding(.horizontal, 16).frame(width: 640, height: 64)
        .background(Color(red: 0.19, green: 0.09, blue: 0.25).opacity(0.96), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(pc.busy && pc.onScreen ? Color(red: 0.25, green: 0.56, blue: 1) : JosiTheme.gold.opacity(0.5), lineWidth: 2))
    }
}
