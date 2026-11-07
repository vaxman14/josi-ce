import Foundation

/// Finds a newer signed installer among the published GitHub releases. Josi never
/// installs anything by itself: the person runs the installer, which updates in
/// place and keeps their data.
enum JosiUpdates {
    private static let feed = URL(string: "https://api.github.com/repos/vaxman14/josi-ce/releases/latest")!
    struct Release { var version: String; var url: URL }
    static var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    /// The newest published installer, or nil when none is newer. A failed check says nothing.
    static func newer() async -> Release? {
        var request = URLRequest(url: feed, timeoutInterval: 15)
        request.setValue("Josi-Mac", forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let feed = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        let version = feed["tag_name"].text.replacing(/^v/, with: "")
        let asset = feed["assets"].list.first { $0["name"].text.hasPrefix("Josi-") && $0["name"].text.hasSuffix("-macOS-arm64.pkg") && !$0["name"].text.hasPrefix("Josi-Client-") }
        // Only ever send someone to GitHub for an installer.
        guard let asset, isNewer(version, than: current), let url = URL(string: asset["browser_download_url"].text),
              url.scheme == "https", url.host()?.lowercased() == "github.com" else { return nil }
        return Release(version: version, url: url)
    }
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ text: String) -> [Int]? {
            let numbers = text.prefix { $0 != "-" }.split(separator: ".").map { Int($0) }
            return numbers.isEmpty || numbers.contains(nil) ? nil : numbers.compactMap { $0 }
        }
        guard let a = parts(candidate), let b = parts(current) else { return false }
        return a.lexicographicallyPrecedes(b) == false && a != b
    }
}
