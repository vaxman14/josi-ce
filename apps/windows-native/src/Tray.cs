using System;
using System.Windows;

namespace Josi.Native {
  /// Josi in the notification area. Closing the window hides it here so PC
  /// control, terminals and notifications keep working; Quit ends the app.
  /// The server on this PC runs as Windows services and is never affected.
  sealed class Tray : IDisposable {
    readonly System.Windows.Forms.NotifyIcon icon = new System.Windows.Forms.NotifyIcon();
    readonly System.Windows.Forms.ToolStripMenuItem resume;
    bool toldOnce;
    public Tray(Action open, Action resumePc, Action quit) {
      using (var stream = typeof(Tray).Assembly.GetManifestResourceStream("Josi.ico"))
        if (stream != null) icon.Icon = new System.Drawing.Icon(stream);
      icon.Text = "Josi";
      var menu = new System.Windows.Forms.ContextMenuStrip();
      var show = new System.Windows.Forms.ToolStripMenuItem("Open Josi"); show.Font = new System.Drawing.Font(show.Font, System.Drawing.FontStyle.Bold);
      show.Click += delegate { open(); };
      resume = new System.Windows.Forms.ToolStripMenuItem("Resume Josi on this PC"); resume.Click += delegate { resumePc(); };
      var exit = new System.Windows.Forms.ToolStripMenuItem("Quit Josi"); exit.Click += delegate { quit(); };
      menu.Items.Add(show); menu.Items.Add(resume); menu.Items.Add(new System.Windows.Forms.ToolStripSeparator()); menu.Items.Add(exit);
      icon.ContextMenuStrip = menu;
      icon.DoubleClick += delegate { open(); };
      icon.MouseClick += (s, e) => { if (e.Button == System.Windows.Forms.MouseButtons.Left) open(); };
      icon.Visible = true;
    }
    /// Shown the first time the window is closed to the tray, so it is not a surprise.
    public void SayHidden() {
      if (toldOnce) return; toldOnce = true;
      icon.BalloonTipTitle = "Josi keeps running";
      icon.BalloonTipText = "The window is out of the way; Josi still works on this PC and answers from other devices. Right-click the icon to quit.";
      icon.ShowBalloonTip(4000);
    }
    public void Update(bool paused, bool working) {
      resume.Visible = paused;
      icon.Text = working ? "Josi is working on this PC" : paused ? "Josi is paused on this PC" : "Josi";
    }
    public void Dispose() { icon.Visible = false; icon.Dispose(); }
  }
}
