import AppKit
import SwiftUI
import Virtualization
import Darwin

/// Readiness/consent connection on this exact VZ device. It cannot dispatch
/// input, export observations, resolve a secret or register an agent runtime.
@MainActor final class NativeGuestConnection: NSObject, ObservableObject, @preconcurrency VZVirtioSocketListenerDelegate {
    @Published private(set) var state = "Waiting for the companion inside the desktop."
    @Published private(set) var paired = false
    @Published private(set) var accessibility = false
    @Published private(set) var screenCapture = false
    private let device: VZVirtioSocketDevice
    private let context: [String: String]
    private let current: @MainActor () throws -> Int
    private let listener = VZVirtioSocketListener()
    private var connection: VZVirtioSocketConnection?
    private var wire: GuestLinkWire?
    private var task: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var pending: CheckedContinuation<Bool, Never>?
    private var alert: NSAlert?
    private var closed = false
    private var attempts = 0

    init(device: VZVirtioSocketDevice, context: [String: String], current: @escaping @MainActor () throws -> Int) {
        self.device = device; self.context = context; self.current = current
        super.init()
        listener.delegate = self
        device.setSocketListener(listener, forPort: GuestLinkWire.port)
    }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard !closed, socketDevice === device, listener === self.listener, self.connection == nil, attempts < 3 else { return false }
        do {
            _ = try current()
            let wire = try GuestLinkWire(descriptor: connection.fileDescriptor, host: true)
            attempts += 1; self.connection = connection; self.wire = wire
            state = "Verifying the guest connection…"
            task = Task { await run(wire) }
            return true
        } catch { return false }
    }
    private func hostBoot() throws -> String {
        var bytes = [CChar](repeating: 0, count: 128), size = 128
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0, (1...128).contains(size) else { throw GuestLinkError.unavailable }
        let value = String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self).lowercased()
        guard UUID(uuidString: value)?.uuidString.lowercased() == value else { throw GuestLinkError.invalid }
        return value
    }
    private func ask(_ code: String, expires: Int) async -> Bool {
        guard let parent = NSApp.windows.first(where: { $0.title == "Josi" }), pending == nil, !closed else { return false }
        let alert = NSAlert()
        alert.messageText = "Compare the companion code"
        alert.informativeText = "\(code)\n\nCheck that this exact code appears in Josi Companion inside your separate desktop.\n\nServer: \(context["serverOrigin"] ?? "")\nWorkspace: \(context["workspaceId"] ?? "")\n\nConnecting reports permission readiness only. It grants no computer or browser automation."
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "The Codes Match")
        self.alert = alert
        parent.makeKeyAndOrderFront(nil)
        timer = Task {
            try? await Task.sleep(for: .milliseconds(max(1, expires - Int(Date().timeIntervalSince1970 * 1000))))
            if !Task.isCancelled { cancelQuestion() }
        }
        return await withCheckedContinuation { continuation in
            pending = continuation
            alert.beginSheetModal(for: parent) { [weak self] result in
                guard let self, let waiting = pending else { return }
                pending = nil; self.alert = nil; timer?.cancel(); timer = nil
                waiting.resume(returning: result == .alertSecondButtonReturn && !closed)
            }
        }
    }
    private func cancelQuestion() {
        timer?.cancel(); timer = nil
        let waiting = pending; pending = nil
        if let alert { alert.window.sheetParent?.endSheet(alert.window); alert.window.orderOut(nil) }
        alert = nil; waiting?.resume(returning: false)
    }
    private func run(_ link: GuestLinkWire) async {
        do {
            let guest = try await link.receiveHello()
            guard !closed, Set(guest.keys) == ["version", "role", "key", "channel", "guestBoot", "hostBoot"],
                  guest["hostBoot"] == (try hostBoot()), let boot = guest["guestBoot"],
                  UUID(uuidString: boot)?.uuidString.lowercased() == boot else { throw GuestLinkError.invalid }
            _ = try current()
            let expiry = Int(Date().timeIntervalSince1970 * 1000) + 60_000
            var host = context
            host["version"] = "1"; host["role"] = "host"; host["key"] = link.publicKey
            host["channel"] = guest["channel"]; host["hostBoot"] = guest["hostBoot"]; host["expiresAtMs"] = String(expiry)
            try await link.sendHello(host)
            let code = try await link.configure(guest: guest, host: host)
            state = "Compare and accept the code in both native windows."
            guard await ask(code, expires: expiry), !closed else { throw GuestLinkError.closed }
            _ = try current()
            guard Int(Date().timeIntervalSince1970 * 1000) < expiry else { throw GuestLinkError.expired }
            try await link.send(["kind": "accept", "code": code])
            let accepted = try await link.receive(seconds: max(1, min(60, (expiry - Int(Date().timeIntervalSince1970 * 1000)) / 1000)))
            guard accepted == ["kind": "accept", "code": code], !closed else { throw GuestLinkError.invalid }
            _ = try current()
            paired = true; state = "Companion connected. Automation is not enabled."
            while !Task.isCancelled && !closed {
                let until = try current()
                try await link.send(["kind": "pulse", "leaseUntilMs": String(until)])
                let reply = try await link.receive()
                _ = try current()
                guard Set(reply.keys) == ["kind", "accessibility", "screenCapture", "executionEnabled"],
                      reply["kind"] == "status", reply["executionEnabled"] == "no",
                      ["yes", "no"].contains(reply["accessibility"] ?? ""),
                      ["yes", "no"].contains(reply["screenCapture"] ?? "") else { throw GuestLinkError.invalid }
                accessibility = reply["accessibility"] == "yes"; screenCapture = reply["screenCapture"] == "yes"
                try await Task.sleep(for: .seconds(2))
            }
        } catch {
            if !closed { state = "Companion disconnected or could not be verified. Reconnect inside the desktop." }
        }
        cancelQuestion(); paired = false; accessibility = false; screenCapture = false
        link.interrupt(); connection?.close(); connection = nil; wire = nil; task = nil
    }
    func close() {
        guard !closed else { return }
        closed = true; cancelQuestion(); wire?.interrupt(); connection?.close()
        device.removeSocketListener(forPort: GuestLinkWire.port)
        task?.cancel(); task = nil; wire = nil; connection = nil
        paired = false; state = "Companion disconnected."
    }
}

struct NativeGuestConnectionView: View {
    @ObservedObject var connection: NativeGuestConnection
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(connection.state).font(.caption)
            if connection.paired {
                Text("Guest Accessibility: \(connection.accessibility ? "ready" : "not enabled") · Screen capture: \(connection.screenCapture ? "ready" : "not enabled")")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Inside the desktop, copy Josi Companion from the Josi Support disk into Applications, then open it and choose Connect to Josi.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
