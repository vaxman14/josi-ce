import Foundation
import Security

enum GuestEnvironment {
    static func identity() throws -> (guest: String, host: String) { try GuestBrowserBoundary.isolatedBoot() }
    static func signedApplication() throws {
        try GuestBrowserBoundary.requireSelf(identifier: "com.heyjosi.ce.unified", executable: "/Applications/Josi.app/Contents/MacOS/Josi")
    }
}
