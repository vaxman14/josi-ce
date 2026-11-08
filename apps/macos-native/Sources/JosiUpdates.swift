import Foundation

/// Finds a newer signed installer among the published GitHub releases, betas
/// included. Josi never installs anything by itself: the person runs the installer,
/// which updates in place and keeps their data.
enum JosiUpdates {
    private static let feed = URL(string: "https://api.github.com/repos/vaxman14/josi-ce/releases?per_page=30")!
    struct Release { var version: String; var url: URL }
    enum Check { case available(Release), current, unavailable }

    /// The newest published Mac installer, or nil when none is newer. A failed check says nothing.
    static func check(than current: String) async -> Check {
        var request = URLRequest(url: feed, timeoutInterval: 15)
        request.setValue("Josi-Mac", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let releases = try? JSONDecoder().decode(Wire.self, from: data), case .array = releases else { return .unavailable }
        var best: Release?
        for release in releases.list where !release["draft"].flag {
            let version = release["tag_name"].text.replacing(/^v/, with: "")
            guard isNewer(version, than: best?.version ?? current),
                  let asset = release["assets"].list.first(where: { $0["name"].text == "Josi-\(version)-macOS-arm64.pkg" }),
                  let url = URL(string: asset["browser_download_url"].text),
                  // Only ever send someone to GitHub for an installer.
                  url.scheme == "https", url.host()?.lowercased() == "github.com" else { continue }
            best = Release(version: version, url: url)
        }
        return best.map(Check.available) ?? .current
    }
    /// 1.2.0-beta.3 follows 1.2.0-beta.2, and 1.2.0 follows both.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ text: String) -> (numbers: [Int], beta: Int?)? {
            let halves = text.split(separator: "-", maxSplits: 1).map(String.init)
            guard let first = halves.first else { return nil }
            let components = first.split(separator: ".", omittingEmptySubsequences: false)
            guard components.count == 3, components.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) && Int($0) != nil }) else { return nil }
            let numbers = components.compactMap { Int($0) }
            guard halves.count == 2 else { return (numbers, nil) }
            guard halves[1].range(of: "^[A-Za-z][A-Za-z0-9.-]*\\.[0-9]+$", options: .regularExpression) != nil,
                  let beta = halves[1].split(separator: ".").last.flatMap({ Int($0) }) else { return nil }
            return (numbers, beta)
        }
        guard let a = parts(candidate), let b = parts(current) else { return false }
        if a.numbers != b.numbers { return b.numbers.lexicographicallyPrecedes(a.numbers) }
        switch (a.beta, b.beta) {
        case let (x?, y?): return x > y
        case (nil, _?): return true
        default: return false
        }
    }
}
