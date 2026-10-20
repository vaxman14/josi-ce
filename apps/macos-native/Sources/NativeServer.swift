import AppKit
import Foundation
import Darwin

enum NativeFiles {
    static func json(_ path: String, owner: uid_t, maximum: Int = 8192, privateFile: Bool = false) throws -> Wire {
        var parent = URL(fileURLWithPath: path).deletingLastPathComponent()
        while parent.path != "/" {
            var info = stat()
            guard lstat(parent.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
                  info.st_uid == 0 || info.st_uid == owner, info.st_mode & 0o022 == 0 else {
                throw JosiError(message: "The installation record is unavailable or its permissions changed.")
            }
            parent.deleteLastPathComponent()
        }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw JosiError(message: "The installation record is unavailable.") }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == owner,
              info.st_nlink == 1, info.st_size >= 0, info.st_size <= maximum,
              info.st_mode & (privateFile ? 0o077 : 0o022) == 0 else {
            throw JosiError(message: "The installation record could not be read safely.")
        }
        var data = Data(count: Int(info.st_size))
        let size = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard size == data.count else { throw JosiError(message: "The installation record changed. Refresh and try again.") }
        return try JSONDecoder().decode(Wire.self, from: data)
    }
}

struct ServerReceipt: Sendable {
    var installed = false
    var retainedData = false
    var version = ""
    var address = ""
    var stopped = false
    static func read() throws -> ServerReceipt {
        let path = "/Library/Application Support/Josi CE Server/status.json"
        if !FileManager.default.fileExists(atPath: path) { return ServerReceipt() }
        let value = try NativeFiles.json(path, owner: 0)
        let port = value["publicPort"].integer
        guard !value["installed"].flag || (1024...65535).contains(port) else {
            throw JosiError(message: "The local server address is unavailable. Use Repair.")
        }
        return ServerReceipt(installed: value["installed"].flag, retainedData: value["dataRetained"].flag,
                             version: value["version"].text, address: "http://localhost:\(port)",
                             stopped: value["serviceState"].text == "stopped")
    }
}

enum NativeServer {
    static let application = "/Applications/Josi.app"
    static let requirement = "=anchor apple generic and identifier \"com.heyjosi.ce.unified\" and certificate leaf[subject.OU] = \"LRH75YR6QW\" and certificate leaf[subject.CN] = \"Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)\""
    static var canManage: Bool {
        Bundle.main.bundlePath == application &&
        FileManager.default.isExecutableFile(atPath: application + "/Contents/Resources/runtime/python/bin/python3.11")
    }
    static func operate(_ operation: String, attempt: UUID) async throws {
        guard canManage, ["install", "start", "stop", "restart", "recover-latest", "uninstall"].contains(operation) else {
            throw JosiError(message: "Install the signed Josi app in Applications to manage the local server.")
        }
        let runtime = application + "/Contents/Resources/runtime"
        let helper = operation == "install" ? "pkg-driver.py" : "maintenance.py"
        let command = "set -eu; /usr/bin/codesign --verify --deep --strict -R " + NativeAuthorization.shell(requirement)
            + " " + NativeAuthorization.shell(application)
            + "; /usr/bin/env -i PATH=/usr/bin:/bin " + NativeAuthorization.shell(runtime + "/python/bin/python3.11")
            + " -I -B " + NativeAuthorization.shell(runtime + "/app/native/" + helper)
            + " " + NativeAuthorization.shell(operation)
            + (operation == "install" ? " " + NativeAuthorization.shell(attempt.uuidString.lowercased()) : "")
        let result = try await process("/usr/bin/osascript", ["-e", NativeAuthorization.script(command)])
        guard result == 0 else {
            throw JosiError(message: "The server change did not finish or authorization was cancelled. Refresh its status before trying again; recovery is available.")
        }
    }
    /// No shell interpolation of server replies, credentials, or page content.
    static func process(_ path: String, _ arguments: [String]) async throws -> Int32 {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: path); task.arguments = arguments
                task.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
                // Detailed installer diagnostics already have a root-owned,
                // attempt-bound log. Do not copy raw subprocess text into UI.
                task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
                do { try task.run(); task.waitUntilExit(); continuation.resume(returning: task.terminationStatus) }
                catch { continuation.resume(throwing: JosiError(message: "macOS could not start that operation.")) }
            }
        }
    }
    static func progress(_ attempt: UUID) -> String? {
        let path = "/Library/Logs/Josi CE Server/Install-\(attempt.uuidString.lowercased()).jsonl"
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return nil }; defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == 0,
              info.st_nlink == 1, info.st_mode & 0o022 == 0 else { return nil }
        let size = min(Int(info.st_size), 64 * 1024)
        guard size > 0, lseek(fd, max(0, info.st_size - off_t(size)), SEEK_SET) >= 0 else { return nil }
        var data = Data(count: size)
        let got = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard got == size else { return nil }
        let labels = ["prepared": "Preparing installation", "verified": "Files verified", "quiescing": "Stopping services",
                      "quiesced": "Services stopped", "snapshot": "Recovery copy saved", "provisioned": "Server prepared",
                      "database-ready": "Database ready", "migrating": "Updating your data", "migrated": "Data update complete",
                      "activating": "Starting services", "activated": "Services started", "healthy": "Server ready",
                      "committed": "Installation complete", "Stopped": "Installation needs attention"]
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n").reversed() {
            if let item = try? JSONDecoder().decode(Wire.self, from: Data(line.utf8)),
               let label = labels[item["phase"].text] { return label }
        }
        return nil
    }
}
