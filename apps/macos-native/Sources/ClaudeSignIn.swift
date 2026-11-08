import Darwin
import Foundation
import Security

/// Anthropic's official Claude Code program, bundled inside Josi.app with the
/// server runtime (scripts/macos/bundle-subscription-cli.py). Only a copy
/// signed by Anthropic's Developer ID is ever run.
enum ClaudeCLI {
    static let requirement = #"anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW""#

    /// The verified program, or nil when this Mac has none. A copy that is
    /// present but not signed by Anthropic is an error, never a fallback.
    static func locate() throws -> URL? {
        var candidates: [URL] = []
        #if DEBUG
        if let path = ProcessInfo.processInfo.environment["JOSI_CLAUDE_EXE"] { candidates.append(URL(fileURLWithPath: path)) }
        #endif
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("runtime/subscription-cli/claude/claude"))
        }
        for candidate in candidates {
            let url = candidate.resolvingSymlinksInPath()
            guard FileManager.default.isExecutableFile(atPath: url.path) else { continue }
            guard signedByAnthropic(url) else {
                throw JosiError(message: "The Claude Code program at \(url.path) is not signed by Anthropic.")
            }
            return url
        }
        return nil
    }

    private static func signedByAnthropic(_ url: URL) -> Bool {
        var code: SecStaticCode?, rule: SecRequirement?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(requirement as CFString, [], &rule) == errSecSuccess, let rule else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), rule) == errSecSuccess
    }
}

/// One `claude setup-token` sign-in, run privately in a pseudo-terminal with a
/// throwaway profile. Josi opens Anthropic's page itself, passes back the code
/// the person copies from it, and receives the long-lived subscription token,
/// which goes only to the server's Vault. The token is never shown or saved here.
@MainActor final class ClaudeSetupToken {
    /// The token ends at the first character that can't be part of it, or where
    /// Claude Code's next words ("Store this token…") begin without a space.
    private static let tokenPattern = /sk-ant-oat01-[A-Za-z0-9_\-]{40,}?(?=Store|[^A-Za-z0-9_\-]|$)/
    private let process = Process()
    private let master: FileHandle
    private let profile: URL
    private var raw = ""
    private var finished = false
    private var pageWaiters: [CheckedContinuation<URL, Error>] = []
    private var resultWaiters: [CheckedContinuation<String, Error>] = []
    private var page: URL?
    private var outcome: Result<String, Error>?
    private var submittedAt = 0

    init(executable: URL) throws {
        profile = FileManager.default.temporaryDirectory.appendingPathComponent("josi-claude-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var primary: Int32 = -1, secondary: Int32 = -1
        // Wide enough that the page link and the token never wrap.
        var size = winsize(ws_row: 60, ws_col: 400, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&primary, &secondary, nil, nil, &size) == 0 else {
            try? FileManager.default.removeItem(at: profile)
            throw JosiError(message: "Claude’s sign-in could not start on this Mac.")
        }
        master = FileHandle(fileDescriptor: primary, closeOnDealloc: true)
        let terminal = FileHandle(fileDescriptor: secondary, closeOnDealloc: true)
        process.executableURL = executable
        process.arguments = ["setup-token"]
        process.currentDirectoryURL = profile
        // A throwaway profile: no personal Claude settings, logins or history are
        // read or written. BROWSER=none: Josi opens the checked page itself.
        process.environment = [
            "PATH": "/usr/bin:/bin", "HOME": profile.path, "CLAUDE_CONFIG_DIR": profile.path, "TMPDIR": profile.path,
            "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "BROWSER": "none", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        ]
        process.standardInput = terminal; process.standardOutput = terminal; process.standardError = terminal
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.exited() } }
        master.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in self?.receive(text) }
        }
        do { try process.run() } catch {
            master.readabilityHandler = nil
            try? FileManager.default.removeItem(at: profile)
            throw JosiError(message: "Claude’s sign-in could not start: \(error.localizedDescription)")
        }
        try? terminal.close()
    }

    /// Anthropic's sign-in page, once Claude Code shows it.
    func signInPage() async throws -> URL {
        if let page { return page }
        if case .failure(let error) = outcome { throw error }
        return try await withCheckedThrowingContinuation { pageWaiters.append($0) }
    }

    /// The subscription token, or Claude Code's own reason it stopped.
    func result() async throws -> String {
        if let outcome { return try outcome.get() }
        return try await withCheckedThrowingContinuation { resultWaiters.append($0) }
    }

    /// Sends the code from Anthropic's page. Claude Code reads a burst of input as
    /// a paste, so Enter follows separately; with bracketed paste on, it is marked.
    func submit(code: String) async throws {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 2048, !value.contains(where: { $0.isNewline || $0.asciiValue.map { $0 < 32 } == true }) else {
            throw JosiError(message: "Paste the code shown on Claude’s page.")
        }
        let on = raw.range(of: "\u{1b}[?2004h", options: .backwards)?.lowerBound
        let off = raw.range(of: "\u{1b}[?2004l", options: .backwards)?.lowerBound
        let bracketed = on != nil && (off == nil || on! > off!)
        submittedAt = raw.count
        master.write(Data((bracketed ? "\u{1b}[200~" + value + "\u{1b}[201~" : value).utf8))
        try await Task.sleep(for: .milliseconds(700))
        master.write(Data("\r".utf8))
    }

    /// What Claude Code showed since the code was sent, without any token.
    func replySinceSubmit() -> String {
        let start = raw.index(raw.startIndex, offsetBy: min(submittedAt, raw.count))
        return Self.lastLines(Self.screen(String(raw[start...])))
    }

    var isFinished: Bool { finished }

    /// Stops the sign-in. `onlyBeforePage` limits it to one still waiting for
    /// Anthropic's page, for the start-up time limit.
    func cancel(reason: String = "Claude’s sign-in was cancelled.", onlyBeforePage: Bool = false) {
        guard !finished, !(onlyBeforePage && page != nil) else { return }
        fail(JosiError(message: reason))
    }

    private func receive(_ text: String) {
        guard !finished else { return }
        raw += text
        if raw.count > 256 * 1024 { raw = String(raw.suffix(128 * 1024)); submittedAt = 0 }
        if page == nil, let url = Self.anthropicPage(in: raw) {
            page = url
            pageWaiters.forEach { $0.resume(returning: url) }; pageWaiters = []
        }
        // Done once the line after the token is drawn, so the token is whole.
        if let token = Self.token(in: raw, requireNextLine: true) { finish(.success(token)) }
    }

    /// The token on Claude Code's screen. Spacing is kept, so the token can't run
    /// into the words after it.
    private static func token(in text: String, requireNextLine: Bool) -> String? {
        let shown = screen(text)
        guard let found = shown.firstMatch(of: tokenPattern) else { return nil }
        if requireNextLine && !shown[found.range.upperBound...].filter({ !$0.isWhitespace }).contains("Storethistoken") { return nil }
        return String(found.output)
    }

    private func exited() {
        guard !finished else { return }
        // Claude Code exits right after printing the token: take it if it's there.
        if let token = Self.token(in: raw, requireNextLine: false) { finish(.success(token)); return }
        let reason = Self.lastLines(Self.screen(raw))
        fail(JosiError(message: reason.isEmpty
            ? "Claude Code stopped before it issued a token. Start the sign-in again."
            : "Claude Code stopped before it issued a token: " + reason))
    }

    private func fail(_ error: Error) { finish(.failure(error)) }

    private func finish(_ result: Result<String, Error>) {
        guard !finished else { return }
        finished = true; outcome = result
        master.readabilityHandler = nil
        if process.isRunning { process.terminate() }
        raw = ""
        try? FileManager.default.removeItem(at: profile)
        let error: Error
        switch result {
        case .success: error = JosiError(message: "Claude Code did not show a sign-in page.")
        case .failure(let failure): error = failure
        }
        pageWaiters.forEach { $0.resume(throwing: error) }; pageWaiters = []
        resultWaiters.forEach { $0.resume(with: result) }; resultWaiters = []
    }

    /// The first https link to Anthropic's own sign-in page, from the terminal
    /// hyperlink Claude Code draws, or from its plain text.
    private static func anthropicPage(in text: String) -> URL? {
        let links = text.matches(of: /\u{1b}\]8;[^;\u{07}\u{1b}]*;(https:\/\/[^\u{07}\u{1b}\s]+)/).map { String($0.output.1) }
            + screen(text).matches(of: /https:\/\/[^\s\u{1b}]+/).map { String($0.output) }
        for link in links {
            guard let url = URL(string: link), url.scheme == "https", url.port == nil, url.user == nil, url.password == nil,
                  let host = url.host?.lowercased(), url.path.contains("oauth") else { continue }
            if ["claude.com", "claude.ai", "anthropic.com"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return url }
        }
        return nil
    }

    /// Terminal output as plain text: cursor moves right become spaces, other
    /// control sequences are dropped.
    private static func screen(_ text: String) -> String {
        var plain = text.replacing(/\u{1b}\[(\d*)C/) { String(repeating: " ", count: max(1, Int($0.output.1) ?? 1)) }
        // A move along the line separates words; a move to another line breaks it.
        plain = plain.replacing(/\u{1b}\[\d*G/, with: " ")
        plain = plain.replacing(/\u{1b}\[[0-9;]*[ABEFHfd]/, with: "\n")
        plain = plain.replacing(/\u{1b}\][^\u{07}\u{1b}]*(\u{07}|\u{1b}\\)/, with: "")
        plain = plain.replacing(/\u{1b}\[[0-9;?<>=]*[ -\/]*[@-~]/, with: "")
        plain = plain.replacing(/\u{1b}[()][0-9A-Za-z]|\u{1b}[=>78]/, with: "")
        return plain.replacingOccurrences(of: "\r", with: "\n")
    }

    private static func lastLines(_ text: String) -> String {
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0.firstMatch(of: tokenPattern) == nil && $0.count > 3 }
        return lines.suffix(3).map { String($0.prefix(200)) }.joined(separator: " ")
    }
}
