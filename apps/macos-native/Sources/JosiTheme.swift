import AppKit
import CoreText
import SwiftUI

/// Every colour the app draws comes from here. A skin is one palette, so a new
/// skin is one case and nothing else changes.
struct JosiPalette {
    var backgroundTop, backgroundBottom, panel, panelDeep, text, lilac, muted, border: Color
    var gold1, gold2, gold3, sheen, error, success, onGold: Color
}

enum JosiSkin: String, CaseIterable, Identifiable {
    case plumGold, classic
    static let key = "josi.skin"
    var id: String { rawValue }
    var label: String { self == .plumGold ? "Plum & Gold" : "Classic" }
    static var current: JosiSkin { JosiSkin(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .plumGold }
    var palette: JosiPalette {
        switch self {
        case .plumGold:
            JosiPalette(backgroundTop: Color(hex: 0x43264A), backgroundBottom: Color(hex: 0x150B19), panel: Color(hex: 0x2C1A33),
                        panelDeep: Color(hex: 0x1B0F20), text: Color(hex: 0xF3E9F2), lilac: Color(hex: 0xB9A0BD), muted: Color(hex: 0x8C7491),
                        border: Color(hex: 0x6B4D72), gold1: Color(hex: 0xFFE7A3), gold2: Color(hex: 0xF0CF7A), gold3: Color(hex: 0xC49536),
                        sheen: Color(hex: 0xFFF1C4), error: Color(hex: 0xE8746A), success: Color(hex: 0x7FD39A), onGold: Color(hex: 0x1B0F20))
        case .classic:
            JosiPalette(backgroundTop: Color(hex: 0x141E30), backgroundBottom: Color(hex: 0x0B111E), panel: Color(hex: 0x1F283D),
                        panelDeep: Color(hex: 0x101728), text: Color(hex: 0xFDF6EA), lilac: Color(hex: 0x9DABBE), muted: Color(hex: 0x7C8AA0),
                        border: Color(hex: 0x252D41), gold1: Color(hex: 0xFFB469), gold2: Color(hex: 0xF6831E), gold3: Color(hex: 0xC8620C),
                        sheen: Color(hex: 0xFFD2A6), error: Color(hex: 0xE8746A), success: Color(hex: 0x7FD39A), onGold: Color(hex: 0x0B111E))
        }
    }
}

enum JosiTheme {
    private static var p: JosiPalette { JosiSkin.current.palette }
    static var backgroundTop: Color { p.backgroundTop }
    static var background: Color { p.backgroundBottom }
    static var card: Color { p.panel }
    static var raised: Color { p.panel }
    static var sidebar: Color { p.panelDeep }
    static var deep: Color { p.panelDeep }
    static var text: Color { p.text }
    static var lilac: Color { p.lilac }
    static var muted: Color { p.muted }
    static var border: Color { p.border }
    static var gold: Color { p.gold2 }
    static var goldDeep: Color { p.gold3 }
    static var sheen: Color { p.sheen }
    static var onGold: Color { p.onGold }
    static var error: Color { p.error }
    static var success: Color { p.success }
    /// The soft gold line around panels, the sidebar and the top bar.
    static var hairline: Color { p.gold2.opacity(0.25) }
    static var goldGradient: LinearGradient {
        LinearGradient(colors: [p.gold1, p.gold2, p.gold3], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static var backdrop: RadialGradient {
        RadialGradient(colors: [p.backgroundTop, p.backgroundBottom], center: UnitPoint(x: 0.25, y: 0), startRadius: 0, endRadius: 900)
    }
}
extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 255) / 255,
                  green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}

/// Bricolage Grotesque for headings, DM Sans for body. Both ship in the app
/// under the SIL Open Font License; SwiftUI falls back to SF if they are absent.
enum JosiFont {
    static func register() {
        guard let folder = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "ttf" { CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil) }
    }
    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font { .custom("Bricolage Grotesque", size: size).weight(weight) }
    static func body(_ size: CGFloat = 14, weight: Font.Weight = .regular) -> Font { .custom("DM Sans", size: size).weight(weight) }
    static var largeTitle: Font { display(30) }
    static var title: Font { display(24) }
    static var title2: Font { display(20) }
    static var title3: Font { display(17) }
    static var headline: Font { body(14, weight: .semibold) }
    static var callout: Font { body(13) }
    static var caption: Font { body(12) }
}

/// The one place the J is drawn. Replace this body when the final mark lands.
struct JosiMark: View {
    var size: CGFloat = 36
    private var mark: NSImage? { Bundle.main.url(forResource: "JosiMark", withExtension: "png").flatMap { NSImage(contentsOf: $0) } }
    var body: some View {
        Group {
            if let mark {
                JosiTheme.goldGradient.mask(Image(nsImage: mark).resizable().scaledToFit())
            } else {
                Text("J").font(JosiFont.display(size * 0.8)).foregroundStyle(JosiTheme.goldGradient)
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// The mark on its plum tile, as the sidebar and small avatars show it.
struct JosiMarkTile: View {
    var size: CGFloat = 34
    var body: some View {
        JosiMark(size: size * 0.6).frame(width: size, height: size)
            .background(LinearGradient(colors: [Color(hex: 0x5A2F63), JosiTheme.card], startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: size * 0.27))
            .overlay(RoundedRectangle(cornerRadius: size * 0.27).stroke(JosiTheme.hairline, lineWidth: 1))
    }
}

/// The window's background: the plum gradient with slow gold stars.
struct JosiBackdrop: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let stars: [(x: Double, y: Double, phase: Double, opacity: Double)] = {
        var seed: UInt64 = 0x4A05_1234
        func next() -> Double { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Double(seed >> 33) / Double(1 << 31) }
        return (0..<46).map { _ in (next(), next(), next() * 3, 0.3 + next() * 0.6) }
    }()
    var body: some View {
        ZStack {
            JosiTheme.background
            JosiTheme.backdrop
            TimelineView(.animation(minimumInterval: reduceMotion ? 3600 : 1.0 / 12, paused: reduceMotion)) { context in
                Canvas { canvas, size in
                    let time = context.date.timeIntervalSinceReferenceDate
                    for star in Self.stars {
                        let twinkle = reduceMotion ? 1 : 0.575 + 0.425 * cos((time + star.phase) * 2 * .pi / 3)
                        canvas.opacity = star.opacity * twinkle
                        canvas.fill(Path(ellipseIn: CGRect(x: star.x * size.width, y: star.y * size.height, width: 2, height: 2)),
                                    with: .color(JosiTheme.gold))
                    }
                }
            }
        }.ignoresSafeArea().accessibilityHidden(true)
    }
}

/// Frosted panel: the sidebar, top bar and composer sit on this.
struct JosiFrost: View {
    var body: some View { Rectangle().fill(.ultraThinMaterial).overlay(JosiTheme.deep.opacity(0.55)) }
}

/// The gold button, with a sheen that slowly crosses it.
struct JosiGoldButtonStyle: ButtonStyle {
    var fullWidth = true
    func makeBody(configuration: Configuration) -> some View { GoldLabel(configuration: configuration, fullWidth: fullWidth) }
    private struct GoldLabel: View {
        let configuration: ButtonStyleConfiguration
        let fullWidth: Bool
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.isEnabled) private var enabled
        var body: some View {
            configuration.label.font(JosiFont.body(14, weight: .semibold)).padding(.horizontal, 16).padding(.vertical, 11)
                .frame(maxWidth: fullWidth ? .infinity : nil).foregroundStyle(JosiTheme.onGold)
                .background {
                    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
                        let phase = reduceMotion ? 0.5 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 4) / 4
                        LinearGradient(stops: [.init(color: JosiTheme.goldDeep, location: 0), .init(color: JosiTheme.gold, location: 0.3),
                                               .init(color: JosiTheme.sheen, location: 0.45), .init(color: JosiTheme.gold, location: 0.6),
                                               .init(color: JosiTheme.goldDeep, location: 1)],
                                       startPoint: UnitPoint(x: 1.5 - phase * 2.5, y: 0), endPoint: UnitPoint(x: 2.5 - phase * 2.5, y: 0.3))
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 12)).opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
        }
    }
}

/// The quiet partner to the gold button.
struct JosiOutlineButtonStyle: ButtonStyle {
    var fullWidth = false
    func makeBody(configuration: Configuration) -> some View { OutlineLabel(configuration: configuration, fullWidth: fullWidth) }
    private struct OutlineLabel: View {
        let configuration: ButtonStyleConfiguration
        let fullWidth: Bool
        @Environment(\.isEnabled) private var enabled
        var body: some View {
            configuration.label.font(JosiFont.body(13, weight: .semibold)).padding(.horizontal, 14).padding(.vertical, 9)
                .frame(maxWidth: fullWidth ? .infinity : nil).foregroundStyle(JosiTheme.text)
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(JosiTheme.border, lineWidth: 1)).contentShape(Rectangle())
                .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
        }
    }
}

/// Plum input field, for the screens that are drawn by hand.
struct JosiFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.textFieldStyle(.plain).font(JosiFont.body(14)).padding(.horizontal, 12).padding(.vertical, 11)
            .background(JosiTheme.deep, in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).stroke(JosiTheme.border, lineWidth: 1))
    }
}

/// A small status capsule, such as the Running pill.
struct JosiPill: View {
    var text: String
    var color: Color = JosiTheme.success
    var body: some View {
        Text(text).font(JosiFont.body(11, weight: .semibold)).foregroundStyle(color).padding(.horizontal, 9).padding(.vertical, 3)
            .background(color.opacity(0.08), in: Capsule()).overlay(Capsule().stroke(color.opacity(0.4), lineWidth: 1))
    }
}

/// The card the hand-drawn screens use. GroupBox picks up the same look.
struct JosiCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(JosiTheme.card, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(JosiTheme.hairline, lineWidth: 1))
    }
}

struct JosiGroupBoxStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            configuration.label.font(JosiFont.title3)
            configuration.content
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(JosiTheme.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(JosiTheme.hairline, lineWidth: 1))
    }
}

struct JosiPillStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(JosiFont.body(13, weight: .medium)).padding(.horizontal, 15).padding(.vertical, 10)
            .foregroundStyle(prominent ? JosiTheme.onGold : JosiTheme.text)
            .background(prominent ? JosiTheme.gold : JosiTheme.raised, in: Capsule())
            .overlay(Capsule().stroke(prominent ? JosiTheme.gold : JosiTheme.muted.opacity(0.25), lineWidth: 1))
            .clipShape(Capsule()).opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct JosiStatusBadge: View {
    let state: String
    private var text: String {
        ["planning": "Planning", "working": "In progress", "needs_instruction": "Needs attention",
         "waiting": "Waiting", "paused": "Paused", "verifying": "Ready to review",
         "completed": "Complete", "cancelled": "Cancelled"][state] ?? state.capitalized
    }
    var body: some View {
        HStack(spacing: 6) { Circle().frame(width: 7, height: 7); Text(text) }
            .font(JosiFont.body(12, weight: .semibold)).foregroundStyle(state == "completed" ? JosiTheme.success : JosiTheme.gold)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(JosiTheme.gold.opacity(0.09), in: Capsule())
    }
}
