using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Josi.Native {
  /// What Josi is doing. The same states as the Android app's Ghost.kt.
  /// What the person sees Josi doing. The header, the chip and the ghost all follow this.
  public enum JosiState { Online, Listening, Thinking, Speaking }
  public enum GhostState { Idle, Resting, Typing, Voice, Waiting, Streaming, Hello, Received, AnswerFound, ListReply, TaskDone, Error }

  /// The one thing screens talk to: they set a state, and this works out which
  /// clip is on. A one-shot plays once and hands back to the loop underneath it.
  public sealed class GhostController {
    const int MaxQueued = 2, PassesPerClip = 2, ChinTapAfterMs = 2000, ExplainMs = 3042, QuietMs = 20000;
    static readonly Dictionary<string, int> Length = new Dictionary<string, int> {
      {"idle-wiggle", 2333}, {"listening", 3042}, {"nod-along", 3042}, {"ear-cup", 3042}, {"thinking", 3042}, {"chin-tap", 3042}, {"explaining", 3042},
      {"gentle-float", 2333}, {"wave-hello", 3750}, {"got-it", 3750}, {"lightbulb", 5167}, {"counting-off", 3750}, {"celebrate", 5167}, {"oops", 5167} };
    static readonly Regex ListLine = new Regex(@"^\s*(?:[-*•]|\d+[.)])\s+.+$", RegexOptions.Multiline);

    public event Action Changed, StateChanged;
    public string Clip { get; private set; }
    public JosiState State { get; private set; }
    /// The loop underneath whatever one-shot is playing.
    public GhostState Mood { get; private set; }
    GhostState? after;
    readonly Queue<string> queue = new Queue<string>();
    bool playingOneShot;
    CancellationTokenSource turns, settling;

    public GhostController() { Clip = "idle-wiggle"; Mood = GhostState.Idle; }

    static bool OneShot(GhostState state) { return state >= GhostState.Hello; }
    static string[] Clips(GhostState state) {
      switch (state) {
        case GhostState.Resting: return new[] { "gentle-float" };
        case GhostState.Typing: return new[] { "listening", "nod-along" };
        case GhostState.Voice: return new[] { "ear-cup", "listening" };
        case GhostState.Waiting: return new[] { "thinking", "chin-tap" };
        case GhostState.Streaming: return new[] { "explaining" };
        case GhostState.Hello: return new[] { "wave-hello" };
        case GhostState.Received: return new[] { "got-it" };
        case GhostState.AnswerFound: return new[] { "lightbulb" };
        case GhostState.ListReply: return new[] { "counting-off" };
        case GhostState.TaskDone: return new[] { "celebrate" };
        case GhostState.Error: return new[] { "oops" };
        default: return new[] { "idle-wiggle" };
      }
    }
    /// Two list lines or more make a list.
    public static bool IsList(string reply) { return ListLine.Matches((reply ?? "").Replace("\r\n", "\n")).Count >= 2; }

    /// A reply as the stage shows it: the sentence, its list if it has one, and what follows the list.
    public sealed class ReplyParts { public string Lead = "", Tail = ""; public List<string> Items = new List<string>(); }
    public static ReplyParts Parts(string reply) {
      var clean = Regex.Replace((reply ?? "").Replace("\r\n", "\n").Trim(), @"^#{1,6}\s+", "", RegexOptions.Multiline);
      var lines = clean.Split('\n');
      var parts = new ReplyParts();
      if (!IsList(clean)) { parts.Lead = clean; return parts; }
      parts.Items = lines.Where(l => ListLine.IsMatch(l)).Select(l => Regex.Replace(l, @"^\s*(?:[-*•]|\d+[.)])\s+", "").Trim()).ToList();
      parts.Lead = string.Join(" ", lines.TakeWhile(l => !ListLine.IsMatch(l))).Trim();
      parts.Tail = string.Join(" ", lines.Reverse().TakeWhile(l => !ListLine.IsMatch(l)).Reverse()).Trim();
      return parts;
    }
    /// The pace of a reply coming in. A long one speeds up, so it never takes over about 3.5 seconds.
    public static int RevealStepMs(int words) { return words == 0 ? 0 : Math.Min(70, 3500 / words); }

    void Publish() {
      var now = Mood == GhostState.Voice || Mood == GhostState.Typing ? JosiState.Listening
        : Mood == GhostState.Waiting ? JosiState.Thinking
        : after == GhostState.Streaming || Mood == GhostState.Streaming ? JosiState.Speaking : JosiState.Online;
      if (now == State) return;
      State = now;
      var handler = StateChanged; if (handler != null) handler();
    }

    void Show(string clip) {
      if (Clip == clip) return;
      Clip = clip;
      var handler = Changed; if (handler != null) handler();
    }
    static void Stop(ref CancellationTokenSource source) { if (source != null) { source.Cancel(); source = null; } }

    public void Set(GhostState state) {
      if (OneShot(state)) {
        if (queue.Count < MaxQueued) queue.Enqueue(Clips(state)[0]);
        if (!playingOneShot) PlayNext();
        return;
      }
      if (state == Mood) return;
      Mood = state;
      if (state != GhostState.Idle) { Stop(ref settling); after = null; }
      Publish();
      ShowLoop();
    }

    /// A new reply: the moment it lands, explaining for a while, then a brief float.
    public void Replied(string body) {
      Set(IsList(body) ? GhostState.ListReply : GhostState.AnswerFound);
      Stop(ref settling);
      after = GhostState.Streaming;
      Publish();
      settling = new CancellationTokenSource();
      Settle(settling.Token);
    }
    async void Settle(CancellationToken token) {
      try {
        while (playingOneShot) await Task.Delay(100, token);
        await Task.Delay(ExplainMs, token);
        after = GhostState.Resting; Publish(); ShowLoop();
        await Task.Delay(Length["gentle-float"], token);
        after = null; ShowLoop();
      } catch (TaskCanceledException) { }
    }

    async void PlayNext() {
      if (queue.Count == 0) { playingOneShot = false; ShowLoop(); return; }
      Stop(ref turns);
      playingOneShot = true;
      var next = queue.Dequeue();
      Show(next);
      await Task.Delay(Length[next]);
      PlayNext();
    }

    void ShowLoop() {
      if (playingOneShot) return;
      Stop(ref turns);
      var state = after ?? Mood;
      Show(Clips(state)[0]);
      if (state != GhostState.Waiting && state != GhostState.Typing && state != GhostState.Voice && state != GhostState.Idle) return;
      turns = new CancellationTokenSource();
      Turn(state, turns.Token);
    }
    async void Turn(GhostState state, CancellationToken token) {
      try {
        if (state == GhostState.Waiting) { await Task.Delay(ChinTapAfterMs, token); Show("chin-tap"); return; }
        if (state == GhostState.Typing || state == GhostState.Voice) {
          var clips = Clips(state);
          for (var turn = 1; ; turn++) { await Task.Delay(Length[Clip] * PassesPerClip, token); Show(clips[turn % clips.Length]); }
        }
        while (true) {
          await Task.Delay(QuietMs, token); Show("gentle-float");
          await Task.Delay(Length["gentle-float"], token); Show("idle-wiggle");
        }
      } catch (TaskCanceledException) { }
    }
  }

  /// One clip being played. A worker decodes a few frames ahead of the playhead.
  /// WPF can't play transparent video, so tools/build-ghost.mjs packs each clip as
  /// premultiplied JPEG colour plus PNG alpha, and this joins them. A loop keeps
  /// its frames, so it stops decoding after one pass; a one-shot drops them as it goes.
  sealed class GhostStream : IDisposable {
    const int Ahead = 10, MaxPooled = 96;
    static readonly System.Collections.Concurrent.ConcurrentBag<byte[]> Pool = new System.Collections.Concurrent.ConcurrentBag<byte[]>();
    byte[] mask;
    readonly byte[] pack;
    readonly int[] colourAt, colourLength, alphaAt, alphaLength;
    readonly byte[][] frames;
    readonly bool keep;
    readonly AutoResetEvent wake = new AutoResetEvent(false);
    volatile int head;
    volatile bool stopped;
    public volatile bool Failed;
    public readonly int Width, Height, Count;

    public GhostStream(string clip, bool loop) {
      keep = loop;
      try {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ghost/" + clip + ".ghost"))
        using (var memory = new MemoryStream()) { stream.CopyTo(memory); pack = memory.ToArray(); }
        if (pack[0] != 'J' || pack[1] != 'G' || pack[2] != 'H' || pack[3] != 'O') throw new InvalidDataException();
        Width = BitConverter.ToInt32(pack, 4); Height = BitConverter.ToInt32(pack, 8); Count = BitConverter.ToInt32(pack, 12);
        colourAt = new int[Count]; colourLength = new int[Count]; alphaAt = new int[Count]; alphaLength = new int[Count];
        var at = 16;
        for (var i = 0; i < Count; i++) {
          colourLength[i] = BitConverter.ToInt32(pack, at); alphaLength[i] = BitConverter.ToInt32(pack, at + 4);
          colourAt[i] = at + 8; alphaAt[i] = colourAt[i] + colourLength[i];
          at = alphaAt[i] + alphaLength[i];
        }
        frames = new byte[Count][];
        var worker = new Thread(Work) { IsBackground = true, Name = "Ghost " + clip };
        worker.Start();
      } catch (Exception) { Failed = true; frames = new byte[0][]; }
    }

    public byte[] Frame(int index) { return index < frames.Length ? frames[index] : null; }
    public void MoveTo(int index) { if (head != index) { head = index; wake.Set(); } }
    public void Dispose() { stopped = true; wake.Set(); }

    int Wanted(int offset) { var at = head + offset; return keep ? at % Count : Math.Min(at, Count - 1); }

    void Work() {
      try {
        while (!stopped) {
          var busy = false;
          for (var k = 0; k < Ahead && !stopped; k++) {
            var index = Wanted(k);
            if (frames[index] != null) continue;
            frames[index] = Join(index);
            busy = true;
            break;
          }
          if (!keep) for (var i = 0; i < head - 1; i++) Drop(i);
          if (!busy) wake.WaitOne(250);
        }
        for (var i = 0; i < Count; i++) Drop(i);
      } catch (Exception) { Failed = true; }
    }
    void Drop(int index) {
      var frame = frames[index];
      if (frame == null) return;
      frames[index] = null;
      if (Pool.Count < MaxPooled) Pool.Add(frame);
    }

    byte[] Join(int index) {
      byte[] pixels;
      if (!Pool.TryTake(out pixels) || pixels.Length != Width * Height * 4) pixels = new byte[Width * Height * 4];
      if (mask == null) mask = new byte[Width * Height];
      Read(colourAt[index], colourLength[index], PixelFormats.Bgr32, pixels, Width * 4);
      Read(alphaAt[index], alphaLength[index], PixelFormats.Gray8, mask, Width);
      for (var i = 0; i < mask.Length; i++) {
        var a = mask[i]; var at = i * 4;
        // JPEG can overshoot; premultiplied colour must never be brighter than its alpha.
        if (pixels[at] > a) pixels[at] = a;
        if (pixels[at + 1] > a) pixels[at + 1] = a;
        if (pixels[at + 2] > a) pixels[at + 2] = a;
        pixels[at + 3] = a;
      }
      return pixels;
    }
    void Read(int at, int length, PixelFormat format, byte[] into, int stride) {
      using (var source = new MemoryStream(pack, at, length, false)) {
        var frame = BitmapDecoder.Create(source, BitmapCreateOptions.None, BitmapCacheOption.OnLoad).Frames[0];
        new FormatConvertedBitmap(frame, format, null, 0).CopyPixels(into, stride, 0);
      }
    }

    public static BitmapImage Still() {
      var image = new BitmapImage();
      image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad;
      image.StreamSource = Assembly.GetExecutingAssembly().GetManifestResourceStream("ghost/still.png");
      image.EndInit(); image.Freeze();
      return image;
    }
  }

  /// The mascot, from the real Masko clips. Two layers, so the next clip starts
  /// behind the one on screen and they crossfade. Shows the still pose with Windows
  /// animations off, and the gold J if a clip can't be read.
  public sealed class GhostView : UserControl {
    const double FramesPerSecond = 24;
    static readonly TimeSpan Crossfade = TimeSpan.FromMilliseconds(260);

    sealed class Layer { public Image Image; public WriteableBitmap Bitmap; public GhostStream Stream; public int Shown = -1; public bool Loop; }
    readonly GhostController controller;
    readonly Grid stage = new Grid();
    readonly Layer[] layers = new Layer[2];
    // Background, like the app's polling timer, so the ghost can never starve it.
    readonly DispatcherTimer timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(1 / FramesPerSecond) };
    readonly Stopwatch clock = new Stopwatch();
    readonly ScaleTransform pop = new ScaleTransform(1, 1);
    readonly System.Windows.Shapes.Ellipse glow;
    int front;
    bool waiting, broken;
    string wanted;

    public static bool Still { get { return !SystemParameters.ClientAreaAnimation || Environment.GetEnvironmentVariable("JOSI_REDUCE_MOTION") == "1"; } }
    static bool Loops(string clip) { return Array.IndexOf(new[] { "idle-wiggle", "listening", "thinking", "gentle-float", "nod-along", "ear-cup", "chin-tap", "explaining" }, clip) >= 0; }

    public GhostView(GhostController controller, double size, bool glowing = false) {
      this.controller = controller;
      Width = size; Height = size; Focusable = false; IsHitTestVisible = false;
      Content = stage;
      stage.RenderTransformOrigin = new Point(0.5, 0.75); stage.RenderTransform = pop;
      System.Windows.Automation.AutomationProperties.SetAutomationId(this, "josi.ghost");
      if (glowing) {
        glow = new System.Windows.Shapes.Ellipse { VerticalAlignment = VerticalAlignment.Bottom, RenderTransformOrigin = new Point(0.5, 0.5) };
        stage.Children.Add(glow); Glow("idle-wiggle");
        SizeChanged += delegate { glow.Width = ActualWidth * 0.64; glow.Height = ActualHeight * 0.16; };
      }
      if (Still) {
        try { stage.Children.Add(Picture(GhostStream.Still(), 1)); }
        catch (Exception) { Fallback(); }
        return;
      }
      if (glow != null) {
        var breathe = new ScaleTransform(1, 1); glow.RenderTransform = breathe;
        var move = new DoubleAnimation(1, 0.82, TimeSpan.FromSeconds(1.2)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever };
        Timeline.SetDesiredFrameRate(move, 20);
        breathe.BeginAnimation(ScaleTransform.ScaleXProperty, move);
      }
      for (var i = 0; i < 2; i++) { layers[i] = new Layer { Image = Picture(null, 0) }; stage.Children.Add(layers[i].Image); }
      timer.Tick += delegate { Tick(); };
      Loaded += delegate { controller.Changed += Follow; Follow(); timer.Start(); };
      Unloaded += delegate { controller.Changed -= Follow; timer.Stop(); };
    }

    public void Resize(double size) { Width = size; Height = size; }

    static Image Picture(ImageSource source, double opacity) {
      var image = new Image { Source = source, Opacity = opacity, Stretch = Stretch.Uniform };
      RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.HighQuality);
      return image;
    }

    /// The light under the ghost, which takes the colour of what Josi is doing.
    void Glow(string clip) {
      if (glow == null) return;
      var p = Skin.Current;
      var colour = clip == "listening" || clip == "nod-along" || clip == "ear-cup" ? Skin.Hex("9ED6D8", 0x8C)
        : clip == "thinking" || clip == "chin-tap" ? Skin.Hex(p.Gold2, 0xB3)
        : clip == "oops" ? Skin.Hex(p.Error, 0x8C)
        : clip == "celebrate" ? Skin.Hex(p.Sheen, 0xD9)
        : Skin.Hex(p.Gold2, 0x61);
      var clear = colour; clear.A = 0;
      var fill = new RadialGradientBrush(colour, clear); fill.Freeze();
      glow.Fill = fill;
    }

    void Follow() {
      var clip = controller.Clip;
      System.Windows.Automation.AutomationProperties.SetItemStatus(this, clip);
      if (clip == wanted || broken) return;
      wanted = clip;
      var back = layers[1 - front];
      back.Image.BeginAnimation(OpacityProperty, null); back.Image.Opacity = 0;
      if (back.Stream != null) back.Stream.Dispose();
      back.Loop = Loops(clip); back.Stream = new GhostStream(clip, back.Loop); back.Shown = -1;
      waiting = true;
    }

    void Tick() {
      if (broken) return;
      var window = Application.Current == null ? null : Application.Current.MainWindow;
      if (!IsVisible || (window != null && window.WindowState == WindowState.Minimized)) return;
      if (waiting) {
        var next = layers[1 - front];
        if (next.Stream.Failed) { Fallback(); return; }
        if (next.Stream.Frame(0) == null) return;
        waiting = false;
        var old = layers[front];
        front = 1 - front;
        clock.Restart();
        Draw(next);
        Glow(wanted);
        var duration = old.Stream == null ? TimeSpan.Zero : Crossfade;
        next.Image.BeginAnimation(OpacityProperty, new DoubleAnimation(1, duration));
        var fade = new DoubleAnimation(0, duration);
        var leaving = old.Stream;
        fade.Completed += delegate { if (leaving != null && old.Stream == leaving) { leaving.Dispose(); old.Stream = null; } };
        old.Image.BeginAnimation(OpacityProperty, fade);
        if (!next.Loop) Pop();
        return;
      }
      var layer = layers[front];
      if (layer.Stream != null) Draw(layer);
    }

    /// A one-shot lands with a bounce.
    void Pop() {
      var bounce = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromMilliseconds(520) };
      bounce.KeyFrames.Add(new EasingDoubleKeyFrame(1.09, KeyTime.FromPercent(0.4), new QuadraticEase { EasingMode = EasingMode.EaseOut }));
      bounce.KeyFrames.Add(new EasingDoubleKeyFrame(1, KeyTime.FromPercent(1), new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.6 }));
      pop.BeginAnimation(ScaleTransform.ScaleXProperty, bounce);
      pop.BeginAnimation(ScaleTransform.ScaleYProperty, bounce);
    }

    /// Timed from the clock, so a slow tick skips a frame and never drifts. A frame
    /// not decoded yet holds the last one.
    void Draw(Layer layer) {
      var stream = layer.Stream;
      if (stream.Count == 0) return;
      var at = (int)(clock.Elapsed.TotalSeconds * FramesPerSecond);
      at = layer.Loop ? at % stream.Count : Math.Min(at, stream.Count - 1);
      stream.MoveTo(at);
      if (at == layer.Shown) return;
      var pixels = stream.Frame(at);
      if (pixels == null) return;
      if (layer.Bitmap == null) {
        layer.Bitmap = new WriteableBitmap(stream.Width, stream.Height, 96, 96, PixelFormats.Pbgra32, null);
        layer.Image.Source = layer.Bitmap;
      }
      layer.Bitmap.WritePixels(new Int32Rect(0, 0, stream.Width, stream.Height), pixels, stream.Width * 4, 0);
      layer.Shown = at;
    }

    void Fallback() {
      broken = true; timer.Stop();
      stage.Children.Clear();
      var mark = Ui.JosiMark(Math.Max(Width, 60) * 0.6);
      mark.HorizontalAlignment = HorizontalAlignment.Center; mark.VerticalAlignment = VerticalAlignment.Center;
      stage.Children.Add(mark);
    }
  }
}
