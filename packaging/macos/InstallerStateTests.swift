import Foundation
@main struct InstallerStateTests {
    static func main() {
        for state in [InstallerState.waiting, .working, .failed, .removed] { precondition(!state.canOpen && !state.canChangeFolder) }
        precondition(InstallerState.ready.canOpen)
        precondition(InstallerState.from(["phase":"committed"]) == .working)
        precondition(InstallerState.from(["result":"success"]) == .ready)
        precondition(InstallerState.from(["result":"failure"]) == .failed)
        for phase in ["migrating", "snapshot", "recovery-required", "unknown"] {
            let copy = InstallerState.phase(phase, service: "database")
            precondition(!copy.contains("migrat") && !copy.contains("recovery") && !copy.contains("database"))
        }
        print("PASS installer state: launch gating, explicit success/failure, plain progress labels")
    }
}
