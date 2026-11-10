import AppKit
import Foundation
import SafariServices
import ServiceManagement

/// The running Josi's side of the browser extension on this Mac. Safari's
/// extension (inside Josi.app) and the Chrome or Brave native host reach Josi
/// through the signed browser broker; Josi registers as its owner here. A
/// browser you allow links with no tab, lists its tabs so chat can name one,
/// and attaches one tab at a time. PC Control decides every read or action;
/// this claims the approved work and hands it to the extension. Page content
/// passes through to the server result and is not kept here.
final class PcBrowserBridge: NSObject, GuestBrowserOwnerCallback, @unchecked Sendable {
    static let shared = PcBrowserBridge()
    private static let sessionMs: Int64 = 55_000, commandSeconds = 20.0, observationBytes = 60_000
    private static let uploadBytes = 8 * 1024 * 1024, chunkBytes = 120 * 1024, presenceTabs = 30
    private static let safariExtension = JosiEdition.current.safariExtension
    private static let allowedKey = "josi.pc.browserProfiles", workspaceKey = "josi.pc.browserWorkspace", lastKey = "josi.pc.browserLast"

    private final class Pending: @unchecked Sendable {
        let commandId = UUID().uuidString.lowercased()
        var command: [String: Wire] = [:], activity = "", value: String?, shown = false
        var file: Data?, fileName = "", mediaType = ""
        /// A Safari download Josi saves for the extension: authorized first, then
        /// its pieces in order, at most 8 MB.
        var authorized = false, saving = Data(), saved: String?
        private let lock = NSLock(); private var continuation: CheckedContinuation<PcOutcome, Never>?, result: PcOutcome?
        func wait() async -> PcOutcome {
            await withCheckedContinuation { next in
                lock.lock()
                if let result { lock.unlock(); next.resume(returning: result); return }
                continuation = next; lock.unlock()
            }
        }
        func finish(_ outcome: PcOutcome) {
            lock.lock(); guard result == nil else { lock.unlock(); return }
            result = outcome; let waiting = continuation; continuation = nil; lock.unlock()
            waiting?.resume(returning: outcome)
        }
    }
    struct Tab: Equatable { let id: Int; let origin: String; let title: String; let active: Bool }
    private final class Link {
        let sessionId = UUID().uuidString.lowercased()
        let profileId: String, family: String, browser: String, application: String
        var tabId = -1, url: String?, title: String?, origins: [String] = [], lastPoll = Date()
        var active: Tab?, tabs: [Tab] = [], queued: Pending?, sent: Pending?
        init(profileId: String, family: String, browser: String, application: String) {
            self.profileId = profileId; self.family = family; self.browser = browser; self.application = application
        }
    }
    struct Discovery: Equatable { let nativeProfileId: String, browser: String, family: String, application: String, origin: String? }

    private let lock = NSLock()
    private var link: Link?
    private(set) var discovered: Discovery?
    private var blockedFlag = false
    private let workspaceId: String
    private var connection: NSXPCConnection?
    private var connectionId = UUID().uuidString.lowercased()
    private var started = false
    /// Raised on the main thread when the link, its tabs or a browser asking to link change.
    var onChange: (@MainActor () -> Void)?

    private override init() {
        if let saved = UserDefaults.standard.string(forKey: Self.workspaceKey), UUID(uuidString: saved) != nil { workspaceId = saved }
        else { workspaceId = UUID().uuidString.lowercased(); UserDefaults.standard.set(workspaceId, forKey: Self.workspaceKey) }
        super.init()
    }
    var blocked: Bool {
        get { lock.lock(); defer { lock.unlock() }; return blockedFlag }
        set { lock.lock(); blockedFlag = newValue; lock.unlock() }
    }
    private func live() -> Bool { link.map { Date().timeIntervalSince($0.lastPoll) < 10 } ?? false }
    private func changed() { Task { @MainActor in self.onChange?() } }

    // ------------------------------------------------------------ allowed browsers
    struct Allowed: Codable, Equatable { let nativeProfileId: String, profileId: String, browser: String, family: String, application: String }
    var allowedBrowsers: [Allowed] {
        (UserDefaults.standard.data(forKey: Self.allowedKey)).flatMap { try? JSONDecoder().decode([Allowed].self, from: $0) } ?? []
    }
    private func saveAllowed(_ list: [Allowed]) { UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: Self.allowedKey) }
    func allowDiscovered() {
        lock.lock(); let found = discovered; discovered = nil; lock.unlock()
        guard let found else { return }
        var list = allowedBrowsers.filter { $0.nativeProfileId != found.nativeProfileId }
        list.append(Allowed(nativeProfileId: found.nativeProfileId, profileId: UUID().uuidString.lowercased(), browser: found.browser, family: found.family, application: found.application))
        saveAllowed(list); changed()
    }
    func ignoreDiscovered() { lock.lock(); discovered = nil; lock.unlock(); changed() }
    func remove(_ nativeProfileId: String) {
        saveAllowed(allowedBrowsers.filter { $0.nativeProfileId != nativeProfileId })
        lock.lock(); if let link, !allowedBrowsers.contains(where: { $0.profileId == link.profileId }) { end(link, "removed"); self.link = nil }; lock.unlock()
        changed()
    }
    func disconnect() { lock.lock(); if let link { end(link, "disconnected") }; link = nil; lock.unlock(); changed() }
    var discovery: Discovery? { lock.lock(); defer { lock.unlock() }; return discovered }
    var linkedBrowser: String? { lock.lock(); defer { lock.unlock() }; return live() ? link?.browser : nil }

    // ------------------------------------------------------------ the broker
    /// Starts the browser broker (a login item inside Josi.app) and becomes its owner.
    func start() {
        lock.lock(); guard !started else { lock.unlock(); return }; started = true; lock.unlock()
        let service = SMAppService.agent(plistName: JosiEdition.current.agent + ".plist")
        if service.status == .notRegistered || service.status == .notFound { try? service.register() }
        Self.installNativeHosts()
        Task.detached { [weak self] in
            while let self {
                self.renew()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
    /// Lets Chrome and Brave start Josi's signed native host for the Josi extension,
    /// for browsers installed for this person. An existing different file is left alone.
    private static func installNativeHosts() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for (family, vendor) in [("chrome", "Google/Chrome"), ("brave", "BraveSoftware/Brave-Browser")] {
            let browserFolder = home + "/Library/Application Support/" + vendor
            guard FileManager.default.fileExists(atPath: browserFolder),
                  let source = Bundle.main.url(forResource: family, withExtension: "json", subdirectory: "NativeMessagingHosts"),
                  let body = try? Data(contentsOf: source), body.count <= 4096 else { continue }
            let folder = browserFolder + "/NativeMessagingHosts", target = folder + "/com.heyjosi.browser.json"
            // An existing file is replaced only when it is Josi's own (same host name
            // and helper path), so an update can add the Chrome Web Store ID.
            if let existing = FileManager.default.contents(atPath: target) {
                guard existing != body, let value = try? JSONSerialization.jsonObject(with: existing) as? [String: Any],
                      value["name"] as? String == "com.heyjosi.browser",
                      value["path"] as? String == JosiEdition.current.helpers + "/JosiBrowserHost" else { continue }
                try? body.write(to: URL(fileURLWithPath: target), options: .atomic); continue
            }
            try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: target, contents: body, attributes: [.posixPermissions: 0o644])
        }
    }
    /// Safari ships extensions turned off: this opens the Josi extension in
    /// Safari's settings, where the person turns on "Josi Browser Control".
    static func openSafariExtensionSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: safariExtension) { _ in }
    }
    static var brokerNeedsApproval: Bool { SMAppService.agent(plistName: JosiEdition.current.agent + ".plist").status == .requiresApproval }
    private func ownerConnection() -> NSXPCConnection {
        lock.lock(); defer { lock.unlock() }
        if let connection { return connection }
        let made = NSXPCConnection(machServiceName: GuestBrowserBoundary.ownerService)
        made.setCodeSigningRequirement(GuestBrowserBoundary.requirement(GuestBrowserBoundary.brokerIdentifier))
        made.remoteObjectInterface = NSXPCInterface(with: GuestBrowserOwner.self)
        made.exportedInterface = NSXPCInterface(with: GuestBrowserOwnerCallback.self)
        made.exportedObject = self
        made.invalidationHandler = { [weak self] in self?.dropConnection() }
        made.interruptionHandler = { [weak self] in self?.dropConnection() }
        made.resume()
        connection = made; connectionId = UUID().uuidString.lowercased()
        return made
    }
    private func dropConnection() {
        lock.lock(); connection = nil
        if let link { end(link, "connection_lost") }; link = nil
        lock.unlock(); changed()
    }
    /// The broker relays only while Josi keeps renewing this short lease.
    private func renew() {
        guard let boot = try? GuestBrowserBoundary.isolatedBoot() else { return }
        let connection = ownerConnection()
        lock.lock(); let id = connectionId; lock.unlock()
        let authority: [String: Any] = ["mode": "host-desktop", "workspaceId": workspaceId, "profileId": NSNull(), "family": "safari",
                                        "guestBootId": boot.guest, "hostBootId": boot.host, "connectionId": id, "generation": 1,
                                        "leaseUntilMs": Int64(Date().timeIntervalSince1970 * 1000) + 9_000]
        guard let data = try? JSONSerialization.data(withJSONObject: authority),
              let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in self?.dropConnection() }) as? GuestBrowserOwner else { return }
        proxy.renew(data) { [weak self] ok in if !ok { connection.invalidate(); self?.dropConnection() } }
    }

    // ------------------------------------------------------------ requests from the browser
    func handle(_ request: Data, peer: Data, reply: @escaping (Data?, NSError?) -> Void) {
        guard let input = try? JSONDecoder().decode(Wire.self, from: request), let source = try? JSONDecoder().decode(Wire.self, from: peer),
              let output = try? JSONEncoder().encode(process(source, input)) else { reply(nil, NSError(domain: "Josi", code: 1)); return }
        reply(output, nil)
    }
    private static func reply(_ id: String, _ ok: Bool, _ payload: Wire = [:]) -> Wire {
        ["version": .number(1), "requestId": .string(id), "ok": .bool(ok), "payload": payload]
    }
    static func originOf(_ url: String?) -> String? {
        guard let url, let parsed = URL(string: url), let scheme = parsed.scheme, ["http", "https"].contains(scheme),
              parsed.user == nil, parsed.password == nil, let host = parsed.host else { return nil }
        return scheme + "://" + host + (parsed.port.map { ":\($0)" } ?? "")
    }
    private static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private func session(_ link: Link) -> Wire {
        ["sessionId": .string(link.sessionId), "workspaceId": .string(workspaceId), "profileId": .string(link.profileId), "family": .string(link.family),
         "expiresAt": .number(Double(Self.now() + Self.sessionMs)), "origins": .array(link.origins.map { .string($0) }), "currentDesktop": .bool(true)]
    }
    /// Which browser a peer is, and the app it runs as.
    private static func browserOf(_ peer: Wire) -> (family: String, browser: String, application: String)? {
        let family = peer["family"].text
        if peer["kind"].text == "safari-profile", family == "safari", peer["extensionId"].text == safariExtension {
            return ("safari", "Safari", FileManager.default.fileExists(atPath: "/Applications/Safari.app") ? "/Applications/Safari.app" : "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app")
        }
        // Josi's own browser: the native host vouched for its exact path and code hash.
        if isOwnBrowser(peer) { return ("chrome", "Josi's browser", peer["bundlePath"].text) }
        if peer["kind"].text == "browser-process", ["chrome", "brave", "firefox"].contains(family), peer["bundlePath"].text.hasPrefix("/") {
            return (family, family.prefix(1).uppercased() + family.dropFirst(), peer["bundlePath"].text)
        }
        return nil
    }
    static func isOwnBrowser(_ peer: Wire) -> Bool {
        peer["kind"].text == "browser-process" && peer["ownBrowser"].flag && peer["codeHash"].text == JosiOwnBrowser.codeHash
            && peer["bundlePath"].text == JosiOwnBrowser.app(home: FileManager.default.homeDirectoryForCurrentUser.path)
    }
    private func process(_ peer: Wire, _ request: Wire) -> Wire {
        let id = request["requestId"].text, payload = request["payload"], operation = request["operation"].text
        guard request["version"].integer == 1, UUID(uuidString: id) != nil, let browser = Self.browserOf(peer) else { return Self.reply(id, false) }
        var didChange = false
        defer { if didChange { changed() } }
        lock.lock(); defer { lock.unlock() }
        if operation == "browser.hello" {
            let nativeProfileId = payload["nativeProfileId"].text
            let withTab: Bool = { if case .number = payload["attachedTabId"] { return true }; return false }()
            let extensionOk = browser.family == "safari" ? payload["extensionId"].text == Self.safariExtension : payload["extensionId"].text == peer["extensionId"].text
            guard extensionOk, UUID(uuidString: nativeProfileId) != nil, withTab || payload["attachedTabId"] == .null,
                  !withTab || (payload["attachedTabId"].integer >= 0 && Self.originOf(payload["url"].text) != nil) else { return Self.reply(id, false) }
            // Josi's own browser needs no "Allow": it is Josi's, started by Josi.
            if Self.isOwnBrowser(peer), !allowedBrowsers.contains(where: { $0.nativeProfileId == nativeProfileId && $0.application == browser.application }) {
                saveAllowed(allowedBrowsers + [Allowed(nativeProfileId: nativeProfileId, profileId: UUID().uuidString.lowercased(), browser: browser.browser, family: "chrome", application: browser.application)])
            }
            guard let known = allowedBrowsers.first(where: { $0.nativeProfileId == nativeProfileId && $0.application == browser.application }) else {
                let found = Discovery(nativeProfileId: nativeProfileId, browser: browser.browser, family: browser.family, application: browser.application, origin: Self.originOf(payload["url"].text))
                if discovered != found { discovered = found; didChange = true }
                return Self.reply(id, true, ["profileDiscovered": .bool(true)])
            }
            // One browser is linked at a time. Another allowed browser waits (standby)
            // unless the person chose it in its popup ("Use this browser").
            if !payload["explicit"].flag, live(), let current = link, current.profileId != known.profileId {
                return Self.reply(id, true, ["standby": .bool(true), "family": .string(current.family)])
            }
            if let link { end(link, "replaced") }
            // Remembered so a closed browser can be started again from chat.
            UserDefaults.standard.set(try? JSONEncoder().encode(known), forKey: Self.lastKey)
            let made = Link(profileId: known.profileId, family: browser.family, browser: known.browser, application: known.application)
            if withTab, let origin = Self.originOf(payload["url"].text) {
                made.tabId = payload["attachedTabId"].integer; made.url = payload["url"].text; made.title = payload["title"].text; made.origins = [origin]
            }
            link = made; didChange = true
            return Self.reply(id, true, session(made))
        }
        guard let link, request["sessionId"].text == link.sessionId else { return Self.reply(id, false) }
        switch operation {
        case "browser.chunk":
            guard let sent = link.sent, let file = sent.file, payload["commandId"].text == sent.commandId else { return Self.reply(id, false) }
            let index = payload["index"].integer, count = (file.count + Self.chunkBytes - 1) / Self.chunkBytes
            guard index >= 0, index < count else { return Self.reply(id, false) }
            let start = index * Self.chunkBytes, piece = file.subdata(in: start..<min(file.count, start + Self.chunkBytes))
            return Self.reply(id, true, ["index": .number(Double(index)), "base64": .string(piece.base64EncodedString()), "last": .bool(index == count - 1)])
        case "browser.poll":
            link.lastPoll = Date()
            // The extension names the tab Josi uses: the one the person is looking at,
            // or the one Josi is working in (held while a task runs and shortly after).
            if payload["tabId"] == .null { if link.tabId >= 0 { link.tabId = -1; link.url = nil; link.title = nil; didChange = true } }
            else if case .number = payload["tabId"], payload["tabId"].integer >= 0, link.sent == nil || payload["tabId"].integer == link.tabId {
                if payload["tabId"].integer != link.tabId { link.tabId = payload["tabId"].integer; didChange = true }
                if let origin = Self.originOf(payload["url"].text), payload["url"].text != link.url || payload["title"].text != link.title {
                    link.url = payload["url"].text; link.title = payload["title"].text; didChange = true
                    if !link.origins.contains(origin), link.origins.count < 128 { link.origins.append(origin) }
                }
            }
            let active = Self.tab(payload["active"], active: true)
            let tabs = payload["tabs"].list.compactMap { Self.tab($0, active: $0["active"].flag) }.prefix(Self.presenceTabs)
            if active != link.active || Array(tabs) != link.tabs { didChange = true }
            link.active = active; link.tabs = Array(tabs)
            var command: Wire = .null
            if !blockedFlag, let queued = link.queued, link.sent == nil {
                link.sent = queued; link.queued = nil; command = .object(queued.command); queued.shown = true
                let activity = queued.activity
                Task { @MainActor in PcExecutor.shared.beginExternal(activity) }
            }
            return Self.reply(id, true, ["session": session(link), "command": command, "paused": .bool(blockedFlag)])
        case "browser.authorize":
            let command = payload["command"], actual = payload["actual"]
            guard let sent = link.sent, !blockedFlag, command["id"].text == sent.commandId, command["kind"].text == sent.command["kind"]?.text,
                  command["sessionId"].text == link.sessionId else { return Self.reply(id, false) }
            let expectedTab = sent.command["tabId"].map { $0.integer } ?? link.tabId
            guard actual == .null || actual["tabId"].integer == expectedTab else { return Self.reply(id, false) }
            sent.authorized = true
            var authority: [String: Wire] = ["commandId": .string(sent.commandId), "sessionId": .string(link.sessionId), "allowed": .bool(true)]
            if let value = sent.value { authority["value"] = .string(value) }
            if let file = sent.file {
                authority["file"] = ["name": .string(sent.fileName), "mediaType": .string(sent.mediaType), "size": .number(Double(file.count)),
                                     "chunks": .number(Double((file.count + Self.chunkBytes - 1) / Self.chunkBytes))]
            }
            return Self.reply(id, true, .object(authority))
        case "browser.receipt":
            guard let sent = link.sent, payload["commandId"].text == sent.commandId else { return Self.reply(id, false) }
            link.sent = nil; hide(sent)
            var ok = payload["outcome"].text == "observed_or_issued"
            let result = payload["result"], kind = sent.command["kind"]?.text ?? ""
            if ok, kind == "attach" {
                // The tab the person approved is now the attached one.
                let origin = Self.originOf(result["url"].text)
                if result["tabId"].integer != sent.command["tabId"]?.integer || origin == nil || origin != sent.command["origin"]?.text { ok = false }
                else { link.tabId = result["tabId"].integer; link.url = result["url"].text; link.title = result["title"].text; if !link.origins.contains(origin!) { link.origins.append(origin!) }; didChange = true }
            }
            if ok, kind == "openTab" {
                let origin = Self.originOf(result["url"].text)
                if result["tabId"].integer < 0 || origin != sent.command["origin"]?.text { ok = false } else { link.tabId = result["tabId"].integer; didChange = true }
            }
            if ok, result["kind"].text == "observation", Self.originOf(result["url"].text) != nil { link.url = result["url"].text; link.title = result["title"].text; didChange = true }
            let code = payload["code"].text
            sent.finish(ok ? (true, result) : pcRefuse(code.isEmpty ? "not_verified" : code))
            return Self.reply(id, true)
        case "browser.save":
            // Safari's download, piece by piece, for the authorized download in flight.
            guard let sent = link.sent, sent.authorized, sent.command["kind"]?.text == "download", payload["commandId"].text == sent.commandId,
                  sent.saved == nil, payload["index"].integer * Self.chunkBytes == sent.saving.count, payload["chunks"].integer >= 1,
                  payload["size"].integer > 0, payload["size"].integer <= Self.uploadBytes,
                  let piece = Data(base64Encoded: payload["base64"].text), !piece.isEmpty, piece.count <= Self.chunkBytes,
                  sent.saving.count + piece.count <= payload["size"].integer else { return Self.reply(id, false) }
            sent.saving.append(piece)
            guard payload["last"].flag else { return Self.reply(id, true, ["index": payload["index"]]) }
            guard sent.saving.count == payload["size"].integer, let name = Self.saveDownload(sent.saving, name: payload["name"].text) else { sent.saving = Data(); return Self.reply(id, false) }
            sent.saved = name; sent.saving = Data()
            return Self.reply(id, true, ["index": payload["index"], "file": .string(name)])
        case "browser.stop":
            end(link, "local_takeover"); self.link = nil; didChange = true
            return Self.reply(id, true)
        default: return Self.reply(id, false)
        }
    }
    /// Writes a downloaded file into ~/Downloads under a name no file has yet,
    /// never following a link. Returns the name it was given.
    private static func saveDownload(_ data: Data, name: String) -> String? {
        var clean = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\0", with: "")
        while clean.hasPrefix(".") { clean.removeFirst() }
        clean = String(clean.prefix(200)); if clean.isEmpty { clean = "download" }
        var folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads").path
        #if DEBUG
        if let test = ProcessInfo.processInfo.environment["JOSI_DOWNLOADS_DIR"] { folder = test }
        #endif
        let stem = (clean as NSString).deletingPathExtension, ext = (clean as NSString).pathExtension
        for attempt in 0..<100 {
            let candidate = attempt == 0 ? clean : "\(stem) (\(attempt + 1))" + (ext.isEmpty ? "" : ".\(ext)")
            let fd = open(folder + "/" + candidate, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
            if fd < 0 { if errno == EEXIST { continue }; return nil }
            defer { close(fd) }
            let written = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
            return written == data.count ? candidate : nil
        }
        return nil
    }
    /// The browser last linked, while it is still allowed and installed.
    private var lastBrowser: Allowed? {
        guard let data = UserDefaults.standard.data(forKey: Self.lastKey), let last = try? JSONDecoder().decode(Allowed.self, from: data),
              allowedBrowsers.contains(where: { $0.application == last.application }), FileManager.default.fileExists(atPath: last.application) else { return nil }
        return last
    }
    /// With no browser of the person's linked or remembered: Josi's own browser,
    /// started on demand (downloaded the first time it is needed).
    private var ownFallback: Allowed? {
        guard PcOwnBrowser.enabled else { return nil }
        return Allowed(nativeProfileId: "own", profileId: "own", browser: "Josi's browser", family: "chrome", application: PcOwnBrowser.shared.appPath)
    }
    private var linked: Bool { lock.lock(); defer { lock.unlock() }; return live() }
    private func showing(_ target: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard live(), let link, link.tabId >= 0 else { return false }
        return Self.originOf(link.url) == target
    }
    /// Starts the approved browser with the approved https page, and waits up to
    /// 40 seconds for the extension to link and show it. A refusal, or nil when ready.
    private func launch(_ scope: Wire, url: String, cancel: PcCancel) async -> PcOutcome? {
        let target = scope["target"].text
        guard let last = lastBrowser ?? ownFallback, scope["application"].text == last.application else { return pcRefuse("browser_not_linked") }
        guard Self.originOf(url) == target, url.hasPrefix("https://"), let page = URL(string: url), let host = page.host else { return pcRefuse("invalid_page") }
        await MainActor.run { PcExecutor.shared.beginExternal("Opening \(host)") }
        defer { Task { @MainActor in PcExecutor.shared.endExternal() } }
        let own = last.application == PcOwnBrowser.shared.appPath
        do {
            if own {
                // Josi's own browser starts hidden, through its private pipe; never as an app window.
                _ = try await PcOwnBrowser.shared.page(url: url)
            } else {
                let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
                _ = try await NSWorkspace.shared.open([page], withApplicationAt: URL(fileURLWithPath: last.application), configuration: configuration)
            }
        } catch { return pcRefuse("browser_did_not_start", own ? error.localizedDescription : nil) }
        // The first start of Josi's own browser may download it, so it gets longer.
        let deadline = Date().addingTimeInterval(own ? 120 : 40)
        while Date() < deadline {
            try? await Task.sleep(for: .milliseconds(500))
            if cancel.isCancelled || blocked { return pcRefuse("paused") }
            if showing(target) { return nil }
        }
        return pcRefuse("browser_not_responding")
    }
    private static func tab(_ value: Wire, active: Bool) -> Tab? {
        guard case .number = value["tabId"], value["tabId"].integer >= 0, let origin = originOf(value["url"].text) else { return nil }
        return Tab(id: value["tabId"].integer, origin: origin, title: String(value["title"].text.prefix(300)), active: active)
    }
    /// Must hold the lock.
    private func end(_ link: Link, _ code: String) {
        for pending in [link.sent, link.queued].compactMap({ $0 }) { hide(pending); pending.finish(pcRefuse(code)) }
        link.sent = nil; link.queued = nil
    }
    private func hide(_ pending: Pending) {
        guard pending.shown else { return }
        pending.shown = false
        Task { @MainActor in PcExecutor.shared.endExternal() }
    }

    // ------------------------------------------------------------ presence for the server
    /// What the server shows chat: the linked browser, its attached tab and the
    /// sites and titles of its open tabs. Never paths or page content.
    func presence() -> Wire? {
        lock.lock(); defer { lock.unlock() }
        guard live(), let link else {
            // No browser running: name the last one used, with no tabs, so
            // "open mercari.com" can start it. Without one, desktop work only.
            guard let last = lastBrowser ?? ownFallback else { return nil }
            return ["connected": .bool(true), "browser": ["family": .string(last.family), "application": .string(last.application), "profile": "Default",
                                                          "origin": .null, "title": .null, "tabs": .array([])]]
        }
        let attached = link.tabId >= 0
        var browser: [String: Wire] = ["family": .string(link.family), "application": .string(link.application), "profile": "Default",
                                       "origin": attached ? (Self.originOf(link.url).map { .string($0) } ?? .null) : .null,
                                       "title": attached ? (link.title.map { .string($0) } ?? .null) : .null,
                                       "tabs": .array(link.tabs.map { ["tabId": .number(Double($0.id)), "origin": .string($0.origin), "title": .string($0.title), "active": .bool($0.active)] })]
        if let active = link.active {
            browser["activeTabId"] = .number(Double(active.id)); browser["activeOrigin"] = .string(active.origin); browser["activeTitle"] = .string(active.title)
        }
        return ["connected": .bool(true), "browser": .object(browser)]
    }

    // ------------------------------------------------------------ approved browser work
    /// Queues one approved command for the extension's next poll, or says why not.
    private func queue(_ request: Wire, launched: Bool = false) -> Result<Pending, PcRefusal> {
        let payload = request["payload"], scope = request["requirements"].list.first?["scope"] ?? .null
        let kind = payload["kind"].text
        let pending = Pending()
        lock.lock()
        guard live(), let link else { lock.unlock(); return .failure(PcRefusal("browser_not_linked", "No browser is linked to Josi on this Mac. In Safari, turn on \"Josi Browser Control\" (Safari > Settings > Extensions; Josi's PC Control page has a button for it), then allow Josi on every website from its toolbar button.")) }
        guard scope["application"].text == link.application, scope["profile"].text == "Default" else { lock.unlock(); return .failure(PcRefusal("browser_changed")) }
        let target = scope["target"].text
        guard Self.originOf(target) == target, let site = URL(string: target)?.host else { lock.unlock(); return .failure(PcRefusal("invalid_site")) }
        var command: [String: Wire] = ["id": .string(pending.commandId), "sessionId": .string(link.sessionId), "profileId": .string(link.profileId),
                                       "expiresAt": .number(Double(Self.now() + Int64(Self.commandSeconds * 1000)))]
        switch kind {
        case "attach":
            // The tab must still be open on the approved site.
            guard case .number = payload["tabId"], let tab = ([link.active].compactMap { $0 } + link.tabs).first(where: { $0.id == payload["tabId"].integer }) else { lock.unlock(); return .failure(PcRefusal("tab_not_found")) }
            guard tab.origin == target else { lock.unlock(); return .failure(PcRefusal("attached_site_changed")) }
            if !link.origins.contains(target) { link.origins.append(target) }
            command["kind"] = "attach"; command["tabId"] = .number(Double(tab.id)); command["origin"] = .string(target)
            pending.activity = "Attaching a tab on \(site)"
        case "open" where launched && link.tabId >= 0 && Self.originOf(link.url) == target:
            // The browser opened the page itself; read it.
            command["kind"] = "inspect"; command["origin"] = .string(target); command["maxOutputBytes"] = .number(Double(Self.observationBytes))
            pending.activity = "Reading \(site)"
        case "open":
            let url = payload["url"].text
            guard Self.originOf(url) == target, url.hasPrefix("https://") else { lock.unlock(); return .failure(PcRefusal("invalid_page")) }
            if !link.origins.contains(target) { link.origins.append(target) }
            // No tab attached: the page opens in a new tab, which becomes the attached one.
            command["kind"] = .string(link.tabId < 0 ? "openTab" : "openPage"); command["url"] = .string(url); command["origin"] = .string(target)
            command["maxOutputBytes"] = .number(Double(Self.observationBytes))
            pending.activity = "Opening \(site)"
        default:
            guard link.tabId >= 0 else { lock.unlock(); return .failure(PcRefusal("no_attached_tab")) }
            guard Self.originOf(link.url) == target else { lock.unlock(); return .failure(PcRefusal("attached_site_changed")) }
            command["tabId"] = .number(Double(link.tabId))
            if kind == "read" {
                command["kind"] = "inspect"; command["origin"] = .string(target); command["maxOutputBytes"] = .number(Double(Self.observationBytes))
                command.removeValue(forKey: "tabId"); pending.activity = "Reading \(site)"
            } else if kind == "download" {
                let url = payload["url"].text
                guard Self.originOf(url) == target, url.hasPrefix("https://") else { lock.unlock(); return .failure(PcRefusal("invalid_download")) }
                command["kind"] = "download"; command["url"] = .string(url); pending.activity = "Downloading from \(site)"
            } else if ["click", "fill", "photo", "select", "drag", "scroll", "upload"].contains(kind) {
                command["kind"] = .string(kind)
                command["observationId"] = .string(payload["observationId"].text); command["elementId"] = .string(payload["elementId"].text)
                if kind == "fill" { pending.value = payload["text"].text }
                if kind == "select" { pending.value = payload["option"].text }
                if kind == "drag" {
                    guard UUID(uuidString: payload["toElementId"].text) != nil else { lock.unlock(); return .failure(PcRefusal("invalid_target")) }
                    command["toElementId"] = .string(payload["toElementId"].text)
                }
                if kind == "scroll" { command["deltaY"] = .number(payload["direction"].text == "up" ? -1 : 1); command["maxOutputBytes"] = .number(Double(Self.observationBytes)) }
                // A photo comes back with a fresh read of the page; leave room for both.
                if kind == "photo" { command["maxOutputBytes"] = .number(163_840) }
                if kind == "upload", let problem = Self.loadUpload(pending, payload["path"].text, request["requirements"].list) { lock.unlock(); return .failure(PcRefusal(problem)) }
                pending.activity = ["click": "Clicking on ", "fill": "Typing on ", "photo": "Looking at a picture on ", "select": "Choosing an option on ",
                                    "drag": "Dragging on ", "scroll": "Scrolling ", "upload": "Uploading a file to "][kind]! + site
            } else { lock.unlock(); return .failure(PcRefusal("unsupported_operation")) }
        }
        pending.command = command
        if let queued = link.queued { hide(queued); queued.finish(pcRefuse("replaced")) }
        link.queued = pending
        lock.unlock()
        return .success(pending)
    }
    func dispatch(_ request: Wire, cancel: PcCancel) async -> PcOutcome {
        // Opening a page while the browser is closed starts it with that page,
        // then reads the page once the extension has linked and shows it.
        var launched = false
        if request["payload"]["kind"].text == "open", !linked {
            if let refusal = await launch(request["requirements"].list.first?["scope"] ?? .null, url: request["payload"]["url"].text, cancel: cancel) { return refusal }
            launched = true
        }
        let pending: Pending
        switch queue(request, launched: launched) {
        case .failure(let refusal): return refusal.outcome
        case .success(let queued): pending = queued
        }
        cancel.onCancel { [weak self] in self?.cancelPending(pending, "paused") }
        // An upload streams its file in chunks; give it longer than a click.
        let limit = Self.commandSeconds + (pending.file != nil ? 40 : 10)
        Task.detached { [weak self] in
            try? await Task.sleep(for: .seconds(limit))
            self?.cancelPending(pending, "browser_not_responding")
        }
        return await pending.wait()
    }
    struct PcRefusal: Error { let outcome: PcOutcome; init(_ code: String, _ detail: String? = nil) { outcome = pcRefuse(code, detail) } }
    private func cancelPending(_ pending: Pending, _ code: String) {
        lock.lock()
        if let link { if link.queued === pending { link.queued = nil }; if link.sent === pending { link.sent = nil } }
        hide(pending)
        lock.unlock()
        pending.finish(pcRefuse(code))
    }
    /// The file for an approved upload, read once from a folder the owner approved
    /// for reading. Returns a refusal code, or nil when it is ready.
    private static func loadUpload(_ pending: Pending, _ path: String, _ requirements: [Wire]) -> String? {
        guard let clean = PcWork.clean(path), clean == path else { return "invalid_path" }
        let folder = (clean as NSString).deletingLastPathComponent
        guard requirements.contains(where: { $0["action"].text == "folder.read" && $0["scope"]["target"].text == folder }) else { return "folder_not_approved" }
        let fd = open(clean, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { return errno == ELOOP ? "file_is_link" : "file_not_found" }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return "file_not_found" }
        guard st.st_size > 0, st.st_size <= uploadBytes else { return "file_too_large" }
        guard let data = try? FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd(), data.count == Int(st.st_size) else { return "file_unreadable" }
        pending.file = data; pending.fileName = (clean as NSString).lastPathComponent
        let types = ["jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "heic": "image/heic",
                     "pdf": "application/pdf", "txt": "text/plain", "csv": "text/csv", "mp4": "video/mp4", "mov": "video/quicktime"]
        pending.mediaType = types[(clean as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
        return nil
    }
}
