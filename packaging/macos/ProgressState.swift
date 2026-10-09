import Foundation

struct ProgressState {
    static func elapsed(start: Date, now: Date) -> String {
        "Elapsed \(max(0, Int(now.timeIntervalSince(start)))) seconds · working"
    }
    static func latest(_ data: Data) -> String? {
        guard data.count <= 1024 * 1024, let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n").reversed() {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let phase = object["phase"] as? String, !phase.isEmpty, phase.count <= 160,
                  !phase.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { continue }
            if let service = object["service"] as? String, service.count <= 80,
               !service.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
                return phase + " · " + service
            }
            return phase
        }
        return nil
    }
}
