import Foundation
import SafariServices

/// Safari supplies the profile identity. JavaScript cannot substitute its own
/// profile, workspace, server or permission record for that OS context.
final class JosiSafariExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let client = GuestBrowserClient()
    func beginRequest(with context: NSExtensionContext) {
        do {
            try GuestBrowserBoundary.requireSelf(identifier: "com.heyjosi.ce.unified.workspace-safari",
                executable: "/Applications/Josi.app/Contents/PlugIns/Josi Workspace.appex/Contents/MacOS/JosiWorkspaceSafari")
            let boot = try GuestBrowserBoundary.isolatedBoot()
            guard context.inputItems.count == 1, let input = context.inputItems.first as? NSExtensionItem,
                  let profile = input.userInfo?[SFExtensionProfileKey] as? UUID,
                  let message = input.userInfo?[SFExtensionMessageKey] as? [String: Any] else { throw GuestBrowserError.invalid }
            let request = try JSONSerialization.data(withJSONObject: message)
            _ = try GuestBrowserBoundary.request(request)
            let peer = try JSONSerialization.data(withJSONObject: [
                "kind": "safari-profile", "family": "safari", "profileId": profile.uuidString.lowercased(),
                "guestBootId": boot.guest, "hostBootId": boot.host,
                "extensionId": "com.heyjosi.ce.unified.workspace-safari",
            ], options: [.sortedKeys])
            let reply = SafariReply(context)
            client.exchange(request, peer: peer) { reply.finish($0) }
        } catch { SafariReply(context).finish(nil) }
    }
}

private final class SafariReply: @unchecked Sendable {
    private let context: NSExtensionContext
    init(_ context: NSExtensionContext) { self.context = context }
    func finish(_ data: Data?) {
        guard let data, let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            context.cancelRequest(withError: NSError(domain: "JosiWorkspace", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The authorized current browser connection is unavailable."]))
            return
        }
        let result = NSExtensionItem()
        result.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [result], completionHandler: nil)
    }
}
