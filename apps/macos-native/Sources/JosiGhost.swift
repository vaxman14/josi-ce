import AVFoundation
import SwiftUI
#if canImport(MaskoPlayer)
@preconcurrency import MaskoPlayer
#endif

/// One clip of the Josi ghost. The raw value is its file name in Resources/Mascot.
enum GhostClip: String, CaseIterable {
    case idle = "idle-wiggle", float = "gentle-float", listening, nodAlong = "nod-along", earCup = "ear-cup"
    case thinking, chinTap = "chin-tap", explaining, waveHello = "wave-hello", gotIt = "got-it"
    case lightbulb, countingOff = "counting-off", celebrate, oops
    var url: URL? { Bundle.main.url(forResource: rawValue, withExtension: "mov", subdirectory: "Mascot") }
    var milliseconds: Int {
        switch self {
        case .idle, .float: 2333
        case .waveHello, .gotIt, .countingOff: 3750
        case .lightbulb, .celebrate, .oops: 5167
        default: 3042
        }
    }
    /// Played once from the start each time, then handed back to a loop.
    var oneShot: Bool { [.waveHello, .gotIt, .lightbulb, .countingOff, .celebrate, .oops].contains(self) }
    static var missing: [String] { allCases.filter { $0.url == nil }.map(\.rawValue) }
}

/// What the person sees Josi doing. The status line, the chip and the ghost all follow this.
enum JosiState { case online, listening, thinking, speaking }
/// The same states as the Windows app's Ghost.cs.
enum GhostState: Int { case idle, resting, typing, voice, waiting, streaming, hello, received, answerFound, listReply, taskDone, error }

/// The one thing screens talk to: they set a state, and this works out which
/// clip is on. A one-shot plays once and hands back to the loop underneath it.
@MainActor final class GhostController: ObservableObject {
    private static let maxQueued = 2, passesPerClip = 2, chinTapAfter = 2000, quiet = 20000
    @Published private(set) var clip = GhostClip.idle
    @Published private(set) var state = JosiState.online
    /// The loop underneath whatever one-shot is playing.
    private var mood = GhostState.idle
    private var after: GhostState?
    private var queue: [GhostClip] = []
    private var playingOneShot = false
    private var turns: Task<Void, Never>?
    private var settling: Task<Void, Never>?

    private static func clips(_ state: GhostState) -> [GhostClip] {
        switch state {
        case .idle: [.idle]
        case .resting: [.float]
        case .typing: [.listening, .nodAlong]
        case .voice: [.earCup, .listening]
        case .waiting: [.thinking, .chinTap]
        case .streaming: [.explaining]
        case .hello: [.waveHello]
        case .received: [.gotIt]
        case .answerFound: [.lightbulb]
        case .listReply: [.countingOff]
        case .taskDone: [.celebrate]
        case .error: [.oops]
        }
    }
    private func publish() {
        let now: JosiState = mood == .voice || mood == .typing ? .listening : mood == .waiting ? .thinking
            : after == .streaming || mood == .streaming ? .speaking : .online
        if now != state { state = now }
    }
    private func show(_ next: GhostClip) {
        if clip != next { clip = next }
#if DEBUG
        JosiDriver.log("clip \(next.rawValue)")
#endif
    }
    func set(_ next: GhostState) {
        if next.rawValue >= GhostState.hello.rawValue {
            if queue.count < Self.maxQueued { queue.append(Self.clips(next)[0]) }
            if !playingOneShot { playNext() }
            return
        }
        guard next != mood else { return }
        mood = next
        if next != .idle { settling?.cancel(); settling = nil; after = nil }
        publish(); showLoop()
    }
    /// A new reply: the moment it lands, explaining for a while, then a brief float.
    func replied(_ body: String) {
        set(JosiReply.isList(body) ? .listReply : .answerFound)
        settling?.cancel()
        after = .streaming
        publish()
        settling = Task { [weak self] in
            while self?.playingOneShot == true { try? await Task.sleep(for: .milliseconds(100)); if Task.isCancelled { return } }
            try? await Task.sleep(for: .milliseconds(GhostClip.explaining.milliseconds))
            guard let self, !Task.isCancelled else { return }
            self.after = .resting; self.publish(); self.showLoop()
            try? await Task.sleep(for: .milliseconds(GhostClip.float.milliseconds))
            guard !Task.isCancelled else { return }
            self.after = nil; self.showLoop()
        }
    }
    private func playNext() {
        guard !queue.isEmpty else { playingOneShot = false; showLoop(); return }
        turns?.cancel(); turns = nil
        playingOneShot = true
        let next = queue.removeFirst()
        show(next)
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(next.milliseconds))
            self?.playNext()
        }
    }
    private func showLoop() {
        guard !playingOneShot else { return }
        turns?.cancel(); turns = nil
        let current = after ?? mood
        show(Self.clips(current)[0])
        guard [.waiting, .typing, .voice, .idle].contains(current) else { return }
        turns = Task { [weak self] in await self?.turn(current) }
    }
    /// What a loop does while it stays on: thinking moves to the chin, typing and
    /// voice alternate, and idle drifts into a float now and then.
    private func turn(_ current: GhostState) async {
        func wait(_ milliseconds: Int) async -> Bool {
            try? await Task.sleep(for: .milliseconds(milliseconds)); return !Task.isCancelled
        }
        switch current {
        case .waiting:
            if await wait(Self.chinTapAfter) { show(.chinTap) }
        case .typing, .voice:
            let clips = Self.clips(current)
            var at = 1
            while await wait(clip.milliseconds * Self.passesPerClip) { show(clips[at % clips.count]); at += 1 }
        default:
            while await wait(Self.quiet) {
                show(.float)
                guard await wait(GhostClip.float.milliseconds) else { return }
                show(.idle)
            }
        }
    }
}

/// A reply as the stage shows it: the sentence, its list if it has one, and what follows the list.
struct JosiReply {
    var lead = "", tail = ""
    var items: [String] = []
    private static var marker: Regex<Substring> { /^\s*(?:[-*•]|\d+[.)])\s+/ }
    private static func item(_ line: String) -> Bool { line.prefixMatch(of: marker) != nil && line.replacing(marker, with: "").contains { !$0.isWhitespace } }
    /// Two list lines or more make a list.
    static func isList(_ reply: String) -> Bool { reply.components(separatedBy: "\n").filter(item).count >= 2 }
    init(_ reply: String) {
        let clean = reply.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
            .map { $0.replacing(/^#{1,6}\s+/, with: "") }
        guard Self.isList(clean.joined(separator: "\n")) else { lead = clean.joined(separator: "\n"); return }
        items = clean.filter(Self.item).map { $0.replacing(Self.marker, with: "").trimmingCharacters(in: .whitespaces) }
        lead = clean.prefix { !Self.item($0) }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        tail = clean.reversed().prefix { !Self.item($0) }.reversed().joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }
    /// The pace of a reply coming in. A long one speeds up, so it never takes over about 3.5 seconds.
    static func revealStep(words: Int) -> Int { words == 0 ? 0 : min(70, 3500 / words) }
}

/// Reduce Motion, or the test switch for it, shows the still pose and skips the movement.
enum JosiMotion {
    @MainActor static var still: Bool {
#if DEBUG
        if ProcessInfo.processInfo.environment["JOSI_REDUCE_MOTION"] != nil { return true }
#endif
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}

/// The players behind one ghost. Clips crossfade, so none is cut mid-frame. A
/// loop keeps its player; a one-shot gets a new one so it starts from the top.
@MainActor final class GhostStage: ObservableObject {
    @Published private(set) var shown: GhostClip
    @Published private(set) var failed: Set<GhostClip> = []
    @Published private(set) var takes: [GhostClip: Int] = [:]
#if canImport(MaskoPlayer)
    private(set) var players: [GhostClip: MaskoPlayer] = [:]
#endif
    private let still = JosiMotion.still
    private var settling: Task<Void, Never>?
    /// With Reduce Motion on, the still pose stands in for every clip.
    let pose: NSImage?
    init(_ clip: GhostClip) {
        pose = still ? Bundle.main.url(forResource: "still", withExtension: "png", subdirectory: "Mascot").flatMap(NSImage.init(contentsOf:)) : nil
        shown = still ? .idle : clip
        if !still { prepare(shown) }
    }
    private func prepare(_ clip: GhostClip) {
#if canImport(MaskoPlayer)
        guard clip.oneShot || players[clip] == nil, let url = clip.url else { return }
        players[clip]?.destroy()
        let player = MaskoPlayer(clip: url, autoPlay: !still)
        player.sound = false
        player.onEvent = { [weak self] event in
            if case .error = event { Task { @MainActor in self?.failed.insert(clip) } }
        }
        players[clip] = player
        takes[clip, default: 0] += 1
#endif
    }
    func show(_ clip: GhostClip) {
        guard !still, clip != shown else { return }
        let previous = shown
        prepare(clip)
#if canImport(MaskoPlayer)
        players[clip]?.play()
#endif
        withAnimation(.easeInOut(duration: 0.28)) { shown = clip }
        settling?.cancel()
        settling = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(320))
            guard let self, !Task.isCancelled, self.shown != previous else { return }
#if canImport(MaskoPlayer)
            self.players[previous]?.pause()
#endif
        }
    }
    func playable(_ clip: GhostClip) -> Bool {
#if canImport(MaskoPlayer)
        players[clip] != nil && !failed.contains(clip)
#else
        false
#endif
    }
}

/// The Josi ghost, following the controller. Falls back to the gold J when a clip can't play.
struct JosiGhost: View {
    @ObservedObject var ghost: GhostController
    var size: CGFloat
    @StateObject private var stage: GhostStage
    init(ghost: GhostController, size: CGFloat) {
        self.ghost = ghost; self.size = size
        _stage = StateObject(wrappedValue: GhostStage(ghost.clip))
    }
    var body: some View {
        ZStack {
            ForEach(GhostClip.allCases, id: \.self) { candidate in
                if stage.playable(candidate) {
#if canImport(MaskoPlayer)
                    if let player = stage.players[candidate] {
                        MaskoView(player: player, pointer: false).opacity(stage.shown == candidate ? 1 : 0).id(stage.takes[candidate] ?? 0)
                    }
#endif
                }
            }
            if let pose = stage.pose { Image(nsImage: pose).resizable().scaledToFit() }
            else if !stage.playable(stage.shown) { JosiMark(size: size * 0.6) }
        }.frame(width: size, height: size).allowsHitTesting(false)
            .onChange(of: ghost.clip) { _, next in stage.show(next) }
            .accessibilityHidden(true)
    }
}
