import AppKit
import SwiftUI

/// Handle Return before NSTextView's newline command, while leaving input
/// method composition, Shift-Return and ordinary editor shortcuts intact.
final class JosiMessageTextView: NSTextView {
    var send: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if (event.keyCode == 36 || event.keyCode == 76),
           !event.modifierFlags.contains(.shift), !event.modifierFlags.contains(.option),
           !event.modifierFlags.contains(.control), !hasMarkedText() {
            send?(); return
        }
        super.keyDown(with: event)
    }
}

struct JosiMessageEditor: NSViewRepresentable {
    @Binding var text: String
    var enabled: Bool
    var onSend: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true; scroll.borderType = .noBorder
        let view = JosiMessageTextView()
        view.isRichText = false; view.importsGraphics = false; view.allowsUndo = true
        view.drawsBackground = false; view.textColor = NSColor(JosiTheme.text)
        view.insertionPointColor = NSColor(JosiTheme.orange)
        view.font = .systemFont(ofSize: 15)
        view.textContainerInset = NSSize(width: 3, height: 8)
        view.isVerticallyResizable = true; view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.setAccessibilityLabel("Message Josi")
        view.setAccessibilityHelp("Enter sends the message. Shift-Enter starts a new line.")
        view.delegate = context.coordinator
        scroll.documentView = view
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? JosiMessageTextView else { return }
        if view.string != text, !view.hasMarkedText() { view.string = text }
        view.isEditable = enabled
        view.send = { if enabled { onSend() } }
    }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: JosiMessageEditor
        init(_ parent: JosiMessageEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
        }
    }
}
