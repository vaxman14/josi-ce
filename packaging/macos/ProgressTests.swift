import Foundation
@main struct ProgressTests {
    static func main() {
        let start = Date(timeIntervalSince1970: 100)
        precondition(ProgressState.elapsed(start: start, now: start.addingTimeInterval(12)).contains("12 seconds"))
        precondition(ProgressState.elapsed(start: start, now: start.addingTimeInterval(-2)).contains("0 seconds"))
        precondition(ProgressState.latest(Data("{\"phase\":\"migrating\",\"service\":\"database\"}\n{\"pha".utf8)) == "migrating · database")
        precondition(ProgressState.latest(Data("{\"phase\":\"prepared\"}\n{\"phase\":\"Starting\",\"service\":\"worker\"}\n".utf8)) == "Starting · worker")
        precondition(ProgressState.latest(Data("{\"phase\":\"unsafe\\noutput\"}".utf8)) == nil)
        precondition(ProgressState.latest(Data(repeating: 65, count: 1024 * 1024 + 1)) == nil)
        precondition(ProgressState.latest(Data("not json".utf8)) == nil)
        print("PASS 7 progress state regressions: elapsed activity, phase/service updates, partial writes and bounds")
    }
}
