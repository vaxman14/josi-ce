import Foundation

/// Wire values stay in memory. No server response, login or Vault material is
/// written to preferences, a cookie file, a diagnostic log or a web renderer.
enum Wire: Codable, Sendable, Equatable {
    case object([String: Wire]), array([Wire]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([Wire].self) { self = .array(v) }
        else { self = .object(try c.decode([String: Wire].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> Wire { if case .object(let o) = self { return o[key] ?? .null }; return .null }
    var text: String { if case .string(let v) = self { return v }; return "" }
    var list: [Wire] { if case .array(let v) = self { return v }; return [] }
    var flag: Bool { if case .bool(let v) = self { return v }; return false }
    var integer: Int { if case .number(let v) = self, v.isFinite, abs(v) < 9e15 { return Int(v) }; return 0 }
    var identifier: String { self["id"].text.isEmpty ? self["goalId"].text : self["id"].text }
}
extension Wire: ExpressibleByDictionaryLiteral {
    init(dictionaryLiteral elements: (String, Wire)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
}
extension Wire: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self = .string(value) }
}
struct JosiError: LocalizedError, Sendable {
    let message: String
    var status = 0
    var errorDescription: String? { message }
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class JosiAPI {
    let origin: URL
    private let session: URLSession
    private var csrf: String?
    private var closed = false
    private var workEventRequest: URLSessionTask?
    init(address: String) throws {
        guard var url = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host.lowercased())),
              url.port == nil || (1...65535).contains(url.port!) else {
            throw JosiError(message: "Use your server’s HTTPS address, or HTTP localhost for a server on this Mac.")
        }
        url.path = ""
        guard let origin = url.url else { throw JosiError(message: "Enter a valid server address.") }
        self.origin = origin
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.urlCredentialStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 180
        config.httpAdditionalHeaders = ["User-Agent": "JosiNative/0.7", "Accept": "application/json"]
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    func close() { closed = true; csrf = nil; cancelWorkProgress(); session.invalidateAndCancel() }
    func cancelWorkProgress() { workEventRequest?.cancel(); workEventRequest = nil }

    /// Owner-scoped invalidations only. Event contents never become goal text,
    /// completion evidence, permissions, or instructions.
    func followWorkProgress(signal: @MainActor (String) -> Void) async throws {
        guard !closed, workEventRequest == nil,
              let url = URL(string: origin.absoluteString + "/api/assistant/work-goals/stream?all=1") else { throw CancellationError() }
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        let (bytes, response) = try await session.bytes(for: request)
        guard !closed, !Task.isCancelled else { bytes.task.cancel(); throw CancellationError() }
        workEventRequest = bytes.task
        defer {
            bytes.task.cancel()
            if workEventRequest === bytes.task { workEventRequest = nil }
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.url == url, response.mimeType == "text/event-stream" else {
            throw JosiError(message: "Live progress is unavailable.", status: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        var line = Data(), event = "", payload = "", total = 0, frameBytes = 0
        for try await byte in bytes {
            try Task.checkCancellation()
            guard !closed, total < 1024 * 1024, line.count < 8192, frameBytes < 16_384 else {
                throw JosiError(message: "The live progress connection ended.")
            }
            total += 1; frameBytes += 1
            if byte != 10 { line.append(byte); continue }
            if line.last == 13 { line.removeLast() }
            guard let text = String(data: line, encoding: .utf8) else { throw JosiError(message: "Invalid progress event.") }
            line.removeAll(keepingCapacity: true)
            if text.isEmpty {
                if !event.isEmpty {
                    guard ["progress", "heartbeat", "unavailable", "access-ended"].contains(event),
                          let value = try? JSONDecoder().decode(Wire.self, from: Data(payload.utf8)),
                          event == "progress" ? ProtectedWire.exact(value, ["revision"])
                            && ProtectedWire.matches(value["revision"], "^[a-f0-9]{64}$") : ProtectedWire.exact(value, [])
                    else { throw JosiError(message: "Invalid progress event.") }
                    signal(event)
                    if event == "access-ended" || event == "unavailable" { return }
                }
                event = ""; payload = ""; frameBytes = 0
            } else if text.hasPrefix("event:") {
                guard event.isEmpty else { throw JosiError(message: "Invalid progress event.") }
                event = String(text.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if text.hasPrefix("data:") {
                if !payload.isEmpty { payload += "\n" }
                payload += String(text.dropFirst(5).drop(while: { $0 == " " }))
            } else if !text.hasPrefix(":") && !text.hasPrefix("retry:") {
                throw JosiError(message: "Unsupported progress event.")
            }
        }
    }
    func downloadBackup(_ identifier: String, expectedBytes: Int64, destination: URL,
                        progress: @MainActor (Int64) throws -> Void) async throws {
        let id = try uuid(identifier)
        guard !closed, expectedBytes > 0, expectedBytes <= 9_007_199_254_740_991,
              let url = URL(string: origin.absoluteString + "/api/ops/admin/backups/\(id)/download") else {
            throw JosiError(message: "Refresh the completed backup before downloading.")
        }
        try progress(0)
        let storage = try FileManager.default.attributesOfFileSystem(forPath: destination.deletingLastPathComponent().path)
        guard let free = storage[.systemFreeSize] as? NSNumber, free.int64Value >= expectedBytes else {
            throw JosiError(message: "The selected disk does not have enough free space for this archive.")
        }
        var request = URLRequest(url: url)
        request.setValue("application/zip", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard !closed, let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.url == url, response.mimeType == "application/zip",
              response.expectedContentLength == expectedBytes else {
            throw JosiError(message: "The completed archive could not be verified. Refresh backup history and try again.")
        }
        try progress(0)
        let file = try NativePrivateExport(destination: destination)
        var buffer = Data(); buffer.reserveCapacity(256 * 1024)
        var total: Int64 = 0
        for try await byte in bytes {
            guard !closed, total < expectedBytes else { throw JosiError(message: "The backup download changed or was interrupted.") }
            buffer.append(byte); total += 1
            if buffer.count == 256 * 1024 {
                try Task.checkCancellation(); try progress(total)
                try file.write(buffer); buffer.removeAll(keepingCapacity: true)
            }
        }
        guard !closed, total == expectedBytes else { throw JosiError(message: "The backup download was incomplete. The destination was not replaced.") }
        try Task.checkCancellation(); try progress(total)
        if !buffer.isEmpty { try file.write(buffer) }
        try file.finish()
    }
    func uuid(_ value: String) throws -> String {
        guard UUID(uuidString: value) != nil else { throw JosiError(message: "Refresh this item before continuing.") }
        return value
    }
    func primeCSRF() async throws {
        let result = try await request("/auth/csrf")
        guard !result["csrfToken"].text.isEmpty, result["csrfToken"].text.count <= 256 else {
            throw JosiError(message: "The server could not prepare a secure session.")
        }
        csrf = result["csrfToken"].text
    }
    func request(_ route: String, method: String = "GET", body: Wire? = nil,
                 headers: [String: String] = [:]) async throws -> Wire {
        guard !closed, route.hasPrefix("/"), !route.hasPrefix("//"),
              !route.contains("#"), !route.contains("\\"), route.utf8.count < 4096,
              let url = URL(string: origin.absoluteString + "/api" + route),
              url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port else {
            throw JosiError(message: "Reconnect to your Josi server.")
        }
        if method != "GET", csrf == nil { try await primeCSRF() }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        if method != "GET" { req.setValue(csrf, forHTTPHeaderField: "x-josi-csrf") }
        for (key, value) in headers { req.setValue(value, forHTTPHeaderField: key) }
        if let body {
            req.httpBody = try JSONEncoder().encode(body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse, response.url == url else {
            throw JosiError(message: "The server returned an unexpected response.")
        }
        guard response.expectedContentLength <= 4 * 1024 * 1024 else {
            bytes.task.cancel(); throw JosiError(message: "The response is too large. Narrow the selected work.")
        }
        var data = Data()
        for try await byte in bytes {
            if data.count >= 4 * 1024 * 1024 || closed {
                bytes.task.cancel(); throw JosiError(message: "The response was interrupted.")
            }
            data.append(byte)
        }
        guard !closed else { throw CancellationError() }
        let value = data.isEmpty ? Wire.null : (try? JSONDecoder().decode(Wire.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            let detail = value["error"].text
            throw JosiError(message: detail.isEmpty ? "The server could not complete that request (\(http.statusCode))." : String(detail.prefix(600)),
                            status: http.statusCode)
        }
        return value
    }
    func localSetupHandoff() async throws {
        guard origin.host == "localhost" else { throw JosiError(message: "Initial setup must be opened on the server Mac.") }
        let handoff = try NativeFiles.json("/Library/Application Support/Josi CE Server/handoff/\(getuid())/bootstrap.json",
                                           owner: getuid(), maximum: 4096, privateFile: true)
        guard handoff["port"].integer == origin.port, handoff["token"].text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw JosiError(message: "The setup handoff does not match this server.")
        }
        let launch = try await request("/onboarding/launch", method: "POST", body: [:],
                                       headers: ["x-josi-setup-token": handoff["token"].text])
        guard launch["token"].text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw JosiError(message: "The setup session could not be prepared.")
        }
        _ = try await request("/onboarding/consume", method: "POST", body: ["token": launch["token"]])
    }
}
