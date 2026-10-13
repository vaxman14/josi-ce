import Foundation

enum NativeAuthorization {
    static func shell(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
    // JSONEncoder escapes slashes by default. AppleScript does not accept \/.
    // Escape only the two characters significant in an AppleScript string.
    static func script(_ command: String) -> String {
        "do shell script \"" + command.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\" with administrator privileges"
    }
}
