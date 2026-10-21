using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Zapier, n8n and Make workflows an administrator exposed. Every run is
  /// prepared first and waits for you to review its exact input and approve.
  public sealed class WorkflowsView : SectionView {
    List<Wire> flows = new List<Wire>(), runs = new List<Wire>();
    readonly Dictionary<string, TextBox> inputs = new Dictionary<string, TextBox>();
    readonly Dictionary<string, string> previews = new Dictionary<string, string>();
    public WorkflowsView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var a = await api.Request("/workflows"); var b = await api.Request("/workflows/history");
      if (Current(stamp)) { flows = a["workflows"].List; runs = b["runs"].List; }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Workflows", "Zapier, n8n and Make workflows made available by an administrator. Every run waits for your approval.", Ui.Pill("Refresh", StartLoad)));
      if (flows.Count == 0) Ui.Add(page, Ui.Secondary("No workflows are available to you yet."), 0);
      foreach (var f in flows) {
        var key = f["integration_id"].Text + ":" + f["external_id"].Text;
        TextBox box; if (!inputs.TryGetValue(key, out box)) inputs[key] = box = Ui.Input("Input (JSON)", "{}", true);
        Ui.Detach(box);
        var integration = f["integration_id"].Text; var external = f["external_id"].Text;
        Ui.Add(page, Ui.CardBox(f["name"].Text, Ui.Caption(Wires.Capitalize(f["provider"].Text) + " · " + f["integration_name"].Text),
          f["description"].Text.Length > 0 ? Ui.Secondary(f["description"].Text) : null, Ui.Field("Input (JSON)", box),
          Ui.Pill("Prepare for Approval", () => {
            object input;
            try { input = box.Text.Trim().Length == 0 ? Wires.O() : Wires.Parse(box.Text).Raw; } catch (Exception) { model.Error = "The input is not valid JSON."; model.Notify(); return; }
            Perform(async (api, stamp) => await api.Request("/workflows/" + api.Uuid(integration) + "/" + Uri.EscapeDataString(external) + "/request", "POST", Wires.O("input", input)));
          }, true)), 0);
      }
      Ui.Add(page, Ui.Headline("Run history and approvals"), 0);
      if (runs.Count == 0) Ui.Add(page, Ui.Caption("No runs yet."), 0);
      foreach (var r in runs) {
        var id = r.Id;
        var items = new List<UIElement> { Ui.Spread(Ui.T(r["external_workflow_id"].Text, 14, FontWeights.Medium), ModelText.Pill(Wires.Words(r["status"].Text), r["status"].Text == "succeeded" || r["status"].Text == "completed")),
          Ui.Caption(Wires.Date(r["created_at"].Text)) };
        if (r["result_summary"].Text.Length > 0) items.Add(Ui.Secondary(r["result_summary"].Text));
        if (r["status"].Text == "pending") {
          string preview;
          if (previews.TryGetValue(id, out preview)) items.Add(Ui.Copyable(preview, 13, null, true));
          items.Add(Ui.Wrap(Ui.Pill(previews.ContainsKey(id) ? "Approve Exact Run" : "Review Exact Input", () => {
              if (!previews.ContainsKey(id)) Perform(async (api, stamp) => { var v = await api.Request("/workflows/runs/" + api.Uuid(id) + "/preview"); previews[id] = v.Json; }, false);
              else Perform(async (api, stamp) => await api.Request("/workflows/runs/" + api.Uuid(id) + "/decide", "POST", Wires.O("approve", true)));
            }, true),
            Ui.Pill("Deny", () => Perform(async (api, stamp) => await api.Request("/workflows/runs/" + api.Uuid(id) + "/decide", "POST", Wires.O("approve", false))))));
        }
        Ui.Add(page, Ui.CardBox(null, items.ToArray()), 0);
      }
      Ui.Add(page, Note(), 0);
      return page;
    }
  }

  /// Administrator: workflow providers. Zapier uses its MCP connection token,
  /// Make its API token and workspace, n8n its public API plus a registered
  /// production webhook per callable workflow.
  public sealed class WorkflowAdminView : SectionView {
    List<Wire> integrations = new List<Wire>(), workflows = new List<Wire>();
    string provider = "zapier", callbackSecret = "", workspaceType = "team";
    readonly TextBox name = Ui.Input("Name"), baseUrl = Ui.Input("URL"), workspaceId = Ui.Input("Workspace ID");
    readonly PasswordBox token = Ui.Secret("Credential");
    readonly CheckBox privateNetwork = Ui.Toggle("Allow this self-hosted n8n server on the private network");
    readonly Dictionary<string, TextBox> paths = new Dictionary<string, TextBox>(), schemas = new Dictionary<string, TextBox>();
    public WorkflowAdminView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() { token.Clear(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp; var r = await api.Request("/admin/workflows");
      if (Current(stamp)) { integrations = r["integrations"].List; workflows = r["workflows"].List; }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Workflow Providers", "Zapier, n8n and Make. Discovered workflows reach people only after you expose them, and every run still needs that person's approval.", Ui.Pill("Refresh", StartLoad)));
      foreach (var box in new Control[] { name, baseUrl, workspaceId, token, privateNetwork }) Ui.Detach(box);
      var form = new List<UIElement> { Ui.Segments(Ui.Options("zapier", "Zapier", "n8n", "n8n", "make", "Make"), provider, v => { provider = v; name.Text = ""; baseUrl.Text = ""; token.Clear(); callbackSecret = ""; Render(); }),
        Ui.Field("Name", name) };
      if (provider == "n8n") {
        form.Add(Ui.Field("n8n URL", baseUrl)); form.Add(privateNetwork);
        form.Add(Ui.Caption("Only allow the private network for a server you control. Josi will then send workflow data to that LAN address."));
      }
      if (provider == "make") {
        form.Add(Ui.Field("Make region URL (for example https://us1.make.com)", baseUrl));
        form.Add(Ui.Segments(Ui.Options("team", "Team", "organization", "Organization"), workspaceType, v => { workspaceType = v; Render(); }));
        form.Add(Ui.Field("Workspace ID", workspaceId));
      }
      form.Add(Ui.Field(provider == "zapier" ? "MCP connection token" : "API credential", token));
      form.Add(Ui.Pill("Test and Save Provider", Save, true));
      if (callbackSecret.Length > 0) { form.Add(Ui.Caption("Callback signing secret (shown once):")); form.Add(Ui.Copyable(callbackSecret, 13, null, true)); }
      Ui.Add(page, Ui.CardBox("Add or reconnect a provider", form.ToArray()), 0);
      foreach (var i in integrations) {
        var id = i.Id;
        var items = new List<UIElement> { Ui.Caption(Wires.Capitalize(i["provider"].Text) + " · " + Wires.Words(i["status"].Text) + (i["account_identity"].Text.Length > 0 ? " · " + i["account_identity"].Text : "") + (i["workspace_identity"].Text.Length > 0 ? " · " + i["workspace_identity"].Text : "")),
          Ui.Wrap(Ui.Pill("Discover Workflows", () => Perform(async (api, stamp) => { await api.Request("/admin/workflows/" + api.Uuid(id) + "/discover", "POST", Wires.O()); note = "Workflows discovered."; })),
            Ui.Pill("Disconnect…", () => { if (Dialogs.Confirm(owner, "Disconnect " + i["name"].Text + "?", "Its workflows stop being available to Josi.", "Disconnect")) Perform(async (api, stamp) => await api.Request("/admin/workflows/" + api.Uuid(id), "DELETE", null)); })) };
        foreach (var w in workflows.Where(w => w["integration_id"].Text == id)) {
          var external = w["external_id"].Text; var key = id + ":" + external; var exposed = w["exposed"].Flag;
          if (i["provider"].Text == "n8n" && w["execution_ref"].Text.Length == 0) {
            TextBox path, schema;
            if (!paths.TryGetValue(key, out path)) paths[key] = path = Ui.Input("/webhook/your-production-path");
            if (!schemas.TryGetValue(key, out schema)) schemas[key] = schema = Ui.Input("Input JSON Schema", "{\"type\":\"object\",\"properties\":{}}");
            Ui.Detach(path); Ui.Detach(schema);
            items.Add(Ui.Stack(4, Ui.T(w["name"].Text, 14, FontWeights.Medium), Ui.Field("Production webhook path", path), Ui.Caption("Copy the production path from an active n8n Webhook node. Test webhook paths are refused."),
              Ui.Field("Input JSON Schema", schema),
              Ui.Pill("Register Webhook", () => {
                var p = path.Text.Trim();
                if (!Regex.IsMatch(p, "^/webhook/[A-Za-z0-9._~/-]+$") || p.Contains("..")) { model.Error = "Use an n8n production path beginning with /webhook/."; model.Notify(); return; }
                object parsed; try { parsed = Wires.Parse(schema.Text).Raw; } catch (Exception) { model.Error = "The input schema is not valid JSON."; model.Notify(); return; }
                Perform(async (api, stamp) => await api.Request("/admin/workflows/" + api.Uuid(id) + "/workflows/" + Uri.EscapeDataString(external) + "/n8n-webhook", "PUT", Wires.O("path", p, "inputSchema", parsed)));
              })));
          } else {
            items.Add(Ui.Spread(Ui.T(w["name"].Text), Ui.Pill(exposed ? "Remove From Josi" : "Expose to Josi", () =>
              Perform(async (api, stamp) => await api.Request("/admin/workflows/" + api.Uuid(id) + "/workflows/" + Uri.EscapeDataString(external) + "/exposure", "PUT", Wires.O("exposed", !exposed))), !exposed)));
          }
        }
        Ui.Add(page, Ui.CardBox(i["name"].Text, items.ToArray()), 0);
      }
      Ui.Add(page, Note(), 0);
      return page;
    }
    void Save() {
      if (name.Text.Trim().Length == 0 || token.Password.Length == 0 || (provider == "make" && workspaceId.Text.Trim().Length == 0)) { model.Error = "Enter a name, the credential" + (provider == "make" ? " and the workspace ID." : "."); model.Notify(); return; }
      var body = Wires.O("provider", provider, "name", name.Text.Trim(), "baseUrl", baseUrl.Text.Trim(), "token", token.Password, "allowPrivateNetwork", privateNetwork.IsChecked == true,
        "workspaceId", workspaceId.Text.Trim(), "workspaceType", workspaceType);
      token.Clear();
      Perform(async (api, stamp) => { var r = await api.Request("/admin/workflows", "POST", body); callbackSecret = r["callbackSecret"].Text; name.Text = ""; note = "Provider verified and saved."; });
    }
  }

  /// Administrator: connect an external REST API and allowlist, one action at
  /// a time, what Josi may ask it. A connection is offered to Josi only after
  /// the API has answered a test; imported actions arrive switched off;
  /// credentials are write-only.
  public sealed class CustomApisView : SectionView {
    List<Wire> connections;
    string editing = "", addingAction = "", importing = "";
    Wire importPreview = Wire.Null; readonly HashSet<string> chosen = new HashSet<string>();
    readonly TextBox cName = Ui.Input("Name"), cSlug = Ui.Input("booking_system"), cUrl = Ui.Input("https://api.example.com/v1", "https://"), cHeader = Ui.Input("X-API-Key", "X-API-Key"),
      cUser = Ui.Input("Username"), cTest = Ui.Input("/health", "/");
    readonly PasswordBox cSecret = Ui.Secret("Token or key"), cPassword = Ui.Secret("Password");
    string cAuth = "bearer";
    readonly TextBox eId = Ui.Input("list_customers"), eSummary = Ui.Input("What it does"), ePath = Ui.Input("/customers/{id}", "/"), eQuery = Ui.Input("search, limit"), spec = Ui.Input("{\"openapi\": \"3.0.0\", \"paths\": { ... }}", "", true);
    readonly CheckBox eBody = Ui.Toggle("This action sends a block of details (a JSON body)");
    string eMethod = "GET";
    public CustomApisView(AppModel model, Window owner) : base(model, owner) { spec.MinHeight = 140; spec.FontFamily = Ui.Mono; }
    protected override void OnLeave() { cSecret.Clear(); cPassword.Clear(); }
    protected override async Task Load() { var api = Api; var stamp = Stamp; var r = await api.Request("/admin/custom-apis"); if (Current(stamp)) connections = r["connections"].List; }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Custom APIs", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Connect an external service Josi does not know about (a booking system, a CRM, something written in-house) and say, one action at a time, exactly what Josi may ask it. Josi never calls anything you have not listed, and never any address other than the one you give."),
        Ui.Caption("Separate from Connections (signing in to Google or Microsoft), Developer services (your own token) and the Model."));
      if (connections == null) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Custom APIs have not loaded."), 0); return page; }
      if (connections.Count == 0 && editing != "new") Ui.Add(page, Ui.CardBox("Nothing connected", Ui.Caption("Josi cannot reach any outside service through this page until you add one, test it, and switch on the actions you want.")), 0);
      if (editing == "new") Ui.Add(page, ConnectionForm(Wire.Null), 0);
      else Ui.Add(page, Ui.Pill(connections.Count == 0 ? "Connect an API" : "Connect Another API", () => { ResetForm(Wire.Null); editing = "new"; Render(); }, connections.Count == 0), 0);
      foreach (var c in connections) Ui.Add(page, Card(c), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    UIElement Card(Wire c) {
      var id = c.Id; var tested = c["lastCheckOk"].IsBool && c["lastCheckOk"].Flag; var enabled = c["enabled"].Flag;
      var auth = c["authKind"].Text == "basic" ? "Username and password" : c["authKind"].Text == "bearer" ? "Bearer token" : "API key in the " + c["authHeader"].Text + " header";
      var items = new List<UIElement> {
        Ui.Row(8, ModelText.Pill(Wires.Words(c["connectionStatus"].Text), c["connectionStatus"].Text == "active"), ModelText.Pill(enabled ? "Available to Josi" : "Not available to Josi", enabled)),
        Ui.Caption("Address: " + c["baseUrl"].Text), Ui.Caption("Josi will only ever call: " + c["host"].Text), Ui.Caption("Short name the assistant uses: " + c["slug"].Text),
        Ui.Caption("Authentication: " + auth + " · Credential: " + c["credentialMask"].Text), Ui.Caption("Last tested: " + (c["lastCheckAt"].Text.Length > 0 ? Wires.Date(c["lastCheckAt"].Text) : "not yet")) };
      if (c["lastErrorCategory"].Text.Length > 0) items.Add(Ui.T(Wires.Words(c["lastErrorCategory"].Text), 13.5, null, Ui.Orange));
      var toggle = Ui.Pill(enabled ? "Make Unavailable to Josi" : "Make Available to Josi", () => Perform(async (api, stamp) => {
        await api.Request("/admin/custom-apis/" + api.Uuid(id) + "/" + (enabled ? "disable" : "enable"), "POST", Wires.O());
        note = enabled ? "Josi can no longer use this API." : "Josi may now use the actions you have switched on.";
      }), !enabled);
      toggle.IsEnabled = enabled || tested;
      items.Add(Ui.Wrap(Ui.Pill("Test Connection", () => Perform(async (api, stamp) => { await api.Request("/admin/custom-apis/" + api.Uuid(id) + "/test", "POST", Wires.O()); note = c["name"].Text + " answered."; })), toggle,
        Ui.Pill(editing == id ? "Cancel Edit" : "Edit", () => { if (editing == id) editing = ""; else { ResetForm(c); editing = id; } Render(); }),
        Ui.Danger("Remove…", () => { if (Dialogs.Confirm(owner, "Remove " + c["name"].Text + "?", "The connection and all its actions are removed.", "Remove")) Perform(async (api, stamp) => { await api.Request("/admin/custom-apis/" + api.Uuid(id), "DELETE", null); note = c["name"].Text + " and its actions were removed."; }); })));
      if (!enabled && !tested) items.Add(Ui.Caption("Josi offers an API to the assistant only after it has answered a test. Test it first."));
      if (editing == id) items.Add(ConnectionForm(c));
      var endpoints = c["endpoints"].List;
      items.Add(Ui.Spread(Ui.Headline("What Josi may ask it (" + endpoints.Count(e => e["enabled"].Flag) + " of " + endpoints.Count + " switched on)"),
        Ui.Row(8, Ui.Pill(addingAction == id ? "Cancel" : "Add an Action", () => { addingAction = addingAction == id ? "" : id; Render(); }),
          Ui.Pill(importing == id ? "Cancel Import" : "Import OpenAPI", () => { importing = importing == id ? "" : id; importPreview = Wire.Null; chosen.Clear(); Render(); }))));
      if (endpoints.Count == 0) items.Add(Ui.Caption("Nothing is listed, so Josi can ask this API for nothing at all."));
      foreach (var e in endpoints) {
        var eid = e.Id; var on = e["enabled"].Flag;
        var parameters = e["parameters"].List;
        items.Add(new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Child = Ui.Stack(4,
          Ui.Spread(Ui.T(e["operationId"].Text, 13.5, FontWeights.Medium), Ui.Row(6, ModelText.Pill(Wires.Capitalize(e["capability"].Text), e["capability"].Text == "read"), ModelText.Pill(on ? "Switched on" : "Switched off", on))),
          Ui.T(e["summary"].Text, 13.5), Ui.Copyable(e["method"].Text + " " + e["pathTemplate"].Text, 12.5, Ui.Muted, true),
          Ui.Caption((parameters.Count > 0 ? "Accepts: " + string.Join(", ", parameters.Select(p => p["name"].Text + (p["required"].Flag ? "" : " (optional)"))) + "." : "Takes no parameters.") + (e["acceptsBody"].Flag ? " Sends a block of details." : "")),
          Ui.Wrap(Ui.Pill(on ? "Switch Off" : "Switch On", () => Perform(async (api, stamp) => await api.Request("/admin/custom-apis/endpoints/" + api.Uuid(eid) + "/" + (on ? "disable" : "enable"), "POST", Wires.O())), !on),
            Ui.Pill("Remove", () => Perform(async (api, stamp) => await api.Request("/admin/custom-apis/endpoints/" + api.Uuid(eid), "DELETE", null))))) });
      }
      if (addingAction == id) items.Add(EndpointForm(id));
      if (importing == id) items.Add(Import(c));
      return Ui.CardBox(c["name"].Text, items.ToArray());
    }
    void ResetForm(Wire c) {
      cName.Text = c["name"].Text; cSlug.Text = c["slug"].Text; cUrl.Text = c.IsNull ? "https://" : c["baseUrl"].Text;
      cAuth = c.IsNull ? "bearer" : c["authKind"].Text; cHeader.Text = c["authHeader"].Text.Length > 0 ? c["authHeader"].Text : "X-API-Key";
      cTest.Text = c.IsNull ? "/" : c["testPath"].Text; cUser.Text = ""; cSecret.Clear(); cPassword.Clear();
    }
    UIElement ConnectionForm(Wire existing) {
      foreach (var box in new Control[] { cName, cSlug, cUrl, cHeader, cUser, cTest, cSecret, cPassword }) Ui.Detach(box);
      var items = new List<UIElement> { Ui.Field("Name (what people see, for example “Our booking system”)", cName) };
      if (existing.IsNull) items.Add(Ui.Field("Short name for the assistant (lowercase, digits, underscores; blank makes one from the name)", cSlug));
      items.Add(Ui.Field("Address (https:// only; Josi refuses private or internal addresses)", cUrl));
      items.Add(Ui.Segments(Ui.Options("bearer", "Bearer token", "api_key", "API key in a header", "basic", "Username and password"), cAuth, v => { cAuth = v; Render(); }));
      if (cAuth == "api_key") items.Add(Ui.Field("Header name (never a query string)", cHeader));
      if (cAuth == "basic") { items.Add(Ui.Field("Username", cUser)); items.Add(Ui.Field(existing.IsNull ? "Password" : "Password (blank keeps the stored one)", cPassword)); }
      else items.Add(Ui.Field((cAuth == "bearer" ? "Token" : "API key") + (existing.IsNull ? " (encrypted; nobody can read it back)" : " (blank keeps the stored one)"), cSecret));
      items.Add(Ui.Field("Test path (a path Josi can GET, often /health or /me)", cTest));
      items.Add(Ui.Wrap(Ui.Pill(existing.IsNull ? "Add Connection" : "Save", () => {
        if (cName.Text.Trim().Length == 0 || !cUrl.Text.StartsWith("https://")) { model.Error = "Enter a name and an https:// address."; model.Notify(); return; }
        var body = Wires.O("name", cName.Text.Trim(), "baseUrl", cUrl.Text.Trim(), "authKind", cAuth, "testPath", cTest.Text.Trim());
        if (existing.IsNull) body["slug"] = cSlug.Text.Trim();
        if (cAuth == "api_key") body["authHeader"] = cHeader.Text.Trim();
        if (cAuth == "basic") { if (cUser.Text.Length > 0 || cPassword.Password.Length > 0 || existing.IsNull) { body["username"] = cUser.Text; body["password"] = cPassword.Password; } }
        else if (cSecret.Password.Length > 0 || existing.IsNull) body["secret"] = cSecret.Password;
        cSecret.Clear(); cPassword.Clear();
        var id = existing.Id;
        Perform(async (api, stamp) => {
          if (existing.IsNull) { await api.Request("/admin/custom-apis", "POST", body); note = "Added. Test it, then switch on the actions Josi may use."; }
          else { await api.Request("/admin/custom-apis/" + api.Uuid(id), "PATCH", body); note = "Saved. Changing the address or the credential means testing it again."; }
          editing = "";
        });
      }, true), Ui.Pill("Cancel", () => { editing = ""; Render(); })));
      return Ui.CardBox(existing.IsNull ? "Connect an API" : "Edit this connection", items.ToArray());
    }
    UIElement EndpointForm(string connection) {
      foreach (var box in new Control[] { eId, eSummary, ePath, eQuery, eBody }) Ui.Detach(box);
      var read = eMethod == "GET" || eMethod == "HEAD";
      var items = new List<UIElement> { Ui.Caption("Whether Josi asks first is decided by the method: anything other than GET or HEAD waits for the person to approve it."),
        Ui.Field("Action id (lowercase letters, digits and underscores)", eId), Ui.Field("What it does (the words the assistant reads and you review)", eSummary),
        Ui.Segments(Ui.Options("GET", "GET", "HEAD", "HEAD", "POST", "POST", "PUT", "PUT", "PATCH", "PATCH", "DELETE", "DELETE"), eMethod, v => { eMethod = v; Render(); }),
        Ui.Field("Path under the address, with {placeholders}", ePath), Ui.Field("Query parameters (comma separated; anything else is dropped)", eQuery) };
      if (!read) items.Add(eBody);
      items.Add(Ui.Wrap(Ui.Pill("Add, Switched Off", () => {
        if (!Regex.IsMatch(eId.Text, "^[a-z][a-z0-9_]*$") || eSummary.Text.Trim().Length == 0 || !ePath.Text.StartsWith("/") || ePath.Text.StartsWith("//")) { model.Error = "Check the action id, description and path."; model.Notify(); return; }
        var parameters = Regex.Matches(ePath.Text, "\\{([a-zA-Z][a-zA-Z0-9_]*)\\}").Cast<Match>().Select(m => (object)Wires.O("name", m.Groups[1].Value, "in", "path", "required", true, "description", ""))
          .Concat(eQuery.Text.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).Select(s => (object)Wires.O("name", s, "in", "query", "required", false, "description", ""))).ToList();
        var body = Wires.O("operationId", eId.Text, "summary", eSummary.Text.Trim(), "method", eMethod, "pathTemplate", ePath.Text, "parameters", parameters, "acceptsBody", !read && eBody.IsChecked == true);
        Perform(async (api, stamp) => { await api.Request("/admin/custom-apis/" + api.Uuid(connection) + "/endpoints", "POST", body); addingAction = ""; eId.Text = eSummary.Text = eQuery.Text = ""; ePath.Text = "/"; note = "Added, and switched off. Switch it on when you are happy with it."; });
      }, true), Ui.Pill("Cancel", () => { addingAction = ""; Render(); })));
      return Ui.CardBox("Add an action", items.ToArray());
    }
    UIElement Import(Wire c) {
      var id = c.Id; Ui.Detach(spec);
      var items = new List<UIElement> { Ui.Caption("Paste the JSON form of an OpenAPI 3 document. Nothing is saved until you choose from the list, and everything chosen arrives switched off. Josi ignores addresses in the document and only ever calls " + c["host"].Text + "."),
        spec, Ui.Pill("Read the Document", () => { var doc = spec.Text; Perform(async (api, stamp) => { importPreview = await api.Request("/admin/custom-apis/" + api.Uuid(id) + "/endpoints/import", "POST", Wires.O("document", doc)); chosen.Clear(); }, false); }) };
      if (!importPreview.IsNull) {
        var servers = importPreview["declaredServers"].List;
        if (servers.Count > 0) items.Add(Ui.Caption("That document names " + string.Join(", ", servers.Select(s => s.Text)) + " as its address. Josi ignored it and will use " + c["baseUrl"].Text + "."));
        items.Add(Ui.T(importPreview["proposals"].List.Count + " action(s) found. Choose the ones Josi may use."));
        foreach (var p in importPreview["proposals"].List) {
          var op = p["operationId"].Text;
          var box = Ui.Toggle(op + ": " + p["summary"].Text + "   (" + p["method"].Text + " " + p["pathTemplate"].Text + ")", chosen.Contains(op));
          box.Click += delegate { if (box.IsChecked == true) chosen.Add(op); else chosen.Remove(op); };
          items.Add(box);
        }
        var skipped = importPreview["skipped"].List;
        if (skipped.Count > 0) items.Add(new Disclosure(skipped.Count + " operation(s) could not be used", () => Ui.Stack(2, skipped.Select(s => (UIElement)Ui.Caption(s["method"].Text + " " + s["path"].Text + ": " + s["reason"].Text)).ToArray())));
        items.Add(Ui.Pill("Import Chosen Actions, Switched Off", () => {
          if (chosen.Count == 0) return;
          var doc = spec.Text; var ops = chosen.Cast<object>().ToList();
          Perform(async (api, stamp) => { await api.Request("/admin/custom-apis/" + api.Uuid(id) + "/endpoints/import", "POST", Wires.O("document", doc, "operations", ops)); note = ops.Count + " action(s) imported, all switched off."; importing = ""; importPreview = Wire.Null; });
        }, true));
      }
      return Ui.CardBox("Import from an OpenAPI document", items.ToArray());
    }
  }
}
