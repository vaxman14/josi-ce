import AppKit
import SwiftUI

@MainActor final class JosiModel: ObservableObject {
    enum Screen { case connect, login, setup, workspace }
    @Published var screen = Screen.connect
    @Published var section = "chat"
    @Published var address = ""
    @Published var receipt = ServerReceipt()
    @Published var busy = false
    @Published var error = ""
    @Published var activity = ""
    @Published var user: Wire = .null
    @Published var threads: [Wire] = []
    @Published var messages: [Wire] = []
    @Published var turns: [Wire] = []
    @Published var goals: [Wire] = []
    @Published var tasks: [Wire] = []
    @Published var selectedThread: String?
    @Published var draft = ""
    @Published var pendingMessage = false
    @Published var setup: Wire = .null
    @Published var setupReview: Wire = .null
    @Published var hostChecks: [Wire] = []
    @Published var recovery: Wire = .null
    @Published var vaultRecovery: Wire = .null
    @Published var mfaRecovery: Wire = .null
    @Published var mfaChallenge = ""
    @Published var automation: Wire = .null
    @Published var automationSettings: Wire = .null
    @Published var automationCatalog: Wire = .null
    @Published var lastRefreshed: Date?
    @Published var progressConnection = "Periodic updates"
    let desktop = NativeWorkspaceController()
    private(set) var api: JosiAPI?
    private var installAttempt: UUID?
    private var refreshing = false
    private var workStream: Task<Void, Never>?
    private var workRefresh: Task<Void, Never>?
    private var lastProgressSignal: ContinuousClock.Instant?
    private var workStreamUnsupported = false
    private var workAccessEnded = false
    private var workRefreshRequested = false
    private var workNeedsRefresh = true
    private var pending: (id: String, thread: String, message: String)?
    var signedInName: String { user["displayName"].text.isEmpty ? user["username"].text : user["displayName"].text }
    var isAdministrator: Bool { user["role"].text == "super_admin" }
    var chatGoals: [Wire] { goals.filter { $0["threadId"].text == selectedThread }.prefix(6).map { $0 } }

    func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = ""
        Task {
            do { try await action() }
            catch is CancellationError {}
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    func refreshLocal() {
        do { receipt = try ServerReceipt.read() }
        catch { self.error = error.localizedDescription }
    }
    func connect(_ address: String, local: Bool = false) async throws {
        guard mfaRecovery == .null else { throw JosiError(message: "Save your sign-in recovery codes before changing servers.") }
        if desktop.requiresClosure { try await desktop.close() }
        let next = try JosiAPI(address: address)
        stopWorkStream(); api?.close(); api = next
        workStreamUnsupported = false; workAccessEnded = false
        user = .null; threads = []; messages = []; turns = []; goals = []; tasks = []
        pending = nil; pendingMessage = false; draft = ""; selectedThread = nil
        recovery = .null; setup = .null; setupReview = .null; mfaChallenge = ""
        automation = .null; automationSettings = .null; automationCatalog = .null
        self.address = next.origin.absoluteString
        try await next.primeCSRF()
        var incomplete = false
        do { incomplete = !(try await next.request("/onboarding/state"))["completed"].flag }
        catch let e as JosiError where e.status == 404 { /* CE servers without native bootstrap can still accept login. */ }
        guard api === next else { return }
        if incomplete {
            guard local else { throw JosiError(message: "Finish first-time setup in Josi on the server Mac, then connect here.") }
            try await next.localSetupHandoff()
            guard api === next else { return }
            screen = .setup
            try await loadSetup()
        } else { screen = .login }
    }
    func signIn(identifier: String, password: String) async throws {
        guard let api else { return }
        let result = try await api.request("/auth/login", method: "POST",
                                          body: ["identifier": .string(identifier), "password": .string(password), "rememberMe": .bool(false)])
        guard self.api === api else { return }
        if result["mfaRequired"].flag { mfaChallenge = result["challenge"].text; return }
        try await finishLogin(api, user: result["user"])
    }
    func verifyMFA(_ code: String) async throws {
        guard let api else { return }
        let result = try await api.request("/auth/mfa/verify-login", method: "POST",
                                          body: ["challenge": .string(mfaChallenge), "code": .string(code)])
        guard self.api === api else { return }
        try await finishLogin(api, user: result["user"])
    }
    private func finishLogin(_ api: JosiAPI, user: Wire) async throws {
        try await api.primeCSRF()
        guard self.api === api else { return }
        self.user = user; mfaChallenge = ""; screen = .workspace
        try await reloadWorkspace()
    }
    func disconnect() {
        guard !busy else { return }
        guard mfaRecovery == .null else { error = "Save your sign-in recovery codes before disconnecting."; return }
        guard !desktop.requiresClosure else { error = "Close the separate desktop before disconnecting."; return }
        stopWorkStream(); api?.close(); api = nil
        user = .null; threads = []; messages = []; turns = []; goals = []; tasks = []; setup = .null
        setupReview = .null; recovery = .null; mfaChallenge = ""; draft = ""; pending = nil; pendingMessage = false
        automationSettings = .null; automationCatalog = .null; automation = .null; selectedThread = nil
        screen = .connect; error = ""; activity = ""
    }
    func signOut() async throws {
        guard mfaRecovery == .null else { throw JosiError(message: "Save your sign-in recovery codes before signing out.") }
        if desktop.requiresClosure { try await desktop.close() }
        if let api { _ = try await api.request("/auth/logout", method: "POST", body: [:]) }
        // run() keeps busy set until this completes; disconnect's UI guard
        // must not prevent clearing the revoked session.
        stopWorkStream(); api?.close(); api = nil
        user = .null; threads = []; messages = []; turns = []; goals = []; tasks = []
        draft = ""; pending = nil; pendingMessage = false; selectedThread = nil
        recovery = .null; setup = .null; setupReview = .null; mfaChallenge = ""
        automationSettings = .null; automationCatalog = .null; automation = .null; screen = .connect
    }
    func operate(_ operation: String) async throws {
        guard mfaRecovery == .null else { throw JosiError(message: "Save your sign-in recovery codes before changing the server.") }
        if desktop.requiresClosure { try await desktop.close() }
        let attempt = UUID(); installAttempt = operation == "install" ? attempt : nil
        activity = "Waiting for macOS authorization…"
        defer { installAttempt = nil; activity = "" ; refreshLocal() }
        try await NativeServer.operate(operation, attempt: attempt)
    }
    func poll() async {
        if let installAttempt { activity = NativeServer.progress(installAttempt) ?? activity }
        followWork()
        guard screen == .workspace, !busy, !refreshing, NSApp.isActive else { return }
        refreshing = true; defer { refreshing = false }
        do { try await reloadWorkspace(refreshGoals: workNeedsRefresh || (lastProgressSignal.map { $0.duration(to: .now) >= .seconds(20) } ?? true)) }
        catch is CancellationError {}
        catch { self.error = "Updates are unavailable. " + error.localizedDescription }
    }
    func reloadWorkspace(refreshGoals: Bool = true) async throws {
        guard let api, screen == .workspace else { return }
        let threadResult = try await api.request("/assistant/threads")
        guard self.api === api else { return }
        threads = threadResult["threads"].list
        if refreshGoals && !workAccessEnded {
            do {
                let result = try await api.request("/assistant/work-goals?all=1")
                guard self.api === api, !workAccessEnded else { return }; adoptGoals(result["goals"].list)
            } catch let e as JosiError where e.status == 404 { goals = [] } // Older remote CE servers remain usable.
        }
        if section == "tasks" {
            let result = try await api.request("/assistant/tasks?all=1")
            guard self.api === api else { return }; tasks = result["tasks"].list
        }
        if let selectedThread { try await loadThread(selectedThread) }
        if self.api === api { lastRefreshed = Date() }
    }
    private func adoptGoals(_ next: [Wire]) {
        workNeedsRefresh = false
        goals = next.map { value in
            if let previous = goals.first(where: { $0["goalId"] == value["goalId"] }),
               previous["revision"].integer > value["revision"].integer { return previous }
            return value
        }
    }
    private var wantsWorkStream: Bool {
        screen == .workspace && NSApp.isActive && ["chat", "tasks"].contains(section) && !workAccessEnded
    }
    private func stopWorkStream() {
        workStream?.cancel(); workStream = nil; api?.cancelWorkProgress()
        workRefresh?.cancel(); workRefresh = nil; workRefreshRequested = false
        workNeedsRefresh = true
        lastProgressSignal = nil; progressConnection = workAccessEnded ? "Sign in again to follow work" : "Periodic updates"
    }
    private func followWork() {
        guard wantsWorkStream else { stopWorkStream(); return }
        if let lastProgressSignal, lastProgressSignal.duration(to: .now) >= .seconds(20) {
            progressConnection = "Periodic updates"
        }
        guard workStream == nil, !workStreamUnsupported, let api else { return }
        let owner = user["id"]
        workStream = Task {
            while !Task.isCancelled && self.api === api && user["id"] == owner && wantsWorkStream {
                var retrySeconds = 5
                progressConnection = "Connecting live progress…"
                do {
                    try await api.followWorkProgress { event in
                        guard self.api === api, self.user["id"] == owner, !Task.isCancelled else { return }
                        switch event {
                        case "progress", "heartbeat":
                            self.lastProgressSignal = .now; self.progressConnection = "Live progress"
                            if event == "progress" { self.refreshWork(api, owner: owner) }
                        case "access-ended":
                            self.workAccessEnded = true; self.goals = []
                            self.progressConnection = "Sign in again to follow work"
                            self.error = "Your progress session ended. Sign in again to continue following your work."
                        default:
                            self.lastProgressSignal = nil; self.progressConnection = "Periodic updates"
                        }
                    }
                } catch let error as JosiError {
                    guard !Task.isCancelled, self.api === api, user["id"] == owner else { return }
                    if error.status == 404 { workStreamUnsupported = true; break }
                    if [401, 403].contains(error.status) {
                        workAccessEnded = true; goals = []
                        self.error = "Sign in again to follow your work."; break
                    }
                    if error.status == 429 { retrySeconds = 15 }
                } catch { if Task.isCancelled { return } }
                guard !Task.isCancelled, self.api === api, user["id"] == owner, wantsWorkStream else { return }
                lastProgressSignal = nil; progressConnection = "Periodic updates"
                do { try await Task.sleep(for: .seconds(retrySeconds)) } catch { return }
            }
            if !Task.isCancelled, self.api === api, user["id"] == owner {
                workStream = nil
                progressConnection = workAccessEnded ? "Sign in again to follow work" : "Periodic updates"
            }
        }
    }
    private func refreshWork(_ api: JosiAPI, owner: Wire) {
        workNeedsRefresh = true
        workRefreshRequested = true
        guard workRefresh == nil else { return }
        workRefresh = Task {
            // Collapse closely spaced invalidations without guessing a local
            // checklist or allowing an older request to lower a saved revision.
            defer { if !Task.isCancelled { workRefresh = nil } }
            while workRefreshRequested && !Task.isCancelled {
                workRefreshRequested = false
                do {
                    try await Task.sleep(for: .milliseconds(200))
                    guard self.api === api, user["id"] == owner, wantsWorkStream else { return }
                    let result = try await api.request("/assistant/work-goals?all=1")
                    guard !Task.isCancelled, self.api === api, user["id"] == owner, !workAccessEnded else { return }
                    adoptGoals(result["goals"].list); lastRefreshed = Date()
                } catch {
                    if !Task.isCancelled { workNeedsRefresh = true; lastProgressSignal = nil; progressConnection = "Periodic updates" }
                    return
                }
            }
        }
    }
    func selectThread(_ id: String) async throws {
        selectedThread = id; messages = []; turns = []; section = "chat"
        try await loadThread(id)
    }
    func loadThread(_ id: String) async throws {
        guard let api else { return }
        let path = try api.uuid(id)
        let result = try await api.request("/assistant/threads/\(path)?recent=1")
        guard self.api === api, selectedThread == id else { return }
        messages = result["messages"].list
        let accepted = try await api.request("/assistant/threads/\(path)/turns")
        guard self.api === api, selectedThread == id else { return }
        turns = accepted["turns"].list
    }
    func newThread() async throws {
        guard let api else { return }
        let result = try await api.request("/assistant/threads", method: "POST", body: [:])
        guard self.api === api else { return }
        let id = try api.uuid(result["thread"]["id"].text)
        try await selectThread(id); try await reloadWorkspace()
    }
    func send() async throws {
        guard let api else { return }
        if pending == nil {
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.count <= 8000 else { throw JosiError(message: "Write a message of up to 8,000 characters.") }
            if selectedThread == nil { try await newThread() }
            guard self.api === api, let selectedThread else { return }
            pending = (UUID().uuidString.lowercased(), selectedThread, text)
            pendingMessage = true; draft = ""
        }
        guard let pending else { return }
        let id = try api.uuid(pending.thread)
        // If the reply is lost, Retry delivery retains this exact identifier
        // and body. The server owns deduplication and durable task execution.
        _ = try await api.request("/assistant/threads/\(id)/turns", method: "POST",
                                  body: ["client_message_id": .string(pending.id), "message": .string(pending.message)],
                                  headers: ["Idempotency-Key": pending.id])
        guard self.api === api else { return }
        self.pending = nil; pendingMessage = false
        try await reloadWorkspace()
    }
    func control(_ goal: Wire, action: String, instruction: String = "") async throws {
        guard let api else { return }
        let id = try api.uuid(goal["goalId"].text)
        _ = try await api.request("/assistant/work-goals/\(id)/control", method: "POST",
                                  body: ["revision": goal["revision"], "action": .string(action), "instruction": .string(instruction)])
        guard self.api === api else { return }
        try await reloadWorkspace()
    }
    func loadAutomation() async throws {
        guard let api else { return }
        automation = .null; automationSettings = .null; automationCatalog = .null
        let result = try await api.request("/assistant/automation/workspaces")
        guard self.api === api else { return }; automation = result
        if isAdministrator {
            let result = try await api.request("/admin/automation")
            guard self.api === api else { return }; automationSettings = result
            let catalog = try await api.request("/admin/automation/catalog")
            guard self.api === api else { return }; automationCatalog = catalog
        }
    }
    func changeGoal(_ goal: Wire, endpoint: String, fields: [String: Wire]) async throws {
        guard let api, ["memory", "outcome", "retire-step"].contains(endpoint) else { return }
        let id = try api.uuid(goal["goalId"].text)
        var body = fields; body["revision"] = goal["revision"]
        _ = try await api.request("/assistant/work-goals/\(id)/\(endpoint)", method: "POST", body: .object(body))
        guard self.api === api else { return }
        try await reloadWorkspace()
    }
    func loadSetup() async throws {
        guard let api else { return }
        let next = try await api.request("/setup/state")
        guard self.api === api else { return }; setup = next
        if next["completed"].flag { recovery = .null; screen = .login; return }
        if next["recoveryPending"].flag {
            let value = try await api.request("/setup/vault-recovery")
            guard self.api === api else { return }; recovery = value
        }
        if next["nextStep"].text == "host_checks" {
            let result = try await api.request("/setup/host-checks")
            guard self.api === api else { return }; hostChecks = result["checks"].list
        }
        if next["completedSteps"].list.contains(.string("llm")) {
            let value = try await api.request("/setup/review")
            guard self.api === api else { return }; setupReview = value
        }
    }
    func setupStep(_ step: String, body: Wire) async throws {
        guard let api, ["host_checks", "owner", "domain", "llm", "smtp", "security", "telemetry", "review"].contains(step) else { return }
        let value = try await api.request("/setup/steps/\(step)", method: "POST", body: body)
        guard self.api === api else { return }
        if value["vaultRecovery"] != .null { recovery = value["vaultRecovery"] }
        if step == "llm" { _ = try await api.request("/setup/verify/llm", method: "POST", body: [:]) }
        guard self.api === api else { return }; try await loadSetup()
    }
    func confirmRecovery() async throws {
        guard let api else { return }
        _ = try await api.request("/setup/vault-recovery-confirmed", method: "POST", body: [:])
        guard self.api === api else { return }; recovery = .null; try await loadSetup()
    }
    func finishSetup() async throws {
        guard let api else { return }
        _ = try await api.request("/setup/complete", method: "POST", body: [:])
        guard self.api === api else { return }; recovery = .null; screen = .login
    }
}
