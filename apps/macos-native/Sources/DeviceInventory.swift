import Foundation

enum NativeDeviceInventory {
    static func validate(_ value: Wire, user: String, previous: Wire = .null) throws -> Wire {
        guard case .array(let devices) = value["devices"],
              case .bool = value["reconciliationRequired"], value["authorityEpoch"].integer > 0 else {
            throw JosiError(message: "Josi could not read the saved devices. Refresh Saved Devices; an unreadable response does not mean no Macs are enrolled.")
        }
        let reference = value["reference"]
        if reference != .null {
            guard reference["recordId"].text == "914a736a-94bf-46f2-a602-82ff4180c45d",
                  reference["version"].integer > 0, reference["epoch"].integer > 0,
                  ProtectedWire.matches(reference["digest"], "^[a-f0-9]{64}$") else { throw approvalUnavailable() }
        }
        guard devices.isEmpty || reference != .null else { throw approvalUnavailable() }
        for device in devices {
            guard ProtectedWire.uuid(device["enrollmentId"]), ProtectedWire.uuid(device["identity"]["deviceId"]),
                  ProtectedWire.uuid(device["identity"]["serverId"]), device["identity"]["userId"].text == user,
                  !device["identity"]["serverOrigin"].text.isEmpty,
                  !device["label"].text.isEmpty,
                  device["revokedAt"] == .null || !device["revokedAt"].text.isEmpty else { throw approvalUnavailable() }
        }
        let old = previous["reference"]
        guard old == .null || reference != .null && reference["version"].integer >= old["version"].integer else {
            throw JosiError(message: "The refreshed device list is older than the saved enrollment. Keep the existing enrollment and refresh again.")
        }
        if old != .null, reference["version"] == old["version"], reference["digest"] != old["digest"] {
            throw JosiError(message: "The saved device list could not be verified. Keep the existing enrollment and check the server.")
        }
        return value
    }
    static func confirms(_ inventory: Wire, enrollment: Wire, identity: Wire) -> Bool {
        inventory["devices"].list.contains {
            $0["enrollmentId"] == enrollment && $0["identity"] == identity && $0["revokedAt"] == .null
        }
    }
}
