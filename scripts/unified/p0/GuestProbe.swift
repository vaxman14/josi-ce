import Foundation
import Darwin

@main
struct GuestProbe {
    static func connectHost() throws -> Int32 {
        let fd = socket(AF_VSOCK, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ProbeWireError.io }
        var address = sockaddr_vm()
        address.svm_len = UInt8(MemoryLayout<sockaddr_vm>.size)
        address.svm_family = sa_family_t(AF_VSOCK)
        address.svm_cid = 2 // VMADDR_CID_HOST, from Apple's sys/vsock.h
        address.svm_port = 40501
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_vm>.size)) }
        }
        guard result == 0 else { Darwin.close(fd); throw ProbeWireError.io }
        return fd
    }
    static func serve(_ fixture: ProbeFixture) throws {
        let fd = try connectHost(); defer { Darwin.close(fd) }
        let wire = try ProbeWire(fd: fd, fixture: fixture, server: false)
        try wire.handshake()
        // This probe deliberately has no generic execution, file, UI or network operation.
        for _ in 0..<5 {
            let request: [String: Any]
            do { request = try wire.receive() }
            catch {
                try wire.send(["status": "denied", "code": "invalid_envelope"])
                return
            }
            switch request["operation"] as? String {
            case "echo":
                guard let value = request["value"] as? String, value.utf8.count <= 1024 else { throw ProbeWireError.rejected }
                try wire.send(["status": "ok", "value": value, "os": ProcessInfo.processInfo.operatingSystemVersionString])
            case "close": return
            default: try wire.send(["status": "denied", "code": "unsupported_operation"])
            }
        }
        throw ProbeWireError.rejected
    }
    static func main() {
        do {
            let folder = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.deletingLastPathComponent()
            let fixture = try ProbeFixture.load(folder.appendingPathComponent("fixture.json"))
            let bad = ProbeFixture(purpose: fixture.purpose, workspace: fixture.workspace, key: Data(repeating: 0, count: 32).base64EncodedString())
            let fd = try connectHost()
            let badWire = try ProbeWire(fd: fd, fixture: bad, server: false)
            var rejected = false
            do { try badWire.handshake() } catch { rejected = true }
            Darwin.close(fd)
            guard rejected else { throw ProbeWireError.rejected }
            print("Wrong fixture key denied.")
            try serve(fixture)
            try serve(fixture)
            print("Guest probe complete. No shell/UI/file execution capability was exposed.")
        } catch {
            fputs("Disposable guest channel probe failed.\n", stderr)
            exit(1)
        }
    }
}
