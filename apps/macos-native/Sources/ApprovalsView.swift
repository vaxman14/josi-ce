import AppKit
import SwiftUI

/// The scrolling frame the lean pages share. Nothing here paints a background,
/// so the window's backdrop shows through.
struct NativeLeanPage<Content: View>: View {
    var maxWidth: CGFloat = 900
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) { content }
                .padding(28).frame(maxWidth: maxWidth, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
}

/// A heading inside a page.
struct NativeLeanTitle: View {
    var text: String
    var body: some View { Text(text).font(JosiFont.title3).foregroundStyle(JosiTheme.text) }
}

/// Quiet supporting copy.
struct NativeLeanNote: View {
    var text: String
    var color: Color = JosiTheme.lilac
    var body: some View {
        Text(text).font(JosiFont.callout).foregroundStyle(color).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
    }
}

/// The loading, error and result lines, always in the same place.
struct NativeLeanStatus: View {
    var loading = false
    var error = ""
    var note = ""
    var body: some View {
        if loading { ProgressView().controlSize(.small) }
        if !error.isEmpty { NativeLeanNote(text: error, color: JosiTheme.error) }
        if !note.isEmpty { NativeLeanNote(text: note, color: JosiTheme.success) }
    }
}

/// True when the server has no such route, which an older server answers with 404.
func nativeRouteMissing(_ error: Error) -> Bool { (error as? JosiError)?.status == 404 }

@MainActor func nativeConfirm(_ title: String, detail: String, button: String) -> Bool {
    let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
    alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: button)
    return alert.runModal() == .alertSecondButtonReturn
}

/// A card with the gold edge that marks something waiting on a decision.
private struct NativeApprovalCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        JosiCard { content }
            .overlay(alignment: .leading) { Rectangle().fill(JosiTheme.gold).frame(width: 3) }
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

/// The frozen email an approval would send. The server keeps the rendered HTML;
/// this app shows its subject and plain-text form.
private struct NativeApprovalEmail: View {
    @EnvironmentObject var model: JosiModel
    let id: String
    @State private var preview: Wire = .null
    @State private var error = ""
    @State private var open = true
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !error.isEmpty { NativeLeanNote(text: error, color: JosiTheme.error) }
            if preview != .null {
                DisclosureGroup(isExpanded: $open) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(preview["subject"].text).font(JosiFont.headline)
                        Text(preview["text"].text).font(JosiFont.callout).textSelection(.enabled)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                } label: { Text("Final email").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac) }
            }
        }
        .task(id: id) {
            guard let api = model.api, let identifier = try? api.uuid(id) else { return }
            do {
                let result = try await api.request("/mail/templates/approvals/\(identifier)/preview")
                guard !Task.isCancelled, model.api === api else { return }
                preview = result
            } catch {
                // 404 means this approval has no frozen email to show.
                guard !Task.isCancelled, model.api === api, !nativeRouteMissing(error) else { return }
                self.error = error.localizedDescription
            }
        }
    }
}

struct NativeApprovalsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var approvals: [Wire] = []
    @State private var calls: [Wire] = []
    @State private var history: [Wire] = []
    @State private var historyAvailable = true
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var unavailable = false
    @State private var refreshAfter = 2.0
    @State private var error = ""
    @State private var note = ""
    @State private var generation = 0
    @State private var changes: [Wire] = []
    @State private var changeList: Wire = .null
    private var nothing: Bool { approvals.isEmpty && calls.isEmpty && changes.isEmpty }

    /// Everything waiting on this person, for the sidebar badge. An older server
    /// with no approvals route has nothing waiting.
    static func pendingCount(api: JosiAPI) async throws -> Int {
        let snapshot: Wire
        do { snapshot = try await api.request("/assistant/approvals") }
        catch where nativeRouteMissing(error) { return 0 }
        let prepared = snapshot["count"] == .null ? snapshot["approvals"].list.count : snapshot["count"].integer
        let requests = (try? await api.request("/custom-apis/pending"))?["pending"].list.count ?? 0
        let changes = (try? await api.request("/settings-changes"))?["proposals"].list.filter { $0["canApprove"].flag }.count ?? 0
        return prepared + requests + changes
    }

    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                JosiHeading(title: "Approvals", subtitle: "Things Josi will not do until you say so.")
                Button("Refresh") { model.run { await refresh() } }
                    .buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            }
            NativeLeanStatus(loading: !loaded && !loadFailed && !unavailable, error: error, note: note)
            if unavailable {
                NativeLeanNote(text: "This server does not offer approvals yet. Update the server to use them.")
            } else if loadFailed && !loaded {
                NativeLeanNote(text: "Approvals could not be loaded. Refresh to try again.", color: JosiTheme.error)
            } else if loaded {
                if nothing {
                    JosiCard {
                        Text("Nothing to approve").font(JosiFont.headline)
                        NativeLeanNote(text: "When Josi wants to do something it should ask about first, it will appear here.")
                    }
                }
                SettingsChangeList(changes: changes, policy: changeList) { await refresh(full: false) }
                if !calls.isEmpty {
                    NativeLeanTitle(text: "Requests to a connected API")
                    NativeLeanNote(text: "These have not happened. Approving one sends it immediately, exactly as described.")
                    ForEach(calls, id: \.identifier) { call($0) }
                }
                if !approvals.isEmpty {
                    if !calls.isEmpty { NativeLeanTitle(text: "Work Josi has prepared") }
                    ForEach(approvals, id: \.identifier) { approval($0) }
                }
                if historyAvailable { decisions }
            }
        }
        .task {
            await refresh()
            var last = Date()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(refreshAfter)) } catch { return }
                guard NSApp.isActive, !model.busy else { continue }
                // Prepared work follows the server's cadence; the rest changes rarely.
                let full = Date().timeIntervalSince(last) >= 15
                if full { last = Date() }
                await refresh(full: full)
            }
        }
        .onDisappear { generation += 1 }
    }

    private func call(_ item: Wire) -> some View {
        NativeApprovalCard {
            HStack {
                Text(item["connectionName"].text).font(JosiFont.headline)
                Spacer()
                JosiPill(text: capabilityLabel(item["capability"].text), color: JosiTheme.error)
            }
            Text(item["summary"].text).font(JosiFont.body()).textSelection(.enabled)
            NativeLeanNote(text: "Expires " + nativeDate(item["expiresAt"].text) + ". After that it can no longer be answered.", color: JosiTheme.muted)
            HStack {
                Button("Approve and send") { decideCall(item, approve: true) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Deny") { decideCall(item, approve: false) }.buttonStyle(JosiOutlineButtonStyle())
            }.disabled(model.busy)
        }
    }
    private func approval(_ item: Wire) -> some View {
        NativeApprovalCard {
            Text(item["summary"].text).font(JosiFont.body()).textSelection(.enabled)
            if item["action_class"].text == "email_send" { NativeApprovalEmail(id: item.identifier) }
            NativeLeanNote(text: item["action"].text.replacingOccurrences(of: "_", with: " "), color: JosiTheme.muted)
            HStack {
                Button("Approve") { decide(item, approve: true) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                Button("Deny") { decide(item, approve: false) }.buttonStyle(JosiOutlineButtonStyle())
            }.disabled(model.busy)
        }
    }
    @ViewBuilder private var decisions: some View {
        NativeLeanTitle(text: "Recent decisions")
        if history.isEmpty {
            NativeLeanNote(text: "No decisions yet.")
        } else {
            JosiCard {
                ForEach(Array(history.prefix(20).enumerated()), id: \.offset) { index, item in
                    if index > 0 { Divider().overlay(JosiTheme.hairline) }
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item["summary"].text).font(JosiFont.callout).lineLimit(3).textSelection(.enabled)
                            Text(nativeDate(decidedAt(item))).font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                        }
                        Spacer(minLength: 8)
                        JosiPill(text: statusLabel(item["status"].text), color: statusColor(item["status"].text))
                    }
                }
            }
        }
    }

    private func refresh(full: Bool = true) async {
        guard let api = model.api else { return }
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        do {
            let snapshot = try await api.request("/assistant/approvals")
            guard current() else { return }
            approvals = snapshot["approvals"].list
            if case .number(let delay) = snapshot["refreshAfterMs"] { refreshAfter = min(60, max(2, delay / 1000)) }
            loaded = true; loadFailed = false; unavailable = false
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { unavailable = true } else { loadFailed = true }
            return
        }
        guard full else { return }
        if let result = try? await api.request("/custom-apis/pending"), current() { calls = result["pending"].list }
        if let result = try? await api.request("/settings-changes"), current() { changeList = result; changes = result["proposals"].list }
        do {
            let result = try await api.request("/assistant/approvals/history")
            guard current() else { return }
            history = result["approvals"].list; historyAvailable = true
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { historyAvailable = false }
        }
    }
    private func decide(_ item: Wire, approve: Bool) {
        guard let api = model.api, let id = try? api.uuid(item.identifier) else { return }
        perform(api) {
            _ = try await api.request("/assistant/approvals/\(id)/decide", method: "POST", body: ["approve": .bool(approve)])
            return approve ? "Approved." : "Denied. Nothing was done."
        }
    }
    private func decideCall(_ item: Wire, approve: Bool) {
        guard let api = model.api, let id = try? api.uuid(item.identifier) else { return }
        let name = item["connectionName"].text
        perform(api) {
            let result = try await api.request("/custom-apis/pending/\(id)/\(approve ? "approve" : "deny")", method: "POST", body: [:])
            guard approve else { return "Denied. Nothing was sent." }
            return result["ok"] == .bool(false) ? "\(name) refused the request. Nothing was changed." : "Sent to \(name)."
        }
    }
    private func perform(_ api: JosiAPI, _ action: @escaping @MainActor () async throws -> String) {
        let owner = model.user["id"]
        error = ""; note = ""
        model.run {
            do {
                let done = try await action()
                guard model.api === api, model.user["id"] == owner else { return }
                note = done
            } catch {
                guard model.api === api, model.user["id"] == owner else { return }
                self.error = error.localizedDescription
            }
            await refresh()
        }
    }
    private func decidedAt(_ item: Wire) -> String {
        for key in ["decided_at", "expires_at", "created_at"] where !item[key].text.isEmpty { return item[key].text }
        return ""
    }
    private func capabilityLabel(_ value: String) -> String {
        ["read": "Reads only", "write": "Changes something", "delete": "Deletes something"][value] ?? "Needs your approval"
    }
    private func statusLabel(_ value: String) -> String {
        ["approved": "Approved", "denied": "Denied", "expired": "Expired"][value] ?? value.replacingOccurrences(of: "_", with: " ").capitalized
    }
    private func statusColor(_ value: String) -> Color {
        value == "approved" ? JosiTheme.success : value == "denied" ? JosiTheme.error : JosiTheme.muted
    }
}
