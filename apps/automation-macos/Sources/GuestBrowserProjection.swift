import Foundation

struct GuestCanonicalBrowser {
    let profileId: UUID, recordId: UUID
    let version: Int, epoch: Int, digest: String
    let expiresAtMs: Int64
    let prepared: GuestBrowserProfiles.Prepared
}

/// Current Vault metadata received through the paired host. This projection
/// identifies a target; it grants no browser operation or extension session.
@MainActor enum GuestBrowserProjection {
    private static func object(_ value: Any?, keys: Set<String>) throws -> [String: Any] {
        guard let value = value as? [String: Any], Set(value.keys) == keys else { throw GuestLinkError.invalid }
        return value
    }
    private static func integer(_ value: Any?) throws -> Int64 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == Double(number.int64Value), number.int64Value >= 0 else { throw GuestLinkError.invalid }
        return number.int64Value
    }
    static func resolve(_ raw: String, prepared: GuestBrowserProfiles.Prepared?, identity: [String: String],
                        application: GuestPinnedApplication?, leaseUntil: Int) throws -> GuestCanonicalBrowser? {
        guard !raw.isEmpty, let prepared, application == prepared.application else { return nil }
        guard raw.utf8.count <= 4096 else { throw GuestLinkError.invalid }
        let packet = try object(JSONSerialization.jsonObject(with: Data(raw.utf8)), keys: ["candidateId", "projection"])
        // An earlier selection may still be in flight.
        guard packet["candidateId"] as? String == prepared.candidate.candidateId else { return nil }
        let p = try object(packet["projection"], keys: ["schemaVersion", "sessionId", "identity", "reference", "browser", "expiresAtMs", "executionEnabled"])
        let i = try object(p["identity"], keys: ["userId", "serverId", "deviceId", "workspaceId"])
        let r = try object(p["reference"], keys: ["recordId", "version", "epoch", "digest"])
        let b = try object(p["browser"], keys: ["profileId", "profileRevision", "identity", "candidate", "registeredAt"])
        let bi = try object(b["identity"], keys: Set(i.keys))
        let candidate = try object(b["candidate"], keys: ["schemaVersion", "kind", "candidateId", "guestBootId", "label", "family",
            "applicationId", "installationRevision", "nativeProfileId", "profilePath", "extensionId", "extensionVersion", "extensionDigest", "distribution"])
        let now = Int64(Date().timeIntervalSince1970 * 1000), expiry = try integer(p["expiresAtMs"])
        guard expiry > now else { return nil }
        guard try integer(p["schemaVersion"]) == 1, p["executionEnabled"] as? Bool == false,
              let session = p["sessionId"] as? String, UUID(uuidString: session)?.uuidString.lowercased() == session,
              expiry <= leaseUntil, expiry - now <= 10_000,
              i.allSatisfy({ $0.value as? String == identity[$0.key] }),
              bi.allSatisfy({ $0.value as? String == identity[$0.key] }),
              try integer(b["profileRevision"]) == 1,
              let profile = b["profileId"] as? String, let profileId = UUID(uuidString: profile), profileId.uuidString.lowercased() == profile,
              candidate["candidateId"] as? String == profile,
              let record = r["recordId"] as? String, record == "32eae367-3509-4241-9829-81c28b7b4088",
              let recordId = UUID(uuidString: record), let digest = r["digest"] as? String,
              digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw GuestLinkError.invalid }
        let version = try integer(r["version"]), epoch = try integer(r["epoch"])
        guard version > 0, epoch > 0, version <= Int.max, epoch <= Int.max,
              let expected = try JSONSerialization.jsonObject(with: JSONEncoder().encode(prepared.candidate)) as? [String: Any]
        else { throw GuestLinkError.invalid }
        let ignored: Set<String> = ["candidateId", "guestBootId", "label"]
        guard NSDictionary(dictionary: candidate.filter { !ignored.contains($0.key) })
            .isEqual(to: expected.filter { !ignored.contains($0.key) }) else { throw GuestLinkError.invalid }
        return GuestCanonicalBrowser(profileId: profileId, recordId: recordId, version: Int(version), epoch: Int(epoch),
            digest: digest, expiresAtMs: expiry, prepared: prepared)
    }
}
