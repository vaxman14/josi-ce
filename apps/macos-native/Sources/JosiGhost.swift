import AVFoundation
import SwiftUI
#if canImport(MaskoPlayer)
@preconcurrency import MaskoPlayer
#endif

/// What the ghost is doing. The raw value is the clip's file name in
/// Resources/Mascot.
enum GhostMood: String, CaseIterable {
    case idle = "idle-wiggle", listening, thinking, float = "gentle-float"
    var clip: URL? { Bundle.main.url(forResource: rawValue, withExtension: "mov", subdirectory: "Mascot") }
    static var missing: [String] { allCases.filter { $0.clip == nil }.map(\.rawValue) }
}

/// One looping player per mood. Moods crossfade, so no clip is cut mid-frame.
@MainActor final class GhostStage: ObservableObject {
    @Published private(set) var shown: GhostMood
    @Published private(set) var failed: Set<GhostMood> = []
#if canImport(MaskoPlayer)
    private(set) var players: [GhostMood: MaskoPlayer] = [:]
#endif
    private let still: Bool = {
#if DEBUG
        if ProcessInfo.processInfo.environment["JOSI_REDUCE_MOTION"] != nil { return true }
#endif
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }()
    private var settling: Task<Void, Never>?
    init(_ mood: GhostMood) { shown = mood; prepare(mood) }
    private func prepare(_ mood: GhostMood) {
#if canImport(MaskoPlayer)
        guard players[mood] == nil, let clip = mood.clip else { return }
        let player = MaskoPlayer(clip: clip, autoPlay: !still)
        player.sound = false
        player.onEvent = { [weak self] event in
            if case .error = event { Task { @MainActor in self?.failed.insert(mood) } }
        }
        players[mood] = player
#endif
    }
    func show(_ mood: GhostMood) {
        guard mood != shown else { return }
        let previous = shown
        prepare(mood)
#if canImport(MaskoPlayer)
        if !still { players[mood]?.play() }
#endif
        withAnimation(.easeInOut(duration: still ? 0 : 0.28)) { shown = mood }
        settling?.cancel()
        settling = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(320))
            guard let self, !Task.isCancelled, self.shown != previous else { return }
#if canImport(MaskoPlayer)
            self.players[previous]?.pause()
#endif
        }
    }
    func playable(_ mood: GhostMood) -> Bool {
#if canImport(MaskoPlayer)
        players[mood] != nil && !failed.contains(mood)
#else
        false
#endif
    }
}

/// The Josi ghost. Falls back to the gold J when a clip can't play.
struct JosiGhost: View {
    var mood: GhostMood
    var size: CGFloat
    @StateObject private var stage: GhostStage
    init(mood: GhostMood, size: CGFloat) {
        self.mood = mood; self.size = size
        _stage = StateObject(wrappedValue: GhostStage(mood))
    }
    var body: some View {
        ZStack {
            ForEach(GhostMood.allCases, id: \.self) { candidate in
                if stage.playable(candidate) {
#if canImport(MaskoPlayer)
                    if let player = stage.players[candidate] {
                        MaskoView(player: player, pointer: false).opacity(stage.shown == candidate ? 1 : 0)
                    }
#endif
                }
            }
            if !stage.playable(stage.shown) { JosiMark(size: size * 0.6) }
        }.frame(width: size, height: size).allowsHitTesting(false)
            .onChange(of: mood) { _, next in stage.show(next) }
            .accessibilityHidden(true)
    }
}
