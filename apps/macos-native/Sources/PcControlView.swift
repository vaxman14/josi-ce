import AppKit
import ApplicationServices
import ServiceManagement
import SwiftUI

/// What Josi may do on this Mac, for the owner: on or off, everyday things
/// without asking, each saved permission with Revoke, the browsers allowed to
/// link, macOS's own permissions, the open terminals and the activity log.
/// Asking Josi in chat does all of this too; this page is the fallback.
struct NativePcControlView: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject private var pc = PcExecutor.shared
    @State private var state: Wire = .null
    @State private var loading = false
    @State private var error = ""
    @State private var note = ""
    @State private var password = ""
    @State private var askingFull = false
    @State private var browsers: [PcBrowserBridge.Allowed] = []
    @State private var accessibility = PcDesktop.accessibilityTrusted
    @State private var screen = CGPreflightScreenCaptureAccess()
    var body: some View {
        NativeLeanPage {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("PC Control").font(JosiFont.title2)
                    NativeLeanNote(text: "What Josi may do on this Mac. You can also change any of this by asking Josi.")
                }
                Spacer()
                Button("Refresh") { Task { await load() } }.buttonStyle(JosiOutlineButtonStyle())
            }
            NativeLeanStatus(loading: loading, error: error, note: note)
            if state != .null {
                overview
                macPermissions
                if !pc.requests.isEmpty || pc.needsApproval { PcRequestCards() }
                policies
                browserCard
                activity
            }
        }
        .task { await load() }
        .onDisappear { password = "" }
    }
    private var overview: some View {
        JosiCard {
            HStack {
                Text(state["enabled"].flag ? "On" : "Off").font(JosiFont.headline).foregroundStyle(state["enabled"].flag ? JosiTheme.success : JosiTheme.muted)
                Text("· \(PcDevice.name)").font(JosiFont.callout).foregroundStyle(JosiTheme.muted)
                Spacer()
                Button(state["enabled"].flag ? "Turn Off" : "Turn On") {
                    let on = !state["enabled"].flag
                    perform(on ? "Computer control is on. Approve this Mac if Josi asks." : "Computer control is off.") { api in
                        _ = try await api.request("/admin/pc-control/enabled", method: "PUT", body: ["enabled": .bool(on)])
                    }
                }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Stop Everything") { pc.stop(); note = "Stopped. Temporary and task permissions were taken back." }.buttonStyle(JosiOutlineButtonStyle())
            }
            NativeLeanNote(text: state["availability"].text)
            Toggle("Everyday things without asking: programs, files and windows. Commands, deleting, purchases, credentials, installs and security changes still ask.",
                   isOn: Binding(get: { state["fullControl"].flag }, set: { on in
                       if on { askingFull = true } else {
                           perform("Josi asks again before everyday things.") { api in _ = try await api.request("/admin/pc-control/full-control", method: "PUT", body: ["enabled": .bool(false)]) }
                       }
                   })).toggleStyle(.checkbox).disabled(!state["enabled"].flag)
            if askingFull {
                HStack {
                    SecureField("Your Josi password", text: $password).textFieldStyle(JosiFieldStyle()).onSubmit(turnOnFull)
                    Button("Confirm", action: turnOnFull).buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(password.isEmpty)
                    Button("Cancel") { askingFull = false; password = "" }.buttonStyle(JosiOutlineButtonStyle())
                }
            }
            HStack {
                Button(pc.paused ? "Resume" : "Pause") { if pc.paused { pc.resume() } else { pc.pause() } }.buttonStyle(JosiOutlineButtonStyle()).disabled(pc.pendingStop)
                if pc.terminals > 0 {
                    Text("\(pc.terminals) terminal\(pc.terminals == 1 ? "" : "s") open").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    Button("Close Terminals") { PcTerminals.shared.stopAll() }.buttonStyle(JosiOutlineButtonStyle())
                }
            }
        }
    }
    private var macPermissions: some View {
        JosiCard {
            Text("macOS permissions").font(JosiFont.headline)
            permissionRow("Accessibility: to read and use windows", granted: accessibility) { PcDesktop.askForAccessibility() }
            permissionRow("Screen Recording: to take pictures of a window", granted: screen) { _ = CGRequestScreenCaptureAccess() }
            NativeLeanNote(text: "macOS keeps these in System Settings > Privacy & Security. Josi works without them for commands, files and the browser.")
        }
    }
    private func permissionRow(_ label: String, granted: Bool, ask: @escaping () -> Void) -> some View {
        HStack {
            Image(systemName: granted ? "checkmark.circle.fill" : "circle").foregroundStyle(granted ? JosiTheme.success : JosiTheme.muted)
            Text(label).font(JosiFont.callout)
            Spacer()
            if !granted { Button("Allow…") { ask() }.buttonStyle(JosiOutlineButtonStyle()) }
        }
    }
    private var policies: some View {
        JosiCard {
            Text("Saved permissions").font(JosiFont.headline)
            let list = state["policies"].list
            if list.isEmpty { NativeLeanNote(text: "None yet. Josi asks each time until you allow something from a card in the chat or ask her.") }
            ForEach(list, id: \.identifier) { policy in
                let label = state["catalog"].list.first { $0["action"] == policy["action"] }?["label"].text ?? policy["action"].text
                let application = policy["scope"]["application"].text
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label).font(JosiFont.callout)
                        Text(policy["scope"]["target"].text + (application.isEmpty ? "" : " · " + (application as NSString).lastPathComponent))
                            .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).textSelection(.enabled)
                        Text(Self.mode(policy) + (policy["active"].flag ? "" : " · ended")).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    }
                    Spacer()
                    Button("Revoke") {
                        let id = policy.identifier, revision = state["revision"].integer
                        perform("Revoked.") { api in _ = try await api.request("/admin/pc-control/policies/\(try api.uuid(id))?revision=\(revision)", method: "DELETE") }
                    }.buttonStyle(JosiOutlineButtonStyle())
                }
            }
        }
    }
    private static func mode(_ policy: Wire) -> String {
        switch policy["mode"].text {
        case "always": return "Always allowed"
        case "never": return "Never"
        case "ask": return "Ask every time"
        case "temporary": return "Allowed until " + policy["expiresAt"].text
        case "task": return "Allowed for one task"
        default: return policy["mode"].text
        }
    }
    private var browserCard: some View {
        JosiCard {
            Text("Browsers").font(JosiFont.headline)
            NativeLeanNote(text: pc.browserLinked.map { "\($0) is linked. Josi uses the tab you're looking at, or one she opens." }
                ?? "No browser is linked right now. Safari: turn on \"Josi Browser Control\", then click Josi in Safari's toolbar and allow it on every website.")
            HStack {
                Button("Turn On Josi in Safari") { PcBrowserBridge.openSafariExtensionSettings() }.buttonStyle(JosiOutlineButtonStyle())
                if PcBrowserBridge.brokerNeedsApproval {
                    Button("Allow Josi's Browser Helper") { SMAppService.openSystemSettingsLoginItems() }.buttonStyle(JosiOutlineButtonStyle())
                }
            }
            ForEach(browsers, id: \.nativeProfileId) { browser in
                HStack {
                    Text(browser.browser).font(JosiFont.callout)
                    Text((browser.application as NSString).lastPathComponent).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    Spacer()
                    Button("Remove") { PcBrowserBridge.shared.remove(browser.nativeProfileId); browsers = PcBrowserBridge.shared.allowedBrowsers }
                        .buttonStyle(JosiOutlineButtonStyle())
                }
            }
        }
    }
    private var activity: some View {
        JosiCard {
            Text("Activity").font(JosiFont.headline)
            let entries = state["activity"].list.prefix(40)
            if entries.isEmpty { NativeLeanNote(text: "Nothing yet.") }
            ForEach(Array(entries), id: \.identifier) { entry in
                HStack(alignment: .top) {
                    Text(Self.when(entry["at"].text)).font(JosiFont.caption).foregroundStyle(JosiTheme.muted).frame(width: 130, alignment: .leading)
                    Text(entry["description"].text.isEmpty ? entry["kind"].text : entry["description"].text).font(JosiFont.caption).textSelection(.enabled)
                    Spacer()
                }
            }
        }
    }
    private static func when(_ iso: String) -> String {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    private func turnOnFull() {
        let secret = password; password = ""; askingFull = false
        perform("Josi can do everyday things on this Mac without asking.") { api in
            _ = try await api.request("/admin/pc-control/full-control", method: "PUT", body: ["enabled": .bool(true), "password": .string(secret)])
        }
    }
    private func load() async {
        guard let api = model.api else { return }
        loading = true; defer { loading = false }
        accessibility = PcDesktop.accessibilityTrusted; screen = CGPreflightScreenCaptureAccess()
        browsers = PcBrowserBridge.shared.allowedBrowsers
        do { state = try await api.request("/admin/pc-control"); error = "" } catch { self.error = error.localizedDescription }
    }
    private func perform(_ done: String, _ work: @escaping (JosiAPI) async throws -> Void) {
        guard let api = model.api else { return }
        error = ""; note = ""
        Task {
            do { try await work(api); note = done } catch { self.error = error.localizedDescription }
            await load()
        }
    }
}
