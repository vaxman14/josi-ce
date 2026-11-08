import Foundation
import Darwin

/// Mediated file access. Directory descriptors, O_NOFOLLOW and link-count
/// checks prevent links/aliases from turning a folder grant into host access.
enum ComputerFiles {
    static func execute(_ operation: Wire) throws -> Wire {
        let args = operation["args"], root = operation["scope"]["target"].text
        switch operation["action"].text {
        case "file.list": return try list(args["path"].text, root: root)
        case "file.read":
            let bytes = try read(args["path"].text, root: root)
            guard let value = String(data: bytes, encoding: .utf8) else { throw JosiError(message: "Only UTF-8 text files are supported.") }
            return ["text": .string(value), "sha256": .string(ComputerWire.digest(bytes)), "untrusted": .bool(true)]
        case "file.write": return try write(args["path"].text, root: root, text: args["text"].text, expectedDigest: args["expectedDigest"].text)
        default: throw JosiError(message: "Unsupported mediated file operation.")
        }
    }
    static func parent(_ path: String, root: String) throws -> (Int32, String) {
        guard path.hasPrefix("/"), root.hasPrefix("/"), path == root || path.hasPrefix(root == "/" ? "/" : root + "/"),
              !path.contains("\\"), !path.contains("//"), !path.utf8.contains(0) else { throw JosiError(message: "File is outside the approved folder.") }
        let protected = ["/Library/Application Support/Josi CE Server", "/Library/Keychains", NSHomeDirectory() + "/Library/Keychains",
            NSHomeDirectory() + "/Library/Application Support/Josi", NSHomeDirectory() + "/Library/Preferences/com.heyjosi.ce.unified.plist"]
            + (Bundle.main.bundleURL.pathExtension == "app" ? [Bundle.main.bundleURL.path] : [])
        guard !protected.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) else { throw JosiError(message: "Josi authority, device keys and credential stores are outside mediated file access.") }
        let pieces = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard !pieces.isEmpty, pieces.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw JosiError(message: "Use a canonical absolute file path.") }
        var fd = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard fd >= 0 else { throw JosiError(message: "Cannot open the filesystem root.") }
        for part in pieces.dropLast() {
            let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            close(fd); fd = next
            guard fd >= 0 else { throw JosiError(message: "A folder was replaced, is inaccessible, or is a symbolic link.") }
        }
        var filesystem = statfs()
        guard fstatfs(fd, &filesystem) == 0, filesystem.f_flags & UInt32(MNT_LOCAL) != 0 else { close(fd); throw JosiError(message: "Only local filesystems are supported by this file adapter.") }
        return (fd, pieces.last!)
    }
    static func read(_ path: String, root: String) throws -> Data {
        let (parent, name) = try parent(path, root: root); defer { close(parent) }
        let fd = openat(parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw JosiError(message: "Cannot read this regular file without following links.") }
        defer { close(fd) }; return try data(fd)
    }
    private static func data(_ fd: Int32) throws -> Data {
        var st = stat(); guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1, st.st_size <= 64 * 1024 else { throw JosiError(message: "Only single-link regular files up to 64 KiB are supported.") }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = Darwin.read(fd, &buffer, buffer.count)
            if n == 0 { break }; if n < 0 && errno == EINTR { continue }
            guard n > 0, result.count + n <= 64 * 1024 else { throw JosiError(message: "File changed or exceeded the read limit.") }
            result.append(contentsOf: buffer.prefix(n))
        }
        return result
    }
    static func write(_ path: String, root: String, text: String, expectedDigest: String) throws -> Wire {
        let bytes = Data(text.utf8); guard bytes.count <= 64 * 1024 else { throw JosiError(message: "Keep file writes below 64 KiB.") }
        let (parent, name) = try parent(path, root: root); defer { close(parent) }
        let flags = expectedDigest.isEmpty ? O_RDWR | O_CREAT | O_EXCL : O_RDWR
        let fd = openat(parent, name, flags | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw JosiError(message: "File changed, already exists, or cannot be opened safely.") }
        defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw JosiError(message: "Another operation is using this file.") }
        defer { flock(fd, LOCK_UN) }
        let old = try data(fd)
        guard expectedDigest.isEmpty || ComputerWire.digest(old) == expectedDigest else { throw JosiError(message: "The file changed since the last read. Read it again before editing.") }
        guard lseek(fd, 0, SEEK_SET) == 0 else { throw JosiError(message: "Cannot seek in this file.") }
        var offset = 0
        while offset < bytes.count {
            let n = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if n < 0 && errno == EINTR { continue }; guard n > 0 else { throw JosiError(message: "File write failed; inspect the file before retrying.") }; offset += n
        }
        guard ftruncate(fd, off_t(bytes.count)) == 0, fsync(fd) == 0 else { throw JosiError(message: "File flush failed; inspect the file before retrying.") }
        return ["sha256": .string(ComputerWire.digest(bytes)), "bytes": .number(Double(bytes.count))]
    }
    static func list(_ path: String, root: String) throws -> Wire {
        let (parent, name) = try parent(path, root: root); defer { close(parent) }
        let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw JosiError(message: "Cannot list this folder without following links.") }
        guard let directory = fdopendir(fd) else { close(fd); throw JosiError(message: "Cannot list this folder.") }
        defer { closedir(directory) }
        var names: [Wire] = []
        while let entry = readdir(directory), names.count < 500 {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { ptr in ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN)) { String(cString: $0) } }
            if name != "." && name != ".." { names.append(.string(name)) }
        }
        return ["names": .array(names), "limit": .number(500), "untrusted": .bool(true)]
    }
}
