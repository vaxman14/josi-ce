import AppKit
import CryptoKit
import Darwin
import Foundation

/// Cancels one running PC Control action: Pause, Stop, a lost lease, or the
/// person taking over the screen.
final class PcCancel: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var handlers: [() -> Void] = []
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() {
        lock.lock(); guard !cancelled else { lock.unlock(); return }
        cancelled = true; let run = handlers; handlers = []; lock.unlock()
        run.forEach { $0() }
    }
    func onCancel(_ handler: @escaping () -> Void) {
        lock.lock(); if cancelled { lock.unlock(); handler(); return }
        handlers.append(handler); lock.unlock()
    }
    func check() throws { if isCancelled { throw PcStop() } }
}
struct PcStop: Error {}

/// A PC Control result: ok with a JSON value, or a refusal code.
typealias PcOutcome = (ok: Bool, result: Wire)
func pcRefuse(_ code: String, _ detail: String? = nil) -> PcOutcome {
    var value: [String: Wire] = ["code": .string(code)]
    if let detail { value["detail"] = .string(detail) }
    return (false, .object(value))
}

/// Josi's hands on this Mac beyond the screen: commands in a shell, the
/// person's folders and files, and the programs installed here. Every request
/// arrives already decided by the server's PC Control; this side re-checks the
/// exact scope (the shell, the folder tree, the file's folder) before doing
/// anything, runs as the signed-in user, and keeps nothing it saw.
enum PcWork {
    static let shells = ["zsh": "/bin/zsh", "bash": "/bin/bash"]
    private static let tools = ["git", "node", "npm", "npx", "python3", "pip3", "swift", "xcodebuild", "xcrun", "brew", "gh", "docker", "java", "go",
                                "cargo", "rustc", "ruby", "code", "ffmpeg", "curl", "tar", "make", "adb"]
    private static let maxEntries = 500, readBytes = 200 * 1024, readChars = 64 * 1024

    /// An exact absolute path, one spelling: what the server's scopes use.
    static func clean(_ path: String) -> String? {
        guard path.hasPrefix("/"), !path.contains("\0"), path.count <= 1024 else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        if parts.contains(where: { $0 == "." || $0 == ".." }) { return nil }
        let joined = "/" + parts.filter { !$0.isEmpty }.joined(separator: "/")
        return joined
    }
    /// True when folder is root or lies under it (exact spelling, never a sibling's prefix).
    static func within(_ folder: String, _ root: String) -> Bool {
        guard let f = clean(folder), let r = clean(root) else { return false }
        return f == r || r == "/" || f.hasPrefix(r + "/")
    }
    private static func isDirectory(_ path: String) -> Bool {
        var st = stat(); return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
    }
    /// Refuses a folder chain that contains a symbolic link, so a grant never
    /// leads somewhere the owner did not choose. Josi's own data stays out of reach.
    private static func plainChain(_ folder: String) -> String? {
        guard let path = clean(folder) else { return "invalid_path" }
        for protected in [FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/Josi", "/Library/Application Support/Josi CE Server"]
        where path == protected || path.hasPrefix(protected + "/") { return "protected_folder" }
        var current = ""
        for part in path.split(separator: "/") {
            current += "/" + part
            var st = stat()
            guard lstat(current, &st) == 0 else { return "folder_missing" }
            // /var, /tmp and /etc are system links on every Mac; anything else that is a link is refused.
            if (st.st_mode & S_IFMT) == S_IFLNK, !["/var", "/tmp", "/etc"].contains(current) { return "folder_is_link" }
        }
        return nil
    }

    // ------------------------------------------------------------ commands
    static func command(_ payload: Wire, _ scope: Wire, cancel: PcCancel) -> PcOutcome {
        guard let shell = shells[payload["shell"].text], shell == scope["application"].text, FileManager.default.isExecutableFile(atPath: shell) else { return pcRefuse("shell_unknown") }
        let cwd = payload["cwd"].text, root = scope["target"].text
        guard !cwd.isEmpty, isDirectory(cwd), within(cwd, root) else { return pcRefuse("folder_outside_scope") }
        let command = payload["command"].text
        guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return pcRefuse("empty_command") }
        let seconds = payload["timeoutSeconds"].integer > 0 ? min(600, max(5, payload["timeoutSeconds"].integer)) : 120
        let started = Date()
        let run = PcProcess.run(shell, ["-l", "-c", command], cwd: cwd, seconds: seconds, cancel: cancel)
        if cancel.isCancelled { return pcRefuse("paused") }
        return (true, ["kind": "desktop_command", "shell": .string(payload["shell"].text), "cwd": .string(cwd), "exitCode": .number(Double(run.exit)),
                       "timedOut": .bool(run.timedOut), "durationMs": .number(Double(Int(Date().timeIntervalSince(started) * 1000))),
                       "stdout": .string(run.stdout), "stderr": .string(run.stderr), "truncated": .bool(run.truncated), "untrustedContent": .bool(true)])
    }

    // ------------------------------------------------------------ this Mac
    static func environment() -> PcOutcome {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let path = PcProcess.loginPath()
        var found: [String: Wire] = [:]
        for tool in tools {
            for folder in path.split(separator: ":") where FileManager.default.isExecutableFile(atPath: "\(folder)/\(tool)") {
                found[tool] = .string("\(folder)/\(tool)"); break
            }
        }
        var volumes: [Wire] = []
        let keys: [URLResourceKey] = [.volumeNameKey, .volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey]
        for url in FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? [] {
            let values = try? url.resourceValues(forKeys: Set(keys))
            volumes.append(["path": .string(url.path), "name": .string(values?.volumeName ?? ""),
                            "freeBytes": .number(Double(values?.volumeAvailableCapacityForImportantUsage ?? 0)),
                            "totalBytes": .number(Double(values?.volumeTotalCapacity ?? 0))])
        }
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return (true, ["kind": "desktop_environment", "platform": "macos", "user": .string(NSUserName()), "home": .string(home),
                       "computer": .string(PcDevice.name), "macos": .string("\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"),
                       "architecture": "arm64", "processors": .number(Double(ProcessInfo.processInfo.processorCount)),
                       "folders": ["desktop": .string(home + "/Desktop"), "documents": .string(home + "/Documents"), "downloads": .string(home + "/Downloads"),
                                   "pictures": .string(home + "/Pictures"), "applications": "/Applications", "userApplications": .string(home + "/Applications"),
                                   "temp": .string(NSTemporaryDirectory().hasSuffix("/") ? String(NSTemporaryDirectory().dropLast()) : NSTemporaryDirectory())],
                       "shells": ["zsh": "/bin/zsh", "bash": "/bin/bash"], "defaultShell": "zsh", "tools": .object(found), "volumes": .array(volumes),
                       "josiApp": .string(Bundle.main.bundlePath),
                       "note": "This is a Mac: paths look like /Users/name/folder, programs are .app bundles, shortcuts use cmd.", "untrustedContent": .bool(true)])
    }

    /// Installed programs whose name matches, from the Applications folders, with their exact .app path.
    static func findApps(_ query: String) -> PcOutcome {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return pcRefuse("empty_query") }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var found: [Wire] = [], seen = Set<String>()
        func scan(_ folder: String, depth: Int) {
            guard depth <= 2, found.count < 30, let items = try? FileManager.default.contentsOfDirectory(atPath: folder) else { return }
            for item in items.sorted() {
                let path = folder + "/" + item
                if item.hasSuffix(".app") {
                    let name = String(item.dropLast(4))
                    let display = (Bundle(path: path)?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? name
                    let haystack = (name + " " + display).lowercased()
                    if words.allSatisfy({ haystack.contains($0) }), seen.insert(path).inserted {
                        found.append(["name": .string(display), "application": .string(path), "source": "applications"])
                    }
                } else if isDirectory(path), !item.hasPrefix(".") { scan(path, depth: depth + 1) }
            }
        }
        for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities", home + "/Applications"] { scan(folder, depth: 0) }
        return (true, ["kind": "desktop_apps", "query": .string(query), "apps": .array(found), "untrustedContent": .bool(true)])
    }

    // ------------------------------------------------------------ files
    static func listFolder(_ payload: Wire, _ scope: Wire) -> PcOutcome {
        let folder = payload["folder"].text
        guard let clean = clean(folder), clean == scope["target"].text else { return pcRefuse("folder_outside_scope") }
        if let problem = plainChain(clean) { return pcRefuse(problem) }
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: clean) else { return pcRefuse("folder_unreadable") }
        var entries: [Wire] = [], partial = false
        let iso = ISO8601DateFormatter()
        for name in items.sorted() {
            if entries.count >= maxEntries { partial = true; break }
            var st = stat(); guard lstat(clean + "/" + name, &st) == 0 else { continue }
            let type = st.st_mode & S_IFMT
            var item: [String: Wire] = ["name": .string(name), "kind": .string(type == S_IFDIR ? "folder" : "file"),
                                        "modified": .string(iso.string(from: Date(timeIntervalSince1970: TimeInterval(st.st_mtimespec.tv_sec))))]
            if type == S_IFREG { item["bytes"] = .number(Double(st.st_size)) }
            if name.hasPrefix(".") { item["hidden"] = .bool(true) }
            if type == S_IFLNK { item["link"] = .bool(true) }
            entries.append(.object(item))
        }
        return (true, ["kind": "desktop_folder", "folder": .string(clean), "entries": .array(entries), "partial": .bool(partial), "untrustedContent": .bool(true)])
    }
    private static func fileInScope(_ file: String, _ scope: Wire) -> (path: String, problem: String?) {
        guard let path = clean(file) else { return ("", "invalid_path") }
        let folder = (path as NSString).deletingLastPathComponent
        guard folder == scope["target"].text else { return (path, "file_outside_scope") }
        return (path, plainChain(folder))
    }
    static func readFile(_ payload: Wire, _ scope: Wire) -> PcOutcome {
        let (path, problem) = fileInScope(payload["path"].text, scope)
        if let problem { return pcRefuse(problem) }
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { return pcRefuse(errno == ENOENT ? "file_missing" : errno == ELOOP ? "file_is_link" : "file_unreadable") }
        defer { close(fd) }
        var st = stat(); guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_nlink <= 1 else { return pcRefuse("file_is_link") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let bytes = (try? handle.read(upToCount: readBytes)) ?? Data()
        let length = Int(st.st_size)
        if bytes.prefix(8192).contains(0) {
            return (true, ["kind": "desktop_file", "path": .string(path), "bytes": .number(Double(length)), "binary": .bool(true), "text": "",
                           "note": "This is not a text file.", "untrustedContent": .bool(true)])
        }
        var text = String(decoding: bytes, as: UTF8.self)
        let cut = text.count > readChars || bytes.count < length
        if text.count > readChars { text = String(text.prefix(readChars)) }
        let sha: Wire = bytes.count == length ? .string(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()) : .null
        return (true, ["kind": "desktop_file", "path": .string(path), "bytes": .number(Double(length)), "text": .string(text),
                       "truncated": .bool(cut), "sha256": sha, "untrustedContent": .bool(true)])
    }
    static func writeFile(_ payload: Wire, _ scope: Wire) -> PcOutcome {
        guard let path = clean(payload["path"].text) else { return pcRefuse("invalid_path") }
        let folder = (path as NSString).deletingLastPathComponent
        guard folder == scope["target"].text else { return pcRefuse("file_outside_scope") }
        // The approved folder may be created; nothing above it is touched.
        if !isDirectory(folder) {
            let parent = (folder as NSString).deletingLastPathComponent
            guard isDirectory(parent) else { return pcRefuse("folder_missing") }
            if let problem = plainChain(parent) { return pcRefuse(problem) }
            guard mkdir(folder, 0o755) == 0 else { return pcRefuse("folder_unwritable") }
        }
        if let problem = plainChain(folder) { return pcRefuse(problem) }
        let content = Data(payload["content"].text.utf8), append = payload["append"].flag, expected = payload["expectedSha256"].text
        let existed = access(path, F_OK) == 0
        if !existed && !expected.isEmpty { return pcRefuse("file_changed_read_again") }
        let fd = open(path, O_RDWR | O_NOFOLLOW | (existed ? 0 : O_CREAT | O_EXCL), 0o644)
        guard fd >= 0 else { return pcRefuse(errno == ELOOP ? "file_is_link" : "file_unwritable") }
        defer { close(fd) }
        var st = stat(); guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_nlink <= 1 else { return pcRefuse("file_is_link") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        if existed && !expected.isEmpty {
            let current = (try? handle.readToEnd()) ?? Data()
            if SHA256.hash(data: current).map({ String(format: "%02x", $0) }).joined() != expected { return pcRefuse("file_changed_read_again") }
        }
        do {
            if append { try handle.seekToEnd() } else { try handle.truncate(atOffset: 0); try handle.seek(toOffset: 0) }
            try handle.write(contentsOf: content)
        } catch { return pcRefuse("file_unwritable") }
        var after = stat(); fstat(fd, &after)
        return (true, ["kind": "desktop_file_written", "path": .string(path), "bytes": .number(Double(after.st_size)), "appended": .bool(append), "created": .bool(!existed)])
    }
}

/// A child process in its own process group, so the whole tree ends on a
/// timeout, Pause or Stop. Output keeps its start and end, dropping the middle.
enum PcProcess {
    struct Run { var exit: Int32; var stdout: String; var stderr: String; var timedOut: Bool; var truncated: Bool }
    /// The PATH a login shell gives the person, so Homebrew and the like are found.
    static func loginPath() -> String {
        let run = PcProcess.run("/bin/zsh", ["-l", "-c", "printf %s \"$PATH\""], cwd: NSHomeDirectory(), seconds: 5, cancel: PcCancel())
        let value = run.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" : value
    }
    static func run(_ executable: String, _ arguments: [String], cwd: String, seconds: Int, cancel: PcCancel) -> Run {
        var out: [Int32] = [0, 0], err: [Int32] = [0, 0]
        guard pipe(&out) == 0, pipe(&err) == 0 else { return Run(exit: -1, stdout: "", stderr: "Could not start the shell.", timedOut: false, truncated: false) }
        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, out[1], 1)
        posix_spawn_file_actions_adddup2(&actions, err[1], 2)
        posix_spawn_file_actions_addclose(&actions, out[0]); posix_spawn_file_actions_addclose(&actions, err[0])
        posix_spawn_file_actions_addchdir_np(&actions, cwd)
        var attributes: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attributes, 0)
        var environment = ProcessInfo.processInfo.environment
        environment["JOSI_PC_CONTROL"] = "1"; environment["TERM"] = "dumb"; environment["NO_COLOR"] = "1"; environment["CI"] = "1"
        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) }; posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        var pid: pid_t = 0
        let spawned = posix_spawn(&pid, executable, &actions, &attributes, argv, envp)
        close(out[1]); close(err[1])
        guard spawned == 0 else { close(out[0]); close(err[0]); return Run(exit: -1, stdout: "", stderr: "Could not start the shell (\(spawned)).", timedOut: false, truncated: false) }
        let stdout = Capture(head: 40 * 1024, tail: 24 * 1024), stderr = Capture(head: 16 * 1024, tail: 0)
        let group = DispatchGroup()
        for (fd, capture) in [(out[0], stdout), (err[0], stderr)] {
            group.enter()
            DispatchQueue.global().async {
                var buffer = [UInt8](repeating: 0, count: 16384)
                while true { let n = read(fd, &buffer, buffer.count); if n <= 0 { break }; capture.add(Data(buffer[0..<n])) }
                close(fd); group.leave()
            }
        }
        var timedOut = false
        let killGroup = { kill(-pid, SIGTERM); DispatchQueue.global().asyncAfter(deadline: .now() + 2) { kill(-pid, SIGKILL) } }
        cancel.onCancel(killGroup)
        let deadline = DispatchTime.now() + .seconds(seconds)
        DispatchQueue.global().asyncAfter(deadline: deadline) { if kill(pid, 0) == 0 { timedOut = true; killGroup() } }
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
        _ = group.wait(timeout: .now() + 3)
        let exit: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        return Run(exit: exit, stdout: stdout.text(), stderr: stderr.text(), timedOut: timedOut, truncated: stdout.truncated || stderr.truncated)
    }
    final class Capture: @unchecked Sendable {
        private let lock = NSLock(); private let head: Int, tail: Int
        private var first = Data(), last = Data(), dropped = 0
        init(head: Int, tail: Int) { self.head = head; self.tail = tail }
        var truncated: Bool { lock.lock(); defer { lock.unlock() }; return dropped > 0 }
        func add(_ data: Data) {
            lock.lock(); defer { lock.unlock() }
            let keep = min(head - first.count, data.count)
            if keep > 0 { first.append(data.prefix(keep)) }
            last.append(data.dropFirst(max(0, keep)))
            if last.count > tail { dropped += last.count - tail; last = last.suffix(tail) }
        }
        func text() -> String {
            lock.lock(); defer { lock.unlock() }
            var value = String(decoding: first, as: UTF8.self)
            if dropped > 0 { value += "\n[... \(dropped) bytes omitted ...]\n\n" }
            return value + String(decoding: last, as: UTF8.self)
        }
    }
}
