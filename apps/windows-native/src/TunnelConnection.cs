using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  /// Keeps one paired server reachable: the LAN addresses from the last welcome
  /// first, then the relay. While on the relay it keeps trying the LAN and moves
  /// new requests over when an address answers. Paths aren't trusted: each one
  /// gets the same handshake against the same pinned key.
  public sealed class TunnelConnection : IDisposable {
    public delegate Task<ITunnelTransport> Dialer(Uri url, bool relay, TimeSpan timeout, CancellationToken cancel);
    public const string Client = "windows";
    public static TimeSpan LanTimeout = TimeSpan.FromMilliseconds(800);
    /// A pairing hello spends the code, so a slow answer is waited for. Giving up
    /// early would leave a good code used up and nothing to show for it.
    public static TimeSpan PairLanTimeout = TimeSpan.FromSeconds(5);
    public static TimeSpan RelayTimeout = TimeSpan.FromSeconds(10);
    public TimeSpan LanRetry = TimeSpan.FromMinutes(1);
    public TimeSpan PingEvery = TimeSpan.FromSeconds(20);

    readonly TunnelPairing pairing;
    readonly ITunnelStore store;
    readonly Dialer dial;
    readonly object gate = new object();
    readonly CancellationTokenSource stopping = new CancellationTokenSource();
    TunnelClient current;
    Task<TunnelClient> connecting;
    bool onLan, disposed, ended, watching;

    /// The server ended this pairing (the reason is ready to show). It is already
    /// deleted here. Raised on a background thread.
    public event Action<string> Ended;

    public TunnelConnection(TunnelPairing pairing, ITunnelStore store, Dialer dial = null) {
      this.pairing = pairing; this.store = store; this.dial = dial ?? WebSocketTransport.Open;
    }

    public TunnelPairing Pairing { get { return pairing; } }
    /// How it is reaching the server right now, if it is.
    public string Route { get { lock (gate) return current == null || current.IsClosed ? "Not connected" : onLan ? "Direct, on your network" : "Through the relay"; } }

    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static object ConnectHello() { return Wires.O("v", 1, "op", "connect", "client", Client, "ts", Now()); }

    /// Pairs this PC: makes its key, sends the code inside the handshake, and
    /// keeps what the server said. The code isn't kept. A path that fails isn't
    /// fatal even after the hello went out: only the server can read the hello,
    /// so at worst the next path gets bad_code.
    public static async Task<TunnelConnection> Pair(TunnelInvite invite, string deviceName, ITunnelStore store, Dialer dial = null, CancellationToken cancel = default(CancellationToken)) {
      dial = dial ?? WebSocketTransport.Open;
      var key = X25519.NewPrivateKey();
      var pairing = new TunnelPairing { Site = invite.Site, Relay = invite.Relay, Name = invite.Name, Label = invite.Name, Server = invite.Server, DeviceKey = key, Lan = invite.Lan, Origin = TunnelPairing.OriginFor(invite) };
      Func<object> hello = () => Wires.O("v", 1, "op", "pair", "code", invite.Code, "name", deviceName, "platform", Client, "ts", Now());
      foreach (var address in invite.Lan) {
        try {
          var transport = await dial(new Uri(address), false, LanTimeout, cancel).ConfigureAwait(false);
          var near = await TunnelClient.Connect(transport, key, invite.Server, hello(), PairLanTimeout, cancel).ConfigureAwait(false);
          return Paired(pairing, near, true, store, dial);
        } catch (TunnelException e) when (!e.Refused) { /* the next address, then the relay */ }
      }
      var relayed = await dial(pairing.RelayUrl, true, RelayTimeout, cancel).ConfigureAwait(false);
      var client = await TunnelClient.Connect(relayed, key, invite.Server, hello(), TunnelClient.HandshakeTimeout, cancel).ConfigureAwait(false);
      return Paired(pairing, client, false, store, dial);
    }

    static TunnelConnection Paired(TunnelPairing pairing, TunnelClient client, bool lan, ITunnelStore store, Dialer dial) {
      pairing.Device = client.Welcome["device"].Text;
      // The code is spent now, so the pairing is saved before anything else.
      try { store.Save(pairing); }
      catch (Exception) { client.Dispose(); throw; }
      var connection = new TunnelConnection(pairing, store, dial);
      connection.Adopt(client, lan);
      return connection;
    }

    /// The live connection, making one if there isn't one. Everyone asking at
    /// once shares the same attempt.
    public Task<TunnelClient> Connected(CancellationToken cancel = default(CancellationToken)) {
      Task<TunnelClient> attempt;
      lock (gate) {
        if (disposed) throw new TunnelException("closed");
        if (ended) throw new TunnelException("revoked");
        if (current != null && !current.IsClosed) return Task.FromResult(current);
        if (connecting == null) connecting = Task.Run(Reach);
        attempt = connecting;
      }
      return attempt.WaitAsync(cancel);
    }

    async Task<TunnelClient> Reach() {
      try {
        foreach (var address in LanAddresses()) {
          try { return await Attempt(new Uri(address), false).ConfigureAwait(false); }
          catch (TunnelException e) when (!e.Refused) { /* the next address, then the relay */ }
        }
        return await Attempt(pairing.RelayUrl, true).ConfigureAwait(false);
      } finally { lock (gate) connecting = null; }
    }

    List<string> LanAddresses() { lock (gate) return pairing.Lan.ToList(); }

    /// One path, one handshake. The server's own "no" stops everything; it can
    /// only come from the holder of the pinned key, unlike a relay status line.
    async Task<TunnelClient> Attempt(Uri url, bool relay) {
      byte[] key, pending, server;
      lock (gate) { key = pairing.DeviceKey; pending = pairing.PendingKey; server = pairing.Server; }
      try {
        return Adopt(await Handshake(url, relay, key, server).ConfigureAwait(false), !relay);
      } catch (TunnelException e) when (e.Refused && e.Code == "unknown_device" && pending != null) {
        // The last rotation reached the server but its answer never came back.
        var client = await PromotePending(url, relay, pending, server).ConfigureAwait(false);
        return Adopt(client, !relay);
      } catch (TunnelException e) when (e.Refused) {
        if (e.Code == "revoked" || e.Code == "unknown_device") End(e);
        throw;
      }
    }

    async Task<TunnelClient> PromotePending(Uri url, bool relay, byte[] pending, byte[] server) {
      try {
        var client = await Handshake(url, relay, pending, server).ConfigureAwait(false);
        lock (gate) { pairing.DeviceKey = pending; pairing.PendingKey = null; }
        return client;
      } catch (TunnelException e) when (e.Refused && (e.Code == "revoked" || e.Code == "unknown_device")) { End(e); throw; }
    }

    async Task<TunnelClient> Handshake(Uri url, bool relay, byte[] key, byte[] server) {
      var transport = await dial(url, relay, relay ? RelayTimeout : LanTimeout, stopping.Token).ConfigureAwait(false);
      return await TunnelClient.Connect(transport, key, server, ConnectHello(), relay ? TunnelClient.HandshakeTimeout : LanTimeout, stopping.Token).ConfigureAwait(false);
    }

    /// Takes a finished handshake on as the connection for new requests.
    TunnelClient Adopt(TunnelClient client, bool lan) {
      client.PingEvery = PingEvery;
      client.ServerRotated = ServerRotated;
      client.Revoked = () => End(new TunnelException("revoked"));
      client.Closed = gone => { lock (gate) if (current == gone) current = null; };
      TunnelClient previous;
      lock (gate) {
        if (disposed) { client.Dispose(); throw new TunnelException("closed"); }
        previous = current;
        current = client; onLan = lan;
        var welcome = client.Welcome;
        if (welcome["server"].Text.Length > 0) pairing.Label = welcome["server"].Text;
        if (welcome.Contains("lan")) pairing.Lan = TunnelInvite.CleanLan(welcome["lan"]);
        try { store.Save(pairing); }
        catch (Exception) { /* the next welcome brings all of this again */ }
        if (!watching) { watching = true; Task.Run(WatchLan); }
      }
      var notice = client.Welcome["rotate"]["publicKey"].Text;
      if (notice.Length > 0) ServerRotated(notice);
      client.Start();
      if (previous != null) previous.Retire();
      return client;
    }

    /// Both the rotate in a welcome and the control message arrive inside the
    /// authenticated session. The new key is for next time: this session goes on.
    void ServerRotated(string publicKey) {
      var key = Base64Url.Decode(publicKey);
      if (!X25519.IsUsablePublicKey(key)) return;
      lock (gate) {
        if (disposed || ended || CryptographicOperations.FixedTimeEquals(key, pairing.Server)) return;
        pairing.Server = key;
        try { store.Save(pairing); }
        catch (Exception) { /* told again in the next welcome, while the old key still works */ }
      }
    }

    async Task WatchLan() {
      try {
        while (true) {
          await Task.Delay(LanRetry, stopping.Token).ConfigureAwait(false);
          bool onRelay;
          lock (gate) onRelay = current != null && !current.IsClosed && !onLan;
          if (!onRelay) continue;
          foreach (var address in LanAddresses()) {
            try { await Attempt(new Uri(address), false).ConfigureAwait(false); break; }
            catch (TunnelException) { }
          }
        }
      } catch (OperationCanceledException) { }
    }

    /// Replaces this device's key. The new key is saved before the server hears
    /// of it, and kept until the server's answer settles it, so a crash or a lost
    /// reply can't leave the server knowing a key this PC has forgotten.
    public async Task RotateDeviceKey(CancellationToken cancel = default(CancellationToken)) {
      var client = await Connected(cancel).ConfigureAwait(false);
      byte[] next;
      lock (gate) {
        if (pairing.PendingKey == null) { pairing.PendingKey = X25519.NewPrivateKey(); store.Save(pairing); }
        next = pairing.PendingKey;
      }
      try { await client.RotateDeviceKey(X25519.PublicKey(next), TunnelClient.HandshakeTimeout).ConfigureAwait(false); }
      catch (TunnelException e) when (e.Refused) {
        lock (gate) { pairing.PendingKey = null; store.Save(pairing); }
        throw;
      }
      lock (gate) { pairing.DeviceKey = next; pairing.PendingKey = null; store.Save(pairing); }
    }

    /// The server says this PC is no longer paired.
    void End(TunnelException reason) {
      lock (gate) {
        if (ended) return;
        ended = true;
        try { store.Delete(pairing); } catch (Exception) { }
      }
      var handler = Ended;
      if (handler != null) handler(reason.Message);
    }

    public void Dispose() {
      TunnelClient client;
      lock (gate) {
        if (disposed) return;
        disposed = true;
        client = current; current = null;
      }
      stopping.Cancel();
      if (client != null) client.Dispose();
    }
  }

  /// HttpClient traffic for a paired server. Each request becomes one tunnel
  /// stream; the response is handed back at its head, so event streams and large
  /// downloads flow as they arrive. Cookies are the server's job on this path.
  public sealed class TunnelHandler : HttpMessageHandler {
    public readonly TunnelConnection Connection;
    public TunnelHandler(TunnelConnection connection) { Connection = connection; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel) {
      var headers = Headers(request);
      var path = request.RequestUri.PathAndQuery;
      Func<System.IO.Stream, CancellationToken, Task> body = null;
      if (request.Content != null) body = (output, token) => request.Content.CopyToAsync(output, token);
      TunnelReply reply;
      try {
        while (true) {
          var client = await Connection.Connected(cancel).ConfigureAwait(false);
          try { reply = await client.Send(request.Method.Method, path, headers, body, cancel).ConfigureAwait(false); break; }
          // The connection died before the request left: a fresh one can carry it.
          catch (TunnelException e) when (e.Code == "not_sent" && !cancel.IsCancellationRequested) { }
        }
      } catch (TunnelException e) { throw new HttpRequestException(e.Message, e); }
      var response = new HttpResponseMessage((HttpStatusCode)reply.Status) { RequestMessage = request, Version = HttpVersion.Version11, Content = new StreamContent(reply.Body) };
      foreach (var pair in reply.Headers)
        if (!response.Headers.TryAddWithoutValidation(pair.Key, pair.Value)) response.Content.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
      return response;
    }

    /// One entry per name, since the server's side keeps the last one it sees.
    /// Reading ContentLength first makes HttpContent work it out for us.
    static List<KeyValuePair<string, string>> Headers(HttpRequestMessage request) {
      var result = new List<KeyValuePair<string, string>>();
      foreach (var header in request.Headers.NonValidated) result.Add(new KeyValuePair<string, string>(header.Key, string.Join(", ", header.Value)));
      if (request.Content != null) {
        var length = request.Content.Headers.ContentLength;
        foreach (var header in request.Content.Headers.NonValidated) if (!header.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) result.Add(new KeyValuePair<string, string>(header.Key, string.Join(", ", header.Value)));
        if (length.HasValue) result.Add(new KeyValuePair<string, string>("Content-Length", length.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)));
      }
      return result;
    }

    protected override void Dispose(bool disposing) {
      if (disposing) Connection.Dispose();
      base.Dispose(disposing);
    }
  }
}
