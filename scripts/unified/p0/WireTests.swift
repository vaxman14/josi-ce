import Foundation
import Darwin

@main
struct WireTests {
    static let fixture = ProbeFixture(purpose: "disposable-josi-p0", workspace: "synthetic-wire-test", key: Data(repeating: 7, count: 32).base64EncodedString())
    static func check(_ condition: Bool) throws { if !condition { throw ProbeWireError.rejected } }
    static func pair(clientFixture: ProbeFixture = fixture, host: @escaping (ProbeWire) throws -> Void,
                     guest: @escaping (ProbeWire) throws -> Void) throws -> Set<String> {
        var fds: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else { throw ProbeWireError.io }
        let group = DispatchGroup(), lock = NSLock()
        var failures = Set<String>()
        for (label, fd, config, action) in [("host", fds[0], fixture, host), ("guest", fds[1], clientFixture, guest)] {
            group.enter()
            DispatchQueue.global().async {
                defer { Darwin.close(fd); group.leave() }
                do {
                    let wire = try ProbeWire(fd: fd, fixture: config, server: label == "host")
                    try wire.handshake(); try action(wire)
                } catch { lock.lock(); failures.insert(label); lock.unlock() }
            }
        }
        guard group.wait(timeout: .now()+12) == .success else { throw ProbeWireError.io }
        return failures
    }
    static func main() {
        do {
            let text = "Exact_Text / Ünicode ✓\nSecond line"
            try check(try pair(host: { wire in
                try wire.send(["text": text]); try check(try wire.receive()["text"] as? String == text)
            }, guest: { wire in
                let value = try wire.receive(); try check(value["text"] as? String == text); try wire.send(value)
            }).isEmpty)
            let wrong = ProbeFixture(purpose: fixture.purpose, workspace: fixture.workspace, key: Data(repeating: 8, count: 32).base64EncodedString())
            try check(try pair(clientFixture: wrong, host: { _ in }, guest: { _ in }) == ["host", "guest"])
            let foreign = ProbeFixture(purpose: fixture.purpose, workspace: "foreign-workspace", key: fixture.key)
            try check(try pair(clientFixture: foreign, host: { _ in }, guest: { _ in }) == ["host", "guest"])
            try check(try pair(host: { wire in
                let frame = try wire.send(["text": "once"]); try wire.writeFrame(frame)
            }, guest: { wire in
                _ = try wire.receive(); _ = try wire.receive()
            }) == ["guest"])
            try check(try pair(host: { wire in
                let frame = try wire.send(["text": "first"])
                var altered = try JSONSerialization.jsonObject(with: frame) as! [String: Any]
                altered["sequence"] = 1 // Authenticated sequence cannot be rewritten to bypass replay detection.
                try wire.writeFrame(JSONSerialization.data(withJSONObject: altered))
            }, guest: { wire in _ = try wire.receive(); _ = try wire.receive() }) == ["guest"])
            try check(try pair(host: { wire in
                var header = UInt32(ProbeWire.limit+1).bigEndian
                _ = withUnsafeBytes(of: &header) { Darwin.write(wire.fd, $0.baseAddress!, $0.count) }
            }, guest: { wire in _ = try wire.receive() }) == ["guest"])
            try check(try pair(host: { wire in
                try wire.send(["text": "host-message"])
                _ = try wire.receive()
            }, guest: { wire in
                _ = try wire.receive()
                let wrongDirection = try ProbeWire(fd: wire.fd, fixture: fixture, server: true)
                wrongDirection.key = wire.key; wrongDirection.session = wire.session
                try wrongDirection.send(["text": "reflected-host-direction"])
            }) == ["host"])
            print("7 synthetic encrypted-channel checks passed (round trip, wrong key/workspace, replay, sequence tamper, size bound, direction reflection).")
        } catch { fputs("Encrypted-channel self-test failed.\n", stderr); exit(1) }
    }
}
