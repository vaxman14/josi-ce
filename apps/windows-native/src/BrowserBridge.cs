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

    const int UploadBytes = 8 * 1024 * 1024, ChunkBytes = 120 * 1024, PresenceTabs = 30;

    sealed class Pending {
      public string CommandId, Activity; public Dictionary<string, object> Command; public string Value; public bool Shown;
      /// An approved upload: the file is read here once and handed to the
      /// extension in chunks; it never passes through the server or the model.
      public byte[] File; public string FileName, MediaType;
      public readonly TaskCompletionSource<Tuple<bool, object>> Done = new TaskCompletionSource<Tuple<bool, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    sealed class Tab { public long Id; public string Origin, Title; public bool Active; }
    /// A browser linked to this Josi. TabId is -1 while no tab is attached: the
    /// browser is still linked, so chat can name its tabs and attach one.
    sealed class Link {
      public object Owner; public string SessionId, ProfileId, Family, Browser, Application, Profile, Url, Title;
      public long TabId = -1; public readonly List<string> Origins = new List<string>(); public DateTime LastPoll;
      public Tab Active; public List<Tab> Tabs = new List<Tab>();
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
    /// A browser is linked (with or without an attached tab).
    public bool Linked { get { lock (gate) return Live(); } }
    public bool Attached { get { lock (gate) return Live() && link.TabId >= 0; } }
    public string AttachedBrowser { get { lock (gate) return Live() ? link.Browser : ""; } }
    public string AttachedApplication { get { lock (gate) return Live() ? link.Application : ""; } }
    public string AttachedProfile { get { lock (gate) return Live() ? link.Profile : ""; } }
    public string AttachedOrigin { get { lock (gate) return Live() && link.TabId >= 0 ? OriginOf(link.Url) ?? "" : ""; } }
    public string AttachedTitle { get { lock (gate) return Live() && link.TabId >= 0 ? link.Title ?? "" : ""; } }
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
            // Item 37: every family the build produces, each with the ID the app knows for it.
            var knownExtension = family == "firefox" ? payload["extensionId"].Text == BrowserHost.FirefoxExtensionId
              : (family == "chrome" || family == "brave" || family == "edge") && BrowserHost.ChromiumExtensionIds.Contains(payload["extensionId"].Text);
            // Step H: a standing link carries no tab (attachedTabId null) and no address.
            var withTab = payload["attachedTabId"].IsNumber;
            if (!knownExtension || !Wires.IsUuid(nativeProfileId) || !(withTab || payload["attachedTabId"].IsNull)
              || (withTab && (payload["attachedTabId"].Integer < 0 || OriginOf(url) == null))) return Reply(id, false, null);
            var browser = peer["family"].Text == "edge" ? "Edge" : Wires.Capitalize(peer["family"].Text);
            var known = Allowed().FirstOrDefault(a => a["nativeProfileId"].Text == nativeProfileId
              && string.Equals(a["application"].Text, peer["application"].Text, StringComparison.OrdinalIgnoreCase));
            if (known == null) {
              if (discovered == null || discovered.NativeProfileId != nativeProfileId) changed = true;
              discovered = new Discovery { NativeProfileId = nativeProfileId, Browser = browser, Application = peer["application"].Text, Url = OriginOf(url) };
              return Reply(id, true, Wires.O("profileDiscovered", true));
            }
            // One browser is linked at a time. A standing link (no tab) from a
            // different browser, or its remembered tab, waits while another is live,
            // so several allowed browsers do not knock each other off; only a tab
            // the person attaches with a click takes over.
            if (!payload["explicit"].Flag && Live() && link.ProfileId != known["profileId"].Text) return Reply(id, true, Wires.O("standby", true, "family", link.Family));
            if (link != null) { Fail(link.Sent, "replaced"); Fail(link.Queued, "replaced"); }
            link = new Link { Owner = owner, SessionId = Guid.NewGuid().ToString(), ProfileId = known["profileId"].Text, Family = family,
              Browser = browser, Application = known["application"].Text, Profile = known["profile"].Text.Length > 0 ? known["profile"].Text : "Default",
              Url = withTab ? url : null, Title = withTab ? payload["title"].Text : null, TabId = withTab ? payload["attachedTabId"].Integer : -1, LastPoll = DateTime.UtcNow };
            if (withTab) link.Origins.Add(OriginOf(url));
            changed = true;
            return Reply(id, true, Session());
          }
          if (operation == "browser.chunk") {
            // Pieces of an approved upload's file, only for the command in flight.
            if (link == null || link.Owner != owner || request["sessionId"].Text != link.SessionId) return Reply(id, false, null);
            var sent = link.Sent;
            if (sent?.File == null || payload["commandId"].Text != sent.CommandId || !payload["index"].IsNumber) return Reply(id, false, null);
            var index = payload["index"].Integer; var count = (sent.File.Length + ChunkBytes - 1) / ChunkBytes;
            if (index < 0 || index >= count) return Reply(id, false, null);
            var start = (int)index * ChunkBytes; var length = Math.Min(ChunkBytes, sent.File.Length - start);
            return Reply(id, true, Wires.O("index", index, "base64", Convert.ToBase64String(sent.File, start, length), "last", index == count - 1));
          }
          if (link == null || link.Owner != owner || request["sessionId"].Text != link.SessionId) return Reply(id, false, null);
          if (operation == "browser.poll") {
            link.LastPoll = DateTime.UtcNow;
            if (link.TabId >= 0) {
              // The extension reports the attached tab; a tab it no longer has detaches.
              if (payload["tabId"].IsNull) { link.TabId = -1; link.Url = link.Title = null; changed = true; }
              else {
                var origin = OriginOf(payload["url"].Text);
                if (origin != null && (payload["url"].Text != link.Url || payload["title"].Text != link.Title)) {
                  link.Url = payload["url"].Text; link.Title = payload["title"].Text; changed = true;
                  if (!link.Origins.Contains(origin) && link.Origins.Count < 128) link.Origins.Add(origin);
                }
              }
            }
            var active = TabFrom(payload["active"], true);
            var tabs = payload["tabs"].List.Select(t => TabFrom(t, t["active"].Flag)).Where(t => t != null).Take(PresenceTabs).ToList();
            if (Describe(active) != Describe(link.Active) || string.Join("|", tabs.Select(Describe)) != string.Join("|", link.Tabs.Select(Describe))) changed = true;
            link.Active = active; link.Tabs = tabs;
            object command = null;
            if (!DesktopExecutor.Current.Blocked && link.Queued != null && link.Sent == null) {
              link.Sent = link.Queued; link.Queued = null; command = link.Sent.Command;
              link.Sent.Shown = true; DesktopExecutor.Current.BeginExternal(link.Sent.Activity);
            }
            return Reply(id, true, Wires.O("session", Session(), "command", command, "paused", DesktopExecutor.Current.Blocked));
          }
          if (operation == "browser.authorize") {
            var sent = link.Sent; var command = payload["command"]; var actual = payload["actual"];
            // An attach names its tab in the command; everything else runs in the attached tab.
            var expectedTab = sent != null && sent.Command.ContainsKey("tabId") ? Convert.ToInt64(sent.Command["tabId"]) : link.TabId;
            var allowed = !DesktopExecutor.Current.Blocked && sent != null && command["id"].Text == sent.CommandId && command["kind"].Text == (string)sent.Command["kind"]
              && command["sessionId"].Text == link.SessionId
              && (actual.IsNull || actual["tabId"].Integer == expectedTab);
            if (!allowed) return Reply(id, false, null);
            var authority = Wires.O("commandId", sent.CommandId, "sessionId", link.SessionId, "allowed", true);
            if (sent.Value != null) authority["value"] = sent.Value;
            if (sent.File != null) authority["file"] = Wires.O("name", sent.FileName, "mediaType", sent.MediaType, "size", (long)sent.File.Length,
              "chunks", (long)((sent.File.Length + ChunkBytes - 1) / ChunkBytes));
            return Reply(id, true, authority);
          }
          if (operation == "browser.receipt") {
            var sent = link.Sent;
            if (sent == null || payload["commandId"].Text != sent.CommandId) return Reply(id, false, null);
            link.Sent = null; Hide(sent);
            var ok = payload["outcome"].Text == "observed_or_issued";
            var result = payload["result"];
            if (ok && (string)sent.Command["kind"] == "attach") {
              // The tab the person approved is now the attached one.
              var origin = OriginOf(result["url"].Text);
              if (result["tabId"].Integer != Convert.ToInt64(sent.Command["tabId"]) || origin == null || origin != (string)sent.Command["origin"]) ok = false;
              else { link.TabId = result["tabId"].Integer; link.Url = result["url"].Text; link.Title = result["title"].Text; if (!link.Origins.Contains(origin)) link.Origins.Add(origin); changed = true; }
            }
            if (ok && (string)sent.Command["kind"] == "openTab") {
              var origin = OriginOf(result["url"].Text);
              if (!result["tabId"].IsNumber || result["tabId"].Integer < 0 || origin != (string)sent.Command["origin"]) ok = false;
              else { link.TabId = result["tabId"].Integer; changed = true; }
            }
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
    static void Fail(Pending pending, string code) {
      if (pending == null) return;
      // A command that was in the extension's hands also ends its ghost-bar activity.
      Hide(pending); pending.Done.TrySetResult(Tuple.Create(false, (object)Wires.O("code", code)));
    }
    static void Hide(Pending pending) {
      if (pending == null) return;
      lock (pending) { if (!pending.Shown) return; pending.Shown = false; }
      DesktopExecutor.Current.EndExternal();
    }
    static Tab TabFrom(Wire value, bool active) {
      if (value.IsNull || !value["tabId"].IsNumber || value["tabId"].Integer < 0) return null;
      var origin = OriginOf(value["url"].Text); if (origin == null) return null;
      var title = value["title"].Text; if (title.Length > 300) title = title.Substring(0, 300);
      return new Tab { Id = value["tabId"].Integer, Origin = origin, Title = title, Active = active };
    }
    static string Describe(Tab t) { return t == null ? "" : t.Id + " " + t.Origin + " " + t.Title + " " + t.Active; }
    Tab FindTab(long tabId) {
      if (link.Active != null && link.Active.Id == tabId) return link.Active;
      return link.Tabs.FirstOrDefault(t => t.Id == tabId);
    }

    // ------------------------------------------- server: PC Control executor
    /// Every second while you are signed in as the administrator: report the
    /// attached tab (or that Josi is open on this desktop), tell you about
    /// requests waiting for your approval, and run approved work: browser
    /// work goes to the extension, desktop work to the desktop executor.
    async void Execute(AppModel model) {
      string lastPresence = null; var presenceAt = DateTime.MinValue; var checkedAt = DateTime.MinValue;
      var announced = new HashSet<string>(); string registeredFor = null; var approvalAsked = false;
      while (true) {
        await Task.Delay(1000);
        var api = model.Api;
        if (api == null || model.Screen != Screen.Workspace || !model.IsAdministrator) continue;
        try {
          if (DesktopExecutor.Current.PendingStop) {
            await api.Request("/admin/pc-control/stop", "POST", Wires.O());
            DesktopExecutor.Current.StopAcknowledged();
          }
          api.BindPc(model.User["id"].Text);
          // Known to the account before pairing or enabling, so chat can list this
          // PC and offer to turn control on for it.
          var registration = api.OriginText + "|" + model.User["id"].Text;
          if (registeredFor != registration) {
            // An older server has no register route; pairing and presence still work without it.
            try { await api.Request("/admin/pc-control/register", "PUT", Wires.O()); } catch (JosiException) { }
            registeredFor = registration;
          }
          if (!await api.PcAuthority.Ensure(api)) {
            // Approval happens where the person is: a card in the chat and PC
            // Control, never as a surprise sheet from here.
            if (api.PcAuthority.NeedsApproval && (await api.Request("/admin/pc-control/identity"))["enabled"].Flag) {
              PcInbox.Set(new List<Wire>(), true);
              if (!approvalAsked) { approvalAsked = true; Raise(); if (!model.Active) Notifications.Show("Approve this PC for Josi", "PC control is on, but this PC has not been approved yet. Approve it from the card in Josi's chat."); }
            }
            continue;
          }
          PcInbox.Set(PcInbox.Requests, false);
          // Paused here means paused for the server too: no presence, so a PC
          // tool answers "Josi is not open or is paused" at once instead of
          // leaving approved work waiting until the model gives up.
          if (DesktopExecutor.Current.Paused) { lastPresence = null; continue; }
          Dictionary<string, object> presence; bool live;
          lock (gate) {
            live = Live();
            if (live) {
              var attachedTab = link.TabId >= 0;
              var browser = Wires.O("family", link.Browser.ToLowerInvariant(), "application", link.Application, "profile", link.Profile,
                "origin", attachedTab ? OriginOf(link.Url) : null, "title", attachedTab ? link.Title : null,
                // Sites and titles only, so chat can name a tab and attach it; never paths or page content.
                "tabs", link.Tabs.Select(t => (object)Wires.O("tabId", t.Id, "origin", t.Origin, "title", t.Title, "active", t.Active)).ToList());
              if (link.Active != null) { browser["activeTabId"] = link.Active.Id; browser["activeOrigin"] = link.Active.Origin; browser["activeTitle"] = link.Active.Title; }
              presence = Wires.O("connected", true, "browser", browser);
            }
            // No browser linked: Josi is still open on this desktop, so desktop work can run.
            else presence = Wires.O("connected", true, "browser", Wires.O("family", "desktop", "application", Environment.ProcessPath ?? "", "profile", "Default", "origin", null, "title", null));
          }
          var json = Wires.Serialize(presence);
          if (json != lastPresence || (DateTime.UtcNow - presenceAt).TotalSeconds >= 10) {
            await api.Request("/admin/pc-control/executor/presence", "PUT", presence);
            lastPresence = json; presenceAt = DateTime.UtcNow;
          }
          if ((DateTime.UtcNow - checkedAt).TotalSeconds >= 4) {
            checkedAt = DateTime.UtcNow;
            var waiting = (await api.Request("/admin/pc-control"))["requests"].List;
            PcInbox.Set(waiting, false);
            foreach (var q in waiting)
              if (announced.Add(q.Id) && !model.Active) Notifications.Show("Josi is asking for permission", q["description"].Text + ". Allow or deny it from the card in Josi's chat.");
          }
          // Paused, or you took over: approved work waits rather than runs.
          if (DesktopExecutor.Current.Paused) continue;
          var next = (await api.Request("/admin/pc-control/executor/next", "POST", Wires.O()))["request"];
          if (next.IsNull) continue;
          var outcome = await ExecuteWithLease(model, api, next);
          if (outcome.Item1 && next["payload"]["kind"].Text == "desktop.terminal.open")
            _ = PcTerminals.Watch(next.Id,
              async token => (await api.Request("/admin/pc-control/executor/terminals/" + api.Uuid(next.Id) + "/lease", "GET", null, null, token))["authorized"].Flag,
              () => model.Api == api && model.Screen == Screen.Workspace && model.IsAdministrator && !DesktopExecutor.Current.Paused);
          await api.Request("/admin/pc-control/executor/" + api.Uuid(next.Id) + "/result", "POST", Wires.O("ok", outcome.Item1, "result", outcome.Item2));
        } catch (JosiException) { }
        catch (Exception e) when (e is IOException || e is TaskCanceledException || e is System.Net.Http.HttpRequestException) { }
      }
    }

    Task<Tuple<bool, object>> ExecuteWithLease(AppModel model, JosiApi api, Wire request) {
      var desktop = request["payload"]["kind"].Text.StartsWith("desktop.", StringComparison.Ordinal);
      var route = "/admin/pc-control/executor/" + api.Uuid(request.Id) + "/lease";
      return PcExecutionLease.Run(async cancellation => (await api.Request(route, "GET", null, null, cancellation))["authorized"].Flag,
        () => model.Api == api && model.Screen == Screen.Workspace && model.IsAdministrator && !DesktopExecutor.Current.Paused,
        () => desktop ? DesktopExecutor.Current.Run(request) : Dispatch(request), () => {
        DesktopExecutor.Current.Pause();
        lock (gate) { if (link != null) { Fail(link.Queued, "control_stopped"); Fail(link.Sent, "control_stopped"); link.Queued = link.Sent = null; } }
      });
    }

    async Task<Tuple<bool, object>> Dispatch(Wire request) {
      var payload = request["payload"]; var scope = request["requirements"].List.Select(r => r["scope"]).FirstOrDefault() ?? Wire.Null;
      Pending pending;
      lock (gate) {
        Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
        if (!Live()) return refuse("browser_not_linked");
        if (!string.Equals(scope["application"].Text, link.Application, StringComparison.OrdinalIgnoreCase) || scope["profile"].Text != link.Profile)
          return refuse("browser_changed");
        var target = scope["target"].Text; var kind = payload["kind"].Text;
        if (OriginOf(target) != target) return refuse("invalid_site");
        var site = new Uri(target).Host;
        pending = new Pending { CommandId = Guid.NewGuid().ToString() };
        var command = Wires.O("id", pending.CommandId, "sessionId", link.SessionId, "profileId", link.ProfileId, "expiresAt", Now() + CommandMs);
        if (kind == "attach") {
          // The tab must still be open on the approved site.
          var tab = payload["tabId"].IsNumber ? FindTab(payload["tabId"].Integer) : null;
          if (tab == null) return refuse("tab_not_found");
          if (tab.Origin != target) return refuse("attached_site_changed");
          if (!link.Origins.Contains(target)) link.Origins.Add(target);
          command["kind"] = "attach"; command["tabId"] = tab.Id; command["origin"] = target;
          pending.Activity = "Attaching a tab on " + site;
        } else if (kind == "open") {
          if (OriginOf(payload["url"].Text) != target || !payload["url"].Text.StartsWith("https://", StringComparison.Ordinal)) return refuse("invalid_page");
          if (!link.Origins.Contains(target)) link.Origins.Add(target);
          // No tab attached: the page opens in a new tab, which becomes the attached one.
          command["kind"] = link.TabId < 0 ? "openTab" : "openPage"; command["url"] = payload["url"].Text; command["origin"] = target; command["maxOutputBytes"] = ObservationBytes;
          pending.Activity = "Opening " + site;
        } else if (link.TabId < 0) return refuse("no_attached_tab");
        else {
          // The approved site must still be the one in the attached tab.
          if (OriginOf(link.Url) != target) return refuse("attached_site_changed");
          command["tabId"] = link.TabId;
          if (kind == "read") { command["kind"] = "inspect"; command["origin"] = target; command["maxOutputBytes"] = ObservationBytes; command.Remove("tabId"); pending.Activity = "Reading " + site; }
          else if (kind == "download") {
            var url = payload["url"].Text;
            if (OriginOf(url) != target || !url.StartsWith("https://", StringComparison.Ordinal)) return refuse("invalid_download");
            command["kind"] = "download"; command["url"] = url; pending.Activity = "Downloading from " + site;
          } else if (new[] { "click", "fill", "photo", "select", "drag", "scroll", "upload" }.Contains(kind)) {
            command["kind"] = kind;
            command["observationId"] = payload["observationId"].Text; command["elementId"] = payload["elementId"].Text;
            if (kind == "fill") pending.Value = payload["text"].Text;
            if (kind == "select") pending.Value = payload["option"].Text;
            if (kind == "drag") { if (!Wires.IsUuid(payload["toElementId"].Text)) return refuse("invalid_target"); command["toElementId"] = payload["toElementId"].Text; }
            if (kind == "scroll") { command["deltaY"] = payload["direction"].Text == "up" ? -1 : 1; command["maxOutputBytes"] = ObservationBytes; }
            // A photo comes back with a fresh read of the page; leave room for
            // both (a 72 KB JPEG plus the trimmed read) under the host frame size.
            if (kind == "photo") command["maxOutputBytes"] = 163840;
            if (kind == "upload") {
              var problem = LoadUpload(pending, payload["path"].Text, request["requirements"].List);
              if (problem != null) return refuse(problem);
            }
            pending.Activity = (kind == "click" ? "Clicking on " : kind == "fill" ? "Typing on " : kind == "photo" ? "Looking at a picture on "
              : kind == "select" ? "Choosing an option on " : kind == "drag" ? "Dragging on " : kind == "scroll" ? "Scrolling " : "Uploading a file to ") + site;
          } else return refuse("unsupported_operation");
        }
        pending.Command = command;
        Fail(link.Queued, "replaced"); link.Queued = pending;
      }
      // An upload streams its file in chunks; give it longer than a click.
      var finished = await Task.WhenAny(pending.Done.Task, Task.Delay(CommandMs + (pending.File != null ? 40000 : 10000)));
      if (finished != pending.Done.Task) {
        lock (gate) if (link != null) { if (link.Queued == pending) link.Queued = null; if (link.Sent == pending) link.Sent = null; }
        Hide(pending);
        return Tuple.Create(false, (object)Wires.O("code", "browser_not_responding"));
      }
      return pending.Done.Task.Result;
    }

    /// The file for an approved upload, read once from the folder the owner
    /// approved for reading. Returns a refusal code, or null when it is ready.
    static string LoadUpload(Pending pending, string path, List<Wire> requirements) {
      string full;
      try { full = Path.GetFullPath(path); } catch (Exception e) when (e is ArgumentException || e is NotSupportedException || e is PathTooLongException) { return "invalid_path"; }
      if (!string.Equals(full, path, StringComparison.OrdinalIgnoreCase)) return "invalid_path";
      var folder = Path.GetDirectoryName(full);
      if (!requirements.Any(r => r["action"].Text == "folder.read" && string.Equals(r["scope"]["target"].Text.TrimEnd('\\'), (folder ?? "").TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)))
        return "folder_not_approved";
      try {
        var info = new FileInfo(full);
        if (!info.Exists || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint | FileAttributes.Device)) != 0) return "file_not_found";
        if (info.Length == 0 || info.Length > UploadBytes) return "file_too_large";
        pending.File = File.ReadAllBytes(full);
      } catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { return "file_unreadable"; }
      pending.FileName = Path.GetFileName(full);
      var ext = Path.GetExtension(full).ToLowerInvariant();
      pending.MediaType = ext == ".jpg" || ext == ".jpeg" ? "image/jpeg" : ext == ".png" ? "image/png" : ext == ".gif" ? "image/gif" : ext == ".webp" ? "image/webp"
        : ext == ".heic" ? "image/heic" : ext == ".pdf" ? "application/pdf" : ext == ".txt" ? "text/plain" : ext == ".csv" ? "text/csv"
        : ext == ".mp4" ? "video/mp4" : ext == ".mov" ? "video/quicktime" : "application/octet-stream";
      return null;
    }
  }
}
