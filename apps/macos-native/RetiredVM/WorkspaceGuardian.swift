import Foundation
import Darwin

/// A private child monitors only parent/lease liveness and normal detachment.
/// It receives no password or execution authority and cannot issue VM input.
@MainActor final class NativeWorkspaceGuardian {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var finished = false
    var running: Bool { !finished && process.isRunning }
    func start(_ id: String) async throws {
        guard NativeServer.canManage, ProtectedWire.uuid(.string(id)), !process.isRunning else { throw approvalUnavailable() }
        let runtime = NativeServer.application + "/Contents/Resources/runtime"
        process.executableURL = URL(fileURLWithPath: runtime + "/python/bin/python3.11")
        process.arguments = ["-I", "-B", runtime + "/app/native/automation-workspace-guardian.py", id]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        let descriptor = input.fileHandleForWriting.fileDescriptor
        guard fcntl(descriptor, F_SETNOSIGPIPE, 1) == 0,
              fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK) == 0 else { throw approvalUnavailable() }
        try process.run()
        let reader = output.fileHandleForReading
        do {
            let response: Wire = try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        var data = Data()
                        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
                        while !data.contains(10) {
                            guard DispatchTime.now().uptimeNanoseconds < deadline, data.count < 1024 else { throw approvalUnavailable() }
                            var ready = pollfd(fd: reader.fileDescriptor, events: Int16(POLLIN), revents: 0)
                            let result = poll(&ready, 1, 250)
                            if result == 0 || result < 0 && errno == EINTR { continue }
                            guard result > 0, let bytes = try reader.read(upToCount: 1024), !bytes.isEmpty else { throw approvalUnavailable() }
                            data.append(bytes)
                        }
                        continuation.resume(returning: try JSONDecoder().decode(Wire.self, from: Data(data.prefix { $0 != 10 })))
                    } catch { continuation.resume(throwing: approvalUnavailable()) }
                }
            }
            guard response == ["ready": .bool(true)], running else { throw approvalUnavailable() }
            try renew()
        } catch { try? input.fileHandleForWriting.close(); throw error }
    }
    private func send(_ command: String) throws {
        guard running else { throw approvalUnavailable() }
        let bytes = Data(command.utf8)
        let count = bytes.withUnsafeBytes { Darwin.write(input.fileHandleForWriting.fileDescriptor, $0.baseAddress, $0.count) }
        guard count == bytes.count else { throw approvalUnavailable() }
    }
    func renew() throws { try send("alive\n") }
    func closed() {
        // Sent only after this owner verified actual detachment. The child
        // independently checks that fact before exiting.
        try? send("closed\n"); finished = true
        try? input.fileHandleForWriting.close()
    }
}
