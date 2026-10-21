using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Josi.Native {
  /// The running Josi's side of the browser extension. A browser you allow
  /// here can attach one tab; the server's PC Control decides every read or
  /// action (your saved permissions, or your approval), and this app claims
  /// the approved work one request at a time and hands it to the extension.
  /// Page content passes through to the server result and is not kept here.
  sealed class BrowserBridge {
    public static readonly BrowserBridge Current = new BrowserBridge();
    const string SettingsKey = "browserProfiles";
    const int SessionMs = 55000, CommandMs = 20000, ObservationBytes = 60000;

    sealed class Pending {
      public string CommandId; public Dictionary<string, object> Command; public string Value;
      public readonly TaskCompletionSource<Tuple<bool, object>> Done = new TaskCompletionSource<Tuple<bool, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    sealed class Link {
      public object Owner; public string SessionId, ProfileId, Family, Browser, Application, Profile, Url, Title;
      public long TabId; public readonly List<string> Origins = new List<string>(); public DateTime LastPoll;
      public Pending Queued, Sent;
    }
    public sealed class Discovery { public string NativeProfileId, Browser, Application, Url; }

    readonly object gate = new object();
    readonly string workspaceId;
    Link link; Discovery discovered;
    Dispatcher ui; bool started;
    /// Raised on the UI thread when the attached tab or a request to connect changes.
    public event Action Changed;

    BrowserBridge() {
      workspaceId = LocalSettings.Get("browserWorkspace");
      if (!Wires.IsUuid(workspaceId)) { workspaceId = Guid.NewGuid().ToString(); try { LocalSettings.Set("browserWorkspace", workspaceId); } catch (IOException) { } }
    }

    // ------------------------------------------------------------- state
    public Discovery Discovered { get { lock (gate) return discovered; } }
    public bool Attached { get { lock (gate) return Live(); } }
    public string AttachedBrowser { get { lock (gate) return Live() ? link.Browser : ""; } }
    public string AttachedApplication { get { lock (gate) return Live() ? link.Application : ""; } }
    public string AttachedProfile { get { lock (gate) return Live() ? link.Profile : ""; } }
    public string AttachedOrigin { get { lock (gate) return Live() ? OriginOf(link.Url) ?? "" : ""; } }
    public string AttachedTitle { get { lock (gate) return Live() ? link.Title : ""; } }
    bool Live() { return link != null && (DateTime.UtcNow - link.LastPoll).TotalSeconds < 10; }

    /// Browsers you allowed: their extension install id, browser and executable.
    public List<Wire> Allowed() {
      try { return Wires.Parse(LocalSettings.Get(SettingsKey, "[]")).List; } catch (Exception) { return new List<Wire>(); }
    }
    void SaveAllowed(IEnumerable<Wire> items) { LocalSettings.Set(SettingsKey, Wires.Serialize(Wires.A(items))); }
    public void Allow() {
      Discovery d; lock (gate) { d = discovered; discovered = null; }
      if (d == null) return;
      var items = Allowed().Where(a => a["nativeProfileId"].Text != d.NativeProfileId).ToList();
      items.Add(new Wire(Wires.O("nativeProfileId", d.NativeProfileId, "profileId", Guid.NewGuid().ToString(), "browser", d.Browser,
        "application", d.Application, "profile", "Default", "allowedAt", DateTime.UtcNow.ToString("o"))));
      SaveAllowed(items); Raise();
    }
    public void Ignore() { lock (gate) discovered = null; Raise(); }
    public void Remove(string nativeProfileId) {
      SaveAllowed(Allowed().Where(a => a["nativeProfileId"].Text != nativeProfileId));
      lock (gate) if (link != null && Allowed().All(a => a["profileId"].Text != link.ProfileId)) link = null;
      Raise();
    }
    /// Ends the attached tab's session; the extension stops on its next poll.
    public void Disconnect() { lock (gate) { Fail(link?.Sent, "disconnected"); Fail(link?.Queued, "disconnected"); link = null; } Raise(); }
    void Raise() { var u = ui; if (u != null) u.BeginInvoke(new Action(() => Changed?.Invoke())); }

    // ------------------------------------------------- pipe from the host
    public void Start(AppModel model, Dispatcher dispatcher) {
      if (started) return; started = true; ui = dispatcher;
      new Thread(Accept) { IsBackground = true, Name = "josi browser" }.Start();
      dispatcher.BeginInvoke(new Action(() => Execute(model)));
    }
    void Accept() {
      while (true) {
        NamedPipeServerStream pipe;
        try { pipe = new NamedPipeServerStream(BrowserHost.PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly); }
        catch (IOException) { Thread.Sleep(1000); continue; }
        catch (UnauthorizedAccessException) { return; }
        try { pipe.WaitForConnection(); }
        catch (IOException) { pipe.Dispose(); continue; }
        new Thread(() => Serve(pipe)) { IsBackground = true, Name = "josi browser host" }.Start();
      }
    }
    void Serve(NamedPipeServerStream pipe) {
      var owner = new object();
      try {
        var peer = Wires.Parse(Encoding.UTF8.GetString(Frames.Read(pipe, 4096) ?? new byte[0]));
        if (peer["kind"].Text != "peer" || peer["application"].Text.Length == 0) return;
        while (true) {
          var request = Frames.Read(pipe, BrowserHost.MaxFrame); if (request == null) return;
          var reply = Handle(owner, peer, Wires.Parse(Encoding.UTF8.GetString(request)));
          Frames.Write(pipe, Encoding.UTF8.GetBytes(Wires.Serialize(reply)));
        }
      } catch (Exception e) when (e is IOException || e is FormatException || e is InvalidOperationException || e is ArgumentException) { }
      finally {
        pipe.Dispose();
        bool ended = false;
        lock (gate) if (link != null && link.Owner == owner) { Fail(link.Sent, "connection_lost"); Fail(link.Queued, "connection_lost"); link = null; ended = true; }
        if (ended) Raise();
      }
    }

    static Dictionary<string, object> Reply(string requestId, bool ok, object payload) {
      return Wires.O("version", 1, "requestId", requestId, "ok", ok, "payload", payload ?? Wires.O());
    }
    static string OriginOf(string url) {
      Uri uri;
      return Uri.TryCreate(url ?? "", UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http") && uri.UserInfo.Length == 0
        ? uri.GetLeftPart(UriPartial.Authority) : null;
    }
    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    Dictionary<string, object> Session() {
      return Wires.O("sessionId", link.SessionId, "workspaceId", workspaceId, "profileId", link.ProfileId, "family", link.Family,
        "expiresAt", Now() + SessionMs, "origins", link.Origins.Cast<object>().ToList(), "currentDesktop", true);
    }

    Dictionary<string, object> Handle(object owner, Wire peer, Wire request) {
      var id = request["requestId"].Text; var payload = request["payload"]; var operation = request["operation"].Text;
      if (request["version"].Integer != 1 || !Wires.IsUuid(id)) throw new FormatException();
      bool changed = false;
      try {
        lock (gate) {
          if (operation == "browser.hello") {
            var family = payload["family"].Text; var nativeProfileId = payload["nativeProfileId"].Text; var url = payload["url"].Text;
            if (family != "chrome" && family != "brave" || payload["extensionId"].Text != BrowserHost.ExtensionId
              || !Wires.IsUuid(nativeProfileId) || !payload["attachedTabId"].IsNumber || OriginOf(url) == null) return Reply(id, false, null);
            var browser = peer["family"].Text == "edge" ? "Edge" : Wires.Capitalize(peer["family"].Text);
            var known = Allowed().FirstOrDefault(a => a["nativeProfileId"].Text == nativeProfileId
              && string.Equals(a["application"].Text, peer["application"].Text, StringComparison.OrdinalIgnoreCase));
            if (known == null) {
              discovered = new Discovery { NativeProfileId = nativeProfileId, Browser = browser, Application = peer["application"].Text, Url = OriginOf(url) };
              changed = true;
              return Reply(id, true, Wires.O("profileDiscovered", true));
            }
            if (link != null) { Fail(link.Sent, "replaced"); Fail(link.Queued, "replaced"); }
            link = new Link { Owner = owner, SessionId = Guid.NewGuid().ToString(), ProfileId = known["profileId"].Text, Family = family,
              Browser = browser, Application = known["application"].Text, Profile = known["profile"].Text.Length > 0 ? known["profile"].Text : "Default",
              Url = url, Title = payload["title"].Text, TabId = payload["attachedTabId"].Integer, LastPoll = DateTime.UtcNow };
            link.Origins.Add(OriginOf(url));
            changed = true;
            return Reply(id, true, Session());
          }
          if (link == null || link.Owner != owner || request["sessionId"].Text != link.SessionId) return Reply(id, false, null);
          if (operation == "browser.poll") {
            link.LastPoll = DateTime.UtcNow;
            var origin = OriginOf(payload["url"].Text);
            if (origin != null && (payload["url"].Text != link.Url || payload["title"].Text != link.Title)) {
              link.Url = payload["url"].Text; link.Title = payload["title"].Text; changed = true;
              if (!link.Origins.Contains(origin) && link.Origins.Count < 128) link.Origins.Add(origin);
            }
            object command = null;
            if (link.Queued != null && link.Sent == null) { link.Sent = link.Queued; link.Queued = null; command = link.Sent.Command; }
            return Reply(id, true, Wires.O("session", Session(), "command", command));
          }
          if (operation == "browser.authorize") {
            var sent = link.Sent; var command = payload["command"]; var actual = payload["actual"];
            var allowed = sent != null && command["id"].Text == sent.CommandId && command["kind"].Text == (string)sent.Command["kind"]
              && command["sessionId"].Text == link.SessionId
              && (actual.IsNull || actual["tabId"].Integer == link.TabId);
            if (!allowed) return Reply(id, false, null);
            var authority = Wires.O("commandId", sent.CommandId, "sessionId", link.SessionId, "allowed", true);
            if (sent.Value != null) authority["value"] = sent.Value;
            return Reply(id, true, authority);
          }
          if (operation == "browser.receipt") {
            var sent = link.Sent;
            if (sent == null || payload["commandId"].Text != sent.CommandId) return Reply(id, false, null);
            link.Sent = null;
            var ok = payload["outcome"].Text == "observed_or_issued";
            var result = payload["result"];
            if (ok && result["kind"].Text == "observation" && OriginOf(result["url"].Text) != null) { link.Url = result["url"].Text; link.Title = result["title"].Text; changed = true; }
            sent.Done.TrySetResult(Tuple.Create(ok, ok ? result.Raw : (object)Wires.O("code", payload["code"].Text.Length > 0 ? payload["code"].Text : "not_verified")));
            return Reply(id, true, null);
          }
          if (operation == "browser.stop") {
            Fail(link.Sent, "local_takeover"); Fail(link.Queued, "local_takeover"); link = null; changed = true;
            return Reply(id, true, null);
          }
          return Reply(id, false, null);
        }
      } finally { if (changed) Raise(); }
    }
    static void Fail(Pending pending, string code) { pending?.Done.TrySetResult(Tuple.Create(false, (object)Wires.O("code", code))); }

    // ------------------------------------------- server: PC Control executor
    /// Every second while you are signed in as the administrator: report the
    /// attached tab, tell you about requests waiting for your approval, and
    /// run approved work. Nothing runs without an attached tab.
    async void Execute(AppModel model) {
      string lastPresence = null; var presenceAt = DateTime.MinValue; var checkedAt = DateTime.MinValue;
      var announced = new HashSet<string>();
      while (true) {
        await Task.Delay(1000);
        var api = model.Api;
        if (api == null || model.Screen != Screen.Workspace || !model.IsAdministrator) continue;
        try {
          Dictionary<string, object> presence; bool live;
          lock (gate) {
            live = Live();
            presence = live ? Wires.O("connected", true, "browser", Wires.O("family", link.Browser.ToLowerInvariant(), "application", link.Application,
              "profile", link.Profile, "origin", OriginOf(link.Url), "title", link.Title)) : Wires.O("connected", false);
          }
          var json = Wires.Serialize(presence);
          if (json != lastPresence || live && (DateTime.UtcNow - presenceAt).TotalSeconds >= 10) {
            await api.Request("/admin/pc-control/executor/presence", "PUT", presence);
            lastPresence = json; presenceAt = DateTime.UtcNow;
          }
          if (!live) continue;
          if ((DateTime.UtcNow - checkedAt).TotalSeconds >= 4) {
            checkedAt = DateTime.UtcNow;
            foreach (var q in (await api.Request("/admin/pc-control"))["requests"].List)
              if (announced.Add(q.Id) && !model.Active) Notifications.Show("Josi is asking to use your browser", q["description"].Text + ". Approve it in Josi under PC Control.");
          }
          var next = (await api.Request("/admin/pc-control/executor/next", "POST", Wires.O()))["request"];
          if (next.IsNull) continue;
          var outcome = await Dispatch(next);
          await api.Request("/admin/pc-control/executor/" + api.Uuid(next.Id) + "/result", "POST", Wires.O("ok", outcome.Item1, "result", outcome.Item2));
        } catch (JosiException) { }
        catch (Exception e) when (e is IOException || e is TaskCanceledException || e is System.Net.Http.HttpRequestException) { }
      }
    }

    async Task<Tuple<bool, object>> Dispatch(Wire request) {
      var payload = request["payload"]; var scope = request["requirements"].List.Select(r => r["scope"]).FirstOrDefault() ?? Wire.Null;
      Pending pending;
      lock (gate) {
        Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
        if (!Live()) return refuse("no_attached_tab");
        if (!string.Equals(scope["application"].Text, link.Application, StringComparison.OrdinalIgnoreCase) || scope["profile"].Text != link.Profile)
          return refuse("browser_changed");
        var target = scope["target"].Text; var kind = payload["kind"].Text;
        pending = new Pending { CommandId = Guid.NewGuid().ToString() };
        var command = Wires.O("id", pending.CommandId, "sessionId", link.SessionId, "profileId", link.ProfileId, "expiresAt", Now() + CommandMs);
        if (kind == "open") {
          if (OriginOf(payload["url"].Text) != target || !payload["url"].Text.StartsWith("https://", StringComparison.Ordinal)) return refuse("invalid_page");
          if (!link.Origins.Contains(target)) link.Origins.Add(target);
          command["kind"] = "openPage"; command["url"] = payload["url"].Text; command["origin"] = target; command["maxOutputBytes"] = ObservationBytes;
        } else {
          // The approved site must still be the one in the attached tab.
          if (OriginOf(link.Url) != target) return refuse("attached_site_changed");
          if (kind == "read") { command["kind"] = "inspect"; command["origin"] = target; command["maxOutputBytes"] = ObservationBytes; }
          else if (kind == "click" || kind == "fill") {
            command["kind"] = kind; command["tabId"] = link.TabId;
            command["observationId"] = payload["observationId"].Text; command["elementId"] = payload["elementId"].Text;
            if (kind == "fill") pending.Value = payload["text"].Text;
          } else return refuse("unsupported_operation");
        }
        pending.Command = command;
        Fail(link.Queued, "replaced"); link.Queued = pending;
      }
      var finished = await Task.WhenAny(pending.Done.Task, Task.Delay(CommandMs + 10000));
      if (finished != pending.Done.Task) {
        lock (gate) if (link != null) { if (link.Queued == pending) link.Queued = null; if (link.Sent == pending) link.Sent = null; }
        return Tuple.Create(false, (object)Wires.O("code", "browser_not_responding"));
      }
      return pending.Done.Task.Result;
    }
  }
}
