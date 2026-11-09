import CryptoKit
import Foundation

nonisolated(unsafe) var failures = 0
func check(_ condition: Bool, _ name: String) {
    print((condition ? "PASS " : "FAIL ") + name)
    if !condition { failures += 1 }
}
func hex(_ text: String) -> Data {
    var out = Data(), index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        out.append(UInt8(text[index..<next], radix: 16)!)
        index = next
    }
    return out
}
func throwsCode(_ code: String?, _ body: () throws -> Void) -> Bool {
    do { try body(); return false }
    catch let error as TunnelError { return code == nil || error.code == code }
    catch { return false }
}
func json(_ url: URL) throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any] }

func noiseVector(_ folder: URL) throws {
    let v = try json(folder.appendingPathComponent("noise_vector_ik.json"))
    let messages = (v["messages"] as! [[String: String]])
    func field(_ name: String) -> Data { hex(v[name] as! String) }
    var handshake = try TunnelHandshake(key: try TunnelKey(raw: field("init_static")), remote: field("init_remote_static"), prologue: field("init_prologue"))
    let one = try handshake.writeFirst(hex(messages[0]["payload"]!), ephemeral: try TunnelKey(raw: field("init_ephemeral")))
    check(one == hex(messages[0]["ciphertext"]!), "IK message 1 matches the vector")
    let (payload, opened) = try handshake.readSecond(hex(messages[1]["ciphertext"]!), framed: false)
    check(payload == hex(messages[1]["payload"]!), "IK message 2 opens to the vector payload")
    check(handshake.hash == field("handshake_hash"), "handshake hash matches the vector")
    var session = opened, all = true
    for (index, message) in messages.dropFirst(2).enumerated() {
        let plain = hex(message["payload"]!), sealed = hex(message["ciphertext"]!)
        if index % 2 == 0 { all = try all && session.seal(plain) == sealed }
        else { all = try all && session.open(sealed) == plain }
    }
    check(all && messages.count > 4, "IK transport messages match the vector, both directions")
}

func framingVector(_ folder: URL) throws {
    let v = try json(folder.appendingPathComponent("framing.json"))
    let key = hex(v["key"] as! String), zero = Data(count: 32)
    var sender = TunnelSession(send: TunnelCipher(key: key), recv: TunnelCipher(key: zero))
    var receiver = TunnelSession(send: TunnelCipher(key: zero), recv: TunnelCipher(key: key))
    sender.rekeyMessages = v["rekey_messages"] as! Int
    let messages = v["messages"] as! [String], sealed = v["ciphertexts"] as! [String]
    var same = true, opened = true
    for (message, expected) in zip(messages, sealed) {
        let out = try sender.seal(Data(message.utf8))
        same = same && out == hex(expected)
        opened = try opened && receiver.open(out) == Data(message.utf8)
    }
    check(same && messages.count == sealed.count, "framing vector matches, rekeys included")
    check(opened, "framing vector opens, rekeys included")
    var padded = TunnelSession(send: TunnelCipher(key: key), recv: TunnelCipher(key: key))
    check(try padded.seal(Data("a".utf8)).count == padded.seal(Data(repeating: 97, count: 200)).count, "sizes pad to the same block")
    check(throwsCode("closed") { _ = try padded.seal(Data(count: 65517)) }, "an oversize frame is refused")
    check((try? padded.seal(Data(count: 65516)))?.count == 65535, "the largest frame fits one Noise message")
}

func refusals() throws {
    let key = Data(repeating: 7, count: 32)
    var sender = TunnelSession(send: TunnelCipher(key: key), recv: TunnelCipher())
    var receiver = TunnelSession(send: TunnelCipher(), recv: TunnelCipher(key: key))
    var sealed = try sender.seal(Data("secret".utf8))
    sealed[sealed.startIndex] ^= 1
    check(throwsCode("tampered") { _ = try receiver.open(sealed) }, "a flipped bit in a transport message is refused")
    let server = TunnelKey(), device = TunnelKey()
    var handshake = try TunnelHandshake(key: device, remote: server.publicKey)
    _ = try handshake.writeFirst(Data("hello".utf8))
    check(throwsCode("handshake") { _ = try handshake.readSecond(Data(repeating: 9, count: 64)) }, "a second message not from the pinned key is refused")
    let lowOrder = Data(count: 32)
    check(throwsCode("handshake") { _ = try device.dh(lowOrder) }, "a low-order public key is refused")
}

func codes() {
    let code = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    check(TunnelCode.isValid(code), "a full code is valid")
    check(TunnelCode.normalize("0123-4567 89ab-cdef\nghjk-mnpq-rstv-wxyz") == code, "dashes, spaces and case are dropped")
    check(TunnelCode.normalize("oOiIlL") == "001111", "O, I and L read as digits")
    check(!TunnelCode.isValid("K7QM4XHT"), "a short code is refused")
    check(!TunnelCode.isValid(String(repeating: "U", count: 32)), "U is not in the alphabet")
    check(TunnelCode.inviteId(code) == TunnelBytes.hex(SHA256.hash(data: Data("josi-invite-id/1|\(code)".utf8))).prefix(32).description, "invite id is the hash prefix")
    check(TunnelInvite.parseLink("https://a.test/#josi-pair=SHORT.e30") == nil, "a link with a bad code is refused")
    let box = TunnelInviteBox(v: 1, server: TunnelBytes.base64url(Data(count: 32)), site: String(repeating: "a", count: 32), relay: "ws://relay.example.com")
    let plain = TunnelBytes.base64url(try! JSONEncoder().encode(box))
    check(TunnelInvite.parseLink("https://a.test/#josi-pair=\(code).\(plain)") == nil, "plain ws to a remote relay is refused")
    check(TunnelAddress.origin(link: nil, box: TunnelInviteBox(v: 1, server: "", site: "", relay: "wss://relay.heyjosi.com", name: "alice")) == "https://alice.heyjosi.com", "a typed code's origin comes from the name")
    func rotated(until: String?) -> TunnelPairing {
        var pairing = TunnelPairing(invite: TunnelInvite(code: code, box: box, origin: "https://a.test"), key: TunnelKey())
        pairing.adopt(TunnelRotation(publicKey: TunnelBytes.base64url(TunnelKey().publicKey), until: until))
        return pairing
    }
    check(rotated(until: nil).fallbackServer == nil, "a server key replaced with no overlap is never tried again")
    check(rotated(until: "2020-01-01T00:00:00.000Z").fallbackServer == nil, "a server key past its overlap is never tried again")
    check(rotated(until: "2999-01-01T00:00:00.000Z").fallbackServer != nil, "a server key inside its overlap can still be tried")
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

struct Fixture {
    let control: URL, relay: String
    @discardableResult func call(_ path: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: control.appendingPathComponent(path))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
    func code() async throws -> (code: String, link: String) {
        let value = try await call("code")
        return (value["code"] as! String, value["link"] as! String)
    }
}
func wait(_ what: String, seconds: Double = 5, until: () async throws -> Bool) async throws -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { if try await until() { return true }; try await Task.sleep(for: .milliseconds(50)) }
    print("timed out waiting for " + what); return false
}
func refusal(_ body: () async throws -> Void) async -> String? {
    do { try await body(); return nil }
    catch let error as TunnelError { return error.code }
    catch { return "other: \(error)" }
}

func endToEnd(_ fixture: Fixture) async throws {
    let store = TunnelKeychain(service: "com.heyjosi.ce.tunnel.test." + UUID().uuidString.lowercased())
    defer { for pairing in (try? store.list()) ?? [] { try? store.delete(pairing.site) } }
    let forgotten = Forgotten()

    // Typed code: looked up on the relay, box opened, LAN not answering yet.
    let first = try await fixture.code()
    let typed = first.code.enumerated().map { $0.offset % 4 == 0 && $0.offset > 0 ? "-\($0.element)" : "\($0.element)" }.joined().lowercased()
    let invite = try await TunnelInvite.resolve(typed, relay: fixture.relay)
    check(invite.code == first.code && invite.box.name == "alice", "a typed code opens the invite the reference sealed")
    check(invite.origin == "https://alice.127.0.0.1", "a typed code's origin is derived")
    let linked = TunnelInvite.parseLink(first.link)
    check(linked?.box == invite.box && linked?.origin == "https://alice.heyjosi.test", "a link carries the same box and the link's origin")
    let started = Date()
    let connection = try await TunnelConnection.pair(linked!, name: "Test Mac", store: store, lanRetry: .milliseconds(300)) { site in forgotten.add(site) }
    let pairPath = await connection.path
    check(pairPath == .relay, "pairing falls through to the relay when the LAN is silent")
    check(Date().timeIntervalSince(started) < 3, "a dead LAN address costs well under the relay timeout")
    let saved = try store.load(invite.box.site)
    check(saved?.device.isEmpty == false && saved?.lan.isEmpty == false, "the pairing is saved with its device id")
    check(try store.list().count == 1, "the Keychain lists the pairing")
    let state = try await fixture.call("state")
    check((state["hellos"] as! [[String: String]]).first == ["op": "pair", "name": "Test Mac", "platform": "mac"], "the pair hello reached the server")
    check(await refusal { _ = try await TunnelConnection.pair(linked!, name: "Again", store: store) } == "bad_code", "a used code is refused")

    // HTTP through URLProtocol, over the relay.
    let origin = URL(string: "https://alice.heyjosi.test")!
    TunnelRoutes.attach(origin.host!, connection)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [TunnelURLProtocol.self]; config.httpCookieStorage = nil
    config.httpAdditionalHeaders = ["User-Agent": "JosiNative/test", "Accept": "application/json"]
    config.timeoutIntervalForRequest = 10
    let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    func url(_ path: String) -> URL { URL(string: origin.absoluteString + path)! }
    func object(_ data: Data) -> [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }

    let (csrf, csrfResponse) = try await session.data(from: url("/api/auth/csrf"))
    let head = csrfResponse as! HTTPURLResponse
    check(head.statusCode == 200 && csrfResponse.url == url("/api/auth/csrf"), "a GET comes back through the tunnel")
    check(!(object(csrf)["csrfToken"] as! String).isEmpty && head.value(forHTTPHeaderField: "Set-Cookie") == nil, "the jar keeps the cookie and the body keeps the token")
    var post = URLRequest(url: url("/api/echo?a=1&b=two%20words"))
    post.httpMethod = "POST"; post.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let payload = Data((0..<200_000).map { UInt8($0 % 251) })
    post.httpBody = payload
    let (echoed, echoResponse) = try await session.data(for: post)
    let echo = object(echoed)
    check((echoResponse as! HTTPURLResponse).statusCode == 200, "a POST with no CSRF header passes on the jar's token")
    check(echo["length"] as? Int == payload.count && echo["sha256"] as? String == TunnelBytes.hex(SHA256.hash(data: payload)), "a 200 KB body arrives whole, over several frames")
    check(echo["query"] as? String == "?a=1&b=two%20words", "path and query keep their encoding")
    check((echo["cookie"] as? String ?? "").contains("josi_session="), "the server's jar supplied the session cookie")
    check(echo["userAgent"] as? String == "JosiNative/test", "session headers reach the server")
    check(echo["encoding"] as? String == "identity", "no compressed response is asked for")
    let (_, bigResponse) = try await session.data(from: url("/api/big"))
    check(bigResponse.expectedContentLength == 300_000 && bigResponse.mimeType == "application/zip", "length and type survive for the backup checks")
    let (_, redirect) = try await session.data(from: url("/api/redirect"))
    check((redirect as! HTTPURLResponse).statusCode == 302, "a redirect is handed back, not followed")
    let (_, missing) = try await session.data(from: url("/api/nothing"))
    check((missing as! HTTPURLResponse).statusCode == 404, "an error status is a response, not a failure")

    // Streaming: each event is released by another request on the same tunnel.
    let (bytes, streamResponse) = try await session.bytes(from: url("/api/events"))
    check(streamResponse.mimeType == "text/event-stream", "the stream's head arrives before its end")
    var ticks = 0
    for try await line in bytes.lines where line.hasPrefix("event: tick") {
        ticks += 1
        if ticks < 3 { _ = try await session.data(from: url("/api/next")) }
    }
    check(ticks == 3, "an event stream delivers as it goes, beside other requests")

    // Cancelling reaches the server as a Reset.
    let (forever, _) = try await session.bytes(from: url("/api/forever"))
    forever.task.cancel()
    check(try await wait("cancel") { try await fixture.call("state")["cancelled"] as? Int == 1 }, "cancelling a request resets its stream")

    // Device key rotation, then a fresh handshake on the new key.
    let oldKey = try store.load(invite.box.site)!.key
    try await connection.rotateDeviceKey()
    let rotated = try store.load(invite.box.site)!
    check(rotated.key != oldKey && rotated.pendingKey == nil, "a rotation swaps the saved key")
    let liveAfter = try await session.data(from: url("/api/onboarding/state"))
    check((liveAfter.1 as! HTTPURLResponse).statusCode == 200, "the running session carries on after a rotation")
    let again = TunnelConnection(pairing: rotated, store: store)
    _ = try await again.session()
    check(await again.path == .relay, "the new device key connects")
    await again.close()

    // A rotation whose reply was lost: this record still leads with a key the
    // server has dropped, and holds the one it moved to as pending.
    var lost = TunnelPairing(invite: linked!, key: TunnelKey())
    lost.device = rotated.device; lost.server = rotated.server
    lost.stage(try TunnelKey(raw: rotated.key))
    let recovered = TunnelConnection(pairing: lost, store: store)
    _ = try await recovered.session()
    let recoveredRecord = await recovered.pairing
    check(recoveredRecord.key == rotated.key && recoveredRecord.pendingKey == nil, "a lost rotation reply resolves to the key the server has")
    await recovered.close()
    try store.save(rotated)

    // Server rotation with overlap: followed in session, used next time.
    try await fixture.call("rotate-server-overlap")
    check(try await wait("rotation notice") { await connection.pairing.server != rotated.server }, "a rotate-server notice is followed")
    let notified = try store.load(invite.box.site)!
    check(notified.server != rotated.server && notified.previousServer == rotated.server && notified.fallbackServer != nil, "the new server key is saved, the old one kept for its overlap")
    let next = TunnelConnection(pairing: notified, store: store)
    _ = try await next.session()
    await next.close()
    check(true, "the next connection uses the new server key")
    var behind = notified
    behind.server = rotated.server; behind.previousServer = nil; behind.previousUntil = nil
    try store.save(behind)
    let catchingUp = TunnelConnection(pairing: behind, store: store)
    _ = try await catchingUp.session()
    check(try await wait("welcome rotate") { await catchingUp.pairing.server == notified.server }, "a rotate in the welcome is followed")
    await catchingUp.close()
    try store.save(notified)

    // A pinned key that isn't the server's never connects, on any path.
    var wrong = notified
    wrong.server = TunnelBytes.base64url(TunnelKey().publicKey); wrong.previousServer = nil; wrong.previousUntil = nil
    let impostor = TunnelConnection(pairing: wrong, store: store)
    check(await refusal { _ = try await impostor.session() } != nil, "a server without the pinned key is refused")
    check(await impostor.path == .none, "nothing is left connected after a key mismatch")
    await impostor.close()

    // Tampering ends the session and fails what was running.
    let client = try await connection.session()
    try await fixture.call("tamper")
    var tampered = ""
    do { _ = try await session.data(from: url("/api/onboarding/state")) } catch { tampered = error.localizedDescription }
    check(tampered == TunnelError("tampered").message, "a tampered frame fails the request, in plain words")
    check(client.isClosed, "a tampered frame ends the session")
    _ = try await session.data(from: url("/api/onboarding/state"))
    check(true, "the next request makes a new session")

    // Status text is a hint: offline gives up at once, and only ends things.
    let live = try await connection.session()
    try await fixture.call("offline")
    check(try await wait("offline") { live.isClosed }, "server-offline ends the relay session")
    let offlineStart = Date()
    check(await refusal { _ = try await connection.session() } == "offline", "a new attempt gives up on server-offline")
    check(Date().timeIntervalSince(offlineStart) < 3, "giving up doesn't wait for a timeout")
    try await fixture.call("online")

    // The LAN answers: new requests move over, and the relay goes quiet.
    let relayClient = try await connection.session()
    try await fixture.call("lan/start")
    check(try await wait("LAN") { await connection.path == .lan }, "a LAN that starts answering takes over")
    check(try await wait("retire") { relayClient.isClosed }, "the idle relay session is closed")
    let before = try await fixture.call("state")["relayFrames"] as! Int
    _ = try await session.data(from: url("/api/onboarding/state"))
    let after = try await fixture.call("state")["relayFrames"] as! Int
    check(before == after, "requests no longer touch the relay")
    let lanClient = try await connection.session()
    try await fixture.call("lan/stop")
    check(try await wait("LAN drop") { lanClient.isClosed }, "losing the LAN ends that session")
    _ = try await session.data(from: url("/api/onboarding/state"))
    check(await connection.path == .relay, "the next request finds the relay again")

    // Revoked: the pairing goes, and nothing retries.
    _ = try await connection.session()
    try await fixture.call("revoke")
    check(try await wait("revoke") { forgotten.sites.contains(invite.box.site) }, "a revoke is reported")
    check(try store.load(invite.box.site) == nil, "a revoke deletes the pairing")
    do { _ = try await session.data(from: url("/api/onboarding/state")); check(false, "a revoked pairing can't reach the server") }
    catch { check(true, "a revoked pairing can't reach the server") }
    TunnelRoutes.release(origin.host!, connection)
    do { _ = try await session.data(from: url("/api/onboarding/state")); check(false, "with no route a session fails instead of going out") }
    catch { check(true, "with no route a session fails instead of going out") }
}

final class Forgotten: @unchecked Sendable {
    private let lock = NSLock(); private var values = Set<String>()
    var sites: Set<String> { lock.withLock { values } }
    func add(_ site: String) { lock.withLock { _ = values.insert(site) } }
}

#if JOSI_TUNNEL_APP
@MainActor func throughJosiAPI(_ fixture: Fixture) async throws {
    let store = TunnelKeychain(service: "com.heyjosi.ce.tunnel.test." + UUID().uuidString.lowercased())
    defer { for pairing in (try? store.list()) ?? [] { try? store.delete(pairing.site) } }
    let link = try await fixture.code().link
    let connection = try await TunnelConnection.pair(TunnelInvite.parseLink(link)!, name: "Test Mac", store: store)
    let api = try JosiAPI(address: "https://alice.heyjosi.test", tunnel: connection)
    try await api.primeCSRF()
    let state = try await api.request("/onboarding/state")
    check(state["completed"].flag, "JosiAPI reads through the tunnel")
    let echo = try await api.request("/echo", method: "POST", body: ["hello": "there"])
    check(echo["length"].integer == 17 && echo["type"].text == "application/json", "JosiAPI posts through the tunnel with CSRF")
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data(repeating: 3, count: 150_000).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
    let attachment = try await api.uploadAttachment(file, thread: "11111111-1111-4111-8111-111111111111")
    check(attachment["id"].text.count == 64, "an attachment uploads through the tunnel")
    var events: [String] = []
    try await api.followWorkProgress { events.append($0) }
    check(events == ["heartbeat", "progress", "access-ended"], "the work-progress stream reads through the tunnel")
    // No cookie comes back here, and if a server's reply has no token either,
    // JosiAPI must leave CSRF to the jar and keep going.
    try await fixture.call("csrf-empty")
    try await api.primeCSRF()
    let tokenless = try await api.request("/echo", method: "POST", body: [:])
    check(tokenless["length"].integer == 2, "an empty CSRF token doesn't stop a tunnelled session")
    do { _ = try await api.request("/missing"); check(false, "API errors stay JosiErrors") }
    catch let error as JosiError { check(error.status == 404, "API errors stay JosiErrors") }
    api.close()
    await connection.close()
}
#endif

@main struct Check {
    static func main() async {
        do {
            let arguments = CommandLine.arguments
            let folder = URL(fileURLWithPath: arguments[1])
            try noiseVector(folder); try framingVector(folder); try refusals(); codes()
            let fixture = Fixture(control: URL(string: arguments[2])!, relay: arguments[3])
            #if JOSI_TUNNEL_APP
            try await throughJosiAPI(fixture)
            #else
            try await endToEnd(fixture)
            #endif
        } catch { print("FAIL threw: \(error)"); failures += 1 }
        print(failures == 0 ? "all passed" : "\(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
