import Foundation
import Security
import Darwin

enum GuestChromeInstall {
    static let destination = "/Applications/Google Chrome.app"
    private static let source = "/Volumes/Josi Support/Google Chrome.app"
    static var available: Bool {
        FileManager.default.fileExists(atPath: source) && !FileManager.default.fileExists(atPath: destination)
    }
    private static func verify(_ path: String) throws {
        var code: SecStaticCode?, requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"com.google.Chrome\" and certificate leaf[subject.OU] = \"EQHXZ8M8AV\""
        guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode), requirement) == errSecSuccess
        else { throw GuestLinkError.invalid }
    }
    /// Explicit guest setup button only. Never called by a model command.
    static func install() async throws {
        try GuestEnvironment.signedApplication()
        _ = try GuestEnvironment.identity()
        try await Task.detached(priority: .userInitiated) {
            var volume = statfs()
            guard available, URL(fileURLWithPath: source).resolvingSymlinksInPath().path == source,
                  statfs(source, &volume) == 0, volume.f_flags & UInt32(MNT_RDONLY) != 0 else { throw GuestLinkError.invalid }
            try verify(source)
            let staging = "/Applications/.JosiChromeInstall-" + UUID().uuidString.lowercased()
            guard mkdir(staging, 0o700) == 0 else { throw GuestLinkError.unavailable }
            defer { try? FileManager.default.removeItem(atPath: staging) }
            let candidate = staging + "/Google Chrome.app"
            try FileManager.default.copyItem(atPath: source, toPath: candidate)
            try verify(candidate)
            // Move refuses an existing destination; an installed application
            // or personal profile is never replaced.
            try FileManager.default.moveItem(atPath: candidate, toPath: destination)
        }.value
    }
}
