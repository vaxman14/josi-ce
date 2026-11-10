import CryptoKit
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
    /// A server whose certificate macOS trusts goes through as usual. One on the
    /// local network whose own authority the person confirmed once is trusted by
    /// that pinned authority; anything else is refused and noted, so the app can
    /// show its fingerprint and ask.
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { completionHandler(.performDefaultHandling, nil); return }
        let host = challenge.protectionSpace.host
        if SecTrustEvaluateWithError(trust, nil) { completionHandler(.performDefaultHandling, nil); return }
        if JosiTrust.trustedByPin(trust, host: host) { completionHandler(.useCredential, URLCredential(trust: trust)); return }
        JosiTrust.noteUntrusted(host: host, trust: trust)
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}

/// Trusting a Josi server's own certificate authority (docs/WINDOWS_CLIENT_NODE_SPEC.md,
/// "Reach"): a server on the local network answers with a certificate its own proxy
/// issued. After the person confirms the fingerprint once, that authority is pinned
/// for that host in ~/Library/Application Support/Josi/trusted.
enum JosiTrust {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var untrusted: (host: String, fingerprint: String)?
    private static func file(_ host: String) -> URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Josi/trusted", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let safe = String(host.lowercased().map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "_" })
        return folder.appendingPathComponent(safe + ".cer")
    }
    static func fingerprint(_ trust: SecTrust) -> String {
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return "" }
        return SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02X", $0) }.joined(separator: ":")
    }
    static func trustedByPin(_ trust: SecTrust, host: String) -> Bool {
        guard let data = try? Data(contentsOf: file(host)), let root = SecCertificateCreateWithData(nil, data as CFData) else { return false }
        SecTrustSetAnchorCertificates(trust, [root] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        return SecTrustEvaluateWithError(trust, nil)
    }
    static func noteUntrusted(host: String, trust: SecTrust) {
        let print = fingerprint(trust)
        lock.withLock { untrusted = (host, print) }
    }
    /// The server whose certificate was refused on the last attempt, if any.
    static func takeUntrusted() -> (host: String, fingerprint: String)? { lock.withLock { let value = untrusted; untrusted = nil; return value } }
    /// Fetches the server's authority over a connection whose certificate is exactly
    /// the one the person approved, and pins it for that host.
    static func trust(origin: URL, fingerprint approved: String) async throws {
        guard let host = origin.host, let url = URL(string: origin.absoluteString + "/api/network/ca") else { throw JosiError(message: "Enter the server's address first.") }
        let session = URLSession(configuration: .ephemeral, delegate: OneCertificate(approved), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let value = try? JSONDecoder().decode(Wire.self, from: data) else {
            throw JosiError(message: "This server issues no certificate of its own, so it can't be trusted this way.")
        }
        let pem = value["pem"].text
        guard pem.contains("BEGIN CERTIFICATE") else { throw JosiError(message: "This server issues no certificate of its own, so it can't be trusted this way.") }
        let body = pem.components(separatedBy: "-----").filter { !$0.contains("CERTIFICATE") && !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.first ?? ""
        guard let der = Data(base64Encoded: body.replacingOccurrences(of: "\n", with: "").replacingOccurrences(of: "\r", with: "")),
              SecCertificateCreateWithData(nil, der as CFData) != nil else { throw JosiError(message: "The server's certificate could not be read.") }
        try der.write(to: file(host), options: .atomic)
    }
    private final class OneCertificate: NSObject, URLSessionDelegate, Sendable {
        let approved: String
        init(_ approved: String) { self.approved = approved }
        func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard let trust = challenge.protectionSpace.serverTrust, JosiTrust.fingerprint(trust) == approved else { completionHandler(.cancelAuthenticationChallenge, nil); return }
            completionHandler(.useCredential, URLCredential(trust: trust))
        }
    }
}

@MainActor final class JosiAPI {
    let origin: URL
    private let session: URLSession
    private var csrf: String?
    private var closed = false
    private var workEventRequest: URLSessionTask?
    /// The signed-in session. Once set, requests go as a native client with
    /// this bearer and no Origin, so "Keep me signed in" survives a relaunch.
    var bearer: String?
    /// Signs PC Control executor requests once this Mac's key is known: the
    /// owner's id and the key. Set by the PC executor after sign-in.
    var pcSigner: (owner: String, key: PcExecutorKey)?
    /// A bare LAN IP, hostname or domain means HTTPS; localhost means this Mac.
    static func normalized(_ address: String) -> String {
        let value = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("://") else { return value }
        let host = value.split(separator: ":").first.map { $0.lowercased() } ?? ""
        return (["localhost", "127.0.0.1"].contains(host) ? "http://" : "https://") + value
    }
    init(address: String) throws {
        guard var url = URLComponents(string: Self.normalized(address)),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host.lowercased())),
              url.port == nil || (1...65535).contains(url.port!) else {
            throw JosiError(message: "Use your server’s address or domain. Remote connections use HTTPS. Localhost is for a server on this Mac.")
        }
        url.path = ""
        guard let origin = url.url else { throw JosiError(message: "Enter a valid server address.") }
        self.origin = origin
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.urlCredentialStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 600
        config.httpAdditionalHeaders = ["User-Agent": "JosiNative/0.7", "Accept": "application/json"]
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    func close() { closed = true; csrf = nil; cancelWorkProgress(); session.invalidateAndCancel() }
    private func identify(_ request: inout URLRequest, native: Bool = false) {
        if native || bearer != nil { request.setValue("native", forHTTPHeaderField: "x-josi-client") }
        else { request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin") }
        if let bearer { request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        // Each Josi app names its computer, so PC Control keeps each one apart.
        request.setValue(PcDevice.id, forHTTPHeaderField: "x-josi-pc")
    }
    func cancelWorkProgress() { workEventRequest?.cancel(); workEventRequest = nil }

    /// Owner-scoped invalidations only. Event contents never become goal text,
    /// completion evidence, permissions, or instructions.
    func followWorkProgress(signal: @MainActor (String) -> Void) async throws {
        guard !closed, workEventRequest == nil,
              let url = URL(string: origin.absoluteString + "/api/assistant/work-goals/stream?all=1") else { throw CancellationError() }
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        identify(&request)
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
                 headers: [String: String] = [:], native: Bool = false, timeout: TimeInterval? = nil) async throws -> Wire {
        guard !closed, route.hasPrefix("/"), !route.hasPrefix("//"),
              !route.contains("#"), !route.contains("\\"), route.utf8.count < 4096,
              let url = URL(string: origin.absoluteString + "/api" + route),
              url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port else {
            throw JosiError(message: "Reconnect to your Josi server.")
        }
        let tokenAuth = native || bearer != nil
        if method != "GET", !tokenAuth, csrf == nil { try await primeCSRF() }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        identify(&req, native: native)
        if method != "GET", !tokenAuth { req.setValue(csrf, forHTTPHeaderField: "x-josi-csrf") }
        for (key, value) in headers { req.setValue(value, forHTTPHeaderField: key) }
        if let body {
            req.httpBody = try JSONEncoder().encode(body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        // The executor routes and pairing check a signature over exactly these bytes.
        if route.hasPrefix("/admin/pc-control/executor") || (route.hasPrefix("/admin/pc-control/identity") && method == "POST") {
            guard let pcSigner else { throw JosiError(message: "Approve this Mac for Josi before it can work on it.") }
            let path = String(url.absoluteString.dropFirst(origin.absoluteString.count))
            for (key, value) in try PcProof.headers(key: pcSigner.key, owner: pcSigner.owner, method: method, path: path, body: req.httpBody ?? Data()) {
                req.setValue(value, forHTTPHeaderField: key)
            }
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
    private func mediaResponse(_ request: URLRequest, mime: String? = nil) async throws -> Data {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard !closed, let http = response as? HTTPURLResponse, response.url == request.url else { throw CancellationError() }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard !closed, data.count < 4 * 1024 * 1024 else { throw JosiError(message: "The media response was interrupted or too large.") }
            data.append(byte)
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONDecoder().decode(Wire.self, from: data))?["error"].text ?? ""
            throw JosiError(message: error.isEmpty ? "The server could not process this media." : String(error.prefix(600)), status: http.statusCode)
        }
        if let mime, !(response.mimeType?.hasPrefix(mime) ?? false) { throw JosiError(message: "The server did not return voice audio.") }
        return data
    }
    func voiceAudio(_ route: String, body: Wire) async throws -> Data {
        guard !closed, ["/voice/speech", "/admin/voice-box/preview"].contains(route),
              let url = URL(string: origin.absoluteString + "/api" + route) else { throw CancellationError() }
        if csrf == nil, bearer == nil { try await primeCSRF() }
        var request = URLRequest(url: url); request.httpMethod = "POST"
        identify(&request)
        request.setValue(csrf, forHTTPHeaderField: "x-josi-csrf")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await mediaResponse(request, mime: "audio/")
    }
    func uploadAttachment(_ file: URL, thread: String) async throws -> Wire {
        let id = try uuid(thread)
        guard !closed, file.isFileURL, let url = URL(string: origin.absoluteString + "/api/assistant/threads/\(id)/attachments") else { throw CancellationError() }
        let access = file.startAccessingSecurityScopedResource(); defer { if access { file.stopAccessingSecurityScopedResource() } }
        let properties = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard properties.isRegularFile == true, let size = properties.fileSize, size <= 20 * 1024 * 1024 else { throw JosiError(message: "Choose a file of up to 20 MB.") }
        let content = try Data(contentsOf: file)
        guard content.count <= 20 * 1024 * 1024 else { throw JosiError(message: "The selected file is too large.") }
        let filename = file.lastPathComponent.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        let boundary = "Josi-" + UUID().uuidString
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        body.append(content); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        if csrf == nil, bearer == nil { try await primeCSRF() }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body
        identify(&request)
        request.setValue(csrf, forHTTPHeaderField: "x-josi-csrf")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return try JSONDecoder().decode(Wire.self, from: await mediaResponse(request))["attachment"]
    }
    /// Send to my devices: one file to one of my devices (`toDevice`) or to another
    /// person (`toUser`), from this device. The server relays it; nothing else sees it.
    func sendTransfer(_ file: URL, toDevice: String?, toUser: String?, from device: String) async throws -> Wire {
        var query = URLComponents(); var items = [URLQueryItem(name: "fromDevice", value: device)]
        if let toDevice { items.append(URLQueryItem(name: "toDevice", value: toDevice)) }
        if let toUser { items.append(URLQueryItem(name: "toUser", value: toUser)) }
        query.queryItems = items
        guard !closed, file.isFileURL, let url = URL(string: origin.absoluteString + "/api/device-transfers/" + "?" + (query.percentEncodedQuery ?? "")) else { throw CancellationError() }
        let properties = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard properties.isRegularFile == true, let size = properties.fileSize, size > 0, size <= 25 * 1024 * 1024 else { throw JosiError(message: "Choose a file of up to 25 MB.") }
        let content = try Data(contentsOf: file)
        let filename = file.lastPathComponent.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        let boundary = "Josi-" + UUID().uuidString
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        body.append(content); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        if csrf == nil, bearer == nil { try await primeCSRF() }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body
        identify(&request)
        if bearer == nil { request.setValue(csrf, forHTTPHeaderField: "x-josi-csrf") }
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        let value = (try? JSONDecoder().decode(Wire.self, from: data)) ?? .null
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw JosiError(message: value["error"].text.isEmpty ? "The file could not be sent." : value["error"].text, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return value
    }
    /// A file waiting for this device, at most 25 MB.
    func transferContent(_ id: String, device: String) async throws -> Data {
        guard !closed, let url = URL(string: origin.absoluteString + "/api/device-transfers/\(try uuid(id))/content?deviceId=\(device)") else { throw CancellationError() }
        var request = URLRequest(url: url); identify(&request)
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw JosiError(message: "That file is not waiting any more.") }
        var data = Data()
        for try await byte in bytes {
            guard !closed, data.count <= 25 * 1024 * 1024 else { throw JosiError(message: "The file was interrupted or too large.") }
            data.append(byte)
        }
        return data
    }
    func localSetupHandoff() async throws {
        guard origin.host == "localhost" else { throw JosiError(message: "Initial setup must be opened on the server Mac.") }
        var bootstrap = "/Library/Application Support/Josi CE Server/handoff/\(getuid())/bootstrap.json"
#if DEBUG
        // An Xcode run against a development server uses that server's handoff.
        if let path = ProcessInfo.processInfo.environment["JOSI_LOCAL_HANDOFF"] { bootstrap = path }
#endif
        let handoff = try NativeFiles.json(bootstrap, owner: getuid(), maximum: 4096, privateFile: true)
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
