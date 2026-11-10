using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  /// Keeps native work bounded by live authorization. A server or connection
  /// failure cannot leave it running with an indefinitely cached permission.
  static class PcExecutionLease {
    public static async Task<Tuple<bool, object>> Run(Func<CancellationToken, Task<bool>> authorize,
        Func<bool> attached, Func<Task<Tuple<bool, object>>> execute, Action stop) {
      Task<Tuple<bool, object>> work = null;
      var lastCheck = Stopwatch.StartNew();
      try {
        while (true) {
          if (!attached()) throw new OperationCanceledException();
          if (work == null || lastCheck.ElapsedMilliseconds >= 1500) {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3))) {
              if (!await authorize(timeout.Token).WaitAsync(timeout.Token)) throw new OperationCanceledException();
            }
            lastCheck.Restart();
          }
          if (work == null) work = execute();
          if (await Task.WhenAny(work, Task.Delay(200)) == work) return await work;
        }
      } catch (Exception e) when (e is JosiException || e is OperationCanceledException || e is IOException || e is System.Net.Http.HttpRequestException) {
        stop();
        // Do not accept another request until the canceled action has unwound.
        if (work != null) await work;
        return Tuple.Create(false, (object)Wires.O("code", "execution_lease_lost"));
      }
    }
  }
}
