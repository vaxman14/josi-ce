using System.Collections.Generic;

namespace Josi.Native {
  /// What this build ships, matching JosiFlags.swift on the Mac. Everything set
  /// to false stays in the source and comes back by flipping it here, or for the
  /// relay by adding RELAY_ENABLED to DefineConstants in Josi.Windows.csproj.
  static class Flags {
#if RELAY_ENABLED
    /// Pairing, the relay, heyjosi.com addresses and the hosted account service.
    public static readonly bool Relay = true;
#else
    public static readonly bool Relay = false;
#endif
#if JOSI_SERVER_APP
    /// True in Josi (server + client). False in Josi Client, which only connects.
    public static readonly bool ServerApp = true;
#else
    public static readonly bool ServerApp = false;
#endif
    public static string AppName { get { return ServerApp ? "Josi" : "Josi Client"; } }

    public static readonly bool Talk = false;
    public static readonly bool Workflows = false;
    /// Desktop and browser control: Josi working on this PC (commands, files,
    /// programs, windows) through PC Control. Off also means the executor and
    /// the browser bridge never start, not just that their pages are hidden.
    public static readonly bool LocalWorkspace = true;
    /// WhatsApp, Telegram and every other messaging channel. The Josi apps are the channel.
    public static readonly bool Channels = false;
    public static readonly bool Apps = false;
    public static readonly bool VoiceBox = false;
    public static readonly bool Policy = false;
    public static readonly bool Integrations = false;
    public static readonly bool Storage = false;
    public static readonly bool WorkspaceAdmin = false;
    public static readonly bool Family = false;
    public static readonly bool ParentalControls = false;
    /// Sections the beta sidebar leaves out and no other flag covers.
    public static readonly bool ExtraSections = false;

    static readonly Dictionary<string, bool> Needs = new Dictionary<string, bool> {
      {"workflows", Workflows}, {"workflow-providers", Workflows},
      {"automation", LocalWorkspace}, {"pc-control", LocalWorkspace},
      {"channels", Channels}, {"apps", Apps}, {"voice-box", VoiceBox}, {"policy", Policy},
      {"connectors", Integrations}, {"integrations", Integrations}, {"custom-apis", Integrations},
      {"storage", Storage}, {"workspace", WorkspaceAdmin}, {"family", Family}, {"parental", ParentalControls},
      {"models", ServerApp}, {"network", ServerApp}, {"server", ServerApp},
      {"files", ExtraSections}, {"reminders", ExtraSections}, {"memory", ExtraSections},
      {"personalization", ExtraSections}, {"templates", ExtraSections}, {"migration", ExtraSections},
      {"usage", ExtraSections}, {"checklist", ExtraSections}, {"mail-settings", ExtraSections},
      {"improvements", ExtraSections}, {"maintenance", ExtraSections}, {"audit", ExtraSections},
    };

    /// Whether this build shows a sidebar section. Anything not listed shows.
    public static bool Shows(string section) {
      bool shown;
      return !Needs.TryGetValue(section ?? "", out shown) || shown;
    }
  }
}
