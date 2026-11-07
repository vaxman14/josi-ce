import AppKit
import CoreText

/// The Plum & Gold colours and type of the native app, for the AppKit windows
/// that cannot share its SwiftUI theme.
@MainActor enum JosiLook {
    static func colour(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
    }
    static let top = colour(0x43264A), bottom = colour(0x150B19), panel = colour(0x2C1A33), deep = colour(0x1B0F20)
    static let text = colour(0xF3E9F2), lilac = colour(0xB9A0BD), border = colour(0x6B4D72)
    static let gold1 = colour(0xFFE7A3), gold2 = colour(0xF0CF7A), gold3 = colour(0xC49536)
    static func registerFonts() {
        guard let folder = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "ttf" { CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil) }
    }
    private static func font(_ family: String, _ size: CGFloat, _ weight: CGFloat) -> NSFont {
        let variation = NSFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)
        let wght = 0x77676874 // The OpenType 'wght' axis.
        return NSFont(descriptor: NSFontDescriptor(fontAttributes: [.family: family, variation: [wght: weight]]), size: size)
            ?? .systemFont(ofSize: size, weight: weight >= 600 ? .bold : .regular)
    }
    static func display(_ size: CGFloat) -> NSFont { font("Bricolage Grotesque", size, 700) }
    static func body(_ size: CGFloat, weight: CGFloat = 400) -> NSFont { font("DM Sans", size, weight) }
}

/// The plum wash and faint stars behind a window's content.
final class JosiBackdrop: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSGradient(starting: JosiLook.bottom, ending: JosiLook.top)?.draw(in: bounds, angle: 90)
        var seed: UInt32 = 7
        func next() -> CGFloat { seed = seed &* 1664525 &+ 1013904223; return CGFloat(seed >> 8) / CGFloat(1 << 24) }
        for _ in 0..<70 {
            let size = 0.8 + next() * 1.2
            NSColor(white: 1, alpha: 0.12 + next() * 0.3).setFill()
            NSBezierPath(ovalIn: NSRect(x: next() * bounds.width, y: next() * bounds.height, width: size, height: size)).fill()
        }
    }
}

/// A gold action, or a quiet plum one beside it.
final class JosiButton: NSButton {
    private let gold: Bool
    init(_ title: String, gold: Bool = false) {
        self.gold = gold
        super.init(frame: .zero)
        self.title = title;isBordered = false;setButtonType(.momentaryChange)
    }
    required init?(coder: NSCoder) { fatalError("Josi buttons are built in code") }
    override var title: String { didSet { invalidateIntrinsicContentSize();needsDisplay = true } }
    override var isEnabled: Bool { didSet { needsDisplay = true } }
    private var label: NSAttributedString {
        NSAttributedString(string: title, attributes: [.font: JosiLook.body(13, weight: 600), .foregroundColor: gold ? JosiLook.deep : JosiLook.text])
    }
    override var intrinsicContentSize: NSSize { NSSize(width: ceil(label.size().width) + 36, height: 36) }
    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.current?.cgContext.setAlpha(!isEnabled ? 0.4 : isHighlighted ? 0.8 : 1)
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        if gold { NSGradient(colors: [JosiLook.gold1, JosiLook.gold2, JosiLook.gold3])?.draw(in: shape, angle: 0) }
        else { JosiLook.panel.setFill();shape.fill();JosiLook.border.setStroke();shape.stroke() }
        let size = label.size()
        label.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

/// Native artwork follows the window width; the logo keeps its aspect ratio.
@MainActor final class JosiArtworkView: NSView {
    init(logo: NSImage) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = JosiLook.panel.cgColor
        layer?.borderColor = JosiLook.border.cgColor;layer?.borderWidth = 1
        layer?.cornerRadius = 14
        let icon = NSImageView(image: logo)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.setAccessibilityLabel("Josi: gold J on plum")
        let title = NSTextField(labelWithString: "Josi")
        title.font = JosiLook.display(28);title.textColor = JosiLook.text
        let subtitle = NSTextField(wrappingLabelWithString: "Your assistant, on your own server.")
        subtitle.font = JosiLook.body(14);subtitle.textColor = JosiLook.lilac
        let copy = NSStackView(views: [title, subtitle]);copy.orientation = .vertical;copy.alignment = .leading;copy.spacing = 6
        let row = NSStackView(views: [icon, copy]);row.alignment = .centerY;row.spacing = 20
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 120),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 72),
            icon.heightAnchor.constraint(equalToConstant: 72)
        ])
    }
    required init?(coder: NSCoder) { fatalError("Native artwork requires its logo") }
}
