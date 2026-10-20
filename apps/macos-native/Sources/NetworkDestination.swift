import Foundation
import Darwin

enum NativeNetworkError: Error { case denied, expired, unavailable }
enum NativeNetworkClass: String, Sendable { case `public`, `private`, loopback }

struct NativeNetworkRequest: Sendable, Equatable {
    let id: UUID, workspaceId: UUID, taskId: UUID
    let origin: String
    let networkClass: NativeNetworkClass
    let maximumBytes: Int
    let expiresAtMs: Int64
}

struct NativeNetworkDestination: Sendable, Equatable {
    let request: NativeNetworkRequest
    let hostname: String
    let port: UInt16
    /// Numeric addresses only. A connection must use the selected address,
    /// never resolve hostname again or fall back to a different destination.
    let addresses: [String]
    let networkClass: NativeNetworkClass
}

/// Required trusted server adapters, not decisions supplied by a guest, model
/// or UI. Resolution and connection are separate boundaries: DNS may change
/// the required locality, and no socket is opened by a lookup.
protocol NativeNetworkResolutionAuthority: Sendable {
    func beforeLookup(_ request: NativeNetworkRequest) async throws
    func afterLookup(_ destination: NativeNetworkDestination) async throws
}

/// The VM stays offline until the guest transport and real reservation adapter
/// are assembled. This resolver has no default authority and opens no socket.
actor NativeNetworkResolver {
    private let authority: any NativeNetworkResolutionAuthority
    private var consumed = Set<UUID>()
    private var active = false
    init(authority: any NativeNetworkResolutionAuthority) { self.authority = authority }

    func resolve(_ request: NativeNetworkRequest) async throws -> NativeNetworkDestination {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard !active, consumed.count < 4096, !consumed.contains(request.id),
              (1...16_777_216).contains(request.maximumBytes), request.expiresAtMs > now,
              request.expiresAtMs - now <= 10_000 else { throw NativeNetworkError.denied }
        let endpoint = try Self.endpoint(request.origin)
        consumed.insert(request.id); active = true
        defer { active = false }
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(request.expiresAtMs - now))
        func current() throws {
            let current = Int64(Date().timeIntervalSince1970 * 1000)
            guard current >= now, current < request.expiresAtMs, ContinuousClock.now < deadline else { throw NativeNetworkError.expired }
        }
        try await authority.beforeLookup(request)
        try current()
        let addresses = try await Self.lookup(endpoint.host, port: endpoint.port,
                                              milliseconds: min(3000, request.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)))
        try current()
        let classes = try addresses.map(Self.classify)
        guard let locality = classes.first, locality == request.networkClass,
              classes.allSatisfy({ $0 == locality }) else { throw NativeNetworkError.denied }
        let result = NativeNetworkDestination(request: request, hostname: endpoint.host, port: endpoint.port,
                                               addresses: addresses, networkClass: locality)
        try await authority.afterLookup(result)
        try current()
        return result
    }

    private static func endpoint(_ origin: String) throws -> (host: String, port: UInt16) {
        guard !origin.isEmpty, origin.utf8.count <= 2048, origin.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              !origin.contains("*"), !origin.contains("\\"), !origin.contains("%"),
              let parts = URLComponents(string: origin), let scheme = parts.scheme, ["https", "http"].contains(scheme),
              parts.user == nil, parts.password == nil, parts.path.isEmpty, parts.query == nil, parts.fragment == nil,
              let raw = parts.host, !raw.isEmpty, parts.string == origin, raw == raw.lowercased()
        else { throw NativeNetworkError.denied }
        let host = raw.hasPrefix("[") && raw.hasSuffix("]") ? String(raw.dropFirst().dropLast()) : raw
        let defaultPort = scheme == "https" ? 443 : 80
        guard parts.port != defaultPort, let port = UInt16(exactly: parts.port ?? defaultPort), port > 0 else { throw NativeNetworkError.denied }
        if !host.contains(":") {
            guard host.count <= 253, !host.hasSuffix("."), host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({
                !$0.isEmpty && $0.count <= 63 && !$0.hasPrefix("-") && !$0.hasSuffix("-")
                    && $0.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 })
            }) else { throw NativeNetworkError.denied }
            // Refuse noncanonical numeric/hex IPv4 aliases rather than asking
            // the resolver to reinterpret them as another destination.
            let labels = host.split(separator: ".")
            if labels.allSatisfy({ $0.allSatisfy(\.isNumber) || $0.hasPrefix("0x") }) {
                guard labels.count == 4, labels.allSatisfy({ part in
                    guard let value = UInt8(part) else { return false }
                    return String(value) == String(part)
                }) else { throw NativeNetworkError.denied }
            }
        } else { _ = try classify(host) }
        return (host, port)
    }

    private static func classify(_ address: String) throws -> NativeNetworkClass {
        guard !address.contains("%") else { throw NativeNetworkError.denied }
        var v4 = in_addr()
        if inet_pton(AF_INET, address, &v4) == 1 {
            let bytes = withUnsafeBytes(of: v4) { Array($0) }
            let a = Int(bytes[0]), b = Int(bytes[1]), c = Int(bytes[2])
            if a == 127 { return .loopback }
            if a == 10 || a == 172 && (16...31).contains(b) || a == 192 && b == 168 { return .private }
            guard a != 0, a < 224, !(a == 169 && b == 254), !(a == 100 && (64...127).contains(b)),
                  !(a == 192 && b == 0 && (c == 0 || c == 2)), !(a == 192 && b == 88 && c == 99),
                  !(a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)),
                  !(a == 203 && b == 0 && c == 113) else { throw NativeNetworkError.denied }
            return .public
        }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, address, &v6) == 1 else { throw NativeNetworkError.denied }
        let bytes = withUnsafeBytes(of: v6) { Array($0) }
        if bytes.prefix(15).allSatisfy({ $0 == 0 }), bytes[15] == 1 { return .loopback }
        if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255 {
            return try classify(bytes.suffix(4).map(String.init).joined(separator: "."))
        }
        if bytes[0] & 0xfe == 0xfc {
            guard Array(bytes.prefix(4)) != [0xfd, 0x00, 0x0e, 0xc2] else { throw NativeNetworkError.denied }
            return .private
        }
        // Only global unicast, excluding special-use, documentation and
        // transition ranges. Link-local, multicast, NAT64 and scoped addresses
        // cannot turn a public grant into access to a local service.
        guard bytes[0] & 0xe0 == 0x20,
              !(bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] < 2),
              Array(bytes.prefix(4)) != [0x20, 0x01, 0x0d, 0xb8],
              !(bytes[0] == 0x20 && bytes[1] == 0x02),
              !(bytes[0] == 0x3f && bytes[1] == 0xff && bytes[2] & 0xf0 == 0)
        else { throw NativeNetworkError.denied }
        return .public
    }

    private static func lookup(_ hostname: String, port: UInt16, milliseconds: Int64) async throws -> [String] {
        guard milliseconds > 0 else { throw NativeNetworkError.expired }
        return try await withCheckedThrowingContinuation { continuation in
            let reply = NetworkLookupReply { continuation.resume(with: $0) }
            let timeout = DispatchWorkItem { reply.finish(.failure(NativeNetworkError.expired)) }
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Int(milliseconds)), execute: timeout)
            DispatchQueue.global(qos: .utility).async {
                var hints = addrinfo()
                hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP
                var list: UnsafeMutablePointer<addrinfo>?
                guard getaddrinfo(hostname, String(port), &hints, &list) == 0, let head = list else {
                    reply.finish(.failure(NativeNetworkError.unavailable)); return
                }
                defer { freeaddrinfo(head) }
                var values: [String] = [], seen = Set<String>(), entry: UnsafeMutablePointer<addrinfo>? = head, count = 0
                while let current = entry {
                    count += 1
                    guard count <= 64, [AF_INET, AF_INET6].contains(current.pointee.ai_family) else {
                        reply.finish(.failure(NativeNetworkError.denied)); return
                    }
                    var address = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    guard getnameinfo(current.pointee.ai_addr, current.pointee.ai_addrlen, &address, socklen_t(address.count),
                                      nil, 0, NI_NUMERICHOST) == 0 else {
                        reply.finish(.failure(NativeNetworkError.unavailable)); return
                    }
                    let value = String(decoding: address.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    if seen.insert(value).inserted { values.append(value) }
                    entry = current.pointee.ai_next
                }
                guard !values.isEmpty, values.count <= 16 else { reply.finish(.failure(NativeNetworkError.denied)); return }
                reply.finish(.success(values))
            }
        }
    }
}

private final class NetworkLookupReply: @unchecked Sendable {
    private let lock = NSLock()
    private var completion: (@Sendable (Result<[String], Error>) -> Void)?
    init(_ completion: @escaping @Sendable (Result<[String], Error>) -> Void) { self.completion = completion }
    func finish(_ result: Result<[String], Error>) {
        lock.lock(); let callback = completion; completion = nil; lock.unlock()
        callback?(result)
    }
}
