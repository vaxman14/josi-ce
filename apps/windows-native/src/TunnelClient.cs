using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  /// One connection, already open. Binary messages only, in order.
  public interface ITunnelTransport {
    /// One message. Never cancelled part way: a sealed message that doesn't go
    /// out would leave the two ends' counters apart.
    Task SendAsync(byte[] data);
    /// The next message, or null when the connection has ended. It is pulled, not
    /// pushed, so nothing can arrive between the handshake and the session.
    Task<byte[]> ReceiveAsync(CancellationToken cancel);
    void Close();
  }

  /// A WebSocket as a transport. The relay's own status lines arrive as text.
  /// They aren't authenticated, so they only ever make the client give up sooner:
  /// they can't make it trust, pair, unpair or rotate anything. Noise frames are
  /// always binary.
  public sealed class WebSocketTransport : ITunnelTransport {
    readonly ClientWebSocket socket;
    readonly bool relay;
    readonly byte[] buffer = new byte[NoiseSession.MaxMessage + 1];

    WebSocketTransport(ClientWebSocket socket, bool relay) { this.socket = socket; this.relay = relay; }

    /// Opens a connection. On the relay, also waits for it to say the server is
    /// there, since a message sent before that has nowhere to go.
    public static async Task<ITunnelTransport> Open(Uri url, bool relay, TimeSpan timeout, CancellationToken cancel) {
      var socket = new ClientWebSocket();
      if (!relay) socket.Options.Proxy = null;   // a LAN address is never behind the PC's proxy
      var transport = new WebSocketTransport(socket, relay);
      using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancel)) {
        linked.CancelAfter(timeout);
        try {
          await socket.ConnectAsync(url, linked.Token).ConfigureAwait(false);
          if (relay) await transport.WaitForServer(linked.Token).ConfigureAwait(false);
          return transport;
        } catch (Exception e) {
          transport.Close();
          if (cancel.IsCancellationRequested) throw new OperationCanceledException(cancel);
          if (e is TunnelException) throw;
          throw new TunnelException(e is OperationCanceledException ? "timeout" : "unreachable", TunnelException.Explain("unreachable"), e);
        }
      }
    }

    async Task WaitForServer(CancellationToken cancel) {
      while (true) {
        var message = await Next(cancel).ConfigureAwait(false);
        if (message.Closed) throw new TunnelException("unreachable");
        if (message.Status == "server-online") return;
        if (message.Status == "server-offline") throw new TunnelException("offline");
      }
    }

    public Task SendAsync(byte[] data) { return socket.SendAsync(new ArraySegment<byte>(data), WebSocketMessageType.Binary, true, CancellationToken.None); }

    public async Task<byte[]> ReceiveAsync(CancellationToken cancel) {
      while (true) {
        var message = await Next(cancel).ConfigureAwait(false);
        if (message.Closed) return null;
        if (message.Data != null) return message.Data;
        if (message.Status == "server-offline") throw new TunnelException("offline");
      }
    }

    struct Incoming { public bool Closed; public byte[] Data; public string Status; }

    async Task<Incoming> Next(CancellationToken cancel) {
      while (true) {
        var total = 0;
        ValueWebSocketReceiveResult result;
        do {
          if (total == buffer.Length) throw new TunnelException("tampered");   // larger than any message may be
          result = await socket.ReceiveAsync(buffer.AsMemory(total), cancel).ConfigureAwait(false);
          if (result.MessageType == WebSocketMessageType.Close) return new Incoming { Closed = true };
          total += result.Count;
        } while (!result.EndOfMessage);
        if (result.MessageType == WebSocketMessageType.Binary) return new Incoming { Data = buffer.AsSpan(0, total).ToArray() };
        if (relay) return new Incoming { Status = Wires.Parse(Encoding.UTF8.GetString(buffer, 0, total))["type"].Text };
      }
    }

    public void Close() {
      try { socket.Abort(); socket.Dispose(); } catch (Exception) { }
    }
  }

  public sealed class TunnelReply {
    public int Status;
    public List<KeyValuePair<string, string>> Headers = new List<KeyValuePair<string, string>>();
    public TunnelBody Body;
  }

  /// A device's end of the tunnel: the handshake, then HTTP over the mux. It knows
  /// nothing about how bytes reach the server, so the same class runs over the
  /// relay and over the LAN listener.
  public sealed class TunnelClient : IDisposable {
    public static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(15);
    sealed class Call { public uint Id; public TunnelBody Body; public readonly TaskCompletionSource<TunnelReply> Head = new TaskCompletionSource<TunnelReply>(TaskCreationOptions.RunContinuationsAsynchronously); }

    readonly ITunnelTransport transport;
    readonly NoiseSession session;
    readonly ConcurrentDictionary<uint, Call> calls = new ConcurrentDictionary<uint, Call>();
    // Sealing and sending are one step: a nonce has to reach the wire in order,
    // and a WebSocket takes one send at a time.
    readonly SemaphoreSlim sending = new SemaphoreSlim(1, 1);
    readonly CancellationTokenSource stopping = new CancellationTokenSource();
    readonly object gate = new object();
    int nextStream;
    bool closed, retiring;
    long lastHeard = Environment.TickCount64;
    TaskCompletionSource<bool> rotation;

    public readonly Wire Welcome;
    /// How often to ping. A link with no answer for 2.5 times this is dead.
    public TimeSpan PingEvery = TimeSpan.FromSeconds(20);
    /// The server moved to a new key (base64url): remember it, and use it next time.
    public Action<string> ServerRotated;
    public Action Revoked;
    public Action<TunnelClient> Closed;

    TunnelClient(ITunnelTransport transport, NoiseSession session, Wire welcome) { this.transport = transport; this.session = session; Welcome = welcome; }

    public bool IsClosed { get { lock (gate) return closed; } }
    internal NoiseSession Session { get { return session; } }

    /// Runs the handshake. A refusal from the server throws with Refused set. Set
    /// the callbacks, then call Start: nothing is read before that.
    public static async Task<TunnelClient> Connect(ITunnelTransport transport, byte[] key, byte[] serverPublic, object hello, TimeSpan timeout, CancellationToken cancel = default(CancellationToken)) {
      try {
        using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancel)) {
          linked.CancelAfter(timeout);
          var handshake = new NoiseHandshake(key, serverPublic);
          await transport.SendAsync(handshake.WriteFirst(Encoding.UTF8.GetBytes(Wires.Serialize(hello)))).WaitAsync(linked.Token).ConfigureAwait(false);
          var reply = await transport.ReceiveAsync(linked.Token).ConfigureAwait(false);
          if (reply == null) throw new TunnelException("closed");
          var welcome = Wires.Parse(Encoding.UTF8.GetString(handshake.ReadSecond(reply)));
          if (welcome["ok"].Flag && welcome["device"].Text.Length > 0) return new TunnelClient(transport, new NoiseSession(handshake.Send, handshake.Receive), welcome);
          var error = welcome["error"].Text;
          throw new TunnelException(error.Length == 0 ? "bad_server" : error, null, null, error.Length > 0);
        }
      } catch (Exception e) {
        transport.Close();
        if (cancel.IsCancellationRequested) throw new OperationCanceledException(cancel);
        if (e is TunnelException) throw;
        if (e is OperationCanceledException) throw new TunnelException("timeout", null, e);
        if (e is CryptographicException) throw new TunnelException("bad_server", null, e);
        throw new TunnelException("closed", null, e);
      }
    }

    public void Start() {
      Task.Run(Receive);
      Task.Run(KeepAlive);
    }

    /// Sends one request and returns at the response head. `body` writes the
    /// request body, if there is one. "not_sent" means nothing reached the server,
    /// so the caller may try again on a fresh connection.
    public async Task<TunnelReply> Send(string method, string path, IEnumerable<KeyValuePair<string, string>> headers, Func<Stream, CancellationToken, Task> body, CancellationToken cancel) {
      var call = new Call { Id = (uint)Interlocked.Increment(ref nextStream) };
      calls[call.Id] = call;
      using (cancel.Register(() => Abandon(call, new OperationCanceledException(cancel)))) {
        var head = Wires.O("method", method, "path", path, "headers", headers.Select(h => new[] { h.Key, h.Value }).ToList());
        try { await Write(TunnelMux.Json(TunnelFrame.ReqHead, call.Id, head), cancel).ConfigureAwait(false); }
        catch (TunnelException e) { calls.TryRemove(call.Id, out _); throw new TunnelException("not_sent", e.Message, e); }
        var finished = true;
        if (body != null) {
          var upload = new TunnelUpload(this, call.Id);
          try { await body(upload, cancel).ConfigureAwait(false); await upload.Finish(cancel).ConfigureAwait(false); }
          // The server answered, or ended the stream, before reading it all.
          catch (TunnelUpload.Stopped) { finished = false; }
          catch (TunnelException) { throw; }
          catch (Exception e) { Abandon(call, e); throw; }
        }
        if (finished) await Write(TunnelMux.Encode(TunnelFrame.ReqEnd, call.Id), cancel).ConfigureAwait(false);
        return await call.Head.Task.ConfigureAwait(false);
      }
    }

    internal bool IsLive(uint stream) { return calls.ContainsKey(stream); }

    /// Replaces this device's key. The server keeps the old one a few minutes so
    /// a lost reply can't strand the device.
    public async Task RotateDeviceKey(byte[] publicKey, TimeSpan timeout) {
      var waiting = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
      lock (gate) {
        if (closed) throw new TunnelException("closed");
        if (rotation != null) throw new TunnelException("busy", "This PC's key is already being changed.");
        rotation = waiting;
      }
      try {
        await Write(TunnelMux.Json(TunnelFrame.Control, 0, Wires.O("t", "rotate-device", "publicKey", Base64Url.Encode(publicKey)))).ConfigureAwait(false);
        await waiting.Task.WaitAsync(timeout).ConfigureAwait(false);
      } catch (TimeoutException e) { throw new TunnelException("timeout", null, e); }
      finally { lock (gate) { if (rotation == waiting) rotation = null; } }
    }

    /// No new requests will come here: close once the running ones finish.
    public void Retire() {
      lock (gate) retiring = true;
      CloseIfDrained();
    }
    void CloseIfDrained() {
      bool drained;
      lock (gate) drained = retiring && calls.IsEmpty;
      if (drained) Dispose();
    }

    public void Dispose() { Shutdown(new TunnelException("closed")); }

    internal async Task Write(byte[] frame, CancellationToken cancel = default(CancellationToken)) {
      await sending.WaitAsync(cancel).ConfigureAwait(false);
      try {
        if (IsClosed) throw new TunnelException("closed");
        await transport.SendAsync(session.Seal(frame)).ConfigureAwait(false);
      } catch (Exception e) when (!(e is TunnelException)) {
        var error = new TunnelException("closed", null, e);
        Shutdown(error);
        throw error;
      } finally { sending.Release(); }
    }

    /// For frames sent from the read loop: it must never wait on a send, or a
    /// stalled path would also stop us reading.
    void Post(byte[] frame) { _ = PostAsync(frame); }
    async Task PostAsync(byte[] frame) { try { await Write(frame).ConfigureAwait(false); } catch (Exception) { /* the connection is going anyway */ } }

    /// Cancels a stream from this end and tells the server.
    void Abandon(Call call, Exception reason) {
      if (!calls.TryRemove(call.Id, out _)) return;
      if (!IsClosed) Post(TunnelMux.Encode(TunnelFrame.Reset, call.Id));
      if (reason is OperationCanceledException) call.Head.TrySetCanceled(((OperationCanceledException)reason).CancellationToken); else call.Head.TrySetException(reason);
      if (call.Body != null) call.Body.Fail(reason);
      CloseIfDrained();
    }

    async Task Receive() {
      try {
        while (!IsClosed) {
          var data = await transport.ReceiveAsync(stopping.Token).ConfigureAwait(false);
          if (data == null) { Shutdown(new TunnelException("closed")); return; }
          TunnelFrame type; uint stream; ArraySegment<byte> payload;
          // A message that fails authentication means the path is being tampered
          // with. Nothing after it can be trusted, so the whole session ends.
          try { TunnelMux.Decode(session.Open(data), out type, out stream, out payload); }
          catch (CryptographicException e) { Shutdown(new TunnelException("tampered", null, e)); return; }
          Interlocked.Exchange(ref lastHeard, Environment.TickCount64);
          await Handle(type, stream, payload).ConfigureAwait(false);
        }
      } catch (TunnelException e) { Shutdown(e); }
      catch (Exception e) { Shutdown(new TunnelException("closed", null, e)); }
    }

    async Task Handle(TunnelFrame type, uint stream, ArraySegment<byte> payload) {
      Call call;
      calls.TryGetValue(stream, out call);
      switch (type) {
        case TunnelFrame.ResHead:
          if (call == null || call.Body != null) return;
          var head = Parse(payload);
          var status = (int)head["status"].Integer;
          if (status < 200 || status > 599) { Abandon(call, new TunnelException("reset")); return; }
          var body = new TunnelBody(() => Abandon(call, new TunnelException("reset")));
          call.Body = body;
          var reply = new TunnelReply { Status = status, Body = body };
          foreach (var pair in head["headers"].List) {
            var parts = pair.List;
            if (parts.Count == 2) reply.Headers.Add(new KeyValuePair<string, string>(parts[0].Text, parts[1].Text));
          }
          call.Head.TrySetResult(reply);
          return;
        case TunnelFrame.ResBody:
          if (call == null || call.Body == null) return;
          // Pauses reading when a reader falls behind, which is the only flow
          // control there is: the server stops sending when its socket backs up.
          if (!await call.Body.Push(payload).ConfigureAwait(false)) Abandon(call, new IOException("Nothing is reading this response."));
          return;
        case TunnelFrame.ResEnd:
          if (call == null) return;
          calls.TryRemove(stream, out _);
          if (call.Body != null) call.Body.End(); else call.Head.TrySetException(new TunnelException("reset"));
          CloseIfDrained();
          return;
        case TunnelFrame.Reset:
          if (call == null) return;
          calls.TryRemove(stream, out _);
          var ended = new TunnelException("reset");
          call.Head.TrySetException(ended);
          if (call.Body != null) call.Body.Fail(ended);
          CloseIfDrained();
          return;
        case TunnelFrame.Ping: Post(TunnelMux.Encode(TunnelFrame.Pong, 0)); return;
        case TunnelFrame.Control: Control(Parse(payload)); return;
        default: return;
      }
    }

    static Wire Parse(ArraySegment<byte> payload) { return Wires.Parse(Encoding.UTF8.GetString(payload)); }

    void Control(Wire message) {
      TaskCompletionSource<bool> waiting;
      lock (gate) waiting = rotation;
      switch (message["t"].Text) {
        case "rotate-device-ok": if (waiting != null) waiting.TrySetResult(true); return;
        case "rotate-device-refused":
          if (waiting != null) waiting.TrySetException(new TunnelException("refused", "Your server refused the new key.", null, true));
          return;
        case "rotate-server":
          var rotated = ServerRotated;
          if (rotated != null) rotated(message["publicKey"].Text);
          return;
        case "revoked":
          var revoked = Revoked;
          if (revoked != null) revoked();
          Shutdown(new TunnelException("revoked"));
          return;
      }
    }

    async Task KeepAlive() {
      try {
        while (!IsClosed) {
          await Task.Delay(PingEvery, stopping.Token).ConfigureAwait(false);
          if (Environment.TickCount64 - Interlocked.Read(ref lastHeard) > PingEvery.TotalMilliseconds * 2.5) { Shutdown(new TunnelException("closed")); return; }
          Post(TunnelMux.Encode(TunnelFrame.Ping, 0));
        }
      } catch (OperationCanceledException) { }
    }

    void Shutdown(TunnelException reason) {
      TaskCompletionSource<bool> waiting;
      lock (gate) {
        if (closed) return;
        closed = true;
        waiting = rotation;
      }
      stopping.Cancel();
      transport.Close();
      foreach (var entry in calls) {
        Call call;
        if (!calls.TryRemove(entry.Key, out call)) continue;
        call.Head.TrySetException(reason);
        if (call.Body != null) call.Body.Fail(reason);
      }
      if (waiting != null) waiting.TrySetException(reason);
      var handler = Closed;
      if (handler != null) handler(this);
    }
  }

  /// A response body as it arrives. Dispose it early to cancel the request: a
  /// waiting read then ends as if the body had ended, which is what the app's
  /// event-stream readers expect from a cancelled stream.
  public sealed class TunnelBody : Stream {
    const int HighWater = 16 * 1024 * 1024, LowWater = 4 * 1024 * 1024;
    /// A reader this far behind has gone. Better one failed response than a
    /// tunnel that has stopped for everything else as well.
    public static TimeSpan StallLimit = TimeSpan.FromSeconds(30);
    readonly object gate = new object();
    readonly Queue<ArraySegment<byte>> pieces = new Queue<ArraySegment<byte>>();
    readonly Action abandoned;
    long buffered;
    int used;
    bool ended, disposed;
    Exception failure;
    TaskCompletionSource<bool> reader, writer;

    internal TunnelBody(Action abandoned) { this.abandoned = abandoned; }

    /// False when the reader stopped reading altogether.
    internal async Task<bool> Push(ArraySegment<byte> piece) {
      Task drained = null;
      if (piece.Count == 0) return true;   // an empty piece must not read as the end
      lock (gate) {
        if (disposed || ended || failure != null) return true;
        pieces.Enqueue(piece);
        buffered += piece.Count;
        Wake(ref reader);
        if (buffered > HighWater) { writer = writer ?? New(); drained = writer.Task; }
      }
      if (drained == null) return true;
      try { await drained.WaitAsync(StallLimit).ConfigureAwait(false); return true; }
      catch (TimeoutException) { return false; }
    }
    internal void End() { lock (gate) { ended = true; Wake(ref reader); } }
    internal void Fail(Exception reason) { lock (gate) { if (!ended) failure = failure ?? reason; Wake(ref reader); Wake(ref writer); } }

    static TaskCompletionSource<bool> New() { return new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously); }
    static void Wake(ref TaskCompletionSource<bool> waiting) { if (waiting != null) { waiting.TrySetResult(true); waiting = null; } }

    public override async ValueTask<int> ReadAsync(Memory<byte> destination, CancellationToken cancel = default(CancellationToken)) {
      while (true) {
        Task waiting;
        lock (gate) {
          if (disposed) return 0;
          if (pieces.Count > 0) {
            var piece = pieces.Peek();
            var count = Math.Min(piece.Count - used, destination.Length);
            piece.AsMemory(used, count).CopyTo(destination);
            used += count; buffered -= count;
            if (used == piece.Count) { pieces.Dequeue(); used = 0; }
            if (buffered <= LowWater) Wake(ref writer);
            return count;
          }
          if (failure != null) {
            if (failure is OperationCanceledException) throw new OperationCanceledException(((OperationCanceledException)failure).CancellationToken);
            throw new IOException(failure.Message, failure);
          }
          if (ended || destination.Length == 0) return 0;
          reader = reader ?? New();
          waiting = reader.Task;
        }
        await waiting.WaitAsync(cancel).ConfigureAwait(false);
      }
    }
    public override Task<int> ReadAsync(byte[] destination, int offset, int count, CancellationToken cancel) { return ReadAsync(destination.AsMemory(offset, count), cancel).AsTask(); }
    public override int Read(byte[] destination, int offset, int count) { return ReadAsync(destination.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult(); }

    protected override void Dispose(bool disposing) {
      if (disposing) {
        bool abandon;
        lock (gate) {
          if (disposed) return;
          disposed = true;
          abandon = !ended && failure == null;
          pieces.Clear(); buffered = 0;
          Wake(ref reader); Wake(ref writer);
        }
        if (abandon) abandoned();
      }
      base.Dispose(disposing);
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] source, int offset, int count) { throw new NotSupportedException(); }
  }

  /// A request body going out. Small writes are gathered into full frames, since
  /// each frame costs a padded Noise message; awaiting the send is the backpressure.
  sealed class TunnelUpload : Stream {
    public sealed class Stopped : Exception { }
    readonly TunnelClient client;
    readonly uint stream;
    readonly byte[] piece = new byte[TunnelMux.MaxPiece];
    int used;

    public TunnelUpload(TunnelClient client, uint stream) { this.client = client; this.stream = stream; }

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> source, CancellationToken cancel = default(CancellationToken)) {
      while (source.Length > 0) {
        var count = Math.Min(source.Length, piece.Length - used);
        source.Slice(0, count).CopyTo(piece.AsMemory(used));
        used += count;
        source = source.Slice(count);
        if (used == piece.Length) await Finish(cancel).ConfigureAwait(false);
      }
    }
    public override Task WriteAsync(byte[] source, int offset, int count, CancellationToken cancel) { return WriteAsync(source.AsMemory(offset, count), cancel).AsTask(); }
    public override void Write(byte[] source, int offset, int count) { WriteAsync(source, offset, count, CancellationToken.None).GetAwaiter().GetResult(); }

    /// Sends what is gathered.
    public async Task Finish(CancellationToken cancel) {
      if (!client.IsLive(stream)) throw new Stopped();
      if (used == 0) return;
      var frame = TunnelMux.Encode(TunnelFrame.ReqBody, stream, piece.AsSpan(0, used));
      used = 0;
      await client.Write(frame, cancel).ConfigureAwait(false);
    }

    public override bool CanRead { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return true; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override int Read(byte[] destination, int offset, int count) { throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
  }
}
