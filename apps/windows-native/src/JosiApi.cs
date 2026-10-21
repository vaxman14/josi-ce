using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  /// One authenticated connection to a Josi CE server. First-run setup uses
  /// the browser-style cookie and CSRF token, held only in memory. Signed-in
  /// use is the server's native-app mode: an explicit bearer session with no
  /// Origin header, so no browser can attach it and CSRF does not apply.
  public sealed class JosiApi : IDisposable {
    public const string UserAgent = "JosiWindows/0.7";
    const int MaxResponse = 4 * 1024 * 1024;
    public readonly Uri Origin;
    public readonly string OriginText;
    readonly HttpClientHandler handler;
    readonly HttpClient http;
    readonly HttpClient streaming;
    readonly CancellationTokenSource closing = new CancellationTokenSource();
    string csrf, session;
    bool closed, native;
    CancellationTokenSource progress;

    public JosiApi(string address) {
      Uri parsed;
      var text = (address ?? "").Trim();
      if (!Uri.TryCreate(text, UriKind.Absolute, out parsed) || string.IsNullOrEmpty(parsed.Host)
          || parsed.UserInfo.Length > 0 || parsed.Query.Length > 0 || parsed.Fragment.Length > 0
          || (parsed.AbsolutePath != "/" && parsed.AbsolutePath.Length > 0)
          || !(parsed.Scheme == "https" || (parsed.Scheme == "http" && IsLoopback(parsed.Host)))) {
        throw new JosiException("Use your server's HTTPS address, or HTTP localhost for a server on this PC.");
      }
      OriginText = parsed.GetLeftPart(UriPartial.Authority);
      Origin = new Uri(OriginText);
      handler = new HttpClientHandler {
        AllowAutoRedirect = false, UseCookies = true, CookieContainer = new CookieContainer(),
        UseDefaultCredentials = false, Credentials = null, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
      };
      http = new HttpClient(handler, false) { Timeout = TimeSpan.FromSeconds(180), MaxResponseContentBufferSize = MaxResponse };
      streaming = new HttpClient(handler, false) { Timeout = Timeout.InfiniteTimeSpan };
      foreach (var client in new[] { http, streaming }) {
        client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
        client.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
      }
    }
    public static bool IsLoopback(string host) {
      var h = (host ?? "").ToLowerInvariant();
      return h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1";
    }
    public bool IsLocal { get { return IsLoopback(Origin.Host); } }

    /// Switches to native-app requests (sign-in and everything after it).
    public void UseNative() { native = true; csrf = null; }
    /// The bearer session from a native sign-in.
    public void UseSession(string token) {
      if (string.IsNullOrEmpty(token) || token.Length > 512 || !Regex.IsMatch(token, "^[A-Za-z0-9_-]+$"))
        throw new JosiException("The server did not return a usable session.");
      UseNative(); session = token;
    }
    public void EndSession() { session = null; }

    public void Dispose() {
      if (closed) return;
      closed = true; csrf = null; session = null;
      CancelWorkProgress();
      closing.Cancel();
      http.Dispose(); streaming.Dispose(); handler.Dispose();
    }
    public void CancelWorkProgress() {
      var current = progress; progress = null;
      if (current != null) { try { current.Cancel(); } catch (ObjectDisposedException) { } }
    }

    public string Uuid(string value) {
      if (!Wires.IsUuid(value)) throw new JosiException("Refresh this item before continuing.");
      return value;
    }

    Uri Route(string route) {
      if (closed || route == null || !route.StartsWith("/") || route.StartsWith("//") || route.Contains("#")
          || route.Contains("\\") || route.Length >= 4096) throw new JosiException("Reconnect to your Josi server.");
      var url = new Uri(OriginText + "/api" + route);
      if (url.Host != Origin.Host || url.Scheme != Origin.Scheme || url.Port != Origin.Port) throw new JosiException("Reconnect to your Josi server.");
      return url;
    }
    HttpRequestMessage Message(string method, Uri url) {
      var message = new HttpRequestMessage(new HttpMethod(method), url);
      if (native) {
        message.Headers.TryAddWithoutValidation("x-josi-client", "native");
        if (session != null) message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session);
      } else {
        message.Headers.TryAddWithoutValidation("Origin", OriginText);
        if (method != "GET" && csrf != null) message.Headers.TryAddWithoutValidation("x-josi-csrf", csrf);
      }
      message.Headers.Accept.ParseAdd("application/json");
      return message;
    }

    public async Task PrimeCsrf() {
      if (native) return;
      var result = await Request("/auth/csrf");
      var token = result["csrfToken"].Text;
      if (token.Length == 0 || token.Length > 256) throw new JosiException("The server could not prepare a secure session.");
      csrf = token;
    }

    public Task<Wire> Request(string route) { return Request(route, "GET", null, null); }
    public Task<Wire> Request(string route, string method, object body) { return Request(route, method, body, null); }
    public async Task<Wire> Request(string route, string method, object body, IDictionary<string, string> headers) {
      var url = Route(route);
      if (method != "GET" && csrf == null && !native) await PrimeCsrf();
      using (var message = Message(method, url)) {
        if (headers != null) foreach (var pair in headers) message.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
        if (body != null) message.Content = new StringContent(Wires.Serialize(body), Encoding.UTF8, "application/json");
        HttpResponseMessage response;
        try { response = await http.SendAsync(message, closing.Token); }
        catch (OperationCanceledException) { if (closed) throw; throw new JosiException("The server did not answer in time. Check the connection and try again."); }
        catch (HttpRequestException e) { throw new JosiException(Unreachable(e)); }
        using (response) {
          var status = (int)response.StatusCode;
          if (status >= 300 && status < 400) throw new JosiException("The server returned an unexpected redirect. Check its address.", status);
          string text;
          try { text = await response.Content.ReadAsStringAsync(); }
          catch (HttpRequestException) { throw new JosiException("The response is too large or was interrupted. Narrow the selected work."); }
          if (closed) throw new OperationCanceledException();
          var value = Wires.Parse(text);
          if (status < 200 || status >= 300) {
            var detail = value["error"].Text;
            if (detail.Length > 600) detail = detail.Substring(0, 600);
            throw new JosiException(detail.Length == 0 ? "The server could not complete that request (" + status + ")." : detail, status);
          }
          return value;
        }
      }
    }
    /// The server answers the native Google start with a redirect: to Google
    /// (carrying the state the app checks on return) or straight back to the
    /// app with an error. Returned, not followed.
    public async Task<Uri> GoogleSignInStart(string returnUri) {
      using (var message = Message("GET", Route("/auth/google/native/start?redirect_uri=" + Uri.EscapeDataString(returnUri)))) {
        HttpResponseMessage response;
        try { response = await http.SendAsync(message, closing.Token); }
        catch (OperationCanceledException) { if (closed) throw; throw new JosiException("The server did not answer in time. Check the connection and try again."); }
        catch (HttpRequestException e) { throw new JosiException(Unreachable(e)); }
        using (response) {
          var status = (int)response.StatusCode;
          if (status < 300 || status >= 400 || response.Headers.Location == null) {
            var detail = Wires.Parse(await response.Content.ReadAsStringAsync())["error"].Text;
            throw new JosiException(detail.Length > 0 && detail.Length < 300 ? detail : "The server could not start Google sign-in.", status);
          }
          return response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(Origin, response.Headers.Location);
        }
      }
    }

    static string Unreachable(HttpRequestException e) {
      var inner = e.InnerException as WebException;
      if (inner != null && inner.Status == WebExceptionStatus.TrustFailure) return "The server's HTTPS certificate is not trusted by Windows.";
      if (inner != null && inner.Status == WebExceptionStatus.NameResolutionFailure) return "The server address could not be found.";
      return "The server could not be reached. Check that it is running and the address is correct.";
    }

    /// Owner-scoped invalidations only. Event contents never become goal text,
    /// completion evidence, permissions, or instructions.
    public async Task FollowWorkProgress(Action<string> signal) {
      if (closed || progress != null) throw new OperationCanceledException();
      var own = CancellationTokenSource.CreateLinkedTokenSource(closing.Token);
      progress = own;
      try {
        var url = Route("/assistant/work-goals/stream?all=1");
        using (var message = Message("GET", url)) {
          message.Headers.Accept.Clear();
          message.Headers.Accept.ParseAdd("text/event-stream");
          using (var response = await streaming.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, own.Token)) {
            var media = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.MediaType;
            if ((int)response.StatusCode != 200 || media != "text/event-stream")
              throw new JosiException("Live progress is unavailable.", (int)response.StatusCode);
            using (var stream = await response.Content.ReadAsStreamAsync())
            using (own.Token.Register(() => stream.Dispose())) {
              var reader = new StreamReader(stream, new UTF8Encoding(false, true));
              string evt = "", payload = "";
              long total = 0;
              while (true) {
                var line = await reader.ReadLineAsync();
                if (line == null || own.IsCancellationRequested) return;
                total += line.Length + 1;
                if (total > 1024 * 1024 || line.Length > 8192) throw new JosiException("The live progress connection ended.");
                if (line.Length == 0) {
                  if (evt.Length > 0) {
                    if (evt != "progress" && evt != "heartbeat" && evt != "unavailable" && evt != "access-ended") throw new JosiException("Invalid progress event.");
                    var value = Wires.Parse(payload);
                    if (evt == "progress" && !Regex.IsMatch(value["revision"].Text, "^[a-f0-9]{64}$")) throw new JosiException("Invalid progress event.");
                    signal(evt);
                    if (evt == "access-ended" || evt == "unavailable") return;
                  }
                  evt = ""; payload = "";
                } else if (line.StartsWith("event:")) {
                  if (evt.Length > 0) throw new JosiException("Invalid progress event.");
                  evt = line.Substring(6).Trim();
                } else if (line.StartsWith("data:")) {
                  if (payload.Length > 0) payload += "\n";
                  payload += line.Substring(5).TrimStart(' ');
                } else if (!line.StartsWith(":") && !line.StartsWith("retry:")) {
                  throw new JosiException("Unsupported progress event.");
                }
              }
            }
          }
        }
      } catch (IOException) { if (own.IsCancellationRequested) throw new OperationCanceledException(); throw new JosiException("The live progress connection ended."); }
      catch (ObjectDisposedException) { throw new OperationCanceledException(); }
      catch (HttpRequestException) { throw new JosiException("The live progress connection ended."); }
      finally { if (progress == own) progress = null; own.Dispose(); }
    }

    public async Task<Wire> UploadAttachment(string path, string thread) {
      var id = Uuid(thread);
      var info = new FileInfo(path);
      if (!info.Exists || (info.Attributes & (FileAttributes.Directory | FileAttributes.Device | FileAttributes.ReparsePoint)) != 0)
        throw new JosiException("Choose a regular file.");
      if (info.Length > 20 * 1024 * 1024) throw new JosiException("Choose a file of up to 20 MB.");
      var content = File.ReadAllBytes(info.FullName);
      if (content.Length > 20 * 1024 * 1024) throw new JosiException("The selected file is too large.");
      if (csrf == null) await PrimeCsrf();
      var name = info.Name.Replace("\"", "_").Replace("\r", "_").Replace("\n", "_");
      using (var message = Message("POST", Route("/assistant/threads/" + id + "/attachments")))
      using (var form = new MultipartFormDataContent("Josi-" + Guid.NewGuid().ToString("N"))) {
        var file = new ByteArrayContent(content);
        file.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        file.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data") { Name = "\"file\"", FileName = "\"" + name + "\"" };
        form.Add(file);
        message.Content = form;
        using (var response = await http.SendAsync(message, closing.Token)) {
          var value = Wires.Parse(await response.Content.ReadAsStringAsync());
          if (!response.IsSuccessStatusCode) {
            var detail = value["error"].Text;
            throw new JosiException(detail.Length == 0 ? "The server could not process this file." : detail, (int)response.StatusCode);
          }
          return value["attachment"];
        }
      }
    }

    /// Uploads regular files as one multipart form (field repeated per file).
    public async Task<Wire> UploadFiles(string route, string field, IList<string> paths, long maxTotal) {
      long total = 0;
      var parts = new List<KeyValuePair<string, byte[]>>();
      foreach (var path in paths) {
        var info = new FileInfo(path);
        if (!info.Exists || (info.Attributes & (FileAttributes.Directory | FileAttributes.Device | FileAttributes.ReparsePoint)) != 0) throw new JosiException("Choose regular files.");
        total += info.Length;
        if (total > maxTotal) throw new JosiException("The selected files are too large together.");
        parts.Add(new KeyValuePair<string, byte[]>(info.Name.Replace("\"", "_").Replace("\r", "_").Replace("\n", "_"), File.ReadAllBytes(info.FullName)));
      }
      if (!native && csrf == null) await PrimeCsrf();
      using (var message = Message("POST", Route(route)))
      using (var form = new MultipartFormDataContent("Josi-" + Guid.NewGuid().ToString("N"))) {
        foreach (var part in parts) {
          var file = new ByteArrayContent(part.Value);
          file.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
          file.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data") { Name = "\"" + field + "\"", FileName = "\"" + part.Key + "\"" };
          form.Add(file);
        }
        message.Content = form;
        using (var response = await http.SendAsync(message, closing.Token)) {
          var value = Wires.Parse(await response.Content.ReadAsStringAsync());
          if (!response.IsSuccessStatusCode) {
            var detail = value["error"].Text;
            throw new JosiException(detail.Length == 0 ? "The server could not process these files." : detail, (int)response.StatusCode);
          }
          return value;
        }
      }
    }

    /// Voice routes return audio bytes rather than JSON.
    public async Task<byte[]> VoiceAudio(string route, object body) {
      if (route != "/voice/speech" && route != "/admin/voice-box/preview") throw new OperationCanceledException();
      if (csrf == null) await PrimeCsrf();
      using (var message = Message("POST", Route(route))) {
        message.Content = new StringContent(Wires.Serialize(body), Encoding.UTF8, "application/json");
        using (var response = await http.SendAsync(message, closing.Token)) {
          var bytes = await response.Content.ReadAsByteArrayAsync();
          if (!response.IsSuccessStatusCode) {
            var detail = Wires.Parse(Encoding.UTF8.GetString(bytes))["error"].Text;
            throw new JosiException(detail.Length == 0 ? "The server could not process this media." : detail, (int)response.StatusCode);
          }
          var type = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.MediaType;
          if (!type.StartsWith("audio/")) throw new JosiException("The server did not return voice audio.");
          return bytes;
        }
      }
    }

    /// Saves a file from the server (workspace files, attachments, exports) to
    /// a temporary file next to the destination and moves it into place only
    /// when the whole response arrived.
    public async Task DownloadFile(string route, string destination, long maxBytes) {
      var folder = Path.GetDirectoryName(Path.GetFullPath(destination));
      using (var message = Message("GET", Route(route))) {
        message.Headers.Accept.Clear(); message.Headers.Accept.ParseAdd("*/*");
        using (var response = await streaming.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, closing.Token)) {
          if (!response.IsSuccessStatusCode) {
            var detail = Wires.Parse(await response.Content.ReadAsStringAsync())["error"].Text;
            throw new JosiException(detail.Length == 0 ? "The file could not be downloaded." : detail, (int)response.StatusCode);
          }
          var temporary = Path.Combine(folder, ".josi-download-" + Guid.NewGuid().ToString("N"));
          try {
            using (var input = await response.Content.ReadAsStreamAsync())
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
              var buffer = new byte[128 * 1024]; long total = 0; int read;
              while ((read = await input.ReadAsync(buffer, 0, buffer.Length, closing.Token)) > 0) {
                total += read;
                if (total > maxBytes) throw new JosiException("The file is larger than Josi will download here.");
                await output.WriteAsync(buffer, 0, read);
              }
            }
            if (File.Exists(destination)) File.Replace(temporary, destination, null); else File.Move(temporary, destination);
          } finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
        }
      }
    }

    /// The archive is written to a private temporary file next to the chosen
    /// destination and moved into place only after its full length arrives.
    public async Task DownloadBackup(string identifier, long expected, string destination, Action<long> report, Func<bool> cancelled) {
      var id = Uuid(identifier);
      if (expected <= 0) throw new JosiException("Refresh the completed backup before downloading.");
      var folder = Path.GetDirectoryName(Path.GetFullPath(destination));
      var drive = new DriveInfo(Path.GetPathRoot(folder));
      if (drive.AvailableFreeSpace < expected) throw new JosiException("The selected disk does not have enough free space for this archive.");
      using (var message = Message("GET", Route("/ops/admin/backups/" + id + "/download"))) {
        message.Headers.Accept.Clear(); message.Headers.Accept.ParseAdd("application/zip");
        message.Headers.AcceptEncoding.ParseAdd("identity");
        using (var response = await streaming.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, closing.Token)) {
          var type = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.MediaType;
          if ((int)response.StatusCode != 200 || type != "application/zip" || response.Content.Headers.ContentLength != expected)
            throw new JosiException("The completed archive could not be verified. Refresh backup history and try again.");
          var temporary = Path.Combine(folder, ".josi-export-" + Guid.NewGuid().ToString("N"));
          try {
            using (var input = await response.Content.ReadAsStreamAsync())
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 256 * 1024, FileOptions.WriteThrough)) {
              var buffer = new byte[256 * 1024];
              long total = 0;
              while (true) {
                if (cancelled()) throw new OperationCanceledException();
                var read = await input.ReadAsync(buffer, 0, buffer.Length, closing.Token);
                if (read == 0) break;
                total += read;
                if (total > expected) throw new JosiException("The backup download changed or was interrupted.");
                await output.WriteAsync(buffer, 0, read);
                report(total);
              }
              if (total != expected) throw new JosiException("The backup download was incomplete. The destination was not replaced.");
              output.Flush(true);
            }
            if (File.Exists(destination)) File.Replace(temporary, destination, null);
            else File.Move(temporary, destination);
          } finally {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { }
          }
        }
      }
    }

    /// First-run handoff for a server installed on this PC. The setup token is
    /// read from the installer's per-user protected document and never shown.
    public async Task LocalSetupHandoff() {
      if (!IsLocal) throw new JosiException("Initial setup must be opened on the server PC.");
      var token = LocalServer.ReadSetupToken(Origin.Port);
      var launch = await Request("/onboarding/launch", "POST", Wires.O(), new Dictionary<string, string> { { "x-josi-setup-token", token } });
      if (!Regex.IsMatch(launch["token"].Text, "^[a-f0-9]{64}$")) throw new JosiException("The setup session could not be prepared.");
      await Request("/onboarding/consume", "POST", Wires.O("token", launch["token"]));
    }
  }
}
