import Foundation

/// Sends one approved PC Control request to the part of Josi that does it.
/// Browser work needs a linked browser; everything else runs on this Mac.
func pcDispatch(_ request: Wire, cancel: PcCancel) async -> PcOutcome {
    let payload = request["payload"], kind = payload["kind"].text
    let scope = request["requirements"].list.first?["scope"] ?? .null
    switch kind {
    case "desktop.environment": return PcWork.environment()
    case "desktop.apps": return PcWork.findApps(payload["query"].text)
    case "desktop.command":
        guard scope["kind"].text == "command" else { return pcRefuse("scope_mismatch") }
        return PcWork.command(payload, scope, cancel: cancel)
    case "desktop.admin.command":
        return pcRefuse("unsupported_on_mac", "Administrator commands are not available on a Mac.")
    case "desktop.folder", "desktop.readfile", "desktop.writefile":
        guard scope["kind"].text == "folder" else { return pcRefuse("scope_mismatch") }
        return kind == "desktop.folder" ? PcWork.listFolder(payload, scope) : kind == "desktop.readfile" ? PcWork.readFile(payload, scope) : PcWork.writeFile(payload, scope)
    default:
        if kind.hasPrefix("desktop.terminal.") { return PcTerminals.shared.execute(requestId: request.identifier, payload: payload, scope: scope) }
        if kind.hasPrefix("desktop.") { return await PcDesktop.shared.perform(kind: kind, requestId: request.identifier, payload: payload, scope: scope, cancel: cancel) }
        return await PcBrowserBridge.shared.dispatch(request, cancel: cancel)
    }
}
