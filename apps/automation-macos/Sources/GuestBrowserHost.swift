import AppKit
import Foundation
import Security
import Darwin

/// Browser-spawned stdio entry point. It cannot launch apps, select a profile,
/// discover a server address, grant authority or interpret page instructions.
@main enum JosiGuestBrowserHost {
    private static let helper = "/Applications/Josi.app/Contents/Helpers/JosiBrowserHost"
    private static let identifier = "com.heyjosi.ce.browser-host"
    private static let configuration = "/Applications/Josi.app/Contents/Resources/BrowserDistribution.json"
    static func main() {
        do {
            signal(SIGPIPE, SIG_IGN)
            guard fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK) == 0,
                  fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK) == 0 else { throw GuestBrowserError.unavailable }
            try GuestBrowserBoundary.requireSelf(identifier: identifier, executable: helper)
            let client = GuestBrowserClient(), parent = getppid()
            let original = try peer(parent: parent)
            var seen = Set<String>()
            var profile: String?
            for _ in 0..<16384 {
                let header = try readExactly(4)
                let count = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << UInt32(8 * $1.offset) }
                guard count > 0, count <= GuestBrowserBoundary.maximumBytes else { throw GuestBrowserError.invalid }
                let data = try readExactly(Int(count)), request = try GuestBrowserBoundary.request(data)
                guard getppid() == parent, try peer(parent: parent) == original,
                      let id = request["requestId"] as? String, !seen.contains(id) else { throw GuestBrowserError.invalid }
                seen.insert(id)
                let completion = BlockingReply()
                if request["operation"] as? String == "browser.hello" {
                    guard profile == nil, let payload = request["payload"] as? [String: Any],
                          let id = payload["nativeProfileId"] as? String,
                          UUID(uuidString: id)?.uuidString.lowercased() == id else { throw GuestBrowserError.invalid }
                    profile = id
                }
                guard let profile, var bound = try JSONSerialization.jsonObject(with: original) as? [String: Any] else { throw GuestBrowserError.invalid }
                bound["profileId"] = profile
                let peerData = try JSONSerialization.data(withJSONObject: bound, options: [.sortedKeys, .withoutEscapingSlashes])
                client.exchange(data, peer: peerData) { completion.finish($0) }
                let response = try completion.wait()
                var length = UInt32(response.count).littleEndian
                try withUnsafeBytes(of: &length) { try writeAll(Data($0)) }
                try writeAll(response)
            }
        } catch {
            // No raw request, page content, process arguments or error body in
            // stdout/stderr. EOF makes the extension stop its current session.
        }
    }
    private static func readExactly(_ length: Int) throws -> Data {
        var data = Data(count: length), offset = 0
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        while offset < length {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw GuestBrowserError.expired }
            var readable = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let result = poll(&readable, 1, 100)
            if result == 0 || result < 0 && errno == EINTR { continue }
            guard result > 0, readable.revents & Int16(POLLERR | POLLNVAL) == 0 else { throw GuestBrowserError.unavailable }
            let count = data.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress!.advanced(by: offset), length - offset) }
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count > 0 else { throw GuestBrowserError.unavailable }
            offset += count
        }
        return data
    }
    private static func writeAll(_ data: Data) throws {
        var offset = 0
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        while offset < data.count {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw GuestBrowserError.expired }
            var writable = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
            let result = poll(&writable, 1, 100)
            if result == 0 || result < 0 && errno == EINTR { continue }
            guard result > 0, writable.revents & Int16(POLLERR | POLLNVAL | POLLHUP) == 0 else { throw GuestBrowserError.unavailable }
            let count = data.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress!.advanced(by: offset), data.count - offset) }
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count > 0 else { throw GuestBrowserError.unavailable }
            offset += count
        }
    }
    private static func peer(parent: pid_t) throws -> Data {
        let boot = try GuestBrowserBoundary.isolatedBoot()
        guard parent > 1, let app = NSRunningApplication(processIdentifier: parent),
              !app.isTerminated, let bundle = app.bundleIdentifier, let launched = app.launchDate,
              let path = app.bundleURL?.resolvingSymlinksInPath().path else { throw GuestBrowserError.unavailable }
        let family: String
        switch bundle {
        case "com.google.Chrome": family = "chrome"
        case "com.brave.Browser": family = "brave"
        case "org.mozilla.firefox": family = "firefox"
        default: throw GuestBrowserError.unavailable
        }
        var code: SecCode?, requirement: SecRequirement?, information: CFDictionary?, source: SecStaticCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: parent] as CFDictionary, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString("anchor apple generic" as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &source) == errSecSuccess, let source,
              SecCodeCopySigningInformation(source, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let info = information as? [String: Any], let hash = info[kSecCodeInfoUnique as String] as? Data,
              [20, 32].contains(hash.count), let signing = info[kSecCodeInfoIdentifier as String] as? String,
              let team = info[kSecCodeInfoTeamIdentifier as String] as? String else { throw GuestBrowserError.unavailable }
        let configData = try Data(contentsOf: URL(fileURLWithPath: configuration))
        guard configData.count <= 4096, let config = try JSONSerialization.jsonObject(with: configData) as? [String: String],
              let extensionId = config[family], !extensionId.isEmpty, extensionId.utf8.count <= 128 else { throw GuestBrowserError.invalid }
        let own = CommandLine.arguments
        if family == "firefox" {
            guard own.count == 3, own[2] == extensionId else { throw GuestBrowserError.invalid }
        } else {
            guard own.count == 2, own[1] == "chrome-extension://\(extensionId)/" else { throw GuestBrowserError.invalid }
        }
        return try JSONSerialization.data(withJSONObject: [
            "kind": "browser-process", "family": family, "extensionId": extensionId,
            "guestBootId": boot.guest, "hostBootId": boot.host,
            "profilePath": NSNull(), "processId": parent, "launchedAtMs": Int64(launched.timeIntervalSince1970 * 1000),
            "bundleId": bundle, "bundlePath": path, "signingId": signing, "teamId": team,
            "codeHash": hash.map { String(format: "%02x", $0) }.joined(),
        ], options: [.sortedKeys, .withoutEscapingSlashes])
    }
}

private final class BlockingReply: @unchecked Sendable {
    private let lock = NSLock(), semaphore = DispatchSemaphore(value: 0)
    private var response: Data?
    func finish(_ value: Data?) { lock.lock(); response = value; lock.unlock(); semaphore.signal() }
    func wait() throws -> Data {
        guard semaphore.wait(timeout: .now() + 5) == .success else { throw GuestBrowserError.expired }
        lock.lock(); defer { lock.unlock() }
        guard let response else { throw GuestBrowserError.unavailable }
        return response
    }
}
