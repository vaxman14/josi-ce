import Foundation
import Darwin

/// Refuse to start an operation unless its private diagnostic file is durable.
final class DiagnosticLog: @unchecked Sendable {
    let url: URL
    private let descriptor: Int32
    private let lock = NSLock()
    init(directory: URL, operation: String) throws {
        var ancestor = directory
        while ancestor.path != "/" {
            var entry = stat()
            if lstat(ancestor.path, &entry) == 0 && entry.st_mode & S_IFMT != S_IFDIR {
                throw NSError(domain: "JosiDiagnostics", code: 2, userInfo: [NSLocalizedDescriptionKey: "The diagnostic path contains a link or non-folder."])
            }
            ancestor.deleteLastPathComponent()
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o077 == 0 else {
            throw NSError(domain: "JosiDiagnostics", code: 1, userInfo: [NSLocalizedDescriptionKey: "The diagnostic folder is not private."])
        }
        url = directory.appendingPathComponent(operation + "-" + UUID().uuidString + ".log")
        descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        do {
            try append("Josi " + operation + " started " + ISO8601DateFormatter().string(from: Date()) + "\n")
            let parent = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard parent >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            defer { Darwin.close(parent) }
            guard fsync(parent) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        } catch { Darwin.close(descriptor); throw error }
    }
    deinit { Darwin.close(descriptor) }
    static func redact(_ text: String) -> String {
        var result = text
        for (pattern, replacement) in [
            (#"(?i)(password|token|secret|authorization|master.key)(\s*[=:]\s*)\S+"#, "$1$2[redacted]"),
            (#"(?i)(postgres(?:ql)?://)[^\s]+"#, "$1[redacted]"),
            (#"\b[a-fA-F0-9]{64}\b"#, "[redacted]")
        ] {
            result = result.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return result
    }
    static func failureCause(in output: String) -> String? {
        // osascript can wrap the final JSON in an execution-error prefix and
        // a trailing exit code. Show the helper's cause, not that wrapper.
        for line in output.split(separator: "\n").reversed() {
            guard let start = line.firstIndex(of: "{"), let end = line.lastIndex(of: "}"),start <= end,
                  let data = String(line[start...end]).data(using:.utf8),
                  let value = try? JSONSerialization.jsonObject(with:data) as? [String:Any],
                  value["result"] as? String == "failure",let cause = value["cause"] as? String,!cause.isEmpty else { continue }
            let safe = redact(cause)
            return safe.count > 240 ? String(safe.prefix(240)) + "…" : safe
        }
        return nil
    }
    func append(_ text: String) throws {
        lock.lock(); defer { lock.unlock() }
        let bytes = Array(Self.redact(text).utf8)
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
}
