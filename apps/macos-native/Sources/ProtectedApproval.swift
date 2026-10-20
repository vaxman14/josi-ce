import AppKit
import SwiftUI
import CryptoKit
import LocalAuthentication
import Darwin

func approvalUnavailable() -> JosiError {
    JosiError(message: "This protected review is unavailable, cancelled or expired. Refresh settings and begin a new review.")
}

enum ProtectedWire {
    static func exact(_ value: Wire, _ keys: [String]) -> Bool {
        guard case .object(let object) = value else { return false }
        return Set(object.keys) == Set(keys)
    }
    static func uuid(_ value: Wire) -> Bool {
        guard let id = UUID(uuidString: value.text) else { return false }
        return id.uuidString.lowercased() == value.text
    }
    static func matches(_ value: Wire, _ regex: String) -> Bool {
        !value.text.isEmpty && value.text.range(of: regex, options: .regularExpression) != nil
    }
    static func integer(_ value: Wire, positive: Bool = false) -> Bool {
        guard case .number(let number) = value else { return false }
        return number.isFinite && number.rounded() == number && number >= (positive ? 1 : 0) && number <= 9_007_199_254_740_991
    }
    static func reference(_ value: Wire) -> Bool {
        exact(value, ["recordId", "version", "digest", "epoch"]) && uuid(value["recordId"])
            && integer(value["version"], positive: true) && integer(value["epoch"], positive: true)
            && matches(value["digest"], "^[a-f0-9]{64}$")
    }
    static func text(_ value: Wire, max: Int) -> Bool {
        let text = value.text
        return !text.isEmpty && text.utf16.count <= max
            && text.range(of: "[\\x{0000}-\\x{0008}\\x{000b}\\x{000c}\\x{000e}-\\x{001f}\\x{007f}\\x{202a}-\\x{202e}\\x{2066}-\\x{2069}]", options: .regularExpression) == nil
    }
    static func identity(_ value: Wire) -> Wire {
        .object(Dictionary(uniqueKeysWithValues: ["serverOrigin", "serverId", "userId", "deviceId"].map { ($0, value[$0]) }))
    }
    static func sameIdentity(_ a: Wire, _ b: Wire) -> Bool { identity(a) == identity(b) }
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func signature(_ value: Wire, host: Bool = false) throws -> String {
        guard exact(value, ["signature"]) else { throw approvalUnavailable() }
        let encoded = value["signature"].text
        let base = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard matches(.string(encoded), host ? "^[A-Za-z0-9_-]{11,96}$" : "^[A-Za-z0-9_-]{86}$"),
              let data = Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4)),
              host ? (8...72).contains(data.count) && data.first == 0x30 : data.count == 64,
              data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "") == encoded else { throw approvalUnavailable() }
        return encoded
    }
    // These protocol messages contain arrays, strings and safe integers only.
    // Match JSON.stringify exactly, including UTF-8 text and unescaped slashes.
    static func canonical(_ value: Wire) throws -> String {
        switch value {
        case .string(let text):
            var result = "\""
            for scalar in text.unicodeScalars {
                switch scalar.value {
                case 34: result += "\\\""
                case 92: result += "\\\\"
                case 8: result += "\\b"
                case 9: result += "\\t"
                case 10: result += "\\n"
                case 12: result += "\\f"
                case 13: result += "\\r"
                case 0..<32: result += String(format: "\\u%04x", scalar.value)
                default: result.unicodeScalars.append(scalar)
                }
            }
            return result + "\""
        case .number(let number):
            guard integer(value) else { throw approvalUnavailable() }
            return String(Int64(number))
        case .array(let values): return "[" + (try values.map(canonical)).joined(separator: ",") + "]"
        default: throw approvalUnavailable()
        }
    }
    static func challenge(_ value: Wire, host: Bool, origin: String, user: String, device: String) throws -> Data {
        let common = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId", "keyReference", "issuedAtMs", "expiresAtMs"]
        guard exact(value, common + (host ? ["wrappingFingerprint"] : ["purpose", "requestDigest", "presentation"])),
              value["schemaVersion"] == .number(1), ["id", "serverId", "userId", "deviceId"].allSatisfy({ uuid(value[$0]) }),
              value["serverOrigin"].text == origin, value["userId"].text == user, value["deviceId"].text == device,
              matches(value["nonce"], "^[A-Za-z0-9_-]{43}$"), reference(value["keyReference"]),
              integer(value["issuedAtMs"]), integer(value["expiresAtMs"]),
              value["expiresAtMs"].integer > value["issuedAtMs"].integer,
              value["expiresAtMs"].integer - value["issuedAtMs"].integer <= (host ? 60_000 : 120_000)
        else { throw approvalUnavailable() }
        let key = value["keyReference"]
        let ref = Wire.array([key["recordId"], key["version"], key["digest"], key["epoch"]])
        var fields = ["schemaVersion", "id", "nonce", "serverOrigin", "serverId", "userId", "deviceId"].map { value[$0] }
        if host {
            guard matches(value["wrappingFingerprint"], "^[a-f0-9]{64}$") else { throw approvalUnavailable() }
            fields += [ref, value["wrappingFingerprint"], value["issuedAtMs"], value["expiresAtMs"]]
        } else {
            let presentation = value["presentation"]
            guard ["cardinal.activate", "cardinal.retire", "automation.policy.replace", "automation.target.register", "device.revoke"].contains(value["purpose"].text),
                  matches(value["requestDigest"], "^[a-f0-9]{64}$"), exact(presentation, ["wording", "meaning", "advisory"]),
                  text(presentation["wording"], max: 4000), text(presentation["meaning"], max: 64_000),
                  case .array(let advice) = presentation["advisory"], advice.count <= 20,
                  advice.allSatisfy({ text($0, max: 2600) }) else { throw approvalUnavailable() }
            fields += [value["purpose"], value["requestDigest"], ref, value["issuedAtMs"], value["expiresAtMs"],
                       .array([presentation["wording"], presentation["meaning"], presentation["advisory"]])]
        }
        let data = Data(((host ? "josi-protected-host-auth.1\n" : "josi-protected-control.1\n") + (try canonical(.array(fields)))).utf8)
        guard data.count <= 128 * 1024 else { throw approvalUnavailable() }
        return data
    }
    static func material(_ projection: Wire, challenge: Wire) throws -> Wire {
        guard exact(projection, ["schemaVersion", "reference", "issuedAtMs", "expiresAtMs", "material"]),
              projection["schemaVersion"] == .number(1), projection["reference"] == challenge["keyReference"],
              integer(projection["issuedAtMs"]), integer(projection["expiresAtMs"]),
              projection["expiresAtMs"].integer > projection["issuedAtMs"].integer,
              projection["expiresAtMs"].integer - projection["issuedAtMs"].integer <= 60_000 else { throw approvalUnavailable() }
        return try signingMaterial(projection["material"], identity: identity(challenge))
    }
    static func signingMaterial(_ material: Wire, identity: Wire) throws -> Wire {
        guard exact(material, ["schemaVersion", "identity", "wrappingPublicKey", "signingPublicKeySpki", "wrappedPrivateKey"]),
              material["schemaVersion"] == .number(1),
              exact(material["identity"], ["serverOrigin", "serverId", "userId", "deviceId"]),
              material["identity"] == identity else { throw approvalUnavailable() }
        for (key, minimum, maximum) in [("wrappingPublicKey", 65, 65), ("signingPublicKeySpki", 44, 44), ("wrappedPrivateKey", 33, 4096)] {
            let value = material[key].text
            guard value.count <= ((maximum + 2) / 3) * 4, let data = Data(base64Encoded: value),
                  (minimum...maximum).contains(data.count), data.base64EncodedString() == value else { throw approvalUnavailable() }
        }
        return material
    }
}

@MainActor final class ApprovalLease {
    let expires: Int
    private var previousWall: Int
    private let deadline: ContinuousClock.Instant
    init(_ value: Wire) throws {
        previousWall = Int(Date().timeIntervalSince1970 * 1000)
        expires = value["expiresAtMs"].integer
        guard value["issuedAtMs"].integer <= previousWall, expires > previousWall else { throw approvalUnavailable() }
        deadline = .now.advanced(by: .milliseconds(expires - previousWall))
    }
    func check() throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard now >= previousWall, now < expires, ContinuousClock.now < deadline, !Task.isCancelled else { throw approvalUnavailable() }
        previousWall = now
    }
}

/// Main-app-only bounded pipe to the existing signed key host. Private signing
/// keys remain in that helper; only wrapped Vault material crosses these pipes.
@MainActor final class NativeKeyPort {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let identity: Wire
    private var pending = false
    private var closed = false
    private var expiry: Task<Void, Never>?
    init(identity: Wire) { self.identity = identity }
    func start() async throws {
        guard NativeProtectedApproval.provisioned else { throw approvalUnavailable() }
        let bundle = "/Applications/Josi.app/Contents/Helpers/JosiProtectedKeyHost.app"
        let helper = bundle + "/Contents/MacOS/JosiProtectedKeyHost"
        var info = stat()
        guard lstat(helper, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o022 == 0,
              URL(fileURLWithPath: helper).resolvingSymlinksInPath().path == helper else { throw approvalUnavailable() }
        let requirement = "=anchor apple generic and identifier \"com.heyjosi.ce.protected-key\" and certificate leaf[subject.OU] = \"LRH75YR6QW\""
        guard try await NativeServer.process("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, bundle]) == 0,
              !Task.isCancelled else { throw approvalUnavailable() }
        process.executableURL = URL(fileURLWithPath: helper)
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        // A cancelled helper must never terminate its native parent via SIGPIPE.
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw approvalUnavailable() }
        try process.run()
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            if !Task.isCancelled { self?.cancel() }
        }
    }
    func cancel() {
        guard !closed else { return }
        closed = true; expiry?.cancel(); expiry = nil
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        // Keep descriptors alive until any background read finishes. Killing
        // this owned child supplies EOF without reusing its reader's descriptor.
    }
    func request(_ operation: String, fields: [String: Wire]) async throws -> Wire {
        guard !closed, process.isRunning, !pending,
              ["create", "proveHost", "proveWorkspaceStorage", "authenticate", "sign", "authenticateEnrollment", "signEnrollment"].contains(operation)
        else { throw approvalUnavailable() }
        pending = true; defer { pending = false }
        let id = UUID().uuidString.lowercased()
        var body = fields
        body["schemaVersion"] = .number(1); body["id"] = .string(id)
        body["identity"] = identity; body["operation"] = .string(operation)
        let encoded = try JSONEncoder().encode(Wire.object(body))
        guard !encoded.isEmpty, encoded.count <= 256 * 1024 else { throw approvalUnavailable() }
        let size = UInt32(encoded.count)
        let frame = Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)]) + encoded
        let writer = input.fileHandleForWriting, reader = output.fileHandleForReading
        let result: Wire = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        try writer.write(contentsOf: frame)
                        func read(_ count: Int) throws -> Data {
                            var data = Data()
                            while data.count < count {
                                guard let part = try reader.read(upToCount: count - data.count), !part.isEmpty else { throw approvalUnavailable() }
                                data.append(part)
                            }
                            return data
                        }
                        let count = try read(4).reduce(0) { ($0 << 8) | Int($1) }
                        guard (1...256 * 1024).contains(count) else { throw approvalUnavailable() }
                        continuation.resume(returning: try JSONDecoder().decode(Wire.self, from: read(count)))
                    } catch { continuation.resume(throwing: approvalUnavailable()) }
                }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
        guard !closed, ProtectedWire.exact(result, ["schemaVersion", "id", "result"]),
              result["schemaVersion"] == .number(1), result["id"].text == id, case .object = result["result"] else {
            cancel(); throw approvalUnavailable()
        }
        return result["result"]
    }
}

@MainActor final class NativeApprovalWindow: NSObject, ObservableObject, NSWindowDelegate {
    let challenge: Wire
    @Published var phase = "review"
    private var panel: NSPanel?
    private var continuation: CheckedContinuation<Bool, Never>?
    private var timer: Task<Void, Never>?
    private var parentObserver: NSObjectProtocol?
    private var cancelled = false
    private let lease: ApprovalLease
    private let cancelAuthentication: @MainActor () -> Void
    init(challenge: Wire, lease: ApprovalLease, cancelAuthentication: @escaping @MainActor () -> Void) {
        self.challenge = challenge; self.lease = lease; self.cancelAuthentication = cancelAuthentication
    }
    func present(parent: NSWindow) async -> Bool {
        guard panel == nil else { return false }
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 760, height: 720),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Josi — Protected Confirmation"; window.minSize = NSSize(width: 620, height: 500)
        window.isReleasedWhenClosed = false; window.delegate = self
        window.contentViewController = NSHostingController(rootView: ProtectedApprovalView(review: self))
        panel = window
        parentObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: parent, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.cancel() }
        }
        timer = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .milliseconds(max(1, lease.expires - Int(Date().timeIntervalSince1970 * 1000))))
            if !Task.isCancelled { cancel() }
        }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            parent.beginSheet(window)
            window.makeKeyAndOrderFront(nil)
        }
    }
    func approve() {
        guard phase == "review", panel?.isKeyWindow == true, NSApp.isActive else { return }
        do { try current() } catch { cancel(); return }
        phase = "authenticating"
        let waiting = continuation; continuation = nil; waiting?.resume(returning: true)
    }
    func current() throws {
        try lease.check()
        guard !cancelled, panel?.isVisible == true, NSApp.isActive else { throw approvalUnavailable() }
    }
    func cancel() {
        cancelled = true
        cancelAuthentication()
        let waiting = continuation; continuation = nil; waiting?.resume(returning: false)
        close()
    }
    func close() {
        timer?.cancel(); timer = nil
        if let parentObserver { NotificationCenter.default.removeObserver(parentObserver); self.parentObserver = nil }
        if let window = panel { window.sheetParent?.endSheet(window); window.orderOut(nil); window.delegate = nil }
        panel = nil
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { cancel(); return false }
}

struct ProtectedApprovalView: View {
    @ObservedObject var review: NativeApprovalWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title).font(.title2.bold())
            Text(review.challenge["serverOrigin"].text).font(.headline).textSelection(.enabled)
            Text("Administrator: " + review.challenge["userId"].text + "\nDevice: " + review.challenge["deviceId"].text)
                .font(.caption).textSelection(.enabled)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(review.challenge["presentation"]["wording"].text).font(.headline)
                    Text(review.challenge["presentation"]["meaning"].text)
                    ForEach(Array(review.challenge["presentation"]["advisory"].list.enumerated()), id: \.offset) { _, advice in Text(advice.text) }
                }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding(8)
            }
            Divider()
            HStack {
                Button("Cancel") { review.cancel() }.keyboardShortcut(.cancelAction)
                Spacer()
                if review.phase == "review" {
                    Button("Approve This Exact Change") { review.approve() }.buttonStyle(.borderedProminent)
                } else {
                    ProgressView().controlSize(.small)
                    Text(review.phase == "saving" ? "Saving to the Vault…" : review.phase == "awaiting-server"
                         ? "Waiting for approval on the server Mac…" : "Waiting for Mac authentication…")
                }
            }
        }.padding(24)
    }
    private var title: String {
        if review.challenge["enrollmentId"] != .null { return "Enroll this protected confirmation device" }
        switch review.challenge["purpose"].text {
        case "workspace.storage": return review.challenge["operation"].text == "open" ? "Open the separate development desktop" : "Prepare separate workspace storage"
        case "automation.target.register": return "Register an app for permission setup"
        case "cardinal.activate": return "Make this Cardinal Rule permanent"
        case "cardinal.retire": return "Retire this Cardinal Rule"
        case "device.revoke": return "Revoke this confirmation device"
        default: return "Change automation permissions"
        }
    }
}

@MainActor enum NativeProtectedApproval {
    static var provisioned: Bool {
        NativeServer.canManage && Bundle.main.object(forInfoDictionaryKey: "JosiProtectedKeyProvisioned") as? Bool == true
            && FileManager.default.fileExists(atPath: "/Applications/Josi.app/Contents/Helpers/JosiProtectedKeyHost.app/Contents/embedded.provisionprofile")
    }
    static var available: Bool {
        guard provisioned else { return false }
        let context = LAContext(); defer { context.invalidate() }
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }
    static func run(model: JosiModel, change: Wire, deviceId: String, password: String, mfa: String, checkSelection: @MainActor () throws -> Void = {}) async throws {
        guard available, model.isAdministrator, let api = model.api, let parent = NSApp.keyWindow,
              ["cardinal.activate", "cardinal.retire", "automation.policy.replace", "automation.target.register", "device.revoke"].contains(change["kind"].text)
        else { throw approvalUnavailable() }
        let user = model.user["id"].text
        var id: String?
        var commitSent = false
        var key: NativeKeyPort?
        var review: NativeApprovalWindow?
        defer { key?.cancel(); review?.close() }
        func connected(selection: Bool = true) throws {
            if selection { try checkSelection() }
            guard model.api === api, model.user["id"].text == user, parent.isVisible else { throw approvalUnavailable() }
        }
        do {
            let prepared = try await api.request("/admin/automation/protected/prepare", method: "POST",
                body: ["change": change, "deviceId": .string(deviceId), "password": .string(password), "mfaCode": .string(mfa)])
            try connected()
            let identifier = try api.uuid(prepared["challengeId"].text); id = identifier
            let base = "/admin/automation/protected/\(identifier)/"
            let host = (try await api.request(base + "host-challenge"))["challenge"]
            let hostMessage = try ProtectedWire.challenge(host, host: true, origin: api.origin.absoluteString, user: user, device: deviceId)
            guard host["id"].text == identifier else { throw approvalUnavailable() }
            let hostLease = try ApprovalLease(host)
            let port = NativeKeyPort(identity: ProtectedWire.identity(host)); key = port
            try await port.start(); try hostLease.check(); try connected()
            let hostSignature = try ProtectedWire.signature(await port.request("proveHost", fields: ["message": .string(hostMessage.base64EncodedString())]), host: true)
            try hostLease.check(); try connected()
            let proof: Wire = ["schemaVersion": .number(1), "challengeId": .string(identifier),
                               "challengeDigest": .string(ProtectedWire.digest(hostMessage)), "signature": .string(hostSignature)]
            let challenge = (try await api.request(base + "presentation", method: "POST", body: ["proof": proof]))["challenge"]
            let message = try ProtectedWire.challenge(challenge, host: false, origin: api.origin.absoluteString, user: user, device: deviceId)
            guard challenge["id"].text == identifier, challenge["purpose"] == change["kind"],
                  ProtectedWire.sameIdentity(host, challenge), host["keyReference"] == challenge["keyReference"] else { throw approvalUnavailable() }
            let lease = try ApprovalLease(challenge)
            func current() async throws {
                try connected(); try lease.check()
                guard (try await api.request(base + "current"))["current"].flag else { throw approvalUnavailable() }
                try connected(); try lease.check()
                if let review { try review.current() }
            }
            try await current()
            let window = NativeApprovalWindow(challenge: challenge, lease: lease, cancelAuthentication: { port.cancel() })
            review = window
            guard await window.present(parent: parent) else { throw approvalUnavailable() }
            try await current()
            let projection = (try await api.request(base + "projection", method: "POST", body: ["proof": proof]))["projection"]
            let material = try ProtectedWire.material(projection, challenge: challenge)
            let projectionLease = try ApprovalLease(projection)
            try window.current(); try connected()
            let payload: [String: Wire] = ["message": .string(message.base64EncodedString()), "material": material]
            let authenticated = try await port.request("authenticate", fields: payload)
            guard ProtectedWire.exact(authenticated, ["authenticated"]), authenticated["authenticated"].flag else { throw approvalUnavailable() }
            try projectionLease.check(); try await current()
            let signature = try ProtectedWire.signature(await port.request("sign", fields: payload))
            try projectionLease.check(); try await current()
            window.phase = "saving"
            let receipt: Wire = ["schemaVersion": .number(1), "challengeId": .string(identifier),
                                 "challengeDigest": .string(ProtectedWire.digest(message)), "signature": .string(signature)]
            commitSent = true
            let result = try await api.request(base + "commit", method: "POST", body: ["receipt": receipt])
            try connected(selection: false)
            guard result["applied"].flag, ["cardinal", "devices", "permissions", "targets"].contains(result["kind"].text) else { throw approvalUnavailable() }
        } catch {
            if !commitSent, let id, model.api === api {
                _ = try? await api.request("/admin/automation/protected/\(id)/cancel", method: "POST", body: [:])
            }
            if commitSent {
                throw JosiError(message: "The server's final response was not confirmed. Refresh settings before another review; the change may already be saved.")
            }
            throw approvalUnavailable()
        }
    }
}

struct NativeProtectedChange: View {
    @EnvironmentObject var model: JosiModel
    let title: String
    let change: Wire
    var onSaved: (@MainActor () -> Void)? = nil
    var checkSelection: (@MainActor () throws -> Void)? = nil
    var requiredDevice: String? = nil
    @State private var open = false
    @State private var device = ""
    @State private var password = ""
    @State private var mfa = ""
    @State private var result = ""
    private var devices: [Wire] {
        model.automationSettings["devices"]["devices"].list.filter {
            $0["revokedAt"] == .null && $0["identity"]["serverOrigin"].text == model.api?.origin.absoluteString
                && (requiredDevice == nil || $0["identity"]["deviceId"].text == requiredDevice)
        }
    }
    private var ready: Bool {
        model.isAdministrator && NativeProtectedApproval.available && !devices.isEmpty
            && !model.automationSettings["devices"]["reconciliationRequired"].flag
            && model.automationCatalog["capabilities"]["permanentChanges"].flag
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(title) { open.toggle(); result = "" }.disabled(model.busy || !ready)
            if !ready {
                Text(!NativeProtectedApproval.provisioned ? "Protected approval is unavailable in this build. Install a build with protected-device signing configured."
                     : "Protected changes require Touch ID and an enrolled confirmation device for this server.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if open {
                Picker("The enrolled Mac you are using", selection: $device) {
                    Text("Choose explicitly").tag("")
                    ForEach(Array(devices.enumerated()), id: \.offset) { _, item in Text(item["label"].text).tag(item["identity"]["deviceId"].text) }
                }
                SecureField("Administrator password", text: $password)
                SecureField("Authenticator code, if enabled", text: $mfa)
                Button("Review Exact Change") {
                    let selected = device, secret = password, code = mfa, proposed = change
                    password = ""; mfa = ""; result = ""
                    model.run {
                        do {
                            try await NativeProtectedApproval.run(model: model, change: proposed, deviceId: selected, password: secret, mfa: code, checkSelection: checkSelection ?? {})
                            result = "Saved to the Vault."; open = false
                            try await model.loadAutomation()
                            onSaved?()
                        } catch {
                            try? await model.loadAutomation()
                            throw error
                        }
                    }
                }.disabled(model.busy || !ready || device.isEmpty || password.isEmpty)
            }
            if !result.isEmpty { Text(result).font(.caption).foregroundStyle(.secondary) }
        }.textFieldStyle(.roundedBorder)
        .onChange(of: change) { _, _ in open = false; password = ""; mfa = ""; result = "" }
        .onDisappear { password = ""; mfa = "" }
    }
}
