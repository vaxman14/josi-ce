using System;
using System.Collections.Generic;
using System.Linq;

namespace Josi.Native {
  /// What the owner must decide about PC work right now, shown as cards in
  /// the chat: PC Control requests waiting for approval, and whether this PC
  /// still needs its one-time approval. Filled by the executor loop, read by
  /// the chat; never a source of authority on its own.
  static class PcInbox {
    static readonly object gate = new object();
    static List<Wire> requests = new List<Wire>();
    static bool needsPcApproval;
    public static event Action Changed;
    public static List<Wire> Requests { get { lock (gate) return requests.ToList(); } }
    public static bool NeedsPcApproval { get { lock (gate) return needsPcApproval; } }
    public static void Set(List<Wire> pending, bool approvalNeeded) {
      bool changed;
      lock (gate) {
        var ids = string.Join(",", pending.Select(q => q.Id)); var before = string.Join(",", requests.Select(q => q.Id));
        changed = ids != before || approvalNeeded != needsPcApproval;
        requests = pending; needsPcApproval = approvalNeeded;
      }
      if (changed) Changed?.Invoke();
    }
    /// Drops a request the owner just decided, so the card goes at once.
    public static void Decided(string id) {
      lock (gate) requests = requests.Where(q => q.Id != id).ToList();
      Changed?.Invoke();
    }
    public static void Clear() { lock (gate) { requests = new List<Wire>(); needsPcApproval = false; } Changed?.Invoke(); }
  }
}
