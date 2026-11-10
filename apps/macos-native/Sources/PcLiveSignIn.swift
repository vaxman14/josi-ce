import Darwin
import Foundation

/// Sign-in cards on this Mac (docs/LIVE_SIGN_IN.md): the person signs in for
/// Josi on a live view of her own browser, or in a terminal running exactly the
/// command on the card. This relays the picture, the terminal output and the
/// person's input through the server's signed executor routes. Nothing is kept,
/// logged or shown to Josi's model.
@MainActor final class PcLiveSignIn {
    static let shared = PcLiveSignIn()
    private var running: Set<String> = []
    private var looping = false

    /// Called by the executor while this Mac is paired and not paused.
    func start(_ api: JosiAPI, attached: @escaping @MainActor () -> Bool) {
        guard !looping else { return }
        looping = true
        Task { @MainActor in
            defer { looping = false }
            while attached() {
                let sessions = (try? await api.request("/admin/pc-control/executor/live"))?["sessions"].list ?? []
                for session in sessions where !running.contains(session.identifier) && ["starting", "ready"].contains(session["state"].text) {
                    running.insert(session.identifier)
                    let id = session.identifier
                    Task.detached {
                        if session["kind"].text == "terminal" { await Self.terminal(api, session) } else { await Self.browser(api, session) }
                        await MainActor.run { _ = PcLiveSignIn.shared.running.remove(id) }
                    }
                }
                try? await Task.sleep(for: .seconds(running.isEmpty ? 2 : 1))
            }
        }
    }

    /// One signed round trip: what this side has, and the person's input back.
    nonisolated private static func sync(_ api: JosiAPI, _ id: String, _ body: Wire) async -> (input: [Wire], ended: Bool) {
        guard let route = try? await MainActor.run(body: { "/admin/pc-control/executor/live/\(try api.uuid(id))/sync" }),
              let reply = try? await api.request(route, method: "POST", body: body) else { return ([], false) }
        return (reply["input"].list, reply["ended"].flag)
    }

    // ------------------------------------------------------------ the live view of Josi's browser
    nonisolated private static func browser(_ api: JosiAPI, _ live: Wire) async {
        let id = live.identifier, own = PcOwnBrowser.shared
        let session: String
        do {
            let url = live["url"].text.hasPrefix("https://") ? live["url"].text : nil
            session = try await own.page(url: url)
        } catch {
            _ = await sync(api, id, ["error": .string("Josi's browser could not start on this Mac: \(error.localizedDescription)")])
            return
        }
        var last = Data(), sentAt = Date.distantPast, ready = false, quiet = 0
        while true {
            var body: [String: Wire] = [:]
            if !ready { body["ready"] = .bool(true); ready = true }
            // A frame when the picture changed, and at least one a second.
            if let picture = try? await own.frame(session), picture != last || Date().timeIntervalSince(sentAt) >= 1 {
                last = picture; sentAt = Date()
                body["frame"] = ["width": .number(Double(PcOwnBrowser.width)), "height": .number(Double(PcOwnBrowser.height)),
                                 "jpegBase64": .string(picture.base64EncodedString())]
            }
            let reply = await sync(api, id, .object(body))
            if reply.ended { break }
            for event in reply.input { try? await own.input(event, session: session) }
            quiet = reply.input.isEmpty ? quiet + 1 : 0
            try? await Task.sleep(for: .milliseconds(reply.input.isEmpty && quiet > 8 ? 400 : 200))
        }
        _ = try? await own.send("Target.detachFromTarget", ["sessionId": .string(session)])
    }

    // ------------------------------------------------------------ the login terminal
    nonisolated private static func terminal(_ api: JosiAPI, _ live: Wire) async {
        let id = live.identifier, command = live["command"].text
        guard !command.isEmpty, command.count <= 400, !command.contains(where: { $0.isNewline }) else {
            _ = await sync(api, id, ["error": "The card has no command to run."]); return
        }
        guard let pty = LoginTerminal(command: command) else { _ = await sync(api, id, ["error": "The terminal could not start on this Mac."]); return }
        defer { pty.close() }
        var ready = false
        while true {
            var body: [String: Wire] = [:]
            if !ready { body["ready"] = .bool(true); ready = true }
            let (data, running, exit) = pty.take()
            if !data.isEmpty || !running { body["output"] = ["data": .string(data), "running": .bool(running), "exitCode": exit.map { .number(Double($0)) } ?? .null] }
            let reply = await sync(api, id, .object(body))
            if reply.ended { break }
            for event in reply.input {
                if event["t"].text == "data" { pty.write(String(event["data"].text.prefix(4096))) }
                else if event["t"].text == "resize" { pty.resize(cols: event["cols"].integer, rows: event["rows"].integer) }
            }
            try? await Task.sleep(for: .milliseconds(reply.input.isEmpty ? 250 : 80))
        }
    }
}

/// A pseudo-terminal running exactly the card's command, as the person signed in
/// to this Mac, through zsh -c (not an open shell). It stays open after the
/// command ends until the person closes the card.
final class LoginTerminal: @unchecked Sendable {
    private let master: Int32, pid: pid_t
    private let lock = NSLock()
    private var pending = Data(), exitCode: Int32?
    init?(command: String) {
        var primary: Int32 = -1, secondary: Int32 = -1
        var size = winsize(ws_row: 36, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&primary, &secondary, nil, nil, &size) == 0, let name = ptsname(primary).map({ String(cString: $0) }) else { return nil }
        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_addopen(&actions, 0, name, O_RDWR, 0)
        posix_spawn_file_actions_adddup2(&actions, 0, 1); posix_spawn_file_actions_adddup2(&actions, 0, 2)
        posix_spawn_file_actions_addchdir_np(&actions, NSHomeDirectory())
        var attributes: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "xterm-256color"; environment["JOSI_PC_CONTROL"] = "1"
        let argv = [strdup("/bin/zsh"), strdup("-l"), strdup("-c"), strdup(command), nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        var child: pid_t = 0
        let result = posix_spawn(&child, "/bin/zsh", &actions, &attributes, argv, envp)
        argv.forEach { free($0) }; envp.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes)
        Darwin.close(secondary)
        guard result == 0 else { Darwin.close(primary); return nil }
        master = primary; pid = child
        DispatchQueue.global().async { [weak self] in self?.drain() }
    }
    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = Darwin.read(master, &buffer, buffer.count)
            if n <= 0 { break }
            lock.lock(); pending.append(contentsOf: buffer[0..<n]); if pending.count > 262_144 { pending = pending.suffix(262_144) }; lock.unlock()
        }
    }
    /// Output since the last call, whether the command still runs, and its exit code.
    func take() -> (String, Bool, Int32?) {
        lock.lock(); defer { lock.unlock() }
        if exitCode == nil { var status: Int32 = 0; if waitpid(pid, &status, WNOHANG) == pid { exitCode = (status >> 8) & 0xff } }
        // Keep a partial UTF-8 character for the next call.
        var cut = pending.count
        while cut > 0, cut > pending.count - 4, String(data: pending.prefix(cut), encoding: .utf8) == nil { cut -= 1 }
        let text = String(decoding: pending.prefix(cut), as: UTF8.self)
        pending = Data(pending.dropFirst(cut))
        return (text, exitCode == nil, exitCode)
    }
    func write(_ text: String) {
        let bytes = Array(text.utf8)
        _ = bytes.withUnsafeBytes { Darwin.write(master, $0.baseAddress, bytes.count) }
    }
    func resize(cols: Int, rows: Int) {
        var size = winsize(ws_row: UInt16(max(5, min(200, rows))), ws_col: UInt16(max(20, min(400, cols))), ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &size)
    }
    func close() {
        kill(-pid, SIGHUP); kill(pid, SIGHUP)
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [pid, master] in kill(-pid, SIGKILL); Darwin.close(master); var s: Int32 = 0; waitpid(pid, &s, WNOHANG) }
    }
}
