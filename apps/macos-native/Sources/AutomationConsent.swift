import AppKit
import SwiftUI

extension ProtectedWire {
    static func consentChallenge(_ value: Wire, workspace: Wire, session: Wire, guest: Wire,
                                 origin: String, user: String) throws -> Data {
        let base = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId",
                    "keyReference", "wrappingFingerprint", "issuedAtMs", "expiresAtMs"]
        guard exact(value, base + ["workspaceId", "label", "storageSessionId", "guestBootId", "guestChannelId",
                                  "consentUntilMs", "permissions", "cardinal"]),
              value["workspaceId"] == workspace["workspaceId"], value["label"] == workspace["label"],
              identity(value) == workspace["identity"],
              value["storageSessionId"] == session["sessionId"], value["consentUntilMs"] == session["expiresAtMs"],
              value["guestBootId"] == guest["guestBootId"], value["guestChannelId"] == guest["guestChannelId"],
              ["workspaceId", "storageSessionId", "guestBootId", "guestChannelId"].allSatisfy({ uuid(value[$0]) }),
              text(value["label"], max: 120), integer(value["consentUntilMs"]),
              value["consentUntilMs"].integer > value["expiresAtMs"].integer,
              value["consentUntilMs"].integer - value["issuedAtMs"].integer <= 7_200_000,
              value["keyReference"]["recordId"].text == "914a736a-94bf-46f2-a602-82ff4180c45d"
        else { throw approvalUnavailable() }
        let host = Wire.object(Dictionary(uniqueKeysWithValues: base.map { ($0, value[$0]) }))
        _ = try challenge(host, host: true, origin: origin, user: user, device: workspace["identity"]["deviceId"].text)
        func reference(_ v: Wire, id: String) throws -> Wire {
            guard exact(v, ["recordId", "version", "digest", "epoch"]), v["recordId"].text == id,
                  integer(v["version"], positive: true), matches(v["digest"], "^[a-f0-9]{64}$"),
                  v["epoch"] == value["keyReference"]["epoch"] else { throw approvalUnavailable() }
            return .array([v["recordId"], v["version"], v["digest"], v["epoch"]])
        }
        let key = value["keyReference"]
        var fields = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId"].map { value[$0] }
        fields += [.array([key["recordId"], key["version"], key["digest"], key["epoch"]]),
                   value["wrappingFingerprint"], value["issuedAtMs"], value["expiresAtMs"],
                   value["workspaceId"], value["label"], value["storageSessionId"], value["guestBootId"],
                   value["guestChannelId"], value["consentUntilMs"],
                   try reference(value["permissions"], id: "5864be11-7936-43c5-a8bc-5c725df6c1fd"),
                   try reference(value["cardinal"], id: "ea230e88-65fc-4c35-b05d-1792c00471cf")]
        return Data(("josi-automation-consent.1\n" + (try canonical(.array(fields)))).utf8)
    }
}

@MainActor enum NativeAutomationConsent {
    static func approve(model: JosiModel, workspace: Wire, session: Wire, guest: Wire,
                        current: @MainActor () throws -> Void) async throws -> Wire {
        guard model.isAdministrator, NativeProtectedApproval.available, let api = model.api,
              let parent = NSApp.keyWindow else { throw approvalUnavailable() }
        let user = model.user["id"], sessionID = try api.uuid(session["sessionId"].text)
        let base = "/admin/automation/storage/sessions/\(sessionID)/consent"
        func valid() throws {
            guard model.api === api, model.user["id"] == user, parent.isVisible, !Task.isCancelled else { throw approvalUnavailable() }
            try current()
        }
        try valid()
        let response = try await api.request(base + "/prepare", method: "POST", body: guest)
        let c = response["challenge"], id = try api.uuid(c["id"].text)
        var port: NativeKeyPort?
        var review: NativeApprovalWindow?
        var submitted = false
        defer {
            port?.cancel(); review?.close()
            if !submitted { Task { _ = try? await api.request(base + "/cancel", method: "POST", body: ["challengeId": .string(id)]) } }
        }
        let message = try ProtectedWire.consentChallenge(c, workspace: workspace, session: session, guest: guest,
                                                        origin: api.origin.absoluteString, user: user.text)
        try valid()
        let lease = try ApprovalLease(c), key = NativeKeyPort(identity: ProtectedWire.identity(c))
        port = key
        guard case .object(var presentation) = c else { throw approvalUnavailable() }
        presentation["purpose"] = "automation.consent"
        presentation["presentation"] = [
            "wording": .string("Allow Josi to work in \(workspace["label"].text)"),
            "meaning": .string("Josi may use this separate desktop under your current permissions and Cardinal Rules. Each action must still pass those rules.\nThis approval ends when the desktop or connection closes, the rules change, or this development session expires."),
            "advisory": .array(["Use Stop Automation at any time. Your personal desktop is outside this approval.",
                               "This does not add permissions or change permanent rules."]),
        ]
        let window = NativeApprovalWindow(challenge: .object(presentation), lease: lease, cancelAuthentication: { key.cancel() })
        review = window
        guard await window.present(parent: parent) else { throw approvalUnavailable() }
        try valid(); try window.current()
        try await key.start()
        let signed = try await key.request("proveAutomationConsent", fields: ["message": .string(message.base64EncodedString())])
        let signature = try ProtectedWire.signature(signed, host: true)
        try valid(); try window.current()
        submitted = true; window.phase = "saving"
        do {
            let result = try await api.request(base + "/authorize", method: "POST", body: [
                "challengeId": .string(id), "proof": ["challengeDigest": .string(ProtectedWire.digest(message)), "signature": .string(signature)],
            ])
            try valid(); try window.current()
            guard ProtectedWire.exact(result, ["schemaVersion", "sessionId", "challengeId", "identity", "guestBootId",
                "guestChannelId", "reference", "permissions", "cardinal", "expiresAtMs", "leaseUntilMs", "executionEnabled"]),
                  result["schemaVersion"] == .number(1), result["sessionId"] == session["sessionId"],
                  result["challengeId"] == c["id"], result["guestBootId"] == guest["guestBootId"],
                  result["guestChannelId"] == guest["guestChannelId"],
                  result["permissions"] == c["permissions"], result["cardinal"] == c["cardinal"],
                  result["reference"]["recordId"] == session["sessionId"],
                  ProtectedWire.exact(result["reference"], ["recordId", "version", "digest", "epoch"]),
                  ProtectedWire.integer(result["reference"]["version"], positive: true),
                  ProtectedWire.matches(result["reference"]["digest"], "^[a-f0-9]{64}$"),
                  result["reference"]["epoch"] == c["keyReference"]["epoch"],
                  result["expiresAtMs"] == c["consentUntilMs"], result["executionEnabled"] == .bool(false),
                  result["identity"] == .object(["userId": c["userId"], "serverId": c["serverId"],
                      "deviceId": c["deviceId"], "workspaceId": c["workspaceId"]])
            else { throw approvalUnavailable() }
            window.close(); key.cancel()
            return result
        } catch {
            // A lost response may still have committed. Clear local state and
            // request durable revocation; never retry the proof automatically.
            _ = try? await api.request(base + "/stop", method: "POST", body: [:])
            throw error
        }
    }
}
