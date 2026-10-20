import AppKit
import SwiftUI
import LocalAuthentication
import Darwin

extension ProtectedWire {
    static func consent(_ value: Wire, identity: Wire) throws -> Data {
        guard exact(value, ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId",
                            "enrollmentId", "requestDigest", "authorityEpoch", "issuedAtMs", "expiresAtMs", "presentation"]),
              value["schemaVersion"] == .number(1), sameIdentity(value, identity),
              ["id", "serverId", "userId", "deviceId", "enrollmentId"].allSatisfy({ uuid(value[$0]) }),
              matches(value["nonce"], "^[A-Za-z0-9_-]{43}$"), matches(value["requestDigest"], "^[a-f0-9]{64}$"),
              integer(value["authorityEpoch"], positive: true), integer(value["issuedAtMs"], positive: true),
              integer(value["expiresAtMs"], positive: true), value["expiresAtMs"].integer > value["issuedAtMs"].integer,
              value["expiresAtMs"].integer - value["issuedAtMs"].integer <= 120_000 else { throw approvalUnavailable() }
        let presentation = value["presentation"]
        guard exact(presentation, ["wording", "meaning", "advisory"]), text(presentation["wording"], max: 4000),
              text(presentation["meaning"], max: 64_000), case .array(let advice) = presentation["advisory"],
              advice.count <= 20, advice.allSatisfy({ text($0, max: 2600) }) else { throw approvalUnavailable() }
        var fields = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId",
                      "enrollmentId", "requestDigest", "authorityEpoch", "issuedAtMs", "expiresAtMs"].map { value[$0] }
        fields.append(.array([presentation["wording"], presentation["meaning"], presentation["advisory"]]))
        let message = Data(("josi-device-consent.1\n" + (try canonical(.array(fields)))).utf8)
        guard message.count <= 64 * 1024 else { throw approvalUnavailable() }
        return message
    }
    static func consentMessage(_ message: Data, identity: Wire) throws -> Wire {
        let prefix = Data("josi-device-consent.1\n".utf8)
        guard message.count <= 64 * 1024, message.starts(with: prefix),
              case .array(let fields) = try JSONDecoder().decode(Wire.self, from: message.dropFirst(prefix.count)),
              fields.count == 13, case .array(let presentation) = fields[12], presentation.count == 3 else { throw approvalUnavailable() }
        let names = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId",
                     "enrollmentId", "requestDigest", "authorityEpoch", "issuedAtMs", "expiresAtMs"]
        var object = Dictionary(uniqueKeysWithValues: zip(names, fields.prefix(12)))
        object["presentation"] = ["wording": presentation[0], "meaning": presentation[1], "advisory": presentation[2]]
        let result = Wire.object(object)
        guard try consent(result, identity: identity) == message else { throw approvalUnavailable() }
        return result
    }
}

/// Immutable descriptor ownership. A concurrent cancellation only shuts down
/// the socket; its descriptor cannot be reused while a worker still holds it.
private final class ConsentSocket: @unchecked Sendable {
    let descriptor: Int32
    let deadline: UInt64
    init(expires: Int) throws {
        let remaining = expires - Int(Date().timeIntervalSince1970 * 1000)
        guard remaining > 0, remaining <= 120_000 else { throw approvalUnavailable() }
        deadline = DispatchTime.now().uptimeNanoseconds + UInt64(remaining) * 1_000_000
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw approvalUnavailable() }
    }
    deinit { Darwin.close(descriptor) }
    func interrupt() { _ = shutdown(descriptor, SHUT_RDWR) }
    func wait(_ event: Int16, until: UInt64? = nil) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds, end = min(deadline, until ?? deadline)
            guard now < end else { throw approvalUnavailable() }
            var entry = pollfd(fd: descriptor, events: event, revents: 0)
            let result = poll(&entry, 1, Int32(min(120_000, (end - now) / 1_000_000 + 1)))
            if result < 0 && errno == EINTR { continue }
            guard result > 0, entry.revents & event != 0 else { throw approvalUnavailable() }
            return
        }
    }
    func connect(path: String) throws {
        var address = sockaddr_un(), noPipe: Int32 = 1
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path),
              fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0, fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0,
              setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout<Int32>.size)) == 0
        else { throw approvalUnavailable() }
        address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes + [0]) }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if result != 0 {
            guard errno == EINPROGRESS else { throw approvalUnavailable() }
            try wait(Int16(POLLOUT), until: DispatchTime.now().uptimeNanoseconds + 10_000_000_000)
            var error: Int32 = 0, size = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &error, &size) == 0, error == 0 else { throw approvalUnavailable() }
        }
    }
    func read(_ count: Int, until: UInt64) throws -> Data {
        var data = Data(count: count), offset = 0
        while offset < count {
            try wait(Int16(POLLIN), until: until)
            let read = data.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress!.advanced(by: offset), count - offset) }
            if read < 0 && [EINTR, EAGAIN].contains(errno) { continue }
            guard read > 0 else { throw approvalUnavailable() }
            offset += read
        }
        return data
    }
    func frame() throws -> Wire {
        let end = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        let length = try read(4, until: end).reduce(0) { ($0 << 8) | Int($1) }
        guard (1...128 * 1024).contains(length) else { throw approvalUnavailable() }
        return try JSONDecoder().decode(Wire.self, from: read(length, until: end))
    }
    func send(_ value: Wire) throws {
        let data = try JSONEncoder().encode(value)
        guard !data.isEmpty, data.count <= 128 * 1024 else { throw approvalUnavailable() }
        let size = UInt32(data.count)
        let frame = Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)]) + data
        var offset = 0
        while offset < frame.count {
            try wait(Int16(POLLOUT))
            let written = frame.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), frame.count - offset) }
            if written < 0 && [EINTR, EAGAIN].contains(errno) { continue }
            guard written > 0 else { throw approvalUnavailable() }
            offset += written
        }
    }
}

@MainActor private final class LocalDeviceConsent {
    let challenge: Wire
    private let channel: ConsentSocket
    private let digest: String
    private let lease: ApprovalLease
    private var used = false
    private var closed = false
    private init(challenge: Wire, channel: ConsentSocket, digest: String) throws {
        self.challenge = challenge; self.channel = channel; self.digest = digest; lease = try ApprovalLease(challenge)
    }
    static func open(_ expected: Wire) async throws -> LocalDeviceConsent? {
        guard NativeServer.canManage, ProtectedWire.uuid(expected["id"]),
              ProtectedWire.matches(expected["challengeDigest"], "^[a-f0-9]{64}$"),
              ProtectedWire.integer(expected["expiresAtMs"]) else { throw approvalUnavailable() }
        let directory = "/Library/Application Support/Josi CE Server/control"
        let path = directory + "/" + expected["id"].text + ".sock"
        var folder = stat(), socket = stat()
        if lstat(directory, &folder) != 0 { if errno == ENOENT { return nil }; throw approvalUnavailable() }
        if lstat(path, &socket) != 0 { if errno == ENOENT { return nil }; throw approvalUnavailable() }
        guard let account = getpwnam("_josice_web"), account.pointee.pw_uid > 0,
              folder.st_mode & S_IFMT == S_IFDIR, folder.st_uid == account.pointee.pw_uid, folder.st_mode & 0o022 == 0,
              socket.st_mode & S_IFMT == S_IFSOCK, socket.st_uid == folder.st_uid,
              URL(fileURLWithPath: directory).resolvingSymlinksInPath().path == directory else { throw approvalUnavailable() }
        for parent in ["/Library", "/Library/Application Support", "/Library/Application Support/Josi CE Server"] {
            var info = stat()
            guard lstat(parent, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == 0, info.st_mode & 0o022 == 0 else { throw approvalUnavailable() }
        }
        let channel = try ConsentSocket(expires: expected["expiresAtMs"].integer)
        do {
            let frame: Wire = try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    DispatchQueue.global(qos: .userInitiated).async {
                        do { try channel.connect(path: path); continuation.resume(returning: try channel.frame()) }
                        catch { continuation.resume(throwing: approvalUnavailable()) }
                    }
                }
            } onCancel: { channel.interrupt() }
            try Task.checkCancellation()
            guard ProtectedWire.exact(frame, ["schemaVersion", "id", "challengeDigest", "expiresAtMs", "message"]),
                  frame["schemaVersion"] == .number(1), frame["id"] == expected["id"],
                  frame["challengeDigest"] == expected["challengeDigest"], frame["expiresAtMs"] == expected["expiresAtMs"],
                  frame["message"].text.count <= 90_000, let message = Data(base64Encoded: frame["message"].text),
                  message.base64EncodedString() == frame["message"].text, ProtectedWire.digest(message) == expected["challengeDigest"].text
            else { throw approvalUnavailable() }
            let challenge = try ProtectedWire.consentMessage(message, identity: expected["identity"])
            guard challenge["id"] == expected["id"], challenge["expiresAtMs"] == expected["expiresAtMs"] else { throw approvalUnavailable() }
            return try LocalDeviceConsent(challenge: challenge, channel: channel, digest: expected["challengeDigest"].text)
        } catch { channel.interrupt(); throw error }
    }
    func close() { closed = true; channel.interrupt() }
    func approve(_ reviewed: Wire) async throws {
        try lease.check()
        guard !closed, !used, reviewed == challenge else { throw approvalUnavailable() }
        used = true
        let frame: Wire = ["schemaVersion": .number(1), "id": challenge["id"], "challengeDigest": .string(digest), "decision": "approve"]
        let channel = channel
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    do { try channel.send(frame); continuation.resume() }
                    catch { continuation.resume(throwing: approvalUnavailable()) }
                }
            }
        } onCancel: { channel.interrupt() }
        try lease.check(); guard !closed else { throw approvalUnavailable() }
    }
}

@MainActor enum NativeDeviceEnrollment {
    static func run(model: JosiModel, label: String = "", password: String = "", mfa: String = "", reviewID: String? = nil) async throws -> String {
        guard NativeProtectedApproval.available, model.isAdministrator, let api = model.api, let parent = NSApp.keyWindow else { throw approvalUnavailable() }
        let user = model.user["id"].text
        var attempt: String?
        var commitSent = false
        var port: NativeKeyPort?
        var local: LocalDeviceConsent?
        var window: NativeApprovalWindow?
        let context = LAContext()
        context.localizedFallbackTitle = ""; context.touchIDAuthenticationAllowableReuseDuration = 0
        defer { port?.cancel(); local?.close(); window?.close(); context.invalidate() }
        func connected() throws {
            guard model.api === api, model.user["id"].text == user, parent.isVisible, !Task.isCancelled else { throw approvalUnavailable() }
        }
        func identity(_ value: Wire) throws {
            guard ProtectedWire.exact(value, ["serverOrigin", "serverId", "userId", "deviceId"]),
                  value["serverOrigin"].text == api.origin.absoluteString, value["userId"].text == user,
                  ["serverId", "userId", "deviceId"].allSatisfy({ ProtectedWire.uuid(value[$0]) }) else { throw approvalUnavailable() }
        }
        do {
            var challenge: Wire
            var material: Wire = .null
            if let reviewID {
                attempt = try api.uuid(reviewID)
                let review = try await api.request("/admin/automation/devices/enroll/\(reviewID)/review")
                try connected(); try identity(review["identity"])
                guard review["id"].text == reviewID else { throw approvalUnavailable() }
                local = try await LocalDeviceConsent.open(review)
                guard let local else { throw JosiError(message: "Review this request in the installed Josi app on the Mac that runs this server.") }
                challenge = local.challenge
            } else {
                let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !label.isEmpty, label.count <= 120, !password.isEmpty else { throw approvalUnavailable() }
                let begin = try await api.request("/admin/automation/devices/enroll/begin", method: "POST", body: ["label": .string(label)])
                try connected(); try identity(begin["identity"])
                let id = try api.uuid(begin["attemptId"].text); attempt = id
                guard ProtectedWire.uuid(begin["enrollmentId"]) else { throw approvalUnavailable() }
                let alert = NSAlert()
                alert.messageText = "Enroll \(label) with Josi?"
                alert.informativeText = "Server: \(api.origin.absoluteString)\nAdministrator: \(user)\n\nCreate a hardware-protected device key, then review its exact identity. The server Mac must also approve. Enrollment grants no automation access."
                alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Create Device Key")
                let accepted = await withCheckedContinuation { continuation in
                    alert.beginSheetModal(for: parent) { continuation.resume(returning: $0 == .alertSecondButtonReturn) }
                }
                guard accepted else { throw approvalUnavailable() }; try connected()
                let key = NativeKeyPort(identity: begin["identity"]); port = key
                try await key.start()
                let created = try await key.request("create", fields: [:])
                guard ProtectedWire.exact(created, ["material"]) else { throw approvalUnavailable() }
                material = try ProtectedWire.signingMaterial(created["material"], identity: begin["identity"])
                try connected()
                let prepared = try await api.request("/admin/automation/devices/enroll/\(id)/prepare", method: "POST",
                    body: ["material": material, "password": .string(password), "mfaCode": .string(mfa)])
                try connected(); challenge = prepared["challenge"]
                let message = try ProtectedWire.consent(challenge, identity: begin["identity"])
                guard challenge["id"].text == id, challenge["enrollmentId"] == begin["enrollmentId"],
                      ProtectedWire.digest(message) == prepared["challengeDigest"].text else { throw approvalUnavailable() }
                local = try await LocalDeviceConsent.open(["id": .string(id), "identity": begin["identity"],
                    "challengeDigest": prepared["challengeDigest"], "expiresAtMs": challenge["expiresAtMs"]])
                if let local, local.challenge != challenge { throw approvalUnavailable() }
            }
            guard let id = attempt else { throw approvalUnavailable() }
            let lease = try ApprovalLease(challenge)
            let review = NativeApprovalWindow(challenge: challenge, lease: lease, cancelAuthentication: {
                port?.cancel(); local?.close(); context.invalidate()
            }); window = review
            guard await review.present(parent: parent) else { throw approvalUnavailable() }
            try connected(); try review.current()
            var possession = ""
            if reviewID == nil {
                guard let port else { throw approvalUnavailable() }
                let fields: [String: Wire] = ["commandDigest": challenge["requestDigest"], "material": material,
                                              "attemptId": .string(id), "expiresAtMs": challenge["expiresAtMs"]]
                let authenticated = try await port.request("authenticateEnrollment", fields: fields)
                guard ProtectedWire.exact(authenticated, ["authenticated"]), authenticated["authenticated"].flag else { throw approvalUnavailable() }
                try connected(); try review.current()
                possession = try ProtectedWire.signature(await port.request("signEnrollment", fields: fields))
                port.cancel(); material = .null
            } else {
                guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil),
                      try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                        localizedReason: "Approve the exact Josi device enrollment you reviewed on this server Mac.")
                else { throw approvalUnavailable() }
            }
            try connected(); try review.current()
            _ = try await api.request("/admin/automation/devices/enroll/\(id)/" + (reviewID == nil ? "status" : "review"))
            try connected(); try review.current()
            if let local { try await local.approve(challenge) }
            if reviewID != nil { return "Local approval sent. The target Mac must finish enrollment before its key is trusted." }
            review.phase = "awaiting-server"
            while true {
                try connected(); try review.current()
                let status = try await api.request("/admin/automation/devices/enroll/\(id)/status")
                try connected(); try review.current()
                if status["state"].text == "approved" { break }
                guard status["state"].text == "waiting" else { throw approvalUnavailable() }
                try await Task.sleep(for: .seconds(1))
            }
            review.phase = "saving"; commitSent = true
            let result = try await api.request("/admin/automation/devices/enroll/\(id)/commit", method: "POST",
                                               body: ["possessionSignature": .string(possession)])
            try connected()
            guard result["enrolled"].flag, result["deviceId"] == challenge["deviceId"], result["enrollmentId"] == challenge["enrollmentId"] else { throw approvalUnavailable() }
            return "Device enrollment saved to the Vault. Automation permissions are managed separately."
        } catch {
            if reviewID == nil, !commitSent, let attempt, model.api === api {
                _ = try? await api.request("/admin/automation/devices/enroll/\(attempt)/cancel", method: "POST", body: [:])
            }
            if commitSent { throw JosiError(message: "The final enrollment response was not confirmed. Refresh devices before starting a new enrollment; it may already be saved.") }
            throw JosiError(message: "Enrollment did not finish. Confirm that the server Mac approved this request, then start a fresh attempt. No automation access was granted.")
        }
    }
}

struct NativeDeviceEnrollmentView: View {
    @EnvironmentObject var model: JosiModel
    @State private var label = ""
    @State private var password = ""
    @State private var mfa = ""
    @State private var requests: [Wire] = []
    @State private var result = ""
    private var ready: Bool {
        NativeProtectedApproval.available && model.isAdministrator
            && model.automationCatalog["capabilities"]["deviceEnrollment"].flag
            && !model.automationSettings["devices"]["reconciliationRequired"].flag
    }
    var body: some View {
        GroupBox("Enroll this Mac") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Create a protected confirmation device for this server and administrator. Review it here and on the Mac running the server.")
                if !ready {
                    Text(!NativeProtectedApproval.provisioned ? "Protected enrollment is unavailable in this build. Install a build with protected-device signing configured."
                         : "Use Touch ID and a server that supports enrollment.").font(.caption).foregroundStyle(.secondary)
                }
                TextField("A name for this Mac", text: $label)
                SecureField("Administrator password", text: $password)
                SecureField("Authenticator code, if enabled", text: $mfa)
                Button("Enroll This Mac…") {
                    let name = label, secret = password, code = mfa
                    password = ""; mfa = ""; result = ""
                    model.run {
                        do {
                            result = try await NativeDeviceEnrollment.run(model: model, label: name, password: secret, mfa: code)
                            try await model.loadAutomation(); requests = []
                        } catch { try? await model.loadAutomation(); throw error }
                    }
                }.disabled(!ready || model.busy || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                Divider()
                Button("Refresh Requests for This Server Mac") {
                    guard let api = model.api else { return }
                    model.run {
                        let value = try await api.request("/admin/automation/devices/enroll/pending")
                        guard model.api === api else { return }; requests = value["requests"].list
                    }
                }.disabled(!ready || model.busy)
                ForEach(requests, id: \.identifier) { request in
                    HStack {
                        Text(request["label"].text + " · " + request["state"].text)
                        Spacer()
                        Button("Review on Server Mac…") {
                            model.run {
                                result = try await NativeDeviceEnrollment.run(model: model, reviewID: request.identifier)
                                requests = []
                            }
                        }.disabled(model.busy || !ready)
                    }
                }
                if !result.isEmpty { Text(result).font(.callout).foregroundStyle(.secondary) }
            }.textFieldStyle(.roundedBorder).padding(10).disabled(model.busy)
        }.onDisappear { password = ""; mfa = ""; requests = [] }
    }
}
