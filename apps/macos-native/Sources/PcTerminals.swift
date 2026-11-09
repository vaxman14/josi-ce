import Darwin
import Foundation

/// Persistent shells Josi opens on this Mac, each in its own pseudo-terminal
/// and session, so variables, the working folder and running programs survive
/// between inputs. They never touch the person's own Terminal or keyboard, end
/// at their lifetime, and stop on Pause, Stop or a lost permission. This is
/// process ownership, not a sandbox.
final class PcTerminals: @unchecked Sendable {
    static let shared = PcTerminals()
    private let lock = NSLock()
    private var sessions: [String: Terminal] = [:]
    var count: Int { lock.lock(); defer { lock.unlock() }; return sessions.values.filter { !$0.closed }.count }
    var onChange: (@Sendable () -> Void)?

    func stopAll() {
        lock.lock(); let all = Array(sessions.values); sessions = [:]; lock.unlock()
        all.forEach { $0.close() }; onChange?()
    }
    private func session(_ id: String) -> Terminal? { lock.lock(); defer { lock.unlock() }; return sessions[id] }
    func close(_ id: String) {
        lock.lock(); let terminal = sessions.removeValue(forKey: id); lock.unlock()
        terminal?.close(); onChange?()
    }
    func execute(requestId: String, payload: Wire, scope: Wire) -> PcOutcome {
        let kind = payload["kind"].text
        let id = kind == "desktop.terminal.open" ? requestId : payload["sessionId"].text
        guard scope["kind"].text == "command" else { return pcRefuse("scope_mismatch") }
        var terminal: Terminal?
        lock.lock()
        if kind == "desktop.terminal.open" {
            guard sessions.count < 8 else { lock.unlock(); return pcRefuse("too_many_terminals", "Close a terminal before opening another.") }
            guard let shell = PcWork.shells[payload["shell"].text], shell == scope["application"].text else { lock.unlock(); return pcRefuse("shell_unknown") }
            let cwd = payload["cwd"].text
            var st = stat()
            guard lstat(cwd, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, PcWork.within(cwd, scope["target"].text) else { lock.unlock(); return pcRefuse("folder_outside_scope") }
            let seconds = min(28_800, max(30, payload["timeoutSeconds"].integer))
            guard let opened = Terminal(shell: shell, cwd: cwd, scope: scope, seconds: seconds) else { lock.unlock(); return pcRefuse("terminal_unavailable") }
            sessions[id] = opened; terminal = opened
        } else {
            terminal = sessions[id]
            guard let found = terminal else { lock.unlock(); return pcRefuse("terminal_ended", "Terminal session has ended.") }
            guard found.scope["target"] == scope["target"], found.scope["application"] == scope["application"] else { lock.unlock(); return pcRefuse("scope_changed") }
            if kind == "desktop.terminal.close" { sessions.removeValue(forKey: id) }
        }
        lock.unlock()
        guard let terminal else { return pcRefuse("terminal_ended") }
        switch kind {
        case "desktop.terminal.open", "desktop.terminal.read": break
        case "desktop.terminal.input":
            guard terminal.write(payload["text"].text) else { return pcRefuse("terminal_input_unavailable") }
            Thread.sleep(forTimeInterval: 0.4)
        case "desktop.terminal.close": terminal.close()
        default: return pcRefuse("unsupported_operation")
        }
        if kind == "desktop.terminal.open" { Thread.sleep(forTimeInterval: 0.6) }
        onChange?()
        return (true, terminal.read(id: id, cursor: payload["cursor"].integer))
    }
    /// Keeps an open terminal alive only while its permission holds.
    func watch(_ id: String, authorized: @escaping @Sendable () async -> Bool) async {
        guard let terminal = session(id) else { return }
        while !terminal.completed {
            if !(await authorized()) || terminal.age >= Double(terminal.seconds) { break }
            try? await Task.sleep(for: .milliseconds(1500))
        }
        close(id)
    }

    final class Terminal: @unchecked Sendable {
        let scope: Wire, seconds: Int
        private let started = Date()
        private let master: Int32
        private let pid: pid_t
        private let lock = NSLock()
        private var output = Data(), start = 0, end = 0
        private(set) var closed = false
        private var exitCode: Int32?
        var age: Double { Date().timeIntervalSince(started) }
        var completed: Bool {
            lock.lock(); defer { lock.unlock() }
            if exitCode == nil { var status: Int32 = 0; if waitpid(pid, &status, WNOHANG) == pid { exitCode = (status >> 8) & 0xff } }
            return closed || exitCode != nil
        }
        init?(shell: String, cwd: String, scope: Wire, seconds: Int) {
            self.scope = scope; self.seconds = seconds
            var primary: Int32 = -1, secondary: Int32 = -1
            var size = winsize(ws_row: 36, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0)
            guard openpty(&primary, &secondary, nil, nil, &size) == 0 else { return nil }
            guard let name = ptsname(primary).map({ String(cString: $0) }) else { Darwin.close(primary); Darwin.close(secondary); return nil }
            var actions: posix_spawn_file_actions_t? = nil
            posix_spawn_file_actions_init(&actions)
            // A new session, then the terminal opened inside it becomes its controlling terminal.
            posix_spawn_file_actions_addopen(&actions, 0, name, O_RDWR, 0)
            posix_spawn_file_actions_adddup2(&actions, 0, 1); posix_spawn_file_actions_adddup2(&actions, 0, 2)
            posix_spawn_file_actions_addchdir_np(&actions, cwd)
            var attributes: posix_spawnattr_t? = nil
            posix_spawnattr_init(&attributes)
            posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
            var environment = ProcessInfo.processInfo.environment
            environment["JOSI_PC_CONTROL"] = "1"; environment["TERM"] = "xterm-256color"
            let argv = [strdup(shell), strdup("-l"), strdup("-i"), nil]
            let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
            var child: pid_t = 0
            let spawned = posix_spawn(&child, shell, &actions, &attributes, argv, envp)
            argv.forEach { free($0) }; envp.forEach { free($0) }
            posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes)
            Darwin.close(secondary)
            guard spawned == 0 else { Darwin.close(primary); return nil }
            master = primary; pid = child
            DispatchQueue.global().async { [weak self] in self?.drain() }
        }
        private func drain() {
            var buffer = [UInt8](repeating: 0, count: 8192)
            while true {
                let n = Darwin.read(master, &buffer, buffer.count)
                if n <= 0 { break }
                lock.lock()
                output.append(contentsOf: buffer[0..<n]); end += n
                if output.count > 262_144 { let remove = output.count - 262_144; output.removeFirst(remove); start += remove }
                lock.unlock()
            }
        }
        func write(_ text: String) -> Bool {
            guard !closed, age < Double(seconds), !text.isEmpty, text.count <= 16_384 else { return false }
            let bytes = Array(text.utf8)
            return bytes.withUnsafeBytes { Darwin.write(master, $0.baseAddress, bytes.count) } == bytes.count
        }
        func read(id: String, cursor: Int) -> Wire {
            let running = !completed
            lock.lock(); defer { lock.unlock() }
            let from = min(max(cursor, start), end), count = min(end - from, 48_000)
            let slice = output.subdata(in: (from - start)..<(from - start + count))
            return ["kind": "desktop_terminal", "sessionId": .string(id), "cursor": .number(Double(from + count)),
                    "output": .string(String(decoding: slice, as: UTF8.self)), "truncated": .bool(cursor < start), "hasMore": .bool(from + count < end),
                    "running": .bool(running && !closed), "exitCode": exitCode.map { .number(Double($0)) } ?? .null, "scope": scope, "untrustedContent": .bool(true)]
        }
        func close() {
            lock.lock(); guard !closed else { lock.unlock(); return }; closed = true; lock.unlock()
            kill(-pid, SIGHUP); kill(pid, SIGHUP)
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [pid, master] in kill(-pid, SIGKILL); kill(pid, SIGKILL); Darwin.close(master); var s: Int32 = 0; waitpid(pid, &s, WNOHANG) }
        }
    }
}
