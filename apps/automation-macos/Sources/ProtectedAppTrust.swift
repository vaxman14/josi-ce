import Foundation
import Security

// Shared code identity check for the signing parent and kernel-identified
// local consent peer. It grants no authority to a claimed PID or bundle ID.
enum ProtectedAppTrustError: Error { case unavailable }
enum ProtectedAppTrust {
    static let appURL = URL(fileURLWithPath: "/Applications/Josi.app", isDirectory: true)
    static func requirement() throws -> SecRequirement {
        var value: SecRequirement?
        let rule = "anchor apple generic and identifier \"com.heyjosi.ce.unified\" and certificate leaf[subject.OU] = \"LRH75YR6QW\""
        guard SecRequirementCreateWithString(rule as CFString, [], &value) == errSecSuccess, let value else { throw ProtectedAppTrustError.unavailable }
        return value
    }
    static func verify(_ dynamic: SecCode, requirement: SecRequirement, full: Bool) throws {
        guard SecCodeCheckValidity(dynamic, [], requirement) == errSecSuccess else { throw ProtectedAppTrustError.unavailable }
        var code: SecStaticCode?
        guard SecCodeCopyStaticCode(dynamic, [], &code) == errSecSuccess, let code else { throw ProtectedAppTrustError.unavailable }
        if full {
            guard SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw ProtectedAppTrustError.unavailable }
        }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let info = information as? [String: Any],
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber,
              // CS_RUNTIME from Security/CSCommon.h is not imported by Swift.
              flags.uint32Value & 0x00010000 != 0,
              let executable = info[kSecCodeInfoMainExecutable as String] as? URL,
              executable.standardizedFileURL.path == appURL.appendingPathComponent("Contents/MacOS/Josi").path else { throw ProtectedAppTrustError.unavailable }
        let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
        for name in ["com.apple.security.get-task-allow", "get-task-allow",
                     "com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.disable-library-validation"] {
            if (entitlements[name] as? NSNumber)?.boolValue == true { throw ProtectedAppTrustError.unavailable }
        }
    }
    static func packagedCode() throws {
        let contents = appURL.appendingPathComponent("Contents", isDirectory: true)
        let plist = try Data(contentsOf: contents.appendingPathComponent("Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "com.heyjosi.ce.unified",
              info["JosiProtectedHostProtocol"] as? Int == 1 else { throw ProtectedAppTrustError.unavailable }
        // The SwiftUI/AppKit client contains compiled application code.
        // verify() still requires the exact installed path, Socal signature,
        // sealed resources, hardened runtime and restricted entitlements.
        if info["JosiNativeClientProtocol"] as? Int == 1 {
            guard info["CFBundleExecutable"] as? String == "Josi",
                  !FileManager.default.fileExists(atPath: contents.appendingPathComponent("Resources/app.asar").path),
                  !FileManager.default.fileExists(atPath: contents.appendingPathComponent("Resources/app").path),
                  !FileManager.default.fileExists(atPath: contents.appendingPathComponent("Frameworks/Electron Framework.framework").path)
            else { throw ProtectedAppTrustError.unavailable }
            return
        }
        guard
              let integrity = info["ElectronAsarIntegrity"] as? [String: [String: String]],
              integrity["Resources/app.asar"]?["algorithm"] == "SHA256",
              let hash = integrity["Resources/app.asar"]?["hash"], hash.count == 64,
              hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              !FileManager.default.fileExists(atPath: contents.appendingPathComponent("Resources/app").path) else { throw ProtectedAppTrustError.unavailable }
        // Pinned Electron V1 fuse layout. Refuse unrecognized/removed fuses.
        // Code signing above validates these bytes and the packaged ASAR hash.
        let binaryURL = contents.appendingPathComponent("Frameworks/Electron Framework.framework/Versions/A/Electron Framework")
        let size = try binaryURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 512 * 1024 * 1024 else { throw ProtectedAppTrustError.unavailable }
        let binary = try Data(contentsOf: binaryURL, options: .mappedIfSafe)
        let sentinel = Data("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8)
        guard let range = binary.range(of: sentinel), range.upperBound + 11 <= binary.count,
              binary.range(of: sentinel, in: range.upperBound..<binary.count) == nil,
              binary[range.upperBound] == 1, binary[range.upperBound + 1] == 9 else { throw ProtectedAppTrustError.unavailable }
        let start = range.upperBound + 2
        for (index, expected) in [0: UInt8(48), 2: 48, 3: 48, 4: 49, 5: 49, 7: 48] {
            guard binary[start + index] == expected else { throw ProtectedAppTrustError.unavailable }
        }
    }
}
