import AppKit
import SwiftUI

enum JosiTheme {
    static let background = Color(hex: 0x0B111E)
    static let sidebar = Color(hex: 0x141E30)
    static let card = Color(hex: 0x101728)
    static let raised = Color(hex: 0x1F283D)
    static let border = Color(hex: 0x252D41)
    static let orange = Color(hex: 0xF6831E)
    static let text = Color(hex: 0xFDF6EA)
    static let muted = Color(hex: 0x9DABBE)
}
extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 255) / 255,
                  green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}

struct JosiMark: View {
    var size: CGFloat = 36
    var body: some View {
        Image(nsImage: NSImage(named: "Josi") ?? NSImage())
            .resizable().scaledToFit().frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
            .accessibilityHidden(true)
    }
}

struct JosiThinking: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dancing = false
    var body: some View {
        HStack(spacing: 14) {
            JosiMark(size: 38)
                .rotationEffect(.degrees(reduceMotion ? 0 : dancing ? 9 : -9))
                .offset(y: reduceMotion ? 0 : dancing ? -4 : 2)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.52).repeatForever(autoreverses: true), value: dancing)
            Text("Josi is thinking…").foregroundStyle(JosiTheme.muted)
            Spacer()
        }.padding(.vertical, 12).onAppear { dancing = true }
            .accessibilityElement(children: .combine)
    }
}

struct JosiGroupBoxStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            configuration.label.font(.headline)
            configuration.content
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(JosiTheme.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(JosiTheme.border, lineWidth: 1))
    }
}

struct JosiPillStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.callout.weight(.medium)).padding(.horizontal, 15).padding(.vertical, 10)
            .foregroundStyle(prominent ? JosiTheme.background : JosiTheme.text)
            .background(prominent ? JosiTheme.orange : JosiTheme.raised, in: Capsule())
            .overlay(Capsule().stroke(prominent ? JosiTheme.orange : JosiTheme.muted.opacity(0.25), lineWidth: 1))
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
            .font(.caption.weight(.semibold)).foregroundStyle(state == "completed" ? Color.green : JosiTheme.orange)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(JosiTheme.orange.opacity(0.09), in: Capsule())
    }
}
