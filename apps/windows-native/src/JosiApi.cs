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
      // Item 36: a server on the LAN answers with a certificate its own proxy
      // issued. Windows does not know that authority; a Josi app that has
      // pinned it (after the person confirmed its fingerprint once) does.
      handler.ServerCertificateCustomValidationCallback = (message, certificate, chain, errors) => {
        if (errors == System.Net.Security.SslPolicyErrors.None) return true;
        if (certificate == null) return false;
        if (TrustedByPin(Origin.Host, certificate, chain)) return true;
        lock (untrustedGate) untrusted = new UntrustedServer { Host = Origin.Host, Thumbprint = certificate.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256), Subject = certificate.Subject };
        return false;
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
    // ---- Trusting a LAN server's own certificate authority (item 36) ----
    public sealed class UntrustedServer { public string Host, Thumbprint, Subject; }
    static readonly object untrustedGate = new object();
    static UntrustedServer untrusted;
    /// The server whose certificate Windows refused on the last attempt, if any.
    public static UntrustedServer TakeUntrusted() { lock (untrustedGate) { var u = untrusted; untrusted = null; return u; } }
    static string PinFile(string host) {
      var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Josi", "trusted");
      Directory.CreateDirectory(folder);
      return Path.Combine(folder, Regex.Replace(host.ToLowerInvariant(), "[^a-z0-9.-]", "_") + ".crt");
    }
    /// True when the presented chain leads to the authority pinned for this host.
    static bool TrustedByPin(string host, System.Security.Cryptography.X509Certificates.X509Certificate certificate, System.Security.Cryptography.X509Certificates.X509Chain presented) {
      try {
        var file = PinFile(host);
        if (!File.Exists(file)) return false;
        using (var root = new System.Security.Cryptography.X509Certificates.X509Certificate2(file))
        using (var leaf = new System.Security.Cryptography.X509Certificates.X509Certificate2(certificate))
        using (var chain = new System.Security.Cryptography.X509Certificates.X509Chain()) {
          chain.ChainPolicy.TrustMode = System.Security.Cryptography.X509Certificates.X509ChainTrustMode.CustomRootTrust;
          chain.ChainPolicy.CustomTrustStore.Add(root);
          chain.ChainPolicy.RevocationMode = System.Security.Cryptography.X509Certificates.X509RevocationMode.NoCheck;
          if (presented != null) foreach (var element in presented.ChainElements) if (!element.Certificate.Equals(leaf)) chain.ChainPolicy.ExtraStore.Add(element.Certificate);
          return chain.Build(leaf);
        }
      } catch (Exception) { return false; }
    }
    /// Fetches the server's certificate authority over the connection the
    /// person just approved by its fingerprint, and pins it for this host.
    public static async Task<string> TrustServer(string origin, UntrustedServer approved) {
      using (var temp = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) {
        temp.ServerCertificateCustomValidationCallback = (message, certificate, chain, errors) =>
          errors == System.Net.Security.SslPolicyErrors.None || (certificate != null && certificate.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256) == approved.Thumbprint);
        using (var client = new HttpClient(temp, false) { Timeout = TimeSpan.FromSeconds(30) }) {
          var result = Wires.Parse(await client.GetStringAsync(new Uri(new Uri(origin), "/api/network/ca")));
          var pem = result["pem"].Text;
          if (!pem.Contains("BEGIN CERTIFICATE")) throw new JosiException("This server issues no certificate of its own, so it cannot be trusted this way.");
          using (var root = System.Security.Cryptography.X509Certificates.X509Certificate2.CreateFromPem(pem)) {
            File.WriteAllBytes(PinFile(new Uri(origin).Host), root.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Cert));
            return result["fingerprint"].Text;
          }
        }
      }
    }
    public static bool IsUntrustedCertificate(Exception e) {
      for (var inner = e; inner != null; inner = inner.InnerException)
        if (inner is System.Security.Authentication.AuthenticationException) return true;
      return false;
    }

    /// This PC's own name for PC Control (item 36): made once, kept in the
    /// profile, so two PCs on one account never share permissions or requests.
    public static readonly string DeviceId = LoadDeviceId();
    static string LoadDeviceId() {
      try {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Josi");
        var file = Path.Combine(folder, "device-id");
        if (File.Exists(file)) { var saved = File.ReadAllText(file).Trim(); if (Regex.IsMatch(saved, "^win-[a-f0-9]{32}$")) return saved; }
        Directory.CreateDirectory(folder);
        var fresh = "win-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(file, fresh);
        return fresh;
      } catch (Exception) { return "win-" + Environment.MachineName.ToLowerInvariant().Replace("_", "-").Replace(".", "-"); }
    }

    HttpRequestMessage Message(string method, Uri url) {
      var message = new HttpRequestMessage(new HttpMethod(method), url);
      message.Headers.TryAddWithoutValidation("x-josi-pc", DeviceId);
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

    /// The type the server expects for each extension it accepts (its
    /// attachment contract refuses a bare octet-stream, because a declared
    /// type the bytes are then checked against is part of the contract).
    /// Anything not listed goes up as octet-stream and is refused by name.
    static readonly Dictionary<string, string> MediaTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
      { "jpg", "image/jpeg" }, { "jpeg", "image/jpeg" }, { "png", "image/png" }, { "gif", "image/gif" }, { "webp", "image/webp" }, { "heic", "image/heic" }, { "heif", "image/heif" },
      { "pdf", "application/pdf" }, { "txt", "text/plain" }, { "md", "text/markdown" }, { "csv", "text/csv" }, { "json", "application/json" }, { "rtf", "application/rtf" },
      { "doc", "application/msword" }, { "xls", "application/vnd.ms-excel" }, { "ppt", "application/vnd.ms-powerpoint" },
      { "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, { "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      { "odt", "application/vnd.oasis.opendocument.text" }, { "ods", "application/vnd.oasis.opendocument.spreadsheet" }, { "odp", "application/vnd.oasis.opendocument.presentationml.presentation" },
      { "mp3", "audio/mpeg" }, { "m4a", "audio/mp4" }, { "aac", "audio/aac" }, { "wav", "audio/wav" }, { "ogg", "audio/ogg" }, { "opus", "audio/opus" }, { "flac", "audio/flac" },
      { "mp4", "video/mp4" }, { "m4v", "video/x-m4v" }, { "mov", "video/quicktime" }, { "webm", "video/webm" }, { "mpeg", "video/mpeg" }, { "zip", "application/zip" } };
    public static string MediaTypeFor(string filename) {
      var dot = filename.LastIndexOf('.');
      string type;
      return dot >= 0 && MediaTypes.TryGetValue(filename.Substring(dot + 1), out type) ? type : "application/octet-stream";
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
        file.Headers.ContentType = new MediaTypeHeaderValue(MediaTypeFor(name));
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
          file.Headers.ContentType = new MediaTypeHeaderValue(MediaTypeFor(part.Key));
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
    public async Task<byte[]> VoiceAudio(string route, object body, CancellationToken cancel = default(CancellationToken)) {
      if (route != "/voice/speech" && route != "/admin/voice-box/preview") throw new OperationCanceledException();
      if (csrf == null) await PrimeCsrf();
      using (var linked = CancellationTokenSource.CreateLinkedTokenSource(closing.Token, cancel))
      using (var message = Message("POST", Route(route))) {
        message.Content = new StringContent(Wires.Serialize(body), Encoding.UTF8, "application/json");
        using (var response = await http.SendAsync(message, linked.Token)) {
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
    /// Streams one file as a multipart upload (a backup of any size), with the
    /// extra fields first so the server can read them before the file body.
    public async Task<Wire> UploadArchive(string route, string path, IDictionary<string, string> fields, Action<long> report, Func<bool> cancelled) {
      var info = new FileInfo(path);
      if (!info.Exists || (info.Attributes & (FileAttributes.Directory | FileAttributes.Device | FileAttributes.ReparsePoint)) != 0) throw new JosiException("Choose a regular file.");
      if (!native && csrf == null) await PrimeCsrf();
      var name = info.Name.Replace("\"", "_").Replace("\r", "_").Replace("\n", "_");
      // The body is read on a thread-pool thread; progress goes back to the
      // thread that asked, since the page it updates belongs to that thread.
      var context = SynchronizationContext.Current;
      Action<long> onUi = count => { if (report == null) return; if (context != null) context.Post(_ => report(count), null); else report(count); };
      using (var stream = new FileStream(info.FullName, FileMode.Open, FileAccess.Read, FileShare.Read, 256 * 1024, true))
      using (var counted = new CountingStream(stream, onUi, cancelled))
      using (var message = Message("POST", Route(route)))
      using (var form = new MultipartFormDataContent("Josi-" + Guid.NewGuid().ToString("N"))) {
        foreach (var field in fields) form.Add(new StringContent(field.Value), "\"" + field.Key + "\"");
        var file = new StreamContent(counted, 256 * 1024);
        file.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        file.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data") { Name = "\"archive\"", FileName = "\"" + name + "\"" };
        file.Headers.ContentLength = info.Length;
        form.Add(file);
        message.Content = form;
        using (var response = await streaming.SendAsync(message, HttpCompletionOption.ResponseContentRead, closing.Token)) {
          var value = Wires.Parse(await response.Content.ReadAsStringAsync());
          if (!response.IsSuccessStatusCode) {
            var detail = value["error"].Text;
            throw new JosiException(detail.Length == 0 ? "The server could not process this file." : detail, (int)response.StatusCode);
          }
          return value;
        }
      }
    }
    sealed class CountingStream : Stream {
      readonly Stream inner; readonly Action<long> report; readonly Func<bool> cancelled; long total, lastReported;
      public CountingStream(Stream inner, Action<long> report, Func<bool> cancelled) { this.inner = inner; this.report = report; this.cancelled = cancelled; }
      public override bool CanRead { get { return true; } }
      public override bool CanSeek { get { return false; } }
      public override bool CanWrite { get { return false; } }
      public override long Length { get { return inner.Length; } }
      public override long Position { get { return total; } set { throw new NotSupportedException(); } }
      public override void Flush() { }
      public override int Read(byte[] buffer, int offset, int count) { var n = inner.Read(buffer, offset, count); Count(n); return n; }
      public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) { var n = await inner.ReadAsync(buffer, offset, count, token); Count(n); return n; }
      void Count(int n) {
        if (cancelled != null && cancelled()) throw new OperationCanceledException();
        total += n;
        if (report != null && total - lastReported >= 1024 * 1024) { lastReported = total; report(total); }
      }
      public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
      public override void SetLength(long value) { throw new NotSupportedException(); }
      public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

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
          if ((int)response.StatusCode != 200 || (type != "application/zip" && type != "application/octet-stream") || response.Content.Headers.ContentLength != expected)
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
