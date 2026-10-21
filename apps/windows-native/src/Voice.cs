using System;
using System.Collections.Generic;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Josi.Native {
  public enum VoiceMode { None, Dictation, Conversation }

  /// Dictation and voice conversation through the server's Voice Box. The
  /// microphone opens only after an explicit Dictate or Voice chat action and
  /// closes with Stop; audio goes only to the connected Josi server.
  public sealed class Voice {
    readonly AppModel model;
    public event Action Changed;
    public bool Available, Starting, Speaking;
    public VoiceMode Mode = VoiceMode.None;
    public string Partial = "", Error = "";
    public Wire Settings = Wire.Null;
    JosiApi api;
    string session = "";
    int sequence, generation, speechGeneration, pendingTurns;
    readonly List<byte> frames = new List<byte>();
    bool pumping;
    Func<string, Task<string>> onText;
    Task turnChain = Task.FromResult(0);
    Microphone microphone;
    SoundPlayer player;

    public Voice(AppModel model) { this.model = model; }
    void Notify() { var handler = Changed; if (handler != null) handler(); }

    public string ModelLabel {
      get {
        if (!Available) return "Voice Box · Setup";
        var voice = Settings["settings"]["voice"].Text;
        return voice == "af_bella" ? "Kokoro · Bella" : voice == "af_heart" ? "Kokoro · Heart" : "Voice Box · Ready";
      }
    }
    public async Task Refresh(JosiApi target) {
      try {
        Available = (await target.Request("/voice/status"))["available"].Flag;
        if (model.IsAdministrator) Settings = await target.Request("/admin/voice-box");
      } catch (JosiException e) { Available = false; Error = e.Status == 404 ? "" : e.Message; }
      Notify();
    }

    public async void Start(VoiceMode mode, JosiApi target, Func<string, Task<string>> handler) {
      if (Mode != VoiceMode.None || Starting) return;
      Starting = true; Error = ""; generation++;
      var mine = generation;
      Notify();
      try {
        var opened = (await target.Request("/voice/session", "POST", Wires.O()))["session"].Text;
        if (!Regex.IsMatch(opened, "^[a-f0-9]{48}$")) throw new JosiException("Voice Box could not open a session.");
        if (mine != generation) { Close(target, opened); return; }
        api = target; session = opened; onText = handler; Mode = mode; sequence = 0; frames.Clear(); Partial = "";
        microphone = new Microphone(bytes => Enqueue(bytes, mine));
        microphone.Start();
      } catch (Exception e) { Error = AppModel.Friendly(e); Stop(); }
      finally { if (mine == generation) Starting = false; Notify(); }
    }
    void Enqueue(byte[] bytes, int mine) {
      if (mine != generation || Mode == VoiceMode.None) return;
      frames.AddRange(bytes);
      if (frames.Count > 480000) { Error = "Voice processing is falling behind. Stop other workloads and try again."; Stop(); return; }
      if (!pumping) Pump(mine);
    }
    async void Pump(int mine) {
      pumping = true;
      var target = api; var opened = session;
      try {
        while (frames.Count > 0 && mine == generation) {
          var count = Math.Min(32000, frames.Count);
          var pcm = frames.GetRange(0, count).ToArray(); frames.RemoveRange(0, count);
          var body = Wires.O("session", opened, "seq", sequence, "pcm", Convert.ToBase64String(pcm));
          Wire result;
          try { result = await target.Request("/voice/audio", "POST", body); }
          catch (JosiException e) {
            if (e.Status != 429) throw;
            result = null;
          }
          if (result == null) { await Task.Delay(250); result = await target.Request("/voice/audio", "POST", body); }
          if (mine != generation) break;
          sequence++;
          foreach (var evt in result["events"].List) {
            switch (evt["type"].Text) {
              case "speech_start": Interrupt(); break;
              case "partial": Partial = evt["text"].Text; Notify(); break;
              case "final":
                var text = evt["text"].Text.Trim();
                Partial = ""; Notify();
                if (text.Length > 0) Accept(text, mine);
                break;
            }
          }
        }
      } catch (Exception e) {
        if (mine == generation) { Error = AppModel.Friendly(e); Stop(); }
      } finally { pumping = false; }
    }
    void Accept(string text, int mine) {
      var handler = onText;
      if (handler == null || pendingTurns >= 3) { Error = "Please wait for Josi to finish answering."; Notify(); return; }
      pendingTurns++;
      var previous = turnChain;
      turnChain = Chain(previous, text, handler, mine);
    }
    async Task Chain(Task previous, string text, Func<string, Task<string>> handler, int mine) {
      try { await previous; } catch (Exception) { }
      if (mine != generation) return;
      try {
        var reply = await handler(text);
        if (reply != null && Mode == VoiceMode.Conversation && mine == generation && api != null) await Speak(reply, api);
      } catch (Exception e) { if (mine == generation) { Error = AppModel.Friendly(e); Notify(); } }
      finally { if (mine == generation) pendingTurns--; }
    }

    public void ToggleSpeak(string text) {
      if (Speaking) { Interrupt(); return; }
      var target = model.Api; if (target == null) return;
      Speak(text, target).ContinueWith(t => { if (t.Exception != null) { Error = AppModel.Friendly(t.Exception.InnerException); Notify(); } }, TaskScheduler.FromCurrentSynchronizationContext());
    }
    public async Task Speak(string text, JosiApi target) {
      Interrupt();
      var mine = speechGeneration;
      Speaking = true; Notify();
      try {
        var remaining = (text ?? "").Trim();
        while (remaining.Length > 0 && mine == speechGeneration) {
          var chunk = remaining.Length > 400 ? remaining.Substring(0, 400) : remaining;
          remaining = remaining.Substring(chunk.Length);
          var audio = await target.VoiceAudio("/voice/speech", Wires.O("text", chunk));
          if (mine != speechGeneration) return;
          var sound = new SoundPlayer(new MemoryStream(audio));
          player = sound;
          try { await Task.Run(() => sound.PlaySync()); }
          catch (InvalidOperationException) { throw new JosiException("Josi could not play the voice reply."); }
        }
      } finally { if (mine == speechGeneration) { Speaking = false; player = null; Notify(); } }
    }
    public void Interrupt() {
      speechGeneration++;
      var current = player; player = null;
      if (current != null) { try { current.Stop(); } catch (Exception) { } }
      if (Speaking) { Speaking = false; Notify(); }
    }
    public void Stop() {
      generation++; Starting = false;
      if (microphone != null) { microphone.Dispose(); microphone = null; }
      Mode = VoiceMode.None; Partial = ""; frames.Clear(); Interrupt(); pendingTurns = 0; onText = null;
      var target = api; var opened = session;
      api = null; session = "";
      if (target != null && opened.Length > 0) Close(target, opened);
      Notify();
    }
    static async void Close(JosiApi target, string opened) {
      try { await target.Request("/voice/close", "POST", Wires.O("session", opened)); } catch (Exception) { }
    }
  }

  /// 16 kHz mono 16-bit PCM from the default Windows recording device through
  /// waveIn. Completed buffers are collected on the UI thread, never in the
  /// driver callback.
  sealed class Microphone : IDisposable {
    const int Rate = 16000, BufferBytes = 3200, Buffers = 6, WhdrDone = 1;
    [StructLayout(LayoutKind.Sequential)] struct WaveFormat { public short Tag, Channels; public int Rate, BytesPerSecond; public short Align, Bits, Extra; }
    [StructLayout(LayoutKind.Sequential)] struct WaveHeader { public IntPtr Data; public int Length, Recorded; public IntPtr User; public int Flags, Loops; public IntPtr Next, Reserved; }
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, int device, ref WaveFormat format, IntPtr callback, IntPtr instance, int flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, int size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);

    readonly Action<byte[]> deliver;
    readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(40) };
    readonly IntPtr[] headers = new IntPtr[Buffers];
    readonly IntPtr[] data = new IntPtr[Buffers];
    IntPtr handle;
    bool disposed;
    static readonly int HeaderSize = Marshal.SizeOf(typeof(WaveHeader));

    public Microphone(Action<byte[]> deliver) { this.deliver = deliver; timer.Tick += delegate { Collect(); }; }
    public void Start() {
      var format = new WaveFormat { Tag = 1, Channels = 1, Rate = Rate, Bits = 16, Align = 2, BytesPerSecond = Rate * 2 };
      var result = waveInOpen(out handle, -1, ref format, IntPtr.Zero, IntPtr.Zero, 0);
      if (result != 0) {
        handle = IntPtr.Zero;
        throw new JosiException("Josi could not open the microphone. Check Settings → Privacy & security → Microphone, and choose an input device in Sound settings.");
      }
      for (var i = 0; i < Buffers; i++) {
        data[i] = Marshal.AllocHGlobal(BufferBytes);
        headers[i] = Marshal.AllocHGlobal(HeaderSize);
        Marshal.StructureToPtr(new WaveHeader { Data = data[i], Length = BufferBytes }, headers[i], false);
        waveInPrepareHeader(handle, headers[i], HeaderSize);
        waveInAddBuffer(handle, headers[i], HeaderSize);
      }
      if (waveInStart(handle) != 0) { Dispose(); throw new JosiException("The microphone could not start."); }
      timer.Start();
    }
    void Collect() {
      if (disposed) return;
      for (var i = 0; i < Buffers; i++) {
        var header = (WaveHeader)Marshal.PtrToStructure(headers[i], typeof(WaveHeader));
        if ((header.Flags & WhdrDone) == 0) continue;
        if (header.Recorded > 0) {
          var bytes = new byte[header.Recorded];
          Marshal.Copy(header.Data, bytes, 0, header.Recorded);
          deliver(bytes);
          if (disposed) return;
        }
        waveInUnprepareHeader(handle, headers[i], HeaderSize);
        Marshal.StructureToPtr(new WaveHeader { Data = data[i], Length = BufferBytes }, headers[i], false);
        waveInPrepareHeader(handle, headers[i], HeaderSize);
        waveInAddBuffer(handle, headers[i], HeaderSize);
      }
    }
    public void Dispose() {
      if (disposed) return;
      disposed = true; timer.Stop();
      if (handle != IntPtr.Zero) {
        waveInReset(handle);
        for (var i = 0; i < Buffers; i++) if (headers[i] != IntPtr.Zero) waveInUnprepareHeader(handle, headers[i], HeaderSize);
        waveInClose(handle); handle = IntPtr.Zero;
      }
      for (var i = 0; i < Buffers; i++) {
        if (headers[i] != IntPtr.Zero) { Marshal.FreeHGlobal(headers[i]); headers[i] = IntPtr.Zero; }
        if (data[i] != IntPtr.Zero) { Marshal.FreeHGlobal(data[i]); data[i] = IntPtr.Zero; }
      }
    }
  }
}
