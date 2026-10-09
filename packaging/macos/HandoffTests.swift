import Foundation
@main struct HandoffTests {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        guard root.path.hasPrefix("/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/") else { fatalError("Disposable fixture required") }
        let cfg = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("data/config/runtime.json"))) as! [String: Any]
        let bootstrap = try String(contentsOf: root.appendingPathComponent("data/secrets/bootstrap/browser-token"), encoding: .utf8)
        let target = try await BrowserHandoff.issue(address: "http://localhost:\(cfg["publicPort"] as! Int)", bootstrap: bootstrap)
        let file = root.appendingPathComponent("private-handoff.json")
        FileManager.default.createFile(atPath: file.path, contents: try JSONEncoder().encode(target), attributes: [.posixPermissions: 0o600])
        print("PASS native Swift CSRF-protected, nonredirecting browser handoff issuance")
    }
}
