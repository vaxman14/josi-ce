import Foundation

enum InstallerState: Equatable {
    case waiting, working, ready, failed, removed
    var canOpen: Bool { self == .ready }
    var canChangeFolder: Bool { self == .ready }
    static func phase(_ raw: String, service: String = "") -> String {
        let names = ["prepared":"Preparing Josi", "verified":"Installation files verified", "quiescing":"Pausing Josi", "quiesced":"Josi paused", "snapshot":"Saving a safety copy", "provisioned":"Preparing your settings", "database-ready":"Preparing your data", "migrating":"Updating your data", "migrated":"Your data is ready", "activating":"Starting Josi", "activated":"Starting Josi", "healthy":"Josi is ready", "committed":"Installation complete", "verifying":"Checking installation files", "recovery-required":"Installation stopped; your data is retained", "Copying and flushing protected files":"Copying Josi files", "Stopping services":"Pausing Josi", "Starting services":"Starting Josi", "Checking readiness":"Checking that Josi is ready"]
        let services = ["database":"Data", "web":"Server", "worker":"Background tasks", "proxy":"Browser connection", "voice":"Voice", "voice-control":"Voice settings"]
        return (names[raw] ?? "Preparing Josi") + (services[service].map { " · " + $0 } ?? "")
    }
    static func from(_ event: [String: Any]) -> InstallerState {
        switch event["result"] as? String {
        case "success": return .ready
        case "failure": return .failed
        case "removed": return .removed
        default: return .working
        }
    }
}
