import Foundation
import Darwin

/// Volatile guest relay. Only the signed Companion can install a short-lived
/// routing scope and answer requests. The scope permits connection only;
/// the owner and server must separately authorize each browser operation. Browser peers cannot call its
/// owner interface or construct an execution permit locally.
@main enum JosiGuestBrowserBroker {
    static func main() {
        do {
            try GuestBrowserBoundary.requireSelf(identifier: GuestBrowserBoundary.brokerIdentifier,
                executable: "/Applications/Josi Companion.app/Contents/Helpers/JosiBrowserBroker")
            let broker = BrowserBroker()
            broker.start()
            withExtendedLifetime(broker) { RunLoop.current.run() }
        } catch { /* No request contents or native errors in logs. */ }
    }
}

private final class BrowserBroker: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.heyjosi.guestbrowser.state")
    private let ownerListener = NSXPCListener(machServiceName: GuestBrowserBoundary.ownerService)
    private let peerListener = NSXPCListener(machServiceName: GuestBrowserBoundary.service)
    private var owner: NSXPCConnection?
    private var authority: [String: Any]?
    private var deadline: UInt64 = 0, lastWall: Int64 = 0
    private var peers: [ObjectIdentifier: NSXPCConnection] = [:]
    private var peerScopes: [ObjectIdentifier: (digest: String, persistent: Bool, busy: Bool)] = [:]
    private var requests = Set<String>(), retiredConnections = Set<String>()
    private var outstanding = false
    func start() {
        ownerListener.setConnectionCodeSigningRequirement(GuestBrowserBoundary.requirement("com.heyjosi.ce.guestcompanion"))
        peerListener.setConnectionCodeSigningRequirement(
            "(" + GuestBrowserBoundary.requirement("com.heyjosi.ce.guestbrowser-host") + ") or ("
                + GuestBrowserBoundary.requirement("com.heyjosi.ce.guestcompanion.workspace-safari") + ")")
        ownerListener.delegate = self; peerListener.delegate = self
        ownerListener.resume(); peerListener.resume()
    }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier == geteuid() else { return false }
        let key = ObjectIdentifier(connection)
        return queue.sync {
            if listener === ownerListener {
                guard owner == nil else { return false }
                owner = connection
                connection.exportedInterface = NSXPCInterface(with: GuestBrowserOwner.self)
                connection.remoteObjectInterface = NSXPCInterface(with: GuestBrowserOwnerCallback.self)
                connection.exportedObject = BrowserOwnerPort(broker: self, connection: connection)
                connection.invalidationHandler = { [weak self] in
                    guard let self else { return }
                    self.queue.async { if self.owner.map(ObjectIdentifier.init) == key { self.owner = nil; self.clear() } }
                }
                connection.interruptionHandler = { [weak connection] in connection?.invalidate() }
            } else {
                guard listener === peerListener, peers.count < 8 else { return false }
                peers[ObjectIdentifier(connection)] = connection
                connection.exportedInterface = NSXPCInterface(with: GuestBrowserExchange.self)
                connection.exportedObject = BrowserPeerPort(broker: self, connection: connection)
                connection.invalidationHandler = { [weak self] in
                    guard let self else { return }
                    self.queue.async {
                        self.peers.removeValue(forKey: key)
                        let scope = self.peerScopes.removeValue(forKey: key)
                        // Safari completes one request per handler lifetime.
                        // Its normal completed-handler exit is not takeover.
                        // Lost in-flight replies and persistent host loss stop.
                        if let scope, scope.digest == self.authority?["connectionId"] as? String,
                           scope.busy || scope.persistent { self.clear() }
                    }
                }
                connection.interruptionHandler = { [weak connection] in connection?.invalidate() }
            }
            connection.resume(); return true
        }
    }
    private func clear() {
        if let digest = authority?["connectionId"] as? String { retiredConnections.insert(digest) }
        authority = nil; deadline = 0; outstanding = false
        // Keep request IDs for this owner connection: stop is not replay reset.
    }
    private func live() -> Bool {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard let authority, now >= lastWall, let until = authority["leaseUntilMs"] as? Int64,
              now < until, DispatchTime.now().uptimeNanoseconds < deadline, owner != nil else { clear(); return false }
        lastWall = now; return true
    }
    func renew(_ data: Data, from connection: NSXPCConnection, reply: @escaping @Sendable (Bool) -> Void) {
        let key = ObjectIdentifier(connection)
        queue.async {
            do {
                guard self.owner.map(ObjectIdentifier.init) == key, data.count <= 8192,
                      let next = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      Set(next.keys) == ["workspaceId", "profileId", "family", "guestBootId", "hostBootId", "connectionId", "generation", "leaseUntilMs"],
                      ["workspaceId", "profileId", "guestBootId", "hostBootId"].allSatisfy({ key in
                          guard let id = next[key] as? String else { return false }
                          return UUID(uuidString: id)?.uuidString.lowercased() == id
                      }), let family = next["family"] as? String, ["chrome", "brave", "firefox", "safari"].contains(family),
                      let digest = next["connectionId"] as? String, UUID(uuidString: digest)?.uuidString.lowercased() == digest,
                      let generation = next["generation"] as? NSNumber, CFGetTypeID(generation) != CFBooleanGetTypeID(),
                      generation.doubleValue == Double(generation.int64Value), generation.int64Value >= 0,
                      let rawUntil = next["leaseUntilMs"] as? NSNumber, CFGetTypeID(rawUntil) != CFBooleanGetTypeID(),
                      rawUntil.doubleValue == Double(rawUntil.int64Value) else { throw GuestBrowserError.invalid }
                let boot = try GuestBrowserBoundary.isolatedBoot(), now = Int64(Date().timeIntervalSince1970 * 1000), until = rawUntil.int64Value
                guard next["guestBootId"] as? String == boot.guest, next["hostBootId"] as? String == boot.host,
                      now >= self.lastWall, until > now, until - now <= 10_000 else { throw GuestBrowserError.expired }
                if let previous = self.authority {
                    guard self.live(), NSDictionary(dictionary: previous.filter { $0.key != "leaseUntilMs" })
                        .isEqual(to: next.filter { $0.key != "leaseUntilMs" }) else { throw GuestBrowserError.invalid }
                }
                guard !self.retiredConnections.contains(digest), self.retiredConnections.count < 4096 else { throw GuestBrowserError.unavailable }
                self.authority = next; self.lastWall = now
                self.deadline = DispatchTime.now().uptimeNanoseconds + UInt64(until - now) * 1_000_000
                reply(true)
            } catch { self.clear(); reply(false) }
        }
    }
    func stop(from connection: NSXPCConnection) {
        let key = ObjectIdentifier(connection)
        queue.async { if self.owner.map(ObjectIdentifier.init) == key { self.clear() } }
    }
    func exchange(_ data: Data, peer: Data, from connection: NSXPCConnection,
                  reply: @escaping @Sendable (Data?, NSError?) -> Void) {
        let key = ObjectIdentifier(connection)
        queue.async {
            do {
                let request = try GuestBrowserBoundary.request(data)
                guard self.peers[key] != nil, self.live(), let authority = self.authority,
                      self.requests.count < 16384, let id = request["requestId"] as? String, !self.requests.contains(id),
                      peer.count <= 8192, let source = try JSONSerialization.jsonObject(with: peer) as? [String: Any],
                      ["family", "profileId", "guestBootId", "hostBootId"].allSatisfy({ source[$0] as? String == authority[$0] as? String }),
                      source["family"] as? String == "safari" || source["workspaceId"] as? String == authority["workspaceId"] as? String,
                      !self.outstanding || request["operation"] as? String == "browser.stop", let owner = self.owner
                else { throw GuestBrowserError.unavailable }
                self.requests.insert(id)
                self.outstanding = true
                let gate = BrokerReply(reply), expires = self.deadline, ownerKey = ObjectIdentifier(owner)
                let digest = authority["connectionId"] as? String
                guard let digest, source["kind"] as? String == (source["family"] as? String == "safari" ? "safari-profile" : "browser-process")
                else { throw GuestBrowserError.invalid }
                self.peerScopes[key] = (digest, source["family"] as? String != "safari", true)
                let stopping = request["operation"] as? String == "browser.stop"
                let timeout = DispatchWorkItem { [self] in
                    self.queue.async { self.clear(); gate.finish(nil) }
                }
                self.queue.asyncAfter(deadline: .now() + 3, execute: timeout)
                guard let callback = owner.remoteObjectProxyWithErrorHandler({ _ in
                    timeout.cancel(); self.queue.async { self.clear(); gate.finish(nil) }
                }) as? GuestBrowserOwnerCallback else { throw GuestBrowserError.unavailable }
                callback.handle(data, peer: peer) { response, error in
                    timeout.cancel()
                    self.queue.async {
                        self.outstanding = false
                        if var scope = self.peerScopes[key], scope.digest == digest {
                            scope.busy = false; self.peerScopes[key] = scope
                        }
                        guard error == nil, self.owner.map(ObjectIdentifier.init) == ownerKey, self.live(), self.deadline >= expires,
                              self.authority?["connectionId"] as? String == digest,
                              let response, response.count <= GuestBrowserBoundary.maximumBytes,
                              let value = try? JSONSerialization.jsonObject(with: response) as? [String: Any],
                              value["requestId"] as? String == id else { self.clear(); gate.finish(nil); return }
                        gate.finish(response)
                        if stopping { self.clear() }
                    }
                }
                if stopping { self.clear() }
            } catch { reply(nil, NSError(domain: "JosiWorkspace", code: 1)) }
        }
    }
}

private final class BrowserOwnerPort: NSObject, GuestBrowserOwner, @unchecked Sendable {
    private weak var broker: BrowserBroker?
    private weak var connection: NSXPCConnection?
    init(broker: BrowserBroker, connection: NSXPCConnection) { self.broker = broker; self.connection = connection }
    func renew(_ authority: Data, reply: @escaping (Bool) -> Void) {
        let safe = OwnerReply(reply)
        guard let connection, let broker else { safe.finish(false); return }
        broker.renew(authority, from: connection) { safe.finish($0) }
    }
    func stop() { if let connection { broker?.stop(from: connection) } }
}
private final class BrowserPeerPort: NSObject, GuestBrowserExchange, @unchecked Sendable {
    private weak var broker: BrowserBroker?
    private weak var connection: NSXPCConnection?
    init(broker: BrowserBroker, connection: NSXPCConnection) { self.broker = broker; self.connection = connection }
    func exchange(_ request: Data, peer: Data, reply: @escaping (Data?, NSError?) -> Void) {
        let safe = BrokerReply(reply)
        guard let connection, let broker else { safe.finish(nil); return }
        broker.exchange(request, peer: peer, from: connection) { data, _ in safe.finish(data) }
    }
}
private final class OwnerReply: @unchecked Sendable {
    private let callback: (Bool) -> Void
    init(_ callback: @escaping (Bool) -> Void) { self.callback = callback }
    func finish(_ value: Bool) { callback(value) }
}
private final class BrokerReply: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: ((Data?, NSError?) -> Void)?
    init(_ callback: @escaping (Data?, NSError?) -> Void) { self.callback = callback }
    func finish(_ value: Data?) {
        lock.lock(); let completion = callback; callback = nil; lock.unlock()
        completion?(value, value == nil ? NSError(domain: "JosiWorkspace", code: 1) : nil)
    }
}
