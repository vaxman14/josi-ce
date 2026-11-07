using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using Microsoft.Win32;

namespace Josi.Native {
  /// Every colour the app draws comes from here, matching JosiTheme.swift. A
  /// skin is one palette, so a new skin is one entry and nothing else changes.
  public sealed class Palette {
    public string Top, Bottom, Panel, Raised, Deep, Text, Lilac, Muted, Border, Gold1, Gold2, Gold3, Sheen, Error, Success, OnGold, TileTop;
  }

  public static class Skin {
    public const string PlumGold = "plumGold", Classic = "classic";
    const string Key = @"Software\Josi", Value = "Skin";

    static readonly Palette Plum = new Palette {
      Top = "43264A", Bottom = "150B19", Panel = "2C1A33", Raised = "1B0F20", Deep = "1B0F20", Text = "F3E9F2", Lilac = "B9A0BD", Muted = "8C7491",
      Border = "6B4D72", Gold1 = "FFE7A3", Gold2 = "F0CF7A", Gold3 = "C49536", Sheen = "FFF1C4", Error = "E8746A", Success = "7FD39A", OnGold = "1B0F20", TileTop = "5A2F63" };
    static readonly Palette Navy = new Palette {
      Top = "141E30", Bottom = "0B111E", Panel = "101728", Raised = "1F283D", Deep = "141E30", Text = "FDF6EA", Lilac = "9DABBE", Muted = "7C8AA0",
      Border = "252D41", Gold1 = "FFB469", Gold2 = "F6831E", Gold3 = "C8620C", Sheen = "FFD2A6", Error = "E8746A", Success = "7FD39A", OnGold = "0B111E", TileTop = "1F283D" };

    /// The skin saved for this Windows account. JOSI_SKIN overrides it for test runs.
    public static string Name {
      get {
        var chosen = Environment.GetEnvironmentVariable("JOSI_SKIN");
        if (string.IsNullOrEmpty(chosen)) {
          try { using (var key = Registry.CurrentUser.OpenSubKey(Key)) chosen = key == null ? null : key.GetValue(Value) as string; }
          catch (Exception) { chosen = null; }
        }
        return chosen == Classic ? Classic : PlumGold;
      }
      set { using (var key = Registry.CurrentUser.CreateSubKey(Key)) key.SetValue(Value, value == Classic ? Classic : PlumGold); }
    }
    public static readonly Palette Current = Name == Classic ? Navy : Plum;

    /// Theme.xaml is written in the Classic hex values. A skin swaps them as text
    /// before it is parsed, which keeps every alpha-tinted variant in step.
    public static string Apply(string theme) {
      var p = Current;
      var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
        {"0B111E", p.Bottom}, {"141E30", p.Deep}, {"101728", p.Panel}, {"1F283D", p.Raised}, {"252D41", p.Border},
        {"F6831E", p.Gold2}, {"FDF6EA", p.Text}, {"9DABBE", p.Lilac}, {"1F6F8F", p.Gold2},
      };
      return Regex.Replace(theme, "(?<=#(?:[0-9A-Fa-f]{2})?)(" + string.Join("|", map.Keys) + ")(?![0-9A-Fa-f])", m => map[m.Value]);
    }

    public static Color Hex(string value, byte alpha = 255) {
      var rgb = Convert.ToInt32(value, 16);
      return Color.FromArgb(alpha, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
    }
    public static SolidColorBrush Solid(string value, byte alpha = 255) {
      var brush = new SolidColorBrush(Hex(value, alpha)); brush.Freeze(); return brush;
    }
    /// A colour as Windows wants it for the title bar: 0x00BBGGRR.
    public static int ColorRef(string value) {
      var c = Hex(value); return c.R | c.G << 8 | c.B << 16;
    }
    public static LinearGradientBrush GoldGradient() {
      var p = Current;
      var brush = new LinearGradientBrush(new GradientStopCollection {
        new GradientStop(Hex(p.Gold1), 0), new GradientStop(Hex(p.Gold2), 0.5), new GradientStop(Hex(p.Gold3), 1) }, new Point(0, 0), new Point(1, 1));
      brush.Freeze(); return brush;
    }
    /// The send button: gold with a sheen that slowly crosses it.
    public static LinearGradientBrush SendFill() {
      var p = Current;
      var move = new TranslateTransform();
      var brush = new LinearGradientBrush(new GradientStopCollection {
        new GradientStop(Hex(p.Gold3), 0), new GradientStop(Hex(p.Gold2), 0.32), new GradientStop(Hex(p.Sheen), 0.5), new GradientStop(Hex(p.Gold2), 0.68), new GradientStop(Hex(p.Gold3), 1) },
        new Point(0, 0), new Point(1, 0)) { SpreadMethod = GradientSpreadMethod.Repeat, RelativeTransform = move };
      if (SystemParameters.ClientAreaAnimation) {
        var cross = new DoubleAnimation(-1, 1, TimeSpan.FromSeconds(3.5)) { RepeatBehavior = RepeatBehavior.Forever };
        Timeline.SetDesiredFrameRate(cross, 30);
        move.BeginAnimation(TranslateTransform.XProperty, cross);
      }
      return brush;
    }
    /// The window's background, lit from the top.
    public static RadialGradientBrush Backdrop() {
      var p = Current;
      var brush = new RadialGradientBrush(Hex(p.Top), Hex(p.Bottom)) { Center = new Point(0.5, 0), GradientOrigin = new Point(0.5, 0), RadiusX = 1.2, RadiusY = 1.1 };
      brush.Freeze(); return brush;
    }
  }

  /// Slow gold stars behind everything. Still when Windows animations are off.
  public sealed class Stars : Canvas {
    sealed class Star { public double X, Y; public Ellipse Dot; }
    readonly List<Star> stars = new List<Star>();

    public Stars() {
      IsHitTestVisible = false; Focusable = false;
      var fill = Skin.Solid(Skin.Current.Gold2);
      ulong seed = 0x4A051234;
      Func<double> next = () => { seed = unchecked(seed * 6364136223846793005UL + 1442695040888963407UL); return (seed >> 33) / (double)(1UL << 31); };
      var moving = SystemParameters.ClientAreaAnimation;
      for (var i = 0; i < 46; i++) {
        double x = next(), y = next(), phase = next() * 3, opacity = 0.3 + next() * 0.6;
        var dot = new Ellipse { Width = 2, Height = 2, Fill = fill, Opacity = opacity };
        Children.Add(dot);
        stars.Add(new Star { X = x, Y = y, Dot = dot });
        if (!moving) continue;
        var twinkle = new DoubleAnimation(opacity, opacity * 0.15, TimeSpan.FromSeconds(1.5)) {
          AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, BeginTime = TimeSpan.FromSeconds(-phase) };
        Timeline.SetDesiredFrameRate(twinkle, 12);
        dot.BeginAnimation(OpacityProperty, twinkle);
      }
      SizeChanged += delegate {
        foreach (var star in stars) { SetLeft(star.Dot, star.X * ActualWidth); SetTop(star.Dot, star.Y * ActualHeight); }
      };
    }
  }
}
