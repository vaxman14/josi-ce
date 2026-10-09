// Read-only physical-acceptance aid. No service registration, start, stop,
// credential access, browser launch or network configuration authority.
import Foundation

struct ServiceStatus: Codable {
    let label: String
    let expectedStartup: String
    let state: String
    let pid: Int?
}

let services = [
    ("database", "boot"), ("web", "boot after database readiness"),
    ("worker", "boot after database readiness"), ("proxy", "boot after API readiness"),
    ("voice-control", "boot"), ("voice", "on demand")
]

func inspect(_ name: String, _ startup: String) throws -> ServiceStatus {
    let label = "com.heyjosi.ce." + name
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["print", "system/" + label]
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    try process.run()
    // Drain concurrently with launchctl; its diagnostic output must not block
    // the child on a full pipe. Never print arbitrary launchd environment data.
    let bytes = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(decoding: bytes, as: UTF8.self)
    if process.terminationStatus != 0 {
        let absent = text.contains("Could not find service")
        return ServiceStatus(label: label, expectedStartup: startup,
                             state: absent ? "not registered" : "query failed", pid: nil)
    }
    let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    let pid = lines.first(where: { $0.hasPrefix("pid = ") }).flatMap { Int($0.dropFirst(6)) }
    let running = lines.contains("state = running") && pid != nil
    return ServiceStatus(label: label, expectedStartup: startup,
                         state: running ? "running (health unverified)" : "registered, not running", pid: pid)
}

do {
    guard CommandLine.arguments.count == 1 else {
        throw NSError(domain: "JosiStatus", code: 1)
    }
    let statuses = try services.map { try inspect($0.0, $0.1) }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(statuses))
    FileHandle.standardOutput.write(Data("\n".utf8))
    // A PID is deliberately not a health verdict. On-demand voice may be idle.
    exit(statuses.allSatisfy { $0.state.hasPrefix("running") ||
        ($0.label.hasSuffix(".voice") && $0.state == "registered, not running") } ? 0 : 1)
} catch {
    FileHandle.standardError.write(Data("Josi service status could not be inspected.\n".utf8))
    exit(2)
}
