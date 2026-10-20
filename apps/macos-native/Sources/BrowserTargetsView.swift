import SwiftUI

enum NativeBrowserTargetWire {
    static func candidate(_ value: Wire, guestBoot: String, workspace: String) -> Bool {
        guard ProtectedWire.exact(value, ["schemaVersion", "kind", "candidateId", "guestBootId", "label", "family",
            "applicationId", "installationRevision", "nativeProfileId", "profilePath", "extensionId", "extensionVersion",
            "extensionDigest", "distribution"]),
              value["schemaVersion"] == .string("1"), value["kind"] == .string("browser"),
              value["guestBootId"] == .string(guestBoot),
              ["candidateId", "guestBootId", "applicationId", "nativeProfileId"].allSatisfy({ ProtectedWire.uuid(value[$0]) }),
              value["installationRevision"] == .number(1), ProtectedWire.text(value["label"], max: 96),
              ["chrome", "brave", "firefox", "safari"].contains(value["family"].text),
              ["unpacked-development", "store-signed"].contains(value["distribution"].text),
              ProtectedWire.text(value["extensionVersion"], max: 64),
              ProtectedWire.matches(value["extensionVersion"], "^[0-9]+(?:\\.[0-9]+){1,3}$"),
              ProtectedWire.matches(value["extensionDigest"], "^[a-f0-9]{64}$") else { return false }
        if value["family"] == .string("safari") {
            return value["profilePath"] == .null && value["extensionId"] == .string("com.heyjosi.ce.guestcompanion.workspace-safari")
        }
        let path = value["profilePath"].text
        let suffix = "/Library/Application Support/Josi Workspace/Profiles/" + workspace + "/" + value["nativeProfileId"].text
        guard ProtectedWire.text(value["profilePath"], max: 1024), path.hasPrefix("/Users/"), path.hasSuffix(suffix),
              !path.dropFirst(7).dropLast(suffix.count).isEmpty,
              !path.dropFirst(7).dropLast(suffix.count).contains("/"),
              !path.contains("\\"), !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return false }
        return value["family"] == .string("firefox")
            ? ProtectedWire.text(value["extensionId"], max: 128) && ProtectedWire.matches(value["extensionId"], "^[a-zA-Z0-9@{}_.-]+$")
            : ProtectedWire.matches(value["extensionId"], "^[a-p]{32}$")
    }
    static func matches(_ candidate: Wire, _ target: Wire, identity: Wire) -> Bool {
        target["identity"] == identity && ["family", "applicationId", "installationRevision", "nativeProfileId", "profilePath",
            "extensionId", "extensionVersion", "extensionDigest", "distribution"].allSatisfy { target["candidate"][$0] == candidate[$0] }
    }
}

struct NativeBrowserRegistrationView: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject var connection: NativeGuestConnection
    var body: some View {
        let registry = model.automationSettings["targets"]
        if registry != .null, let change = try? connection.browserRegistration(registry: registry) {
            let candidate = change["candidate"]
            Divider()
            Text(candidate["label"].text).font(.headline)
            if registry["browsers"].list.contains(where: { NativeBrowserTargetWire.matches(candidate, $0, identity: connection.identity) }) {
                Text("This browser profile is registered. Choose its sites, operations and limits in Automation Settings.")
                    .font(.caption)
            } else {
                Text("Register this separate browser profile before adding site permissions. Saving closes this development desktop; reopen it when ready.")
                    .font(.caption).foregroundStyle(.secondary)
                Text(candidate["family"].text.capitalized + " · Extension " + candidate["extensionVersion"].text).font(.caption)
                NativeProtectedChange(title: "Register This Browser Profile…", change: change,
                    checkSelection: { try connection.requireBrowserSelection(change, registry: model.automationSettings["targets"]) },
                    requiredDevice: change["identity"]["deviceId"].text)
            }
        }
    }
}

struct NativeRegisteredBrowsersView: View {
    @EnvironmentObject var model: JosiModel
    var body: some View {
        let browsers = model.automationSettings["targets"]["browsers"].list
        if !browsers.isEmpty {
            GroupBox("Registered browser profiles") {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(browsers.enumerated()), id: \.offset) { _, target in
                        Text(target["candidate"]["label"].text).font(.headline)
                        Text(target["candidate"]["family"].text.capitalized + " · Extension " + target["candidate"]["extensionVersion"].text).font(.caption)
                        Text("Workspace: " + target["identity"]["workspaceId"].text).font(.caption).textSelection(.enabled)
                    }
                    Text("Each profile needs its own site permissions below. Browser and extension updates require a new registration.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
