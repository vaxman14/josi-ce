import Foundation
@main struct NativeAuthorizationTests {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("josi-script-parser-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        for (index, path) in ["/Users/roman/Documents/RV", "/Users/roman/Documents/Roman's folder", "/Users/roman/Documents/\"quoted\" \\ folder"].enumerated() {
            let command = "set -eu; /usr/bin/env -i PATH=/usr/bin:/bin '/Applications/Josi Server.app/Contents/Resources/runtime/python/bin/python3.11' -I -B '/Applications/Josi Server.app/Contents/Resources/runtime/app/native/maintenance.py' workspace " + NativeAuthorization.shell(path)
            let process = Process();process.executableURL = URL(fileURLWithPath: "/usr/bin/osacompile")
            process.arguments = ["-o",directory.appendingPathComponent("test-\(index).scpt").path,"-e",NativeAuthorization.script(command)]
            try process.run();process.waitUntilExit();precondition(process.terminationStatus == 0)
        }
        print("PASS actual AppleScript parser: slash paths, spaces, apostrophes, quotes and backslashes; no operation executed")
    }
}
