import AppKit
import Foundation

/// Metadata-only readiness for the app explicitly selected in the guest.
/// This never reads a window, creates an executor, launches an app or grants input.
@MainActor enum GuestApplicationReadiness {
    private struct Identity: Decodable {
        let serverId: UUID, userId: UUID, deviceId: UUID, workspaceId: UUID
    }
    private struct Reference: Decodable {
        let recordId: UUID
        let version: Int, epoch: Int
        let digest: String
    }
    private struct Projection: Decodable {
        let schemaVersion: Int, sessionId: UUID, identity: Identity, reference: Reference
        let application: GuestPinnedApplication
        let expiresAtMs: Int64, executionEnabled: Bool
    }
    private struct Request: Decodable {
        let requestId: UUID, candidateId: UUID, projection: Projection
    }
    private static func object(_ value: Any?, keys: [String]) throws -> [String: Any] {
        guard let result = value as? [String: Any], Set(result.keys) == Set(keys) else { throw GuestLinkError.invalid }
        return result
    }
    static func inspect(_ payload: String, selection: String, identity: [String: String], leaseUntil: Int) throws -> String {
        guard !payload.isEmpty, !selection.isEmpty else { return "" }
        guard payload.utf8.count <= 4096, let candidate = try JSONSerialization.jsonObject(with: Data(selection.utf8)) as? [String: String]
        else { throw GuestLinkError.invalid }
        let data = Data(payload.utf8)
        let raw = try object(JSONSerialization.jsonObject(with: data), keys: ["requestId", "candidateId", "projection"])
        let projection = try object(raw["projection"], keys: ["schemaVersion", "sessionId", "identity", "reference",
                                                            "application", "expiresAtMs", "executionEnabled"])
        _ = try object(projection["identity"], keys: ["serverId", "userId", "deviceId", "workspaceId"])
        _ = try object(projection["reference"], keys: ["recordId", "version", "digest", "epoch"])
        _ = try object(projection["application"], keys: ["workspaceId", "applicationId", "installationRevision",
                                                        "bundlePath", "bundleId", "signingId", "teamId", "codeHash"])
        let request = try JSONDecoder().decode(Request.self, from: data), p = request.projection, pin = p.application
        // A selection can change while the previous pulse is in flight.
        guard request.candidateId.uuidString.lowercased() == candidate["candidateId"] else { return "" }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard p.expiresAtMs > now else { return "" }
        guard p.schemaVersion == 1, !p.executionEnabled, p.expiresAtMs <= leaseUntil, p.expiresAtMs - now <= 10_000,
              p.identity.serverId.uuidString.lowercased() == identity["serverId"],
              p.identity.userId.uuidString.lowercased() == identity["userId"],
              p.identity.deviceId.uuidString.lowercased() == identity["deviceId"],
              p.identity.workspaceId.uuidString.lowercased() == identity["workspaceId"],
              pin.workspaceId == p.identity.workspaceId, pin.installationRevision > 0,
              p.reference.recordId.uuidString.lowercased() == "32eae367-3509-4241-9829-81c28b7b4088",
              p.reference.version > 0, p.reference.epoch > 0,
              p.reference.digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              pin.bundlePath == candidate["bundlePath"], pin.bundleId == candidate["bundleId"],
              pin.signingId == candidate["signingId"], pin.teamId == candidate["teamId"], pin.codeHash == candidate["codeHash"],
              !["com.apple.systempreferences", "com.apple.systemsettings", "com.apple.securityagent",
                "com.apple.loginwindow", "com.apple.keychainaccess"].contains(pin.bundleId.lowercased()),
              !pin.bundleId.lowercased().hasPrefix("com.heyjosi."),
              !pin.bundleId.lowercased().hasPrefix("com.socalreceptionist.josi")
        else { throw GuestLinkError.invalid }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: pin.bundleId)
        let state: String
        if apps.isEmpty { state = "not_running" }
        else if apps.count != 1 { state = "ambiguous" }
        else {
            do { try GuestDesktopEngine.verifyApplication(apps[0], pin: pin); state = "running" }
            catch { state = "changed" }
        }
        // Signature inspection can take time; an expired result is not ready.
        guard p.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000) else { return "" }
        return String(decoding: try GuestLinkWire.encode([
            "requestId": request.requestId.uuidString.lowercased(), "applicationId": pin.applicationId.uuidString.lowercased(),
            "installationRevision": String(pin.installationRevision), "state": state,
        ]), as: UTF8.self)
    }
}
