// Echo-only P0 fixture. No observation, file, network, or execution authority.
import SafariServices
import CoreFoundation

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let request = context.inputItems.first as? NSExtensionItem,
              let message = request.userInfo?[SFExtensionMessageKey] as? [String: Any],
              Set(message.keys) == Set(["version", "method", "nonce"]),
              let version = message["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              message["method"] as? String == "probe",
              let nonce = message["nonce"] as? String, !nonce.isEmpty, nonce.count <= 128 else {
            context.cancelRequest(withError: NSError(domain: "JosiP0", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unsupported probe request"]))
            return
        }
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["version": 1, "method": "probe", "nonce": nonce]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
