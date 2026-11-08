import Foundation
import CryptoKit
import AppKit

@main struct ComputerControlProbe {
    @MainActor static func main() throws {
        var checks = 0
        func check(_ ok: @autoclosure () -> Bool, _ message: String) throws {
            guard ok() else { throw JosiError(message: "FAIL: " + message) }; checks += 1
        }
        func refuses(_ message: String, _ fn: () throws -> Void) throws {
            do { try fn() } catch { checks += 1; return }; throw JosiError(message: "FAIL: allowed " + message)
        }
        let root = "/private/tmp/josi-computer-probe-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: root) }
        let file = root + "/hello.txt"
        let written = try ComputerFiles.write(file, root: root, text: "Hello 🐈\n", expectedDigest: "")
        let data = try ComputerFiles.read(file, root: root)
        try check(String(data: data, encoding: .utf8) == "Hello 🐈\n", "UTF-8 round trip")
        try check(written["sha256"].text == ComputerWire.digest(data), "write digest")
        try refuses("overwrite without an expected digest") { _ = try ComputerFiles.write(file, root: root, text: "bad", expectedDigest: "") }
        try refuses("stale edit") { _ = try ComputerFiles.write(file, root: root, text: "bad", expectedDigest: String(repeating: "0", count: 64)) }
        _ = try ComputerFiles.write(file, root: root, text: "Updated", expectedDigest: ComputerWire.digest(data))
        try check(tryRead(file, root) == "Updated", "expected-content edit")
        try FileManager.default.createSymbolicLink(atPath: root + "/link", withDestinationPath: file)
        try refuses("file symbolic link") { _ = try ComputerFiles.read(root + "/link", root: root) }
        try FileManager.default.createSymbolicLink(atPath: root + "/directory", withDestinationPath: root)
        try refuses("directory symbolic link") { _ = try ComputerFiles.read(root + "/directory/hello.txt", root: root) }
        try FileManager.default.linkItem(atPath: file, toPath: root + "/hardlink")
        try refuses("hard-linked file") { _ = try ComputerFiles.read(file, root: root) }
        try refuses("outside folder") { _ = try ComputerFiles.read("/etc/passwd", root: root) }
        try refuses("parent traversal") { _ = try ComputerFiles.read(root + "/../secret", root: root) }
        let listing = try ComputerFiles.list(root, root: root)
        try check(listing["names"].list.count == 4, "bounded directory listing")
        let gate = ComputerLocalGate(); var cancelled = 0; gate.cancelOwnedWork = { cancelled += 1 }
        try refuses("new gate starts stopped") { try gate.check() }
        let owner = UUID().uuidString.lowercased(), deviceId = "mac-fixture", requestId = UUID().uuidString.lowercased()
        let rule: Wire = ["id": "rule", "action": "file.read", "decision": "allow", "scope": ["kind": "folder", "target": .string(root)], "duration": ["kind": "saved"]]
        var device: Wire = ["id": .string(deviceId), "revision": .number(1), "stopped": .bool(false), "revoked": .bool(false), "capabilities": ["file.read"], "rules": .array([rule])]
        let request: Wire = ["id": .string(requestId), "ownerId": .string(owner), "deviceId": .string(deviceId), "revision": .number(1), "state": "running", "taskId": "task",
            "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + 9500), "leaseUntil": .number(Date().timeIntervalSince1970 * 1000 + 9000), "operation": ["action": "file.read", "scope": ["kind": "folder", "target": .string(root)], "args": ["path": .string(file)]]]
        gate.resume(); try gate.begin(request, device: device, owner: owner, deviceId: deviceId); try gate.check()
        gate.takeover(); try check(gate.mode == .takeover && cancelled == 1, "immediate persistent human takeover")
        try refuses("no automatic takeover reset") { try gate.begin(request, device: device, owner: owner, deviceId: deviceId) }
        gate.resume(); try gate.begin(request, device: device, owner: owner, deviceId: deviceId)
        gate.stop(); try check(cancelled == 2, "offline local Stop cancels work")
        try refuses("Stop rejects execution") { try gate.check() }
        gate.resume(); try refuses("wrong owner") { try gate.begin(request, device: device, owner: UUID().uuidString, deviceId: deviceId) }
        if case .object(var values) = device { values["rules"] = []; device = .object(values) }
        try refuses("server approval without a local rule") { try gate.begin(request, device: device, owner: owner, deviceId: deviceId) }
        try refuses("credential-store read") { _ = try ComputerFiles.read(NSHomeDirectory() + "/Library/Keychains/test", root: NSHomeDirectory()) }
        var taskRule = rule
        if case .object(var values) = taskRule { values["duration"] = ["kind": "task", "taskId": "task", "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + 1000)]; taskRule = .object(values) }
        if case .object(var values) = device { values["rules"] = .array([taskRule]); values["activeTasks"] = ["task"]; device = .object(values) }
        try gate.begin(request, device: device, owner: owner, deviceId: deviceId); try gate.check(); checks += 1
        gate.pause()
        gate.resume()
        if case .object(var values) = device { values["activeTasks"] = []; device = .object(values) }
        try refuses("inactive work task") { try gate.begin(request, device: device, owner: owner, deviceId: deviceId) }
        try refuses("expired local lease") { try gate.renew(Int(Date().timeIntervalSince1970 * 1000) - 1, revision: 1) }
        var wall = 1_800_000_000_000, monotonic: UInt64 = 1_000_000_000
        let expiring = ComputerLocalGate(wallNow: { wall }, monotonicNow: { monotonic })
        let expiringRule: Wire = ["id": "rule", "action": "file.read", "decision": "allow", "scope": ["kind": "folder", "target": .string(root)],
            "duration": ["kind": "until", "expiresAt": .number(Double(wall + 1000))]]
        let expiringDevice: Wire = ["id": .string(deviceId), "revision": .number(1), "stopped": .bool(false), "revoked": .bool(false), "capabilities": ["file.read"], "rules": .array([expiringRule])]
        var expiringRequest = request
        if case .object(var values) = expiringRequest {
            values["expiresAt"] = .number(Double(wall + 9500)); values["leaseUntil"] = .number(Double(wall + 9000)); expiringRequest = .object(values)
        }
        expiring.resume(); try expiring.begin(expiringRequest, device: expiringDevice, owner: owner, deviceId: deviceId)
        let originalGeneration = expiring.generation
        expiring.resume(); try check(expiring.generation == originalGeneration && expiring.mode == .working, "Resume cannot reset running authority")
        wall -= 60_000; monotonic += 1_001_000_000
        try refuses("permission expiry despite wall clock rollback and a longer server lease") { try expiring.check() }
        try refuses("renewal cannot extend expired native permission") { try expiring.renew(wall + 9000, revision: 1) }
        let signing = ComputerDeviceKey(key: Curve25519.Signing.PrivateKey())
        let signed = try signing.proof(owner: owner, method: "next", body: ["text": "🐈 / quotes \" new\nline"], now: 1_800_000_000_000)
        let bytes = Data(try ComputerWire.canonical(signed["payload"]).utf8)
        try check(signing.key.publicKey.isValidSignature(Data(base64Encoded: signed["signature"].text)!, for: bytes), "device proof exact bytes")
        try check(signing.id.hasPrefix("mac-") && signing.id.count == 44, "device id pinned to public key")
        if CommandLine.arguments.count == 2 {
            let fixture: Wire = ["publicKey": .string(signing.publicKey), "proof": signed]
            try JSONEncoder().encode(fixture).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
        }
        print("PASS: \(checks) native file, local authority and signing checks. No Keychain writes, OS permission requests, desktop input or installation.")
    }
    static func tryRead(_ path: String, _ root: String) -> String? { (try? ComputerFiles.read(path, root: root)).flatMap { String(data: $0, encoding: .utf8) } }
}
extension Wire: ExpressibleByArrayLiteral { init(arrayLiteral elements: Wire...) { self = .array(elements) } }
