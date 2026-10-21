using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;

namespace Josi.Native {
  public enum Screen { Connect, Login, Setup, Workspace }

  /// Windows counterpart of JosiModel.swift. All server state is canonical on
  /// the CE server; this model only holds the current view of it in memory.
  public sealed class AppModel {
    public event Action Changed;
    public event Action WorkspaceChanged;
    public event Action SectionChanged;

    public Screen Screen = Screen.Connect;
    string section = "chat";
    public string Address = "";
    public ServerReceipt Receipt = new ServerReceipt();
    public bool Busy;
    public string Error = "";
    public string Activity = "";
    public Wire User = Wire.Null;
    public List<Wire> Threads = new List<Wire>();
    public List<Wire> Messages = new List<Wire>();
    public List<Wire> Turns = new List<Wire>();
    public List<Wire> Goals = new List<Wire>();
    public List<Wire> Tasks = new List<Wire>();
    public List<Wire> TaskRuns = new List<Wire>();
    public string SelectedThread;
    public string Draft = "";
    public bool PendingMessage;
    public List<Wire> DraftAttachments = new List<Wire>();
    public string LastAcceptedTurnId;
    public Wire SetupState = Wire.Null, SetupReview = Wire.Null, Recovery = Wire.Null;
    public List<Wire> HostChecks = new List<Wire>();
    public Wire VaultRecovery = Wire.Null, MfaRecovery = Wire.Null;
    public string MfaChallenge = "";
    public Wire Automation = Wire.Null, AutomationSettings = Wire.Null, AutomationCatalog = Wire.Null, AutomationDevices = Wire.Null;
    public bool AutomationLoading;
    public string AutomationError = "", AutomationDevicesError = "";
    public DateTime? LastRefreshed;
    public string ProgressConnection = "Periodic updates";
    public JosiApi Api;

    Window window;
    bool refreshing, workStreamRunning, workStreamUnsupported, workAccessEnded, workNeedsRefresh = true, workRefreshRunning, workRefreshRequested;
    DateTime? lastProgressSignal;
    PendingTurn pending;
    sealed class PendingTurn { public string Id, Thread, Message; public List<Wire> Attachments; }

    public string Section {
      get { return section; }
      set { if (section == value) return; section = value; var handler = SectionChanged; if (handler != null) handler(); FollowWork(); }
    }
    public string SignedInName { get { var name = User["displayName"].Text; return name.Length == 0 ? User["username"].Text : name; } }
    public bool IsAdministrator { get { return User["role"].Text == "super_admin"; } }
    public bool RecoveryPending { get { return !VaultRecovery.IsNull || !Recovery.IsNull || !MfaRecovery.IsNull; } }
    public List<Wire> ChatGoals { get { return Goals.Where(g => g["threadId"].Text == SelectedThread).Take(6).ToList(); } }

    public void Attach(Window owner) {
      window = owner;
      var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
      timer.Tick += async delegate { await Poll(); };
      timer.Start();
    }
    public void Notify() { var handler = Changed; if (handler != null) handler(); }
    void NotifyWorkspace() { var handler = WorkspaceChanged; if (handler != null) handler(); }
    bool Active { get { return window != null && window.IsActive; } }

    /// One user-initiated operation at a time; errors surface in the banner.
    public async void Run(Func<Task> action) {
      if (Busy) return;
      Busy = true; Error = ""; Notify();
      try { await action(); }
      catch (OperationCanceledException) { }
      catch (JosiException e) { Error = e.Message; }
      catch (Exception e) { Error = Friendly(e); }
      finally { Busy = false; Notify(); }
    }
    public static string Friendly(Exception e) {
      if (e is JosiException) return e.Message;
      if (e is UnauthorizedAccessException) return "Windows denied access to that file or folder.";
      if (e is System.IO.IOException) return "The file could not be read or written. " + e.Message;
      return "Something went wrong: " + e.Message;
    }

    public void RefreshLocal() {
      try { Receipt = LocalServer.Read(); }
      catch (Exception e) { Error = Friendly(e); }
      Notify();
    }

    public async Task Connect(string address, bool local = false) {
      if (!MfaRecovery.IsNull) throw new JosiException("Save your sign-in recovery codes before changing servers.");
      var next = new JosiApi(address);
      StopWorkStream();
      if (Api != null) Api.Dispose();
      Api = next;
      workStreamUnsupported = false; workAccessEnded = false;
      ClearAccount();
      Address = next.OriginText;
      await next.PrimeCsrf();
      var incomplete = false;
      try { incomplete = !(await next.Request("/onboarding/state"))["completed"].Flag; }
      catch (JosiException e) { if (e.Status != 404) throw; /* CE servers without native bootstrap still accept login. */ }
      if (Api != next) return;
      if (incomplete) {
        if (!local) throw new JosiException("Finish first-time setup in Josi on the server PC, then connect here.");
        await next.LocalSetupHandoff();
        if (Api != next) return;
        Screen = Screen.Setup;
        await LoadSetup();
      } else Screen = Screen.Login;
      Notify();
    }
    void ClearAccount() {
      User = Wire.Null; Threads.Clear(); Messages.Clear(); Turns.Clear(); Goals.Clear(); Tasks.Clear(); TaskRuns.Clear();
      pending = null; PendingMessage = false; DraftAttachments.Clear(); Draft = ""; SelectedThread = null;
      Recovery = Wire.Null; SetupState = Wire.Null; SetupReview = Wire.Null; MfaChallenge = "";
      Automation = Wire.Null; AutomationSettings = Wire.Null; AutomationCatalog = Wire.Null; AutomationDevices = Wire.Null;
      AutomationError = ""; AutomationDevicesError = "";
    }

    public async Task SignIn(string identifier, string password) {
      var api = Api; if (api == null) return;
      var result = await api.Request("/auth/login", "POST", Wires.O("identifier", identifier, "password", password, "rememberMe", false));
      if (Api != api) return;
      if (result["mfaRequired"].Flag) { MfaChallenge = result["challenge"].Text; Notify(); return; }
      await FinishLogin(api, result["user"]);
    }
    public async Task VerifyMfa(string code) {
      var api = Api; if (api == null) return;
      var result = await api.Request("/auth/mfa/verify-login", "POST", Wires.O("challenge", MfaChallenge, "code", code));
      if (Api != api) return;
      await FinishLogin(api, result["user"]);
    }
    async Task FinishLogin(JosiApi api, Wire user) {
      await api.PrimeCsrf();
      if (Api != api) return;
      User = user; MfaChallenge = ""; Screen = Screen.Workspace; section = "chat";
      Notify();
      await ReloadWorkspace();
    }
    public void Disconnect() {
      if (Busy) return;
      if (!MfaRecovery.IsNull) { Error = "Save your sign-in recovery codes before disconnecting."; Notify(); return; }
      StopWorkStream();
      if (Api != null) Api.Dispose();
      Api = null; ClearAccount();
      Screen = Screen.Connect; Error = ""; Activity = "";
      Notify();
    }
    public async Task SignOut() {
      if (!MfaRecovery.IsNull) throw new JosiException("Save your sign-in recovery codes before signing out.");
      if (Api != null) {
        try { await Api.Request("/auth/logout", "POST", Wires.O()); }
        catch (JosiException e) { if (e.Status != 401) throw; /* An already-ended session still clears locally. */ }
      }
      StopWorkStream();
      if (Api != null) Api.Dispose();
      Api = null; ClearAccount(); Screen = Screen.Connect;
      Notify();
    }

    public async Task Operate(string operation) {
      if (!MfaRecovery.IsNull) throw new JosiException("Save your sign-in recovery codes before changing the server.");
      Activity = "Waiting for Windows administrator approval…"; Notify();
      try { await LocalServer.Operate(operation); }
      finally { Activity = ""; RefreshLocal(); }
    }
    public async Task RunInstaller(string path) {
      Activity = "Running the Josi CE installer…"; Notify();
      try { await LocalServer.RunInstaller(path); }
      finally { Activity = ""; RefreshLocal(); }
    }

    async Task Poll() {
      FollowWork();
      if (Screen != Screen.Workspace || Busy || refreshing || !Active) return;
      refreshing = true;
      try {
        var stale = !lastProgressSignal.HasValue || (DateTime.UtcNow - lastProgressSignal.Value).TotalSeconds >= 20;
        await ReloadWorkspace(workNeedsRefresh || stale);
      } catch (OperationCanceledException) {
      } catch (Exception e) { Error = "Updates are unavailable. " + Friendly(e); Notify(); }
      finally { refreshing = false; }
    }

    public async Task ReloadWorkspace(bool refreshGoals = true) {
      var api = Api;
      if (api == null || Screen != Screen.Workspace) return;
      var threadResult = await api.Request("/assistant/threads");
      if (Api != api) return;
      Threads = threadResult["threads"].List;
      if (refreshGoals && !workAccessEnded) {
        try {
          var result = await api.Request("/assistant/work-goals?all=1");
          if (Api != api || workAccessEnded) return;
          AdoptGoals(result["goals"].List);
        } catch (JosiException e) { if (e.Status != 404) throw; Goals = new List<Wire>(); /* Older remote CE servers remain usable. */ }
      }
      if (section == "tasks") {
        var result = await api.Request("/assistant/tasks?all=1");
        if (Api != api) return; Tasks = result["tasks"].List;
        var runs = await api.Request("/assistant/task-runs");
        if (Api != api) return; TaskRuns = runs["runs"].List;
      }
      if (SelectedThread != null) await LoadThread(SelectedThread);
      if (Api == api) LastRefreshed = DateTime.Now;
      NotifyWorkspace();
    }
    void AdoptGoals(List<Wire> next) {
      workNeedsRefresh = false;
      Goals = next.Select(value => {
        var previous = Goals.FirstOrDefault(g => g["goalId"].Text == value["goalId"].Text);
        return previous != null && previous["revision"].Integer > value["revision"].Integer ? previous : value;
      }).ToList();
    }

    bool WantsWorkStream { get { return Screen == Screen.Workspace && Active && (section == "chat" || section == "tasks") && !workAccessEnded; } }
    void StopWorkStream() {
      if (Api != null) Api.CancelWorkProgress();
      workStreamRunning = false; workRefreshRequested = false; workNeedsRefresh = true;
      lastProgressSignal = null;
      ProgressConnection = workAccessEnded ? "Sign in again to follow work" : "Periodic updates";
    }
    async void FollowWork() {
      if (!WantsWorkStream) { if (workStreamRunning) StopWorkStream(); return; }
      if (lastProgressSignal.HasValue && (DateTime.UtcNow - lastProgressSignal.Value).TotalSeconds >= 20) ProgressConnection = "Periodic updates";
      if (workStreamRunning || workStreamUnsupported || Api == null) return;
      var api = Api; var owner = User["id"].Text;
      workStreamRunning = true;
      try {
        while (Api == api && User["id"].Text == owner && WantsWorkStream && workStreamRunning) {
          var retry = 5;
          ProgressConnection = "Connecting live progress…";
          try {
            await api.FollowWorkProgress(evt => {
              if (Api != api || User["id"].Text != owner) return;
              if (evt == "progress" || evt == "heartbeat") {
                lastProgressSignal = DateTime.UtcNow; ProgressConnection = "Live progress";
                if (evt == "progress") RefreshWork(api, owner);
              } else if (evt == "access-ended") {
                workAccessEnded = true; Goals = new List<Wire>();
                ProgressConnection = "Sign in again to follow work";
                Error = "Your progress session ended. Sign in again to continue following your work."; Notify();
              } else { lastProgressSignal = null; ProgressConnection = "Periodic updates"; }
            });
          } catch (JosiException e) {
            if (Api != api || User["id"].Text != owner) return;
            if (e.Status == 404) { workStreamUnsupported = true; break; }
            if (e.Status == 401 || e.Status == 403) { workAccessEnded = true; Goals = new List<Wire>(); Error = "Sign in again to follow your work."; Notify(); break; }
            if (e.Status == 429) retry = 15;
          } catch (OperationCanceledException) { return; }
          if (Api != api || User["id"].Text != owner || !WantsWorkStream || !workStreamRunning) return;
          lastProgressSignal = null; ProgressConnection = "Periodic updates";
          await Task.Delay(TimeSpan.FromSeconds(retry));
        }
      } finally {
        if (Api == api) { workStreamRunning = false; ProgressConnection = workAccessEnded ? "Sign in again to follow work" : "Periodic updates"; }
      }
    }
    /// Collapse closely spaced invalidations without guessing a local checklist
    /// or allowing an older request to lower a saved revision.
    async void RefreshWork(JosiApi api, string owner) {
      workNeedsRefresh = true; workRefreshRequested = true;
      if (workRefreshRunning) return;
      workRefreshRunning = true;
      try {
        while (workRefreshRequested) {
          workRefreshRequested = false;
          await Task.Delay(200);
          if (Api != api || User["id"].Text != owner || !WantsWorkStream) return;
          var result = await api.Request("/assistant/work-goals?all=1");
          if (Api != api || User["id"].Text != owner || workAccessEnded) return;
          AdoptGoals(result["goals"].List); LastRefreshed = DateTime.Now;
          NotifyWorkspace();
        }
      } catch (Exception) {
        workNeedsRefresh = true; lastProgressSignal = null; ProgressConnection = "Periodic updates";
      } finally { workRefreshRunning = false; }
    }

    public async Task SelectThread(string id) {
      if (SelectedThread != id) { DraftAttachments.Clear(); Draft = ""; }
      SelectedThread = id; Messages = new List<Wire>(); Turns = new List<Wire>();
      Section = "chat"; NotifyWorkspace();
      await LoadThread(id);
      NotifyWorkspace();
    }
    public async Task LoadThread(string id) {
      var api = Api; if (api == null) return;
      var path = api.Uuid(id);
      var result = await api.Request("/assistant/threads/" + path + "?recent=1");
      if (Api != api || SelectedThread != id) return;
      Messages = result["messages"].List;
      var accepted = await api.Request("/assistant/threads/" + path + "/turns");
      if (Api != api || SelectedThread != id) return;
      Turns = accepted["turns"].List;
    }
    public async Task NewThread() {
      var api = Api; if (api == null) return;
      var result = await api.Request("/assistant/threads", "POST", Wires.O());
      if (Api != api) return;
      var id = api.Uuid(result["thread"]["id"].Text);
      await SelectThread(id); await ReloadWorkspace();
    }

    /// Durable submission. If the reply is lost, Retry delivery keeps the exact
    /// identifier and body; the server owns deduplication and task execution.
    public async Task Send() {
      var api = Api; if (api == null) return;
      if (pending == null) {
        var text = (Draft ?? "").Trim();
        if (text.Length == 0 || text.Length > 8000) throw new JosiException("Write a message of up to 8,000 characters.");
        if (SelectedThread == null) { var saved = Draft; await NewThread(); Draft = saved; }
        if (Api != api || SelectedThread == null) return;
        pending = new PendingTurn { Id = Guid.NewGuid().ToString().ToLowerInvariant(), Thread = SelectedThread, Message = text,
          Attachments = DraftAttachments.Select(a => a["id"]).ToList() };
        PendingMessage = true; Draft = ""; DraftAttachments.Clear(); NotifyWorkspace();
      }
      var turn = pending;
      var id = api.Uuid(turn.Thread);
      var accepted = await api.Request("/assistant/threads/" + id + "/turns", "POST",
        Wires.O("client_message_id", turn.Id, "message", turn.Message, "attachment_receipts", Wires.A(turn.Attachments)),
        new Dictionary<string, string> { { "Idempotency-Key", turn.Id } });
      if (Api != api) return;
      LastAcceptedTurnId = accepted["turn"]["id"].Text;
      pending = null; PendingMessage = false;
      await ReloadWorkspace();
    }
    public async Task Control(Wire goal, string action, string instruction) {
      var api = Api; if (api == null) return;
      var id = api.Uuid(goal["goalId"].Text);
      await api.Request("/assistant/work-goals/" + id + "/control", "POST",
        Wires.O("revision", goal["revision"], "action", action, "instruction", instruction ?? ""));
      if (Api != api) return;
      await ReloadWorkspace();
    }
    public async Task ChangeGoal(Wire goal, string endpoint, Dictionary<string, object> fields) {
      var api = Api;
      if (api == null || !(endpoint == "memory" || endpoint == "outcome" || endpoint == "retire-step" || endpoint == "limits")) return;
      var id = api.Uuid(goal["goalId"].Text);
      fields["revision"] = goal["revision"].Raw;
      await api.Request("/assistant/work-goals/" + id + "/" + endpoint, "POST", fields);
      if (Api != api) return;
      await ReloadWorkspace();
    }
    public async Task AttachFile(string path) {
      var api = Api;
      if (api == null || PendingMessage || DraftAttachments.Count >= 10) return;
      if (SelectedThread == null) { var saved = Draft; await NewThread(); Draft = saved; }
      var thread = SelectedThread; if (thread == null) return;
      var receipt = await api.UploadAttachment(path, thread);
      if (Api != api || SelectedThread != thread) return;
      api.Uuid(receipt["id"].Text); DraftAttachments.Add(receipt);
      NotifyWorkspace();
    }
    public async Task<string> VoiceTurn(string text) {
      if (Busy || PendingMessage || (Draft ?? "").Trim().Length > 0)
        throw new JosiException("Send or clear your typed message before continuing voice chat.");
      var api = Api; if (api == null) throw new OperationCanceledException();
      Draft = text; await Send();
      var thread = SelectedThread; var turnId = LastAcceptedTurnId;
      if (thread == null || turnId == null) return null;
      for (var i = 0; i < 150; i++) {
        if (Api != api || SelectedThread != thread) throw new OperationCanceledException();
        await LoadThread(thread); NotifyWorkspace();
        var turn = Turns.FirstOrDefault(t => t.Id == turnId);
        if (turn != null) {
          if (turn["status"].Text == "failed") throw new JosiException("Josi could not complete this voice reply. See its saved request in chat.");
          if (turn["status"].Text == "completed") {
            var message = Messages.FirstOrDefault(m => m.Id == turn["assistant_message_id"].Text);
            return message == null ? null : message["body"].Text;
          }
        }
        await Task.Delay(2000);
      }
      throw new JosiException("Josi is still working. Follow the reply in this conversation.");
    }

    public async Task LoadAutomation() {
      var api = Api; if (api == null) return;
      AutomationLoading = true; AutomationError = ""; NotifyWorkspace();
      try {
        try {
          var result = await api.Request("/assistant/automation/workspaces");
          if (Api != api) return; Automation = result;
        } catch (JosiException e) {
          if (Api != api) return;
          Automation = Wire.Null; AutomationError = e.Message;
        }
        if (IsAdministrator) {
          // Independent of the combined rules/permissions endpoint. A failure
          // there must not erase a successfully enrolled device.
          try {
            var devices = await api.Request("/admin/automation/devices");
            if (Api != api) return; AutomationDevices = devices; AutomationDevicesError = "";
          } catch (JosiException e) {
            if (Api != api) return;
            if (e.Status == 401 || e.Status == 403 || e.Status == 423) AutomationDevices = Wire.Null;
            AutomationDevicesError = e.Message;
          }
          try {
            var settings = await api.Request("/admin/automation");
            if (Api != api) return; AutomationSettings = settings;
            var catalog = await api.Request("/admin/automation/catalog");
            if (Api != api) return; AutomationCatalog = catalog;
          } catch (JosiException e) {
            if (Api != api) return;
            AutomationSettings = Wire.Null; AutomationCatalog = Wire.Null;
            AutomationError = string.Join("\n", new[] { AutomationError, e.Message }.Where(s => s.Length > 0));
          }
        }
      } finally { if (Api == api) { AutomationLoading = false; NotifyWorkspace(); } }
    }

    public async Task LoadSetup() {
      var api = Api; if (api == null) return;
      var next = await api.Request("/setup/state");
      if (Api != api) return; SetupState = next;
      if (next["completed"].Flag) { Recovery = Wire.Null; Screen = Screen.Login; Notify(); return; }
      if (next["recoveryPending"].Flag) {
        var value = await api.Request("/setup/vault-recovery");
        if (Api != api) return; Recovery = value;
      }
      if (next["nextStep"].Text == "host_checks") {
        var result = await api.Request("/setup/host-checks");
        if (Api != api) return; HostChecks = result["checks"].List;
      }
      if (next["completedSteps"].List.Any(s => s.Text == "llm")) {
        var value = await api.Request("/setup/review");
        if (Api != api) return; SetupReview = value;
      }
      Notify();
    }
    static readonly string[] SetupSteps = { "host_checks", "owner", "domain", "llm", "smtp", "security", "telemetry", "review" };
    public async Task SetupStep(string step, object body) {
      var api = Api;
      if (api == null || !SetupSteps.Contains(step)) return;
      var value = await api.Request("/setup/steps/" + step, "POST", body);
      if (Api != api) return;
      if (!value["vaultRecovery"].IsNull) Recovery = value["vaultRecovery"];
      if (step == "llm") await api.Request("/setup/verify/llm", "POST", Wires.O());
      if (Api != api) return;
      await LoadSetup();
    }
    public async Task ConfirmRecovery() {
      var api = Api; if (api == null) return;
      await api.Request("/setup/vault-recovery-confirmed", "POST", Wires.O());
      if (Api != api) return; Recovery = Wire.Null; await LoadSetup();
    }
    public async Task FinishSetup() {
      var api = Api; if (api == null) return;
      await api.Request("/setup/complete", "POST", Wires.O());
      if (Api != api) return; Recovery = Wire.Null; Screen = Screen.Login; Notify();
    }
  }
}
