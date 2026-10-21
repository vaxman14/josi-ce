import Foundation
import Security
import Darwin

enum GuestBrowserError: Error { case unavailable, invalid, expired }

/// Only the signed stdio host and Safari extension call this interface.
/// No endpoint, policy, credential or command-line execution is configurable.
@objc protocol GuestBrowserExchange {
    func exchange(_ request: Data, peer: Data, reply: @escaping (Data?, NSError?) -> Void)
}
@objc protocol GuestBrowserOwner {
    func renew(_ authority: Data, reply: @escaping (Bool) -> Void)
    func stop()
}
@objc protocol GuestBrowserOwnerCallback {
    func handle(_ request: Data, peer: Data, reply: @escaping (Data?, NSError?) -> Void)
}

enum GuestBrowserBoundary {
    static let service = "com.heyjosi.ce.browser"
    static let ownerService = "com.heyjosi.ce.browser.control"
    static let brokerIdentifier = "com.heyjosi.ce.browser-broker"
    static let maximumBytes = 192 * 1024
    static func requirement(_ identifier: String) -> String {
        "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"LRH75YR6QW\""
    }
    static func isolatedBoot() throws -> (guest: String, host: String) {
        func uuid(_ name: String) throws -> String {
            var size = 0
            guard sysctlbyname(name, nil, &size, nil, 0) == 0, (1...64).contains(size) else { throw GuestBrowserError.unavailable }
            var raw = [CChar](repeating: 0, count: size)
            guard sysctlbyname(name, &raw, &size, nil, 0) == 0 else { throw GuestBrowserError.unavailable }
            let value = String(decoding: raw.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self).lowercased()
            guard UUID(uuidString: value)?.uuidString.lowercased() == value else { throw GuestBrowserError.invalid }
            return value
        }
        let boot = try uuid("kern.bootsessionuuid")
        return (boot, boot)
    }
    static func requireSelf(identifier: String, executable: String) throws {
        _ = try isolatedBoot()
        var code: SecCode?, requirement: SecRequirement?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(Self.requirement(identifier) as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
        else { throw GuestBrowserError.unavailable }
        var info: CFDictionary?, source: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &source) == errSecSuccess, let source,
              SecCodeCopySigningInformation(source, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let value = info as? [String: Any],
              (value[kSecCodeInfoMainExecutable as String] as? URL)?.standardizedFileURL.path == executable,
              let flags = value[kSecCodeInfoFlags as String] as? NSNumber, flags.uint32Value & 0x00010000 != 0
        else { throw GuestBrowserError.unavailable }
        var container: SecStaticCode?, containerRequirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: "/Applications/Josi.app") as CFURL, [], &container) == errSecSuccess,
              let container, SecRequirementCreateWithString(Self.requirement("com.heyjosi.ce.unified") as CFString, [], &containerRequirement) == errSecSuccess,
              let containerRequirement, SecStaticCodeCheckValidity(container, SecCSFlags(rawValue: kSecCSStrictValidate), containerRequirement) == errSecSuccess
        else { throw GuestBrowserError.unavailable }
        let entitlements = value[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
        for key in ["get-task-allow", "com.apple.security.get-task-allow",
                    "com.apple.security.cs.disable-library-validation", "com.apple.security.cs.allow-dyld-environment-variables"] {
            if (entitlements[key] as? NSNumber)?.boolValue == true { throw GuestBrowserError.unavailable }
        }
    }
    static func request(_ data: Data) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= maximumBytes,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["version", "requestId", "sessionId", "operation", "payload"],
              let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let id = value["requestId"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let operation = value["operation"] as? String,
              ["browser.hello", "browser.poll", "browser.authorize", "browser.receipt", "browser.stop"].contains(operation),
              value["payload"] is [String: Any] else { throw GuestBrowserError.invalid }
        if !(value["sessionId"] is NSNull) {
            guard let session = value["sessionId"] as? String, UUID(uuidString: session)?.uuidString.lowercased() == session
            else { throw GuestBrowserError.invalid }
        }
        return value
    }
}

/// One connection to the per-user guest service. Both endpoints enforce a
/// designated signature through public macOS 13+ XPC APIs, before any RPC.
/// The broker still has to prove the live workspace/profile and server grant.
final class GuestBrowserClient: @unchecked Sendable {
    private let connection: NSXPCConnection
    init() {
        connection = NSXPCConnection(machServiceName: GuestBrowserBoundary.service)
        connection.remoteObjectInterface = NSXPCInterface(with: GuestBrowserExchange.self)
        connection.setCodeSigningRequirement(GuestBrowserBoundary.requirement(GuestBrowserBoundary.brokerIdentifier))
        connection.resume()
    }
    deinit { connection.invalidate() }
    func exchange(_ request: Data, peer: Data, completion: @escaping @Sendable (Data?) -> Void) {
        guard (try? GuestBrowserBoundary.request(request)) != nil, peer.count <= 8192 else { completion(nil); return }
        let reply = GuestBrowserReply(completion)
        let timeout = DispatchWorkItem { reply.finish(nil) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 4, execute: timeout)
        guard let remote = connection.remoteObjectProxyWithErrorHandler({ _ in
            timeout.cancel(); reply.finish(nil)
        }) as? GuestBrowserExchange else { timeout.cancel(); reply.finish(nil); return }
        remote.exchange(request, peer: peer) { data, error in
            timeout.cancel()
            guard error == nil, let data, data.count <= GuestBrowserBoundary.maximumBytes,
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let input = try? GuestBrowserBoundary.request(request),
                  value["requestId"] as? String == input["requestId"] as? String else { reply.finish(nil); return }
            reply.finish(data)
        }
    }
}

private final class GuestBrowserReply: @unchecked Sendable {
    private let lock = NSLock()
    private var completion: (@Sendable (Data?) -> Void)?
    init(_ completion: @escaping @Sendable (Data?) -> Void) { self.completion = completion }
    func finish(_ data: Data?) {
        lock.lock(); let callback = completion; completion = nil; lock.unlock()
        callback?(data)
    }
}
