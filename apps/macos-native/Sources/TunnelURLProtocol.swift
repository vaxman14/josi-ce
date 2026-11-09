// The relay is off in this release (JosiFlags.relay); this returns with RELAY_ENABLED.
#if RELAY_ENABLED
import Foundation
import os

/// Carries a URLSession's requests through the tunnel. A session configured with
/// this class never touches the network itself: with no route it fails, it doesn't
/// fall back. As with JosiAPI's own session, redirects are handed back, not followed.
final class TunnelURLProtocol: URLProtocol, @unchecked Sendable {
    private struct State {
        var tunnel: TunnelClient?, stream: UInt32?, work: Task<Void, Never>?, watchdog: Task<Void, Never>?
        var answered = false, finished = false, stopped = false
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private var runLoop: CFRunLoop?
    private static let dropped: Set<String> = ["host", "connection", "cookie", "content-length", "accept-encoding", "transfer-encoding", "te", "upgrade", "keep-alive"]

    override class func canInit(with request: URLRequest) -> Bool { ["http", "https"].contains(request.url?.scheme ?? "") }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        runLoop = CFRunLoopGetCurrent()
        let request = request, timeout = request.timeoutInterval
        let this = self
        let work = Task { @Sendable in
            do {
                guard let host = request.url?.host, let connection = TunnelRoutes.connection(host) else { throw TunnelError("closed") }
                let (head, body) = try Self.prepare(request)
                let tunnel = try await connection.session()
                guard !this.state.withLock({ $0.finished }) else { return }
                let stream = try await tunnel.request(method: head.method, path: head.path, headers: head.headers, body: body) { this.event($0) }
                let cancelled = this.state.withLock { $0.tunnel = tunnel; $0.stream = stream; return $0.finished }
                if cancelled { await tunnel.cancel(stream) }
            } catch { this.fail(error) }
        }
        let watchdog = Task { @Sendable in
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
            guard !this.state.withLock({ $0.answered }) else { return }
            this.stop(); this.fail(URLError(.timedOut))
        }
        state.withLock { $0.work = work; $0.watchdog = watchdog }
    }
    override func stopLoading() {
        state.withLock { $0.finished = true; $0.stopped = true }
        stop()
    }
    private func stop() {
        let (tunnel, stream, work, watchdog) = state.withLock { ($0.tunnel, $0.stream, $0.work, $0.watchdog) }
        work?.cancel(); watchdog?.cancel()
        if let tunnel, let stream { Task { await tunnel.cancel(stream) } }
    }

    private static func prepare(_ request: URLRequest) throws -> (head: (method: String, path: String, headers: [(String, String)]), body: Data) {
        guard let url = request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        let body = try readBody(request)
        var headers = (request.allHTTPHeaderFields ?? [:]).filter { !dropped.contains($0.key.lowercased()) }.map { ($0.key, $0.value) }
        // Nothing here would decode it, and the padding already hides sizes.
        headers.append(("Accept-Encoding", "identity"))
        if !body.isEmpty { headers.append(("Content-Length", String(body.count))) }
        let path = (parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath) + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
        return ((request.httpMethod ?? "GET", path, headers), body)
    }
    /// URLSession often hands a protocol the body as a stream, even when it was set as data.
    private static func readBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var out = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0, out.count + count <= 64 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            if count == 0 { return out }
            out.append(contentsOf: buffer[..<count])
        }
    }

    private func event(_ event: TunnelStreamEvent) {
        guard !state.withLock({ $0.finished }) else { return }
        switch event {
        case .head(let head):
            guard let url = request.url, (100...599).contains(head.status) else { stop(); fail(URLError(.badServerResponse)); return }
            var fields: [String: String] = [:]
            for pair in head.headers { fields[pair[0]] = fields[pair[0]].map { $0 + ", " + pair[1] } ?? pair[1] }
            guard let response = HTTPURLResponse(url: url, statusCode: head.status, httpVersion: "HTTP/1.1", headerFields: fields) else { stop(); fail(URLError(.badServerResponse)); return }
            state.withLock { $0.answered = true; $0.watchdog?.cancel() }
            deliver { $0.urlProtocol($1, didReceive: response, cacheStoragePolicy: .notAllowed) }
        case .body(let data): deliver { $0.urlProtocol($1, didLoad: data) }
        case .end: if finish() { deliver { client, this in client.urlProtocolDidFinishLoading(this) } }
        case .failed(let error): fail(error)
        }
    }
    /// A dropped tunnel reads as a dropped connection, so callers that treat a lost
    /// reply as "may have been saved" keep doing so.
    private func fail(_ error: Error) {
        guard finish() else { return }
        var reported = error
        if let tunnel = error as? TunnelError {
            // URLSession rebuilds what it's given as an NSError, so the message has to travel in one.
            reported = ["closed", "reset"].contains(tunnel.code) ? URLError(.networkConnectionLost)
                : NSError(domain: "JosiTunnel", code: 1, userInfo: [NSLocalizedDescriptionKey: tunnel.message, "code": tunnel.code])
        }
        deliver { $0.urlProtocol($1, didFailWithError: reported) }
    }
    private func finish() -> Bool {
        state.withLock { let first = !$0.finished; $0.finished = true; $0.watchdog?.cancel(); return first }
    }
    /// A protocol's client is called on the thread that started it. FIFO, so a
    /// stream's events keep their order.
    private func deliver(_ work: @escaping (any URLProtocolClient, URLProtocol) -> Void) {
        guard let runLoop else { return }
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue) { [self] in
            if !state.withLock({ $0.stopped }), let client { work(client, self) }
        }
        CFRunLoopWakeUp(runLoop)
    }
}

#endif
