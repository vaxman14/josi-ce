import Foundation
import Virtualization

final class ProbeListener: NSObject, VZVirtioSocketListenerDelegate {
    let fixture: ProbeFixture
    let output: URL
    let queue = DispatchQueue(label: "josi-p0-disposable-socket")
    let listener = VZVirtioSocketListener()
    var authenticationDenied = 0
    var sessions = Set<String>()
    var replayDenied = false
    var unsupportedDenied = false
    var textRoundTrips = 0
    private let admission = NSLock()
    private var accepted = 0

    init(fixture: ProbeFixture, output: URL) {
        self.fixture = fixture; self.output = output
        super.init(); listener.delegate = self
        try? JSONSerialization.data(withJSONObject: ["probe": "guest-authenticated-channel", "status": "awaiting_test", "automationExecutorEnabled": false]).write(to: output, options: .atomic)
    }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        // Serial, bounded fixtures. Retain the VZ connection until all IO is over.
        admission.lock(); defer { admission.unlock() }
        guard accepted < 3 else { return false }
        accepted += 1
        queue.async { self.run(connection) }
        return true
    }
    private func run(_ connection: VZVirtioSocketConnection) {
        defer { connection.close() }
        do {
            let wire = try ProbeWire(fd: connection.fileDescriptor, fixture: fixture, server: true)
            do { try wire.handshake() }
            catch ProbeWireError.rejected {
                authenticationDenied += 1
                print("Disposable guest authentication denied."); fflush(stdout)
                return
            }
            guard sessions.insert(wire.session).inserted, sessions.count <= 2 else { throw ProbeWireError.rejected }
            let value = "Josi P0 / Exact_Text: ✓"
            let echo = try wire.send(["operation": "echo", "value": value])
            let response = try wire.receive()
            guard response["status"] as? String == "ok", response["value"] as? String == value else { throw ProbeWireError.rejected }
            textRoundTrips += 1
            if sessions.count == 1 {
                try wire.writeFrame(echo) // Deliberate exact ciphertext/sequence replay.
                let denial = try wire.receive()
                guard denial["status"] as? String == "denied", denial["code"] as? String == "invalid_envelope" else { throw ProbeWireError.rejected }
                replayDenied = true
            } else {
                try wire.send(["operation": "arbitrary_command"])
                let denial = try wire.receive()
                guard denial["status"] as? String == "denied", denial["code"] as? String == "unsupported_operation" else { throw ProbeWireError.rejected }
                unsupportedDenied = true
                try wire.send(["operation": "close"])
                guard authenticationDenied == 1, replayDenied, textRoundTrips == 2 else { throw ProbeWireError.rejected }
                let result: [String: Any] = ["probe": "guest-authenticated-channel", "purpose": fixture.purpose,
                    "wrongKeyDenied": true, "replayDenied": true, "unsupportedOperationDenied": true,
                    "encryptedExactTextRoundTrips": textRoundTrips, "freshReconnectSessions": sessions.count,
                    "guestOS": response["os"] as? String ?? "unknown", "networkDeviceCount": 0,
                    "automationExecutorEnabled": false, "productionEnrollmentVerified": false]
                try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: output, options: .atomic)
                print("Disposable authenticated guest channel proof passed."); fflush(stdout)
            }
        } catch {
            try? JSONSerialization.data(withJSONObject: ["probe": "guest-authenticated-channel", "status": "failed", "automationExecutorEnabled": false]).write(to: output, options: .atomic)
            print("Disposable guest channel proof failed; no successful evidence recorded."); fflush(stdout)
        }
    }
}
