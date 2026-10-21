import AppKit
import SwiftUI

@MainActor private func checkApprovalReturn() async throws {
    func lease(_ duration: Int = 2000) throws -> ApprovalLease {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        return try ApprovalLease(["issuedAtMs": .number(Double(now)), "expiresAtMs": .number(Double(now + duration))])
    }
    // A successful biometric callback may precede the UI return. Do not
    // continue while the application/sheet is still unavailable.
    var ready = false, continued = false
    let live = try lease()
    let delayed = Task { @MainActor in
        try await live.waitUntilReady { ready }
        continued = true
    }
    try await Task.sleep(for: .milliseconds(120))
    precondition(!continued)
    ready = true
    try await delayed.value
    precondition(continued)

    let expired = try lease(60)
    do { try await expired.waitUntilReady { false }; fatalError("Expired approval continued") } catch {}
    let cancelledLease = try lease()
    let cancelled = Task { @MainActor in try await cancelledLease.waitUntilReady { false } }
    await Task.yield(); cancelled.cancel()
    do { try await cancelled.value; fatalError("Cancelled approval continued") } catch {}
    let closed = try lease()
    do { try await closed.waitUntilReady { throw approvalUnavailable() }; fatalError("Closed review continued") } catch {}

    let denied = EnrollmentStage.prepare.failure(JosiError(message: "Confirm current administrator credentials.", status: 401))
    precondition(denied.status == 401 && denied.message.contains("Confirm current administrator credentials."))
    precondition(denied.message.contains("review has not opened"))
    let raw = EnrollmentStage.createKey.failure(NSError(domain: "synthetic-private-native-detail", code: 1))
    precondition(!raw.message.contains("synthetic-private-native-detail"))
    let uncertain = EnrollmentStage.commit.failure(URLError(.networkConnectionLost))
    precondition(uncertain.message.contains("may already be saved"))
    print("PASS approval handoff waits for UI return; expiry, cancellation and closed-review checks; enrollment failure stage and uncertain commit")
}

@main struct DeviceInventoryCheck {
    @MainActor static func main() async throws {
        try await checkApprovalReturn()
        let owner = "11111111-1111-4111-8111-111111111111"
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.appearance = NSAppearance(named: .darkAqua)
        let model = JosiModel()
        try await model.connect(CommandLine.arguments[1])
        model.user = ["id": .string(owner), "role": "super_admin"]
        try await model.loadAutomationDevices()
        let saved = model.automationDevices
        precondition(model.automationDevicesReady && saved["devices"].list.first?["label"].text == "MBP")
        let device = saved["devices"].list[0]
        precondition(NativeDeviceInventory.confirms(saved, enrollment: device["enrollmentId"], identity: device["identity"]))
        precondition(!NativeDeviceInventory.confirms(saved, enrollment: "different", identity: device["identity"]))

        // Real native API decoding must distinguish an unreadable response from
        // an authoritative empty registry, and preserve the last verified Mac.
        do { try await model.loadAutomationDevices(); fatalError("Malformed response accepted") } catch {}
        precondition(model.automationDevices == saved && !model.automationDevicesReady && !model.automationDevicesError.isEmpty)
        try await model.loadAutomationDevices()
        precondition(model.automationDevicesReady)

        // A request started before enrollment must not replace the verified
        // commit result when its older response finally arrives.
        let earlier = Task { try await model.loadAutomationDevices() }
        while !model.automationDevicesLoading { await Task.yield() }
        try model.adoptAutomationDevices(saved)
        try await earlier.value
        precondition(model.automationDevicesReady && model.automationDevices == saved)

        do {
            _ = try NativeDeviceInventory.validate(["reference": .null, "authorityEpoch": .number(1),
                "reconciliationRequired": .bool(false), "devices": .array([])], user: owner, previous: saved)
            fatalError("Older empty inventory accepted")
        } catch {}
        do { _ = try NativeDeviceInventory.validate(saved, user: "another-account"); fatalError("Wrong owner accepted") } catch {}

        // A failure loading rules must not erase or disable the separately
        // verified device inventory used by the workspace picker.
        try await model.loadAutomation()
        precondition(model.automationSettings == .null && !model.automationError.isEmpty)
        precondition(model.automationDevices == saved && model.automationDevicesReady)

        let view = NSHostingView(rootView: NativeWorkspaceStorageView(desktop: model.desktop)
            .environmentObject(model).padding(24).frame(width: 1000).background(JosiTheme.background)
            .environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        view.frame = NSRect(x: 0, y: 0, width: 1000, height: 600)
        try await Task.sleep(for: .milliseconds(200))
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { fatalError("No preview bitmap") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))

        // Loss of Vault access clears the inventory and disables device actions.
        do { try await model.loadAutomationDevices(); fatalError("Locked Vault accepted") } catch {}
        precondition(model.automationDevices == .null && !model.automationDevicesReady)
        model.disconnect()
        precondition(model.automationDevices == .null && model.automationDevicesError.isEmpty)
        print("PASS native HTTP inventory, malformed-response handling, stale-response rejection, owner isolation, unrelated-settings failure, native view rendering, Vault lock and disconnect")
    }
}
