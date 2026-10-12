import AppKit
import Foundation
@main struct BrandResources {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else { fatalError("Logo and destination required") }
        let logo = NSImage(contentsOfFile: CommandLine.arguments[1])!
        let out = URL(fileURLWithPath: CommandLine.arguments[2])
        let size = NSSize(width:720,height:440)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1440, pixelsHigh: 880, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSColor(calibratedRed:0.04,green:0.09,blue:0.16,alpha:1).setFill();NSRect(x:0,y:0,width:720,height:440).fill()
        logo.draw(in:NSRect(x:36,y:318,width:88,height:88))
        let attrs:[NSAttributedString.Key:Any] = [.font:NSFont.boldSystemFont(ofSize:30),.foregroundColor:NSColor.white]
        ("Josi Server" as NSString).draw(at:NSPoint(x:142,y:354),withAttributes:attrs)
        let copy:[NSAttributedString.Key:Any] = [.font:NSFont.systemFont(ofSize:15),.foregroundColor:NSColor(calibratedWhite:0.85,alpha:1)]
        ("Double-click Install Josi.pkg to begin." as NSString).draw(at:NSPoint(x:142,y:325),withAttributes:copy)
        ("Server only, or Server + Desktop Client" as NSString).draw(at:NSPoint(x:48,y:70),withAttributes:copy)
        ("Apple Silicon · macOS 14 or later · Allow several minutes" as NSString).draw(at:NSPoint(x:48,y:42),withAttributes:copy)
        NSGraphicsContext.restoreGraphicsState()
        precondition(bitmap.pixelsWide == 1440 && bitmap.pixelsHigh == 880 && bitmap.size == size)
        try bitmap.representation(using:.png,properties:[:])!.write(to:out)
    }
}
