import AppKit

/// Native artwork follows the window width; the logo keeps its aspect ratio.
@MainActor final class JosiArtworkView: NSView {
    init(logo: NSImage) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedRed: 0.04, green: 0.09, blue: 0.16, alpha: 1).cgColor
        layer?.cornerRadius = 10
        let icon = NSImageView(image: logo)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.setAccessibilityLabel("Josi: white J on navy")
        let title = NSTextField(labelWithString: "Josi Server")
        title.font = .boldSystemFont(ofSize: 28);title.textColor = .white
        let subtitle = NSTextField(wrappingLabelWithString: "Your private AI, running on this Mac.")
        subtitle.font = .systemFont(ofSize: 14);subtitle.textColor = NSColor(calibratedWhite: 0.85, alpha: 1)
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
