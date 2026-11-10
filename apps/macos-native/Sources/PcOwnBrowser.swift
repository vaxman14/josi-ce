import CryptoKit
import Darwin
import Foundation
import Security

/// Josi's own browser on this Mac: Chrome for Testing (JosiOwnBrowser, pinned by
/// version, download hash and code hash), hidden, with its own profile in
/// ~/Library/Application Support/Josi/Browser and the Josi extension. Josi uses
/// it when no browser of yours is linked, and for sign-in cards: you sign in on
/// a live view of it, so the sign-in stays in her profile until you clear it.
///
/// It runs headless and Josi drives it over a private pipe (the DevTools
/// protocol), never an open port, so no other program can reach it and macOS
/// asks for no Screen Recording or Accessibility permission.
final class PcOwnBrowser: @unchecked Sendable {
    static let shared = PcOwnBrowser()
    static let width = 1280, height = 800
    private static let enabledKey = "josi.pc.ownBrowser"
    private let lock = NSLock()
    private var process: pid_t = 0
    private var writer: Int32 = -1
    private var nextId = 1
    private var waiting: [Int: CheckedContinuation<Wire, Error>] = [:]
    private var buffer = Data()
    private var starting: Task<Void, Error>?
    private(set) var status = ""

    private var home: String {
        #if DEBUG
        // A test run keeps its own browser and profile, apart from the real one.
        if let path = ProcessInfo.processInfo.environment["JOSI_OWN_BROWSER_HOME"] { return path }
        #endif
        return FileManager.default.homeDirectoryForCurrentUser.path
    }
    var appPath: String { JosiOwnBrowser.app(home: home) }
    /// On unless the owner turns it off; it is only downloaded when first needed.
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
    var installed: Bool { FileManager.default.isExecutableFile(atPath: JosiOwnBrowser.executable(home: home)) && verified(JosiOwnBrowser.executable(home: home)) }
    var running: Bool { lock.lock(); defer { lock.unlock() }; return process > 0 && kill(process, 0) == 0 }

    // ------------------------------------------------------------ install
    /// Downloads the pinned zip once, checks its size and SHA-256, unpacks it and
    /// checks the executable's code hash. Anything else is deleted, never run.
    func install() async throws {
        if installed { return }
        let folder = JosiOwnBrowser.folder(home: home), target = folder + "/" + JosiOwnBrowser.version
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        setStatus("Getting Josi's browser (about 190 MB, once)…")
        defer { setStatus("") }
        let (file, response) = try await URLSession.shared.download(from: URL(string: JosiOwnBrowser.zipURL)!)
        defer { try? FileManager.default.removeItem(at: file) }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) == JosiOwnBrowser.zipBytes,
              try Self.sha256(file) == JosiOwnBrowser.zipSHA256 else { throw JosiError(message: "Josi's browser download did not match its pinned checksum. Nothing was installed.") }
        try? FileManager.default.removeItem(atPath: target)
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto"); unzip.arguments = ["-x", "-k", file.path, target]
        try unzip.run(); unzip.waitUntilExit()
        guard unzip.terminationStatus == 0, verified(JosiOwnBrowser.executable(home: home)) else {
            try? FileManager.default.removeItem(atPath: target)
            throw JosiError(message: "Josi's browser did not unpack as expected. Nothing was installed.")
        }
    }
    private static func sha256(_ file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func verified(_ executable: String) -> Bool {
        var code: SecStaticCode?, info: CFDictionary?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: executable) as CFURL, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let hash = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else { return false }
        return hash.map { String(format: "%02x", $0) }.joined() == JosiOwnBrowser.codeHash
    }
    private func setStatus(_ text: String) { lock.lock(); status = text; lock.unlock() }

    // ------------------------------------------------------------ start and stop
    /// Starts it if it is not running (installing it the first time). Safe to call often.
    func start() async throws {
        if running { return }
        let task: Task<Void, Error> = lock.withLock {
            if let starting { return starting }
            let made = Task { try await self.launch() }
            starting = made
            return made
        }
        defer { lock.withLock { starting = nil } }
        try await task.value
    }
    private func launch() async throws {
        guard Self.enabled else { throw JosiError(message: "Josi's own browser is turned off on this Mac.") }
        try await install()
        let profile = JosiOwnBrowser.profile(home: home)
        try FileManager.default.createDirectory(atPath: profile + "/NativeMessagingHosts", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // The native host is registered in her profile only, so this browser links to Josi with no prompt.
        if let source = Bundle.main.url(forResource: "chrome", withExtension: "json", subdirectory: "NativeMessagingHosts"),
           let body = try? Data(contentsOf: source) {
            FileManager.default.createFile(atPath: profile + "/NativeMessagingHosts/com.heyjosi.browser.json", contents: body, attributes: [.posixPermissions: 0o600])
        }
        let fileExtension = Bundle.main.resourceURL?.appendingPathComponent("BrowserExtensions/chrome").path ?? ""
        var arguments = ["--headless=new", "--remote-debugging-pipe", "--user-data-dir=\(profile)", "--use-mock-keychain", "--password-store=basic",
                         "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
                         "--disable-features=Translate,MediaRouter", "--window-size=\(Self.width),\(Self.height)"]
        if FileManager.default.fileExists(atPath: fileExtension + "/manifest.json") { arguments.append("--load-extension=\(fileExtension)") }
        arguments.append("about:blank")
        var toChrome: [Int32] = [0, 0], fromChrome: [Int32] = [0, 0]
        guard pipe(&toChrome) == 0, pipe(&fromChrome) == 0 else { throw JosiError(message: "Josi's browser could not start.") }
        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        // --remote-debugging-pipe: the browser reads commands on fd 3 and answers on fd 4.
        posix_spawn_file_actions_adddup2(&actions, toChrome[0], 3)
        posix_spawn_file_actions_adddup2(&actions, fromChrome[1], 4)
        var attributes: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)
        let executable = JosiOwnBrowser.executable(home: home)
        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        var environment = ProcessInfo.processInfo.environment; environment.removeValue(forKey: "DYLD_INSERT_LIBRARIES")
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        var pid: pid_t = 0
        let result = posix_spawn(&pid, executable, &actions, &attributes, argv, envp)
        argv.forEach { free($0) }; envp.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes)
        close(toChrome[0]); close(fromChrome[1])
        guard result == 0 else { close(toChrome[1]); close(fromChrome[0]); throw JosiError(message: "Josi's browser could not start (\(result)).") }
        lock.withLock { process = pid; writer = toChrome[1]; buffer = Data() }
        let reader = fromChrome[0]
        Thread.detachNewThread { [weak self] in self?.read(reader) }
        _ = try await send("Browser.getVersion", [:])
    }
    func stop() {
        lock.lock(); let pid = process, fd = writer; process = 0; writer = -1
        let pending = waiting; waiting = [:]; lock.unlock()
        pending.values.forEach { $0.resume(throwing: JosiError(message: "Josi's browser closed.")) }
        if fd >= 0 { close(fd) }
        if pid > 0 { kill(-pid, SIGTERM); DispatchQueue.global().asyncAfter(deadline: .now() + 3) { kill(-pid, SIGKILL); var s: Int32 = 0; waitpid(pid, &s, WNOHANG) } }
    }

    // ------------------------------------------------------------ the DevTools protocol, over the pipe
    func send(_ method: String, _ params: Wire, session: String? = nil) async throws -> Wire {
        try await withCheckedThrowingContinuation { (next: CheckedContinuation<Wire, Error>) in
            lock.lock()
            guard writer >= 0 else { lock.unlock(); next.resume(throwing: JosiError(message: "Josi's browser is not running.")); return }
            let id = nextId; nextId += 1
            waiting[id] = next
            var message: [String: Wire] = ["id": .number(Double(id)), "method": .string(method), "params": params]
            if let session { message["sessionId"] = .string(session) }
            let fd = writer
            lock.unlock()
            guard var data = try? JSONEncoder().encode(Wire.object(message)) else { fail(id, "Could not encode a browser command."); return }
            data.append(0)
            let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
            if written != data.count { fail(id, "Josi's browser stopped answering.") }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30) { [weak self] in self?.fail(id, "Josi's browser did not answer in time.") }
        }
    }
    private func fail(_ id: Int, _ message: String) {
        lock.lock(); let next = waiting.removeValue(forKey: id); lock.unlock()
        next?.resume(throwing: JosiError(message: message))
    }
    private func read(_ fd: Int32) {
        var chunk = [UInt8](repeating: 0, count: 1 << 16)
        while true {
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            lock.lock(); buffer.append(contentsOf: chunk[0..<n]); var messages: [Data] = []
            while let end = buffer.firstIndex(of: 0) { messages.append(buffer[buffer.startIndex..<end]); buffer = buffer[(end + 1)...] }
            if buffer.isEmpty { buffer = Data() }
            lock.unlock()
            for data in messages {
                guard let value = try? JSONDecoder().decode(Wire.self, from: Data(data)), case .number(let raw) = value["id"] else { continue }
                lock.lock(); let next = waiting.removeValue(forKey: Int(raw)); lock.unlock()
                if value["error"] != .null { next?.resume(throwing: JosiError(message: value["error"]["message"].text)) }
                else { next?.resume(returning: value["result"]) }
            }
        }
        close(fd)
        stop()
    }

    // ------------------------------------------------------------ pages, pictures and input
    /// A session on a page tab: a new tab at `url`, or the first page tab there is.
    func page(url: String?) async throws -> String {
        try await start()
        var target = ""
        if let url { target = try await send("Target.createTarget", ["url": .string(url)])["targetId"].text }
        else {
            let targets = try await send("Target.getTargets", [:])["targetInfos"].list
            target = targets.first { $0["type"].text == "page" }?["targetId"].text ?? ""
            if target.isEmpty { target = try await send("Target.createTarget", ["url": "about:blank"])["targetId"].text }
        }
        _ = try? await send("Target.activateTarget", ["targetId": .string(target)])
        let session = try await send("Target.attachToTarget", ["targetId": .string(target), "flatten": .bool(true)])["sessionId"].text
        _ = try await send("Emulation.setDeviceMetricsOverride", ["width": .number(Double(Self.width)), "height": .number(Double(Self.height)),
                                                                  "deviceScaleFactor": .number(1), "mobile": .bool(false)], session: session)
        _ = try? await send("Page.enable", [:], session: session)
        return session
    }
    /// A JPEG of the page, at most 1280 wide, quality 60.
    func frame(_ session: String) async throws -> Data {
        let shot = try await send("Page.captureScreenshot", ["format": "jpeg", "quality": .number(60)], session: session)
        guard let data = Data(base64Encoded: shot["data"].text) else { throw JosiError(message: "No picture from Josi's browser.") }
        return data
    }
    /// One event from the live view, in the coordinates of the picture the person saw.
    func input(_ event: Wire, session: String) async throws {
        let x = Self.number(event["x"]), y = Self.number(event["y"])
        switch event["t"].text {
        case "move":
            _ = try await send("Input.dispatchMouseEvent", ["type": "mouseMoved", "x": .number(x), "y": .number(y)], session: session)
        case "click":
            let button = event["button"].integer == 3 ? "right" : event["button"].integer == 2 ? "middle" : "left"
            let count = max(1, min(2, event["count"].integer == 0 ? 1 : event["count"].integer))
            _ = try await send("Input.dispatchMouseEvent", ["type": "mouseMoved", "x": .number(x), "y": .number(y)], session: session)
            for type in ["mousePressed", "mouseReleased"] {
                _ = try await send("Input.dispatchMouseEvent", ["type": .string(type), "x": .number(x), "y": .number(y), "button": .string(button),
                                                                "clickCount": .number(Double(count))], session: session)
            }
        case "scroll":
            let dy = max(-20, min(20, Self.number(event["dy"])))
            _ = try await send("Input.dispatchMouseEvent", ["type": "mouseWheel", "x": .number(x), "y": .number(y), "deltaX": .number(0), "deltaY": .number(dy * 100)], session: session)
        case "text":
            let text = String(event["text"].text.prefix(2000))
            if !text.isEmpty { _ = try await send("Input.insertText", ["text": .string(text)], session: session) }
        case "key":
            try await key(event["key"].text, session: session)
        default: break
        }
    }
    private static let keys: [String: (key: String, code: String, keyCode: Int, text: String?)] = [
        "return": ("Enter", "Enter", 13, "\r"), "enter": ("Enter", "Enter", 13, "\r"), "tab": ("Tab", "Tab", 9, nil),
        "backspace": ("Backspace", "Backspace", 8, nil), "escape": ("Escape", "Escape", 27, nil), "delete": ("Delete", "Delete", 46, nil),
        "left": ("ArrowLeft", "ArrowLeft", 37, nil), "right": ("ArrowRight", "ArrowRight", 39, nil), "up": ("ArrowUp", "ArrowUp", 38, nil),
        "down": ("ArrowDown", "ArrowDown", 40, nil), "home": ("Home", "Home", 36, nil), "end": ("End", "End", 35, nil),
        "page_up": ("PageUp", "PageUp", 33, nil), "page_down": ("PageDown", "PageDown", 34, nil), "space": (" ", "Space", 32, " ")]
    /// xdotool-style names (Return, Tab, BackSpace, ctrl+a). On a Mac the editing
    /// shortcuts are Command shortcuts, so ctrl+a/c/v/x/z become those commands.
    private func key(_ name: String, session: String) async throws {
        let parts = name.lowercased().split(separator: "+").map(String.init)
        guard let last = parts.last else { return }
        var modifiers = 0
        for part in parts.dropLast() {
            switch part { case "alt": modifiers |= 1; case "ctrl", "control": modifiers |= 4; case "super", "meta", "cmd": modifiers |= 4; case "shift": modifiers |= 8; default: break }
        }
        let commands = ["a": "selectAll", "c": "copy", "v": "paste", "x": "cut", "z": "undo"]
        if modifiers & 4 != 0, let command = commands[last] {
            for type in ["rawKeyDown", "keyUp"] {
                _ = try await send("Input.dispatchKeyEvent", ["type": .string(type), "key": .string(last), "code": .string("Key" + last.uppercased()),
                                                              "modifiers": .number(Double(modifiers)), "commands": type == "rawKeyDown" ? .array([.string(command)]) : .array([])], session: session)
            }
            return
        }
        guard let known = Self.keys[last] ?? (last.count == 1 ? (last, "Key" + last.uppercased(), Int(last.uppercased().unicodeScalars.first!.value), last) : nil) else { return }
        var down: [String: Wire] = ["type": .string(known.text == nil || modifiers != 0 ? "rawKeyDown" : "keyDown"), "key": .string(known.key), "code": .string(known.code),
                                    "windowsVirtualKeyCode": .number(Double(known.keyCode)), "modifiers": .number(Double(modifiers))]
        if let text = known.text, modifiers == 0 { down["text"] = .string(text) }
        _ = try await send("Input.dispatchKeyEvent", .object(down), session: session)
        _ = try await send("Input.dispatchKeyEvent", ["type": "keyUp", "key": .string(known.key), "code": .string(known.code),
                                                      "windowsVirtualKeyCode": .number(Double(known.keyCode)), "modifiers": .number(Double(modifiers))], session: session)
    }
    private static func number(_ value: Wire) -> Double { if case .number(let n) = value { return n }; return 0 }
}
