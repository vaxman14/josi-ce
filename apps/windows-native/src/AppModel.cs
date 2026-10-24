using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
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
      // While a reply is being written, check every second so it appears
      // promptly; otherwise every three seconds.
      timer.Tick += async delegate { timer.Interval = TimeSpan.FromSeconds(PendingMessage ? 1 : 3); await Poll(); };
      timer.Start();
    }
    public void Notify() { var handler = Changed; if (handler != null) handler(); }
    void NotifyWorkspace() { var handler = WorkspaceChanged; if (handler != null) handler(); }
    public bool Active { get { return window != null && window.IsActive; } }

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
      // The cause is usually one level down (a closed connection, a refused
      // write); without it "an error occurred" says nothing.
      var inner = e.InnerException;
      return "Something went wrong: " + e.Message + (inner != null && inner.Message != e.Message ? " (" + inner.Message + ")" : "");
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
      } else {
        Screen = Screen.Login;
        Notify();
        await Resume(next);
      }
      Notify();
    }

    // --------------------------------------------------------- signing in
    /// The username of a remembered sign-in that has ended, to fill in.
    public string RememberedIdentifier = "";
    /// Whether this server offers Sign in with Google (set up under Connections).
    public bool GoogleSignIn;
    string googleState, signingInAs = "";
    public bool GoogleWaiting { get { return googleState != null; } }

    /// Opens a remembered sign-in, if this PC has one for the server.
    async Task Resume(JosiApi api) {
      var saved = SessionStore.Load(api.OriginText);
      if (saved == null) return;
      RememberedIdentifier = saved.Identifier;
      try { api.UseSession(saved.Token); }
      catch (JosiException) { SessionStore.Forget(api.OriginText); return; }
      Wire me;
      try { me = await api.Request("/auth/me"); }
      catch (JosiException e) {
        if (Api != api) return;
        api.EndSession();
        // Ended or revoked on the server: forget it and ask again. Any other
        // problem keeps it for next time.
        if (e.Status == 401) SessionStore.Forget(api.OriginText); else Error = e.Message;
        return;
      }
      if (Api != api) return;
      await FinishLogin(api, me["user"]);
    }

    public async Task LoadSignInOptions() {
      var api = Api; if (api == null) return;
      api.UseNative();
      try {
        var config = await api.Request("/auth/native/config");
        if (Api != api) return;
        GoogleSignIn = config["googleSignIn"].Flag;
      } catch (JosiException) { GoogleSignIn = false; }
      Notify();
    }

    public async Task SignIn(string identifier, string password) {
      var api = Api; if (api == null) return;
      api.UseNative();
      // A native sign-in is the server's persistent session; Josi remembers it.
      var result = await api.Request("/auth/login", "POST", Wires.O("identifier", identifier, "password", password));
      if (Api != api) return;
      signingInAs = identifier;
      if (result["mfaRequired"].Flag) { MfaChallenge = result["challenge"].Text; Notify(); return; }
      await FinishNativeLogin(api, identifier, result);
    }
    public async Task VerifyMfa(string code) {
      var api = Api; if (api == null) return;
      var result = await api.Request("/auth/mfa/verify-login", "POST", Wires.O("challenge", MfaChallenge, "code", code));
      if (Api != api) return;
      await FinishNativeLogin(api, signingInAs, result);
    }

    /// Opens Google's page in the browser. Google returns to josi://auth/callback
    /// and CompleteGoogle finishes the sign-in.
    public async Task StartGoogle() {
      var api = Api; if (api == null) return;
      api.UseNative();
      AppLinks.Register();
      var next = await api.GoogleSignInStart(AppLinks.GoogleReturn);
      if (Api != api) return;
      if (next.Scheme == "josi") throw new JosiException(GoogleProblem(Query(next, "error")));
      if (next.Scheme != "https" || !next.IsDefaultPort || next.UserInfo.Length > 0 || next.Host != "accounts.google.com")
        throw new JosiException("The server's Google sign-in address was not Google's, so it was not opened.");
      var state = Query(next, "state");
      if (!Regex.IsMatch(state, "^[A-Za-z0-9_-]{20,512}$")) throw new JosiException("The server could not start Google sign-in.");
      googleState = state;
      ModelText.Open(next);
      Notify();
    }
    public void CancelGoogle() { googleState = null; Notify(); }

    public async Task CompleteGoogle(string link) {
      Uri uri;
      if (!Uri.TryCreate(link, UriKind.Absolute, out uri) || uri.Scheme != "josi" || uri.Host != "auth" || uri.AbsolutePath != "/callback")
        throw new JosiException("Josi received a sign-in link it does not recognise.");
      var api = Api; var expected = googleState;
      if (api == null || expected == null || Screen != Screen.Login)
        throw new JosiException("Start Sign in with Google from Josi's sign-in page, then try again.");
      // Only the sign-in this window started may finish here.
      if (Query(uri, "state") != expected) throw new JosiException("That Google sign-in was not started here. Start it again.");
      googleState = null; Notify();
      var error = Query(uri, "error");
      if (error.Length > 0) throw new JosiException(GoogleProblem(error));
      var code = Query(uri, "code");
      if (!Regex.IsMatch(code, "^[A-Za-z0-9_-]{20,512}$")) throw new JosiException("Google sign-in did not finish. Try again.");
      var result = await api.Request("/auth/google/native/exchange", "POST", Wires.O("code", code));
      if (Api != api) return;
      var user = result["user"];
      await FinishNativeLogin(api, user["email"].Text.Length > 0 ? user["email"].Text : user["username"].Text, result);
    }
    static string GoogleProblem(string error) {
      switch (error) {
        case "google_not_linked": return "This Google account is not linked to a Josi account. Sign in with your password, then connect this Google account under Connections.";
        case "google_declined": return "Google sign-in was cancelled.";
        case "google_unavailable": return "Google sign-in is not available on this server right now. Sign in with your password.";
        default: return "Google sign-in did not finish. Try again.";
      }
    }
    static string Query(Uri uri, string name) {
      foreach (var part in uri.Query.TrimStart('?').Split('&')) {
        var at = part.IndexOf('=');
        if (at > 0 && Uri.UnescapeDataString(part.Substring(0, at)) == name) return Uri.UnescapeDataString(part.Substring(at + 1).Replace('+', ' '));
      }
      return "";
    }

    // ------------------------------------------------- account connections
    /// Raised after a connection finishes through josi://connections/callback.
    public event Action ConnectionFinished;
    readonly HashSet<string> connectionStates = new HashSet<string>();

    /// Opens the provider's consent page in the browser for a handshake started
    /// with this app's session; CompleteConnection finishes it.
    public async Task StartConnection(string provider, string connectionId) {
      var api = Api; if (api == null) return;
      AppLinks.Register();
      var body = Wires.O("native", true);
      if (!string.IsNullOrEmpty(connectionId)) body["connectionId"] = connectionId;
      var result = await api.Request("/connections/" + Uri.EscapeDataString(provider) + "/start", "POST", body);
      Uri url;
      if (!Uri.TryCreate(result["url"].Text, UriKind.Absolute, out url) || url.Scheme != "https" || url.UserInfo.Length > 0)
        throw new JosiException("The server did not return a usable sign-in address for " + provider + ".");
      var state = Query(url, "state");
      if (!Regex.IsMatch(state, "^[A-Za-z0-9_-]{20,512}$")) throw new JosiException("The server could not start the connection.");
      connectionStates.Add(state);
      ModelText.Open(url);
      Activity = ""; Error = "";
    }

    public async Task CompleteConnection(string link) {
      Uri uri;
      if (!Uri.TryCreate(link, UriKind.Absolute, out uri) || uri.Scheme != "josi" || uri.Host != "connections" || uri.AbsolutePath != "/callback")
        throw new JosiException("Josi received a connection link it does not recognise.");
      var api = Api; var state = Query(uri, "state"); var provider = Query(uri, "provider");
      if (api == null || !connectionStates.Remove(state)) throw new JosiException("That connection was not started from this Josi window. Start it again from Connections.");
      if (!Regex.IsMatch(provider, "^(google|microsoft|dropbox|box)$")) throw new JosiException("Josi received a connection link it does not recognise.");
      var declined = Query(uri, "error").Length > 0;
      try {
        await api.Request("/connections/" + provider + "/native/complete", "POST", Wires.O("state", state, "code", Query(uri, "code"), "declined", declined));
      } catch (JosiException e) {
        throw new JosiException(ConnectionProblem(e.Message));
      } finally { var handler = ConnectionFinished; if (handler != null) handler(); }
    }
    static string ConnectionProblem(string reason) {
      switch (reason) {
        case "declined": return "You cancelled at the provider, so nothing was connected.";
        case "consumed": case "unknown": case "expired": return "That sign-in had already been used or had expired. Start again.";
        case "session_mismatch": return "That sign-in was started by a different session. Start again here.";
        case "wrong_provider": return "That sign-in did not match the provider it was started for.";
        case "revoked": return "The provider refused the connection. Check the application credentials under Connectors.";
        default: return reason.Length > 0 && reason.Length < 300 ? reason : "The connection could not be completed. Try again.";
      }
    }

    // ------------------------------------------ Send to, and notifications
    readonly List<string> pendingShares = new List<string>();
    readonly NotificationWatcher watcher = new NotificationWatcher();
    DateTime lastNotificationCheck = DateTime.MinValue;
    bool wasPending;
    /// Files from File Explorer's Send to menu: attached to the open
    /// conversation, or once you are signed in.
    public void Share(List<string> paths) {
      pendingShares.AddRange(paths.Where(p => p.Length > 0).Take(10));
      AttachShares();
    }
    void AttachShares() {
      if (Screen != Screen.Workspace || pendingShares.Count == 0 || Busy) return;
      var files = pendingShares.ToList(); pendingShares.Clear();
      Section = "chat";
      Run(async () => { foreach (var path in files) await AttachFile(path); });
    }
    // ------------------------------------------ settings changes by talking
    /// Raised on the UI thread with a proposal this person can make live; the
    /// window shows the approval popup.
    public event Action<Wire> SettingsChangeProposed;
    public void OfferSettingsChange(Wire proposal) {
      var handler = SettingsChangeProposed;
      if (handler != null) handler(proposal);
      else Notifications.Show("Josi proposes a settings change", proposal["title"].Text + ": approve it under Approvals.");
    }
    /// Approve or deny; approving a change this app applies performs it now.
    public async Task<string> DecideSettingsChange(Wire proposal, bool approve) {
      var api = Api; if (api == null) return "";
      var result = await api.Request("/settings-changes/" + api.Uuid(proposal.Id) + "/decide", "POST", Wires.O("approve", approve));
      if (!approve) return "Declined. Nothing changed.";
      if (result["apply"].IsNull) return "Approved. It is applied by " + (proposal["scope"].Text == "administrator" ? "the administrator's" : proposal["proposer"].Text + "'s") + " Josi.";
      return await ApplySettingsChange(proposal, result["apply"]);
    }
    /// Performs the stored request with this app's own session, so the
    /// setting's own route decides. A route that needs the account password
    /// gets it from the person, once, through the usual dialog.
    public async Task<string> ApplySettingsChange(Wire proposal, Wire apply) {
      var api = Api; if (api == null) return "";
      var path = apply["path"].Text; var method = apply["method"].Text;
      var body = apply["body"].IsNull ? Wires.O() : apply["body"].Raw;
      string error = null;
      try { await api.Request(path, method, method == "DELETE" ? null : body); }
      catch (JosiException e) {
        if (e.Status == 401 && e.Message.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0 && window != null) {
          var password = Dialogs.AskPassword(window, "Confirm to apply: " + proposal["title"].Text, proposal["summary"].Text + "\n\nThis setting asks for your account password.", "Apply");
          if (password == null) error = "Not applied: the password prompt was cancelled.";
          else {
            try {
              var withPassword = Wires.O("password", password);
              var map = body as IDictionary<string, object>;
              if (map != null) foreach (var pair in map) withPassword[pair.Key] = pair.Value;
              await api.Request(path, method, withPassword);
            } catch (JosiException again) { error = again.Message; }
          }
        } else error = e.Message;
      }
      try { await api.Request("/settings-changes/" + api.Uuid(proposal.Id) + "/applied", "POST", error == null ? Wires.O("ok", true) : Wires.O("ok", false, "error", error)); }
      catch (JosiException) { }
      if (error == null) { Notifications.Show("Applied", proposal["title"].Text); return "Applied: " + proposal["title"].Text + "."; }
      Error = "Not applied: " + error; Notify();
      return "Not applied: " + error;
    }

    /// Called on the poll timer: background notifications, at most every 30
    /// seconds, and "reply finished" when Josi is not the active window.
    async Task Watch() {
      if (Screen != Screen.Workspace) return;
      if (wasPending && !PendingMessage && !Active) Notifications.Show("Josi replied", "Your reply is ready.");
      wasPending = PendingMessage;
      if ((DateTime.UtcNow - lastNotificationCheck).TotalSeconds < 30) return;
      lastNotificationCheck = DateTime.UtcNow;
      await watcher.Check(this);
    }

    /// "auto" (follow Windows) or "pinned", remembered per server on this PC.
    public string WorkspaceZoneMode {
      get { return Api == null ? "auto" : LocalSettings.Get("workspaceZone:" + Api.OriginText, "auto"); }
      set { if (Api != null) LocalSettings.Set("workspaceZone:" + Api.OriginText, value == "pinned" ? "pinned" : "auto"); }
    }
    /// With the automatic setting, keeps the workspace time zone on Windows'
    /// zone. Administrators only; best effort.
    async Task FollowWindowsZone(JosiApi api) {
      if (!IsAdministrator || WorkspaceZoneMode != "auto") return;
      try {
        var current = (await api.Request("/admin/workspace"))["workspace"];
        var local = TimeZones.Local();
        if (Api == api && !current.IsNull && current["timezone"].Text != local)
          await api.Request("/admin/workspace", "PATCH", Wires.O("name", current["name"].Text, "timezone", local));
      } catch (JosiException) { }
    }

    async Task FinishNativeLogin(JosiApi api, string identifier, Wire result) {
      var token = result["sessionToken"].Text;
      api.UseSession(token);
      try { SessionStore.Save(api.OriginText, identifier, token); }
      catch (JosiException e) { Error = e.Message; }
      RememberedIdentifier = identifier ?? "";
      await FinishLogin(api, result["user"]);
    }
    void ClearAccount() {
      User = Wire.Null; Threads.Clear(); Messages.Clear(); Turns.Clear(); Goals.Clear(); Tasks.Clear(); TaskRuns.Clear();
      pending = null; PendingMessage = false; DraftAttachments.Clear(); Draft = ""; SelectedThread = null;
      Recovery = Wire.Null; SetupState = Wire.Null; SetupReview = Wire.Null; MfaChallenge = "";
      Automation = Wire.Null; AutomationSettings = Wire.Null; AutomationCatalog = Wire.Null; AutomationDevices = Wire.Null;
      AutomationError = ""; AutomationDevicesError = "";
    }

    async Task FinishLogin(JosiApi api, Wire user) {
      await api.PrimeCsrf();
      if (Api != api) return;
      User = user; MfaChallenge = ""; Screen = Screen.Workspace; section = "chat";
      Notify();
      await ReloadWorkspace();
      await FollowWindowsZone(api);
      _ = Dispatcher.CurrentDispatcher.BeginInvoke(new Action(AttachShares), DispatcherPriority.Background);
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
        SessionStore.Forget(Api.OriginText);
      }
      RememberedIdentifier = "";
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
      if (!refreshing && !Busy) { try { await Watch(); } catch (Exception) { } }
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
    /// Submits a setup step. For the model step, returns the server's check
    /// of the saved model: setup stays on that step until the check passes.
    public async Task<Wire> SetupStep(string step, object body) {
      var api = Api;
      if (api == null || !SetupSteps.Contains(step)) return Wire.Null;
      var value = await api.Request("/setup/steps/" + step, "POST", body);
      if (Api != api) return Wire.Null;
      if (!value["vaultRecovery"].IsNull) Recovery = value["vaultRecovery"];
      var check = Wire.Null;
      if (step == "llm") check = await api.Request("/setup/verify/llm", "POST", Wires.O());
      if (Api != api) return Wire.Null;
      await LoadSetup();
      return check;
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
