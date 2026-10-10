import Foundation
import Darwin

@main struct DiagnosticTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { fatalError("Disposable fixture directory required") }
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        guard root.path.hasPrefix("/Volumes/JosiOS/JosiDrive/") else { fatalError("External fixture required") }
        let folder = root.appendingPathComponent(UUID().uuidString)
        var location: URL!
        do {
            let log = try DiagnosticLog(directory: folder, operation: "verification")
            location = log.url
            let uri = "postgres://" + "user:unsafe" + "@localhost/db"
            try log.append("Payload hash mismatch: app/file.js\npassword=unsafe token=unsafe " + uri + "\n" + String(repeating: "a", count: 64))
            let during = try String(contentsOf: location, encoding: .utf8)
            precondition(during.contains("Payload hash mismatch: app/file.js"))
            precondition(!during.contains("unsafe")); precondition(during.contains("[redacted]"))
        }
        let after = try String(contentsOf: location, encoding: .utf8)
        precondition(after.contains("verification started"))
        let attrs = try FileManager.default.attributesOfItem(atPath: location.path)
        precondition((attrs[.posixPermissions] as! NSNumber).intValue == 0o600)
        let linked = root.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: folder)
        do { _ = try DiagnosticLog(directory: linked, operation: "installation"); fatalError("Linked folder accepted") } catch {}
        print("PASS diagnostic durability, cause retention, credential redaction, private permissions and linked-folder refusal")
    }
}
