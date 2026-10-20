import Foundation
import Darwin

/// Standalone transport check; no VM, browser, internet or production authority.
@main enum GuestNetworkWireCheck {
    static func main() async throws {
        var descriptors: [Int32] = [-1, -1]
        precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
        defer { for fd in descriptors { Darwin.close(fd) } }
        let scope = UUID().uuidString.lowercased(), fixture = Data(repeating: 0x42, count: 32)
        let host = try GuestLinkWire(descriptor: descriptors[0], host: true, network: (fixture, scope))
        let guest = try GuestLinkWire(descriptor: descriptors[1], host: false, network: (fixture, scope))
        defer { host.interrupt(); guest.interrupt() }
        let id = UUID().uuidString.lowercased()
        let outbound = ["kind": "network-data", "id": id, "data": Data(repeating: 0x19, count: 32768).base64EncodedString()]
        let inbound = ["kind": "network-data", "id": id, "data": Data(repeating: 0xa1, count: 32768).base64EncodedString()]
        // Queue both reads before either write. A single serial IO queue
        // deadlocks here, which would also stall HTTPS inside the guest.
        let fromGuest = Task { try await host.receive(seconds: 2) }
        let fromHost = Task { try await guest.receive(seconds: 2) }
        try await Task.sleep(for: .milliseconds(50))
        async let a: Void = host.send(outbound)
        async let b: Void = guest.send(inbound)
        _ = try await (a, b)
        let receivedAtHost = try await fromGuest.value, receivedAtGuest = try await fromHost.value
        precondition(receivedAtHost == inbound && receivedAtGuest == outbound)
        var refused = false
        do { try await host.send(["kind": "execute", "id": id]) } catch { refused = true }
        precondition(refused, "The auxiliary network channel must not accept control commands")
        print("PASS: simultaneous authenticated 32 KiB transfers; control-command separation")
    }
}
