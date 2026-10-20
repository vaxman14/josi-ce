import Foundation
import ImageIO
import Vision

/// Reads only a bounded JPEG already captured from an observed page image.
/// No URL fetching, filesystem access or model transmission occurs here.
enum GuestPhotoReader {
    static func recognize(_ encoded: String) async throws -> String {
        guard let bytes = Data(base64Encoded: encoded), bytes.count <= 24 * 1024,
              bytes.base64EncodedString() == encoded else { throw GuestDesktopError.denied }
        return try await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  CGImageSourceGetCount(source) == 1,
                  CGImageSourceGetType(source) as String? == "public.jpeg",
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
                  width > 0, height > 0, width <= 1024, height <= 1024,
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw GuestDesktopError.denied }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: image).perform([request])
            // OCR is uncertain evidence, never authority or a guessed label.
            return String((request.results ?? []).prefix(80).compactMap { result in
                guard let text = result.topCandidates(1).first, text.confidence >= 0.35 else { return nil }
                return text.string
            }.joined(separator: "\n").prefix(6000))
        }.value
    }
}
