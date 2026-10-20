import AppKit
import CryptoKit
import Compression
import Darwin
import Security
import ServiceManagement

struct GuestBrowserProfileCandidate: Encodable, Equatable {
    let schemaVersion = "1", kind = "browser"
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
    private static var bridgeService: SMAppService { .agent(plistName: "com.heyjosi.ce.guestbrowser.plist") }
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
        guard value?["name"] as? String == "com.heyjosi.workspace", value?["type"] as? String == "stdio",
              value?["path"] as? String == "/Applications/Josi Companion.app/Contents/Helpers/JosiBrowserHost",
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
        let name = "com.heyjosi.workspace.json"
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
    private struct ProfileHint: Codable {
        let schemaVersion: Int, family: String, workspaceId: String, nativeProfileId: String
    }
    static func prepare(_ pin: GuestPinnedApplication) throws -> Prepared {
        try GuestEnvironment.signedApplication()
        let boot = try GuestEnvironment.identity()
        guard let family = families[pin.bundleId], family != "safari", pin.installationRevision == 1 else { throw GuestLinkError.invalid }
        try verifyApplication(pin)
        let (entry, folder) = try extensionResources(family)
        let workspace = pin.workspaceId.uuidString.lowercased()
        let (nativeId, path) = try profile(workspace: workspace, family: family)
        let value = GuestBrowserProfileCandidate(candidateId: UUID().uuidString.lowercased(), guestBootId: boot.guest,
            label: family.capitalized + " · Josi workspace", family: family,
            applicationId: pin.applicationId.uuidString.lowercased(), nativeProfileId: nativeId, profilePath: path,
            extensionId: entry.extensionId, extensionVersion: entry.version, extensionDigest: entry.digest,
            distribution: family == "firefox" ? "store-signed" : "unpacked-development")
        guard try JSONEncoder().encode(value).count <= 3000 else { throw GuestLinkError.invalid }
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
    /// The caller obtains this UUID only from the signed Safari native handler's
    /// SFExtensionProfileKey. No text field or page-selected profile is accepted.
    static func prepareSafari(_ pin: GuestPinnedApplication, profile: String) throws -> Prepared {
        try GuestEnvironment.signedApplication()
        let boot = try GuestEnvironment.identity()
        guard pin.bundleId == "com.apple.Safari", pin.installationRevision == 1,
              UUID(uuidString: profile)?.uuidString.lowercased() == profile else { throw GuestLinkError.invalid }
        try verifyApplication(pin)
        let (entry, folder) = try extensionResources("safari")
        let value = GuestBrowserProfileCandidate(candidateId: UUID().uuidString.lowercased(), guestBootId: boot.guest,
            label: "Safari · Josi workspace", family: "safari", applicationId: pin.applicationId.uuidString.lowercased(),
            nativeProfileId: profile, profilePath: nil, extensionId: entry.extensionId,
            extensionVersion: entry.version, extensionDigest: entry.digest, distribution: "unpacked-development")
        return Prepared(candidate: value, application: pin, extensionFolder: folder)
    }
    static func open(_ prepared: Prepared) async throws {
        try GuestEnvironment.signedApplication()
        let boot = try GuestEnvironment.identity()
        let c = prepared.candidate, pin = prepared.application
        guard boot.guest == c.guestBootId, families[pin.bundleId] == c.family else { throw GuestLinkError.invalid }
        try verifyApplication(pin)
        let (entry, folder) = try extensionResources(c.family)
        let (id, path) = try profile(workspace: pin.workspaceId.uuidString.lowercased(), family: c.family)
        guard id == c.nativeProfileId, path == c.profilePath, entry.digest == c.extensionDigest,
              folder == prepared.extensionFolder else { throw GuestLinkError.invalid }
        // Never direct an already-running personal/default browser into a new
        // profile. This launch is an explicit local user gesture, not automation.
        guard NSRunningApplication.runningApplications(withBundleIdentifier: pin.bundleId).isEmpty else {
            throw GuestLinkError.unavailable
        }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.arguments = c.family == "firefox" ? ["--no-remote", "--profile", path, "about:addons"]
            : ["--user-data-dir=" + path, "--profile-directory=Default", "--no-first-run", "--no-default-browser-check",
               c.family == "brave" ? "brave://extensions" : "chrome://extensions"]
        if c.family == "chrome" {
            config.arguments.insert(contentsOf: ["--proxy-server=http://127.0.0.1:40513",
                "--proxy-bypass-list=<-loopback>", "--disable-quic"], at: 0)
        }
        let app = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: pin.bundlePath), configuration: config)
        try GuestDesktopEngine.verifyApplication(app, pin: pin)
    }
    static func requireInstalledExtension(_ prepared: Prepared) throws {
        try GuestEnvironment.signedApplication()
        let c = prepared.candidate
        if c.family == "firefox" {
            try requireFirefoxInstallation(prepared)
            return
        }
        if c.family == "safari" {
            guard c.profilePath == nil, c.distribution == "unpacked-development" else { throw GuestDesktopError.denied }
            let current = try prepareSafari(prepared.application, profile: c.nativeProfileId)
            guard current.candidate.extensionDigest == c.extensionDigest, current.candidate.extensionId == c.extensionId,
                  current.candidate.extensionVersion == c.extensionVersion, current.extensionFolder == prepared.extensionFolder
            else { throw GuestDesktopError.stale }
            return
        }
        guard ["chrome", "brave"].contains(c.family), let profile = c.profilePath,
              c.distribution == "unpacked-development" else { throw GuestDesktopError.unsupported }
        let (entry, folder) = try extensionResources(c.family)
        guard entry.digest == c.extensionDigest, entry.extensionId == c.extensionId,
              entry.version == c.extensionVersion, folder == prepared.extensionFolder else { throw GuestLinkError.invalid }
        let actual = try self.profile(workspace: prepared.application.workspaceId.uuidString.lowercased(), family: c.family)
        guard actual.0 == c.nativeProfileId, actual.1 == profile else { throw GuestLinkError.invalid }
        var found = false
        for name in ["Preferences", "Secure Preferences"] {
            let file = URL(fileURLWithPath: profile).appendingPathComponent("Default/" + name)
            var info = stat()
            if lstat(file.path, &info) != 0 {
                if errno == ENOENT { continue }
                throw GuestLinkError.invalid
            }
            guard info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw GuestLinkError.invalid }
            var bytes = try readFile(file, maximum: 16 * 1024 * 1024)
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            guard let preferences = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw GuestLinkError.invalid }
            guard let extensions = preferences["extensions"] as? [String: Any],
                  let settings = extensions["settings"] as? [String: Any],
                  let installed = settings[c.extensionId] as? [String: Any] else { continue }
            // Chromium stores unpacked paths as absolute locations. Reject a
            // copied development ID loaded from any other directory.
            guard installed["path"] as? String == folder.path,
                  let location = installed["location"] as? NSNumber, CFGetTypeID(location) != CFBooleanGetTypeID(),
                  location.intValue == 4, location.doubleValue == 4 else { throw GuestLinkError.invalid }
            if let reasons = installed["disable_reasons"] {
                guard let reasons = reasons as? [Any], reasons.isEmpty else { throw GuestLinkError.invalid }
            }
            found = true
        }
        guard found else { throw GuestLinkError.unavailable }
    }
    private static func requireFirefoxInstallation(_ prepared: Prepared) throws {
        let c = prepared.candidate
        guard c.distribution == "store-signed", let path = c.profilePath else { throw GuestDesktopError.denied }
        let actual = try profile(workspace: prepared.application.workspaceId.uuidString.lowercased(), family: "firefox")
        let (entry, folder) = try extensionResources("firefox")
        guard actual.0 == c.nativeProfileId, actual.1 == path, entry.digest == c.extensionDigest,
              entry.extensionId == c.extensionId, entry.version == c.extensionVersion, folder == prepared.extensionFolder
        else { throw GuestDesktopError.stale }
        let root = URL(fileURLWithPath: path, isDirectory: true)
        var bytes = try readFile(root.appendingPathComponent("extensions.json"), maximum: 16 * 1024 * 1024)
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard let database = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let addons = database["addons"] as? [[String: Any]], addons.count <= 1024 else { throw GuestLinkError.invalid }
        let matches = addons.filter { $0["id"] as? String == c.extensionId }
        let archive = root.appendingPathComponent("extensions/" + c.extensionId + ".xpi")
        guard matches.count == 1 else { throw GuestDesktopError.denied }
        let installed = matches[0]
        guard installed["location"] as? String == "app-profile", installed["path"] as? String == archive.path,
              installed["version"] as? String == c.extensionVersion, installed["type"] as? String == "extension",
              installed["active"] as? Bool == true, installed["visible"] as? Bool == true,
              ["userDisabled", "appDisabled", "softDisabled", "pendingUninstall"].allSatisfy({ installed[$0] as? Bool == false }),
              installed["embedderDisabled"] == nil || installed["embedderDisabled"] as? Bool == false,
              let signed = installed["signedState"] as? NSNumber, CFGetTypeID(signed) != CFBooleanGetTypeID(),
              signed.doubleValue == 2 else { throw GuestDesktopError.denied }
        var info = stat()
        guard lstat(archive.path, &info) == 0, info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_nlink == 1 else { throw GuestLinkError.invalid }
        let content = try GuestExtensionArchive.files(readFile(archive, maximum: 2 * 1024 * 1024))
        let signing: Set<String> = ["META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa",
                                    "META-INF/cose.manifest", "META-INF/cose.sig"]
        let expected = Set(entry.files.map(\.path))
        guard expected.isSubset(of: Set(content.keys)),
              Set(content.keys).subtracting(expected).isSubset(of: signing),
              content["META-INF/mozilla.rsa"] != nil || content["META-INF/cose.sig"] != nil else { throw GuestLinkError.invalid }
        for item in entry.files {
            guard let body = content[item.path], body.count == item.size,
                  SHA256.hash(data: body).map({ String(format: "%02x", $0) }).joined() == item.sha256 else { throw GuestDesktopError.stale }
        }
        // Firefox owns signature validation; this checks its active signed
        // installation record AND exact packaged code. No preference is edited.
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
    private static func profile(workspace: String, family: String) throws -> (String, String) {
        guard UUID(uuidString: workspace)?.uuidString.lowercased() == workspace, families.values.contains(family),
              let password = getpwuid(geteuid()), let rawHome = password.pointee.pw_dir else { throw GuestLinkError.invalid }
        let home = URL(fileURLWithPath: String(cString: rawHome), isDirectory: true)
        guard home.path.hasPrefix("/Users/"), home.path == home.resolvingSymlinksInPath().standardizedFileURL.path else { throw GuestLinkError.invalid }
        var fd = Darwin.open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw GuestLinkError.unavailable }
        defer { Darwin.close(fd) }
        var path = home.path
        for (index, part) in ["Library", "Application Support", "Josi Workspace", "Profiles", workspace].enumerated() {
            let next = try directory(parent: fd, name: part, create: index >= 2, privateDirectory: index >= 2)
            Darwin.close(fd); fd = next; path += "/" + part
        }
        // This hint only remembers a local folder. Canonical identity, app code,
        // extension code and every allowance still come from the Vault.
        let name = family + ".profile.json"
        let hintFD = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        let hint: ProfileHint
        if hintFD >= 0 {
            defer { Darwin.close(hintFD) }
            hint = try JSONDecoder().decode(ProfileHint.self, from: readDescriptor(hintFD, maximum: 512, privateFile: true))
            guard hint.schemaVersion == 1, hint.family == family, hint.workspaceId == workspace,
                  UUID(uuidString: hint.nativeProfileId)?.uuidString.lowercased() == hint.nativeProfileId else { throw GuestLinkError.invalid }
        } else {
            guard errno == ENOENT else { throw GuestLinkError.invalid }
            hint = ProfileHint(schemaVersion: 1, family: family, workspaceId: workspace, nativeProfileId: UUID().uuidString.lowercased())
            let profileFD = try directory(parent: fd, name: hint.nativeProfileId, create: true, privateDirectory: true)
            Darwin.close(profileFD)
            let data = try JSONEncoder().encode(hint)
            let output = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard output >= 0 else { throw GuestLinkError.unavailable }
            defer { Darwin.close(output) }
            guard data.withUnsafeBytes({ Darwin.write(output, $0.baseAddress, $0.count) }) == data.count,
                  fsync(output) == 0, fsync(fd) == 0 else { throw GuestLinkError.unavailable }
        }
        let profileFD = try directory(parent: fd, name: hint.nativeProfileId, create: false, privateDirectory: true)
        Darwin.close(profileFD)
        let result = path + "/" + hint.nativeProfileId
        guard URL(fileURLWithPath: result).resolvingSymlinksInPath().path == result else { throw GuestLinkError.invalid }
        return (hint.nativeProfileId, result)
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

/// Read a small XPI in memory without extraction, subprocesses or executing
/// archive contents. Zip64, encryption, links, duplicates and oversized data
/// are unsupported. Mozilla validates its signature; this binds loaded code
/// to the signed Companion's catalog rather than trusting an extension ID.
private enum GuestExtensionArchive {
    static func files(_ data: Data) throws -> [String: Data] {
        guard (22...2_097_152).contains(data.count) else { throw GuestLinkError.invalid }
        let b = [UInt8](data)
        func number(_ offset: Int, _ count: Int) throws -> Int {
            guard offset >= 0, count <= 4, offset + count <= b.count else { throw GuestLinkError.invalid }
            return (0..<count).reduce(0) { $0 | Int(b[offset + $1]) << (8 * $1) }
        }
        var end: Int?
        for at in stride(from: b.count - 22, through: max(0, b.count - 65_557), by: -1) {
            if try number(at, 4) == 0x06054b50, try at + 22 + number(at + 20, 2) == b.count { end = at; break }
        }
        guard let end, try number(end + 4, 2) == 0, try number(end + 6, 2) == 0 else { throw GuestLinkError.invalid }
        let count = try number(end + 10, 2), size = try number(end + 12, 4), start = try number(end + 16, 4)
        guard (1...80).contains(count), try number(end + 8, 2) == count, start + size == end else { throw GuestLinkError.invalid }
        var offset = start, total = 0, result: [String: Data] = [:], names = Set<String>(), ranges: [Range<Int>] = []
        for _ in 0..<count {
            guard try number(offset, 4) == 0x02014b50 else { throw GuestLinkError.invalid }
            let flags = try number(offset + 8, 2), method = try number(offset + 10, 2), crc = try number(offset + 16, 4)
            let packed = try number(offset + 20, 4), unpacked = try number(offset + 24, 4)
            let nameSize = try number(offset + 28, 2), extra = try number(offset + 30, 2), comment = try number(offset + 32, 2)
            let attributes = try number(offset + 38, 4), local = try number(offset + 42, 4)
            let next = offset + 46 + nameSize + extra + comment
            guard flags & ~0x0808 == 0, [0, 8].contains(method), method == 0 || packed > 0,
                  packed <= 1_048_576, unpacked <= 1_048_576,
                  (1...256).contains(nameSize), next <= end, try number(offset + 34, 2) == 0,
                  [0, 0o100000, 0o040000].contains((attributes >> 16) & 0o170000)
            else { throw GuestLinkError.invalid }
            func extras(_ first: Int, _ length: Int) throws {
                let limit = first + length
                guard first >= 0, limit <= b.count else { throw GuestLinkError.invalid }
                var at = first
                while at < limit {
                    guard at + 4 <= limit else { throw GuestLinkError.invalid }
                    let kind = try number(at, 2), size = try number(at + 2, 2)
                    // Only timestamp/Unix-owner extras: no alternate names,
                    // offsets, lengths or compression interpretation.
                    guard [0x5455, 0x7875, 0x000a].contains(kind), at + 4 + size <= limit else { throw GuestLinkError.invalid }
                    at += 4 + size
                }
            }
            try extras(offset + 46 + nameSize, extra)
            let rawName = Array(b[(offset + 46)..<(offset + 46 + nameSize)])
            guard rawName.allSatisfy({ $0 >= 32 && $0 < 127 && $0 != 92 }),
                  let name = String(bytes: rawName, encoding: .utf8), !name.hasPrefix("/"), !names.contains(name),
                  name.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." }), !name.contains("//")
            else { throw GuestLinkError.invalid }
            names.insert(name)
            guard try number(local, 4) == 0x04034b50, try number(local + 6, 2) == flags, try number(local + 8, 2) == method,
                  try number(local + 26, 2) == nameSize else { throw GuestLinkError.invalid }
            let bodyStart = try local + 30 + nameSize + number(local + 28, 2), bodyEnd = bodyStart + packed
            guard local < start, bodyEnd <= start, bodyStart >= local + 30 + nameSize,
                  Array(b[(local + 30)..<(local + 30 + nameSize)]) == rawName,
                  !ranges.contains(where: { $0.overlaps(local..<bodyEnd) }) else { throw GuestLinkError.invalid }
            try extras(local + 30 + nameSize, number(local + 28, 2))
            if flags & 8 == 0 {
                guard try number(local + 14, 4) == crc, try number(local + 18, 4) == packed,
                      try number(local + 22, 4) == unpacked else { throw GuestLinkError.invalid }
            }
            ranges.append(local..<bodyEnd); total += unpacked
            guard total <= 4_194_304 else { throw GuestLinkError.invalid }
            var output = Data(count: unpacked + 1)
            let input = Data(b[bodyStart..<bodyEnd])
            if method == 0 {
                guard packed == unpacked else { throw GuestLinkError.invalid }
                output = input
            } else {
                let decoded = output.withUnsafeMutableBytes { target in
                    input.withUnsafeBytes { source in
                        compression_decode_buffer(target.bindMemory(to: UInt8.self).baseAddress!, unpacked + 1,
                            source.bindMemory(to: UInt8.self).baseAddress!, packed, nil, COMPRESSION_ZLIB)
                    }
                }
                guard decoded == unpacked else { throw GuestLinkError.invalid }
                output.count = unpacked
            }
            if name.hasSuffix("/") {
                guard name == "META-INF/", unpacked == 0 else { throw GuestLinkError.invalid }
            } else { result[name] = output }
            offset = next
        }
        guard offset == end else { throw GuestLinkError.invalid }
        return result
    }
}
