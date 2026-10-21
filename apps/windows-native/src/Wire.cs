using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace Josi.Native {
  /// Wire values stay in memory. No server response, login or Vault material is
  /// written to preferences, a cookie file, a diagnostic log or a web renderer.
  public sealed class Wire {
    public static readonly Wire Null = new Wire(null);
    readonly object value;
    public Wire(object value) { this.value = value is Wire ? ((Wire)value).value : value; }
    public object Raw { get { return value; } }
    public bool IsNull { get { return value == null; } }

    public Wire this[string key] {
      get {
        var map = value as IDictionary<string, object>;
        object found;
        return map != null && map.TryGetValue(key, out found) ? new Wire(found) : Null;
      }
    }
    public string Text { get { return value as string ?? ""; } }
    public bool Flag { get { return value is bool && (bool)value; } }
    public bool IsBool { get { return value is bool; } }
    public bool IsNumber { get { return value is int || value is long || value is double || value is decimal || value is float; } }
    public double Number {
      get {
        if (!IsNumber) return 0;
        var n = System.Convert.ToDouble(value, CultureInfo.InvariantCulture);
        return double.IsNaN(n) || double.IsInfinity(n) ? 0 : n;
      }
    }
    public long Integer {
      get {
        var n = Number;
        return Math.Abs(n) < 9e15 ? (long)n : 0;
      }
    }
    public List<Wire> List {
      get {
        var result = new List<Wire>();
        var items = value as IEnumerable;
        if (items == null || value is string || value is IDictionary) return result;
        foreach (var item in items) result.Add(new Wire(item));
        return result;
      }
    }
    public string Id { get { var id = this["id"].Text; return id.Length == 0 ? this["goalId"].Text : id; } }
    public string Json { get { return Wires.Serialize(value); } }
    public bool Same(Wire other) { return Json == (other == null ? "null" : other.Json); }
    public bool Contains(string key) {
      var map = value as IDictionary<string, object>;
      return map != null && map.ContainsKey(key);
    }
    public override string ToString() { return Text; }
  }

  public static class Wires {
    static readonly JsonSerializerOptions Options = new JsonSerializerOptions { MaxDepth = 64 };
    public static Wire Parse(string json) {
      if (string.IsNullOrEmpty(json)) return Wire.Null;
      try {
        using (var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 64 }))
          return new Wire(Convert(document.RootElement));
      } catch (JsonException) { return Wire.Null; }
    }
    /// Plain CLR shapes: Dictionary<string, object>, List<object>, string, long/double, bool, null.
    static object Convert(JsonElement element) {
      switch (element.ValueKind) {
        case JsonValueKind.Object:
          var map = new Dictionary<string, object>();
          foreach (var property in element.EnumerateObject()) map[property.Name] = Convert(property.Value);
          return map;
        case JsonValueKind.Array:
          var list = new List<object>();
          foreach (var item in element.EnumerateArray()) list.Add(Convert(item));
          return list;
        case JsonValueKind.String: return element.GetString();
        case JsonValueKind.Number:
          long whole; if (element.TryGetInt64(out whole)) return whole;
          return element.GetDouble();
        case JsonValueKind.True: return true;
        case JsonValueKind.False: return false;
        default: return null;
      }
    }
    public static string Serialize(object value) {
      return JsonSerializer.Serialize(Unwrap(value), Options);
    }
    static object Unwrap(object value) {
      var wire = value as Wire;
      if (wire != null) return wire.Raw;
      var map = value as IDictionary<string, object>;
      if (map != null) {
        var copy = new Dictionary<string, object>();
        foreach (var pair in map) copy[pair.Key] = Unwrap(pair.Value);
        return copy;
      }
      if (value is string || value == null) return value;
      var list = value as IEnumerable;
      if (list != null) {
        var copy = new List<object>();
        foreach (var item in list) copy.Add(Unwrap(item));
        return copy;
      }
      return value;
    }
    /// Object literal: O("key", value, "key2", value2).
    public static Dictionary<string, object> O(params object[] pairs) {
      var result = new Dictionary<string, object>();
      for (var i = 0; i + 1 < pairs.Length; i += 2) result[(string)pairs[i]] = Unwrap(pairs[i + 1]);
      return result;
    }
    public static List<object> A(IEnumerable<Wire> items) {
      var result = new List<object>();
      foreach (var item in items) result.Add(item.Raw);
      return result;
    }

    public static string Date(string value) {
      DateTimeOffset parsed;
      if (DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out parsed))
        return parsed.ToLocalTime().ToString("MMM d, yyyy, h:mm tt", CultureInfo.CurrentCulture);
      return value;
    }
    public static bool IsUuid(string value) {
      Guid ignored;
      return value != null && value.Length == 36 && Guid.TryParseExact(value, "D", out ignored);
    }
    public static string Capitalize(string value) {
      if (string.IsNullOrEmpty(value)) return value;
      return char.ToUpperInvariant(value[0]) + value.Substring(1);
    }
    public static string Words(string value) { return Capitalize((value ?? "").Replace("_", " ")); }
    public static string Bytes(double bytes) {
      string[] units = { "bytes", "KB", "MB", "GB", "TB" };
      var unit = 0;
      while (bytes >= 1000 && unit < units.Length - 1) { bytes /= 1000; unit++; }
      return unit == 0 ? ((long)bytes).ToString(CultureInfo.CurrentCulture) + " bytes" : bytes.ToString("0.#", CultureInfo.CurrentCulture) + " " + units[unit];
    }
  }

  public sealed class JosiException : Exception {
    public readonly int Status;
    public JosiException(string message) : base(message) { }
    public JosiException(string message, int status) : base(message) { Status = status; }
  }
}
