import Foundation
import Security
import CryptoKit
import Darwin

private enum ConsentFailure: Error { case unavailable, invalid }

/// One attempt, no secrets, no network listener and no authority database.
/// The API owns the parent pipes. Only the actual signed Josi app may connect
/// through the local socket; its main process owns review and OS presence.
@main
struct DeviceConsentHost {
    private static let directory = "/Library/Application Support/Josi CE Server/control"
    private static let limit = 128 * 1024
    private static func exact(_ object: [String: Any], _ keys: Set<String>) throws {
        guard Set(object.keys) == keys else { throw ConsentFailure.invalid }
    }
    private static func uuid(_ value: Any?) -> String? {
        guard let value = value as? String, let parsed = UUID(uuidString: value),
              parsed.uuidString.lowercased() == value else { return nil }
        return value
    }
    private static func clock() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private static func wait(_ fd: Int32, _ events: Int16, _ deadline: UInt64) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw ConsentFailure.unavailable }
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let remaining = min(UInt64(120_000), (deadline - now) / 1_000_000 + 1)
            let result = poll(&descriptor, 1, Int32(remaining))
            if result < 0 && errno == EINTR { continue }
            guard result > 0, descriptor.revents & events != 0 else { throw ConsentFailure.unavailable }
            return
        }
    }
    private static func read(_ fd: Int32, count: Int, deadline: UInt64) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count), offset = 0
        while offset < count {
            try wait(fd, Int16(POLLIN), deadline)
            let size = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), count - offset)
            }
            if size < 0 && errno == EINTR { continue }
            guard size > 0 else { throw ConsentFailure.unavailable }
            offset += size
        }
        return Data(bytes)
    }
    private static func frame(_ fd: Int32, deadline: UInt64) throws -> [String: Any] {
        let header = try read(fd, count: 4, deadline: deadline)
        let size = header.reduce(0) { ($0 << 8) | Int($1) }
        guard size > 0, size <= limit,
              let value = try JSONSerialization.jsonObject(with: read(fd, count: size, deadline: deadline)) as? [String: Any]
        else { throw ConsentFailure.invalid }
        return value
    }
    private static func send(_ fd: Int32, _ value: [String: Any], deadline: UInt64) throws {
        let body = try JSONSerialization.data(withJSONObject: value)
        guard body.count > 0, body.count <= limit else { throw ConsentFailure.invalid }
        let size = UInt32(body.count)
        let bytes = Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)]) + body
        var offset = 0
        while offset < bytes.count {
            try wait(fd, Int16(POLLOUT), deadline)
            let size = bytes.withUnsafeBytes { buffer in
                Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), bytes.count - offset)
            }
            if size < 0 && errno == EINTR { continue }
            guard size > 0 else { throw ConsentFailure.unavailable }
            offset += size
        }
    }
    private static func identity(_ fd: Int32, full: Bool) throws {
        var address = sockaddr_un(), length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let local = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard local == 0, length >= 2, address.sun_family == sa_family_t(AF_UNIX) else { throw ConsentFailure.unavailable }
        var token = audit_token_t(), tokenSize = socklen_t(MemoryLayout<audit_token_t>.size)
        // A kernel audit token includes the process incarnation; a client PID
        // or PID-only lookup would permit reuse/identity races.
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenSize) == 0,
              tokenSize == MemoryLayout<audit_token_t>.size else { throw ConsentFailure.unavailable }
        let data = withUnsafeBytes(of: token) { Data($0) }
        guard data.contains(where: { $0 != 0 }) else { throw ConsentFailure.unavailable }
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit as String: data] as CFDictionary, [], &code) == errSecSuccess,
              let code else { throw ConsentFailure.unavailable }
        try ProtectedAppTrust.verify(code, requirement: ProtectedAppTrust.requirement(), full: full)
        if full { try ProtectedAppTrust.packagedCode() }
    }
    private static func protectedDirectory() throws {
        guard let account = getpwnam("_josice_web"), account.pointee.pw_uid > 0,
              getuid() == account.pointee.pw_uid, geteuid() == account.pointee.pw_uid else { throw ConsentFailure.unavailable }
        var url = URL(fileURLWithPath: directory, isDirectory: true)
        while url.path != "/" {
            var info = stat()
            guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o022 == 0,
                  info.st_uid == (url.path == directory ? getuid() : 0) else { throw ConsentFailure.unavailable }
            url.deleteLastPathComponent()
        }
        guard URL(fileURLWithPath: directory).resolvingSymlinksInPath().path == directory else { throw ConsentFailure.unavailable }
        for fd in [STDIN_FILENO, STDOUT_FILENO] {
            var info = stat()
            guard fstat(fd, &info) == 0, [S_IFIFO, S_IFSOCK].contains(info.st_mode & S_IFMT) else { throw ConsentFailure.unavailable }
        }
    }
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let parent = getppid(), started = clock(), startMono = DispatchTime.now().uptimeNanoseconds
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(120))
        timer.setEventHandler { Darwin._exit(78) }
        timer.resume()
        defer { timer.cancel() }
        var listener: Int32 = -1, client: Int32 = -1
        var socketPath: String?, socketInode: ino_t?
        defer {
            if client >= 0 { Darwin.close(client) }
            if listener >= 0 { Darwin.close(listener) }
            if let path = socketPath, let inode = socketInode {
                var info = stat()
                if lstat(path, &info) == 0, info.st_ino == inode, info.st_uid == getuid(),
                   info.st_mode & S_IFMT == S_IFSOCK { unlink(path) }
            }
        }
        do {
            try protectedDirectory()
            guard parent > 1 else { throw ConsentFailure.unavailable }
            let input = try frame(STDIN_FILENO, deadline: startMono + 10_000_000_000)
            try exact(input, ["schemaVersion", "id", "challengeDigest", "expiresAtMs", "message"])
            guard input["schemaVersion"] as? Int == 1, let id = uuid(input["id"]),
                  let digest = input["challengeDigest"] as? String, digest.count == 64,
                  let expires = input["expiresAtMs"] as? Int64, expires > clock(), expires - started <= 120_000,
                  let encoded = input["message"] as? String, let message = Data(base64Encoded: encoded),
                  message.count <= 64 * 1024, message.base64EncodedString() == encoded,
                  SHA256.hash(data: message).map({ String(format: "%02x", $0) }).joined() == digest,
                  let text = String(data: message, encoding: .utf8), text.hasPrefix("josi-device-consent.1\n"),
                  let array = try JSONSerialization.jsonObject(with: Data(text.dropFirst("josi-device-consent.1\n".count).utf8)) as? [Any],
                  array.count == 13, array[0] as? Int == 1, array[1] as? String == id, array[11] as? Int64 == expires
            else { throw ConsentFailure.invalid }
            let deadline = startMono + UInt64(expires - started) * 1_000_000
            let path = directory + "/" + id + ".sock", pathBytes = Array(path.utf8)
            var address = sockaddr_un()
            guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw ConsentFailure.invalid }
            address.sun_family = sa_family_t(AF_UNIX)
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            withUnsafeMutableBytes(of: &address.sun_path) { buffer in
                buffer.copyBytes(from: pathBytes + [0])
            }
            listener = socket(AF_UNIX, SOCK_STREAM, 0)
            guard listener >= 0, fcntl(listener, F_SETFD, FD_CLOEXEC) == 0 else { throw ConsentFailure.unavailable }
            _ = umask(0o077)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0 else { throw ConsentFailure.unavailable } // Never unlink an existing request.
            socketPath = path
            var info = stat()
            guard lstat(path, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFSOCK else { throw ConsentFailure.unavailable }
            socketInode = info.st_ino
            // Any local account can attempt a connection; only the verified,
            // sealed Josi executable can read or confirm the presentation.
            guard chmod(path, 0o666) == 0, listen(listener, 4) == 0 else { throw ConsentFailure.unavailable }
            try send(STDOUT_FILENO, ["schemaVersion": 1, "id": id, "state": "ready", "challengeDigest": digest], deadline: deadline)
            var accepted = false
            for _ in 0..<8 {
                try wait(listener, Int16(POLLIN), deadline)
                client = accept(listener, nil, nil)
                guard client >= 0 else { throw ConsentFailure.unavailable }
                do { try identity(client, full: true); accepted = true; break }
                catch { Darwin.close(client); client = -1 }
            }
            guard accepted, getppid() == parent, clock() >= started, clock() < expires else { throw ConsentFailure.unavailable }
            try send(client, input, deadline: deadline)
            let decision = try frame(client, deadline: deadline)
            try exact(decision, ["schemaVersion", "id", "challengeDigest", "decision"])
            guard decision["schemaVersion"] as? Int == 1, decision["id"] as? String == id,
                  decision["challengeDigest"] as? String == digest,
                  ["approve", "cancel"].contains(decision["decision"] as? String ?? "") else { throw ConsentFailure.invalid }
            try identity(client, full: false)
            guard getppid() == parent, clock() >= started, clock() < expires,
                  DispatchTime.now().uptimeNanoseconds < deadline else { throw ConsentFailure.unavailable }
            try send(STDOUT_FILENO, ["schemaVersion": 1, "id": id, "challengeDigest": digest,
                                    "state": decision["decision"] as? String == "approve" ? "approved" : "cancelled"], deadline: deadline)
        } catch {
            // No payload, native error detail or consent proof in logs.
            // Normal return runs the socket cleanup above; no retry.
        }
    }
}
