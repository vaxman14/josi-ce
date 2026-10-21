import AppKit
import CryptoKit
import Compression
import Darwin
import Security
import ServiceManagement

struct GuestBrowserProfileCandidate: Encodable, Equatable {
    let schemaVersion = "2", kind = "browser"
    let candidateId: String, guestBootId: String, label: String, family: String
    let applicationId: String
    let installationRevision = 1
    let nativeProfileId: String, profilePath: String?
    let extensionId: String, extensionVersion: String, extensionDigest: String
    let distribution: String
    private enum CodingKeys: String, CodingKey {
        case schemaVersion, kind, candidateId, guestBootId, label, family, applicationId, installationRevision
        case nativeProfileId, profilePath, extensionId, extensionVersion, extensionDigest, distribution
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.container(keyedBy: CodingKeys.self)
        try value.encode(schemaVersion, forKey: .schemaVersion); try value.encode(kind, forKey: .kind)
        try value.encode(candidateId, forKey: .candidateId); try value.encode(guestBootId, forKey: .guestBootId)
        try value.encode(label, forKey: .label); try value.encode(family, forKey: .family)
        try value.encode(applicationId, forKey: .applicationId); try value.encode(installationRevision, forKey: .installationRevision)
        try value.encode(nativeProfileId, forKey: .nativeProfileId)
        if let profilePath { try value.encode(profilePath, forKey: .profilePath) }
        else { try value.encodeNil(forKey: .profilePath) }
        try value.encode(extensionId, forKey: .extensionId); try value.encode(extensionVersion, forKey: .extensionVersion)
        try value.encode(extensionDigest, forKey: .extensionDigest); try value.encode(distribution, forKey: .distribution)
    }
}

/// User-operated guest setup. Local profile hints contain no permission or
/// credential, and cannot replace the server's canonical Vault registration.
@MainActor enum GuestBrowserProfiles {
    static let families = ["com.google.Chrome": "chrome", "com.brave.Browser": "brave", "org.mozilla.firefox": "firefox",
                           "com.apple.Safari": "safari"]
    struct Prepared {
        let candidate: GuestBrowserProfileCandidate
        let application: GuestPinnedApplication
        let extensionFolder: URL
    }
    private static var bridgeService: SMAppService { .agent(plistName: "com.heyjosi.ce.browser.plist") }
    static var bridgeEnabled: Bool { bridgeService.status == .enabled }
    static func enableBridge(_ prepared: Prepared) throws -> Bool {
        try GuestEnvironment.signedApplication()
        guard try GuestEnvironment.identity().guest == prepared.candidate.guestBootId,
              families[prepared.application.bundleId] == prepared.candidate.family else { throw GuestLinkError.invalid }
        let family = prepared.candidate.family
        if family == "safari" { return try enableSafariDiscovery(prepared.application) }
        let file = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/NativeMessagingHosts/" + family + ".json")
        let body = try readFile(file, maximum: 4096)
        let value = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        guard value?["name"] as? String == "com.heyjosi.browser", value?["type"] as? String == "stdio",
              value?["path"] as? String == "/Applications/Josi.app/Contents/Helpers/JosiBrowserHost",
              family == "firefox"
                ? value?["allowed_extensions"] as? [String] == [prepared.candidate.extensionId]
                : value?["allowed_origins"] as? [String] == ["chrome-extension://" + prepared.candidate.extensionId + "/"],
              let password = getpwuid(geteuid()), let rawHome = password.pointee.pw_dir else { throw GuestLinkError.invalid }
        let home = URL(fileURLWithPath: String(cString: rawHome), isDirectory: true)
        guard home.path.hasPrefix("/Users/"), home.path == home.resolvingSymlinksInPath().standardizedFileURL.path else { throw GuestLinkError.invalid }
        let vendor = family == "chrome" ? ["Google", "Chrome"]
            : family == "brave" ? ["BraveSoftware", "Brave-Browser"] : ["Mozilla"]
        let parts = ["Library", "Application Support"] + vendor + ["NativeMessagingHosts"]
        var fd = Darwin.open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw GuestLinkError.unavailable }
        defer { Darwin.close(fd) }
        for (index, part) in parts.enumerated() {
            let next = try directory(parent: fd, name: part, create: index >= 2, privateDirectory: false)
            Darwin.close(fd); fd = next
        }
        let name = "com.heyjosi.browser.json"
        let existing = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if existing >= 0 {
            defer { Darwin.close(existing) }
            guard try readDescriptor(existing, maximum: 4096, privateFile: true) == body else { throw GuestLinkError.invalid }
        } else {
            guard errno == ENOENT else { throw GuestLinkError.invalid }
            let output = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard output >= 0 else { throw GuestLinkError.unavailable }
            defer { Darwin.close(output) }
            guard body.withUnsafeBytes({ Darwin.write(output, $0.baseAddress, $0.count) }) == body.count,
                  fsync(output) == 0, fsync(fd) == 0 else { throw GuestLinkError.unavailable }
        }
        if bridgeService.status != .enabled && bridgeService.status != .requiresApproval { try bridgeService.register() }
        return bridgeService.status == .enabled
    }
    static func disableBridge() async throws {
        try GuestEnvironment.signedApplication()
        _ = try GuestEnvironment.identity()
        if bridgeService.status != .notRegistered { try await bridgeService.unregister() }
    }
    static func bridgeSettings() {
        guard (try? GuestEnvironment.identity()) != nil else { return }
        SMAppService.openSystemSettingsLoginItems()
    }
    private struct FileEntry: Decodable { let path: String, size: Int, sha256: String }
    private struct ExtensionEntry: Decodable {
        let family: String, extensionId: String, version: String, digest: String
        let files: [FileEntry]
    }
    private struct Catalog: Decodable {
        let schemaVersion: Int, distribution: String, extensions: [ExtensionEntry]
    }
    static func prepare(_ pin: GuestPinnedApplication, profile: String) throws -> Prepared {
        try GuestEnvironment.signedApplication()
        let boot = try GuestEnvironment.identity()
        guard let family = families[pin.bundleId], pin.installationRevision == 1,
              UUID(uuidString: profile)?.uuidString.lowercased() == profile else { throw GuestLinkError.invalid }
        try verifyApplication(pin)
        let (entry, folder) = try extensionResources(family)
        let value = GuestBrowserProfileCandidate(candidateId: UUID().uuidString.lowercased(), guestBootId: boot.guest,
            label: family.capitalized + " · Attached browser", family: family,
            applicationId: pin.applicationId.uuidString.lowercased(), nativeProfileId: profile, profilePath: nil,
            extensionId: entry.extensionId, extensionVersion: entry.version, extensionDigest: entry.digest,
            distribution: "unpacked-development")
        return Prepared(candidate: value, application: pin, extensionFolder: folder)
    }
    static func enableSafariDiscovery(_ pin: GuestPinnedApplication) throws -> Bool {
        try GuestEnvironment.signedApplication()
        _ = try GuestEnvironment.identity()
        guard pin.bundleId == "com.apple.Safari", pin.installationRevision == 1 else { throw GuestLinkError.invalid }
        try verifyApplication(pin)
        _ = try extensionResources("safari")
        if bridgeService.status != .enabled && bridgeService.status != .requiresApproval { try bridgeService.register() }
        return bridgeService.status == .enabled
    }
    static func prepareSafari(_ pin: GuestPinnedApplication, profile: String) throws -> Prepared {
        try prepare(pin, profile: profile)
    }
    static func requireInstalledExtension(_ prepared: Prepared) throws {
        // Trust is rooted in the signed native host, allowlisted extension ID,
        // running browser identity and the separately approved instance UUID.
        // Personal profile files are never opened to inspect credentials/configuration.
        try GuestEnvironment.signedApplication()
        let c = prepared.candidate
        let (entry, folder) = try extensionResources(c.family)
        guard c.profilePath == nil, entry.digest == c.extensionDigest, entry.extensionId == c.extensionId,
              entry.version == c.extensionVersion, folder == prepared.extensionFolder else { throw GuestLinkError.invalid }
    }
    private static func verifyApplication(_ pin: GuestPinnedApplication) throws {
        let url = URL(fileURLWithPath: pin.bundlePath)
        guard pin.codeHash.range(of: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", options: .regularExpression) != nil,
              url.path == url.resolvingSymlinksInPath().standardizedFileURL.path,
              Bundle(url: url)?.bundleIdentifier == pin.bundleId else { throw GuestLinkError.invalid }
        var code: SecStaticCode?, requirement: SecRequirement?, information: CFDictionary?
        let expression = "anchor apple generic and cdhash H\"\(pin.codeHash)\""
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let info = information as? [String: Any], info[kSecCodeInfoIdentifier as String] as? String == pin.signingId,
              (info[kSecCodeInfoTeamIdentifier as String] as? String ?? "") == pin.teamId else { throw GuestLinkError.invalid }
    }
    private static func extensionResources(_ family: String) throws -> (ExtensionEntry, URL) {
        let root = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/BrowserExtensions", isDirectory: true)
        let catalogURL = root.appendingPathComponent("BrowserExtensionCatalog.json")
        let bytes = try readFile(catalogURL, maximum: 65536)
        let catalog = try JSONDecoder().decode(Catalog.self, from: bytes)
        let entries = catalog.extensions.filter { $0.family == family }
        guard catalog.schemaVersion == 1, catalog.distribution == "unpacked-development", entries.count == 1 else { throw GuestLinkError.invalid }
        let entry = entries[0]
        let folder = family == "safari"
            ? Bundle.main.bundleURL.appendingPathComponent("Contents/PlugIns/Josi Workspace.appex/Contents/Resources", isDirectory: true)
            : root.appendingPathComponent(family, isDirectory: true)
        guard !entry.files.isEmpty, entry.files.count <= 64,
              Set(entry.files.map(\.path)).count == entry.files.count else { throw GuestLinkError.invalid }
        var fingerprint = ""
        for item in entry.files.sorted(by: { $0.path < $1.path }) {
            guard !item.path.isEmpty, !item.path.hasPrefix("/"),
                  item.path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                  item.path.utf8.allSatisfy({ $0 >= 32 && $0 < 127 && $0 != 92 }), (0...1048576).contains(item.size) else { throw GuestLinkError.invalid }
            let file = folder.appendingPathComponent(item.path), body = try readFile(file, maximum: 1048576)
            guard body.count == item.size else { throw GuestLinkError.invalid }
            let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
            guard hash == item.sha256 else { throw GuestLinkError.invalid }
            fingerprint += item.path + "\0" + hash + "\n"
        }
        let digest = SHA256.hash(data: Data(fingerprint.utf8)).map { String(format: "%02x", $0) }.joined()
        guard digest == entry.digest else { throw GuestLinkError.invalid }
        // Reject additions as well as modifications; no unlisted code can be
        // loaded through a resource folder accepted by this setup flow.
        guard let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey]) else { throw GuestLinkError.invalid }
        var seen = Set<String>()
        for case let file as URL in walker {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw GuestLinkError.invalid }
            if values.isRegularFile == true { seen.insert(String(file.path.dropFirst(folder.path.count + 1))) }
            else if values.isDirectory != true { throw GuestLinkError.invalid }
            guard seen.count <= 64 else { throw GuestLinkError.invalid }
        }
        guard seen == Set(entry.files.map(\.path)) else { throw GuestLinkError.invalid }
        return (entry, folder)
    }
    private static func readFile(_ url: URL, maximum: Int) throws -> Data {
        guard url.path == url.resolvingSymlinksInPath().standardizedFileURL.path else { throw GuestLinkError.invalid }
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw GuestLinkError.unavailable }
        defer { Darwin.close(fd) }
        return try readDescriptor(fd, maximum: maximum, privateFile: false)
    }
    private static func readDescriptor(_ fd: Int32, maximum: Int, privateFile: Bool) throws -> Data {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0, info.st_size <= maximum,
              !privateFile || info.st_uid == geteuid() && info.st_mode & 0o077 == 0 && info.st_nlink == 1 else { throw GuestLinkError.invalid }
        var body = Data(count: Int(info.st_size) + 1)
        let count = body.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count == info.st_size else { throw GuestLinkError.invalid }
        body.count = count
        return body
    }
    private static func directory(parent: Int32, name: String, create: Bool, privateDirectory: Bool) throws -> Int32 {
        if create && mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { throw GuestLinkError.unavailable }
        let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        var info = stat()
        guard fd >= 0, fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(),
              !privateDirectory || info.st_mode & 0o077 == 0 else {
            if fd >= 0 { Darwin.close(fd) }
            throw GuestLinkError.invalid
        }
        return fd
    }
}
