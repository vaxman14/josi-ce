import Foundation

/// Validate a private copy before handing it to macOS Installer. Never run a
/// package script or change the installed app from the running client.
enum JosiInstaller {
    static let identity = "Developer ID Installer: Socal Receptionist LLC (LRH75YR6QW)"
    struct Candidate: Sendable { let url: URL; let version: String }
    static func prepare(_ selected: URL, current: String) async throws -> Candidate {
        try await Task.detached(priority: .userInitiated) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Josi-reviewed-update-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            var retained = false
            defer { if !retained { try? FileManager.default.removeItem(at: folder) } }
            let copy = folder.appendingPathComponent("Josi-update.pkg")
            let values = try selected.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, size > 0, size <= 8 * 1024 * 1024 * 1024 else {
                throw JosiError(message: "Choose a regular Josi installer package of at most 8 GB.")
            }
            try FileManager.default.copyItem(at: selected, to: copy)
            let signature = try run("/usr/sbin/pkgutil", ["--check-signature", copy.path])
            guard signature.contains(identity) else { throw JosiError(message: "This installer is not signed by Socal Receptionist LLC’s Developer ID Installer certificate.") }
            _ = try run("/usr/bin/xar", ["-x", "-f", copy.path, "-C", folder.path, "Distribution"])
            let metadata = folder.appendingPathComponent("Distribution")
            let attributes = try metadata.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard attributes.isRegularFile == true, attributes.isSymbolicLink != true, (attributes.fileSize ?? Int.max) < 1024 * 1024 else { throw JosiError(message: "The installer’s product information is invalid.") }
            let version = try productVersion(Data(contentsOf: metadata))
            guard version == current || JosiUpdates.isNewer(version, than: current) else { throw JosiError(message: "This package would downgrade Josi. Choose a current or newer installer.") }
            retained = true
            return Candidate(url: copy, version: version)
        }.value
    }
    static func productVersion(_ data: Data) throws -> String {
        let delegate = Product(); let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false; parser.delegate = delegate
        guard parser.parse(), delegate.valid, let version = delegate.version,
              version.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil else {
            throw JosiError(message: "This is not a supported Josi upgrade installer.")
        }
        return version
    }
    private final class Product: NSObject, XMLParserDelegate {
        var valid = true
        var version: String?
        func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String]) {
            guard elementName == "pkg-ref" else { return }
            if attributes["id"] != "com.heyjosi.ce.unified.pkg" { valid = false }
            if let value = attributes["version"] {
                if let version, version != value { valid = false }
                version = value
            }
        }
    }
    private static func run(_ executable: String, _ args: [String]) throws -> String {
        let task = Process(), pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: executable); task.arguments = args
        task.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"]
        task.standardOutput = pipe; task.standardError = pipe
        try task.run()
        let bytes = pipe.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
        guard task.terminationStatus == 0, bytes.count < 1024 * 1024 else { throw JosiError(message: "macOS could not verify this installer. Nothing was installed.") }
        return String(decoding: bytes, as: UTF8.self)
    }
}
