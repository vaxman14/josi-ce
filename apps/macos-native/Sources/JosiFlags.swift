/// What this build ships. Everything set to false stays in the source and comes
/// back by flipping it here, or for the relay by adding RELAY_ENABLED to the
/// target's Active Compilation Conditions.
enum JosiFlags {
#if RELAY_ENABLED
    /// Relay, heyjosi.com addresses, the hosted account service, paid plans and included AI.
    static let relay = true
#else
    static let relay = false
#endif
#if JOSI_SERVER_APP
    /// True in Josi (server + client). False in Josi Client, which only connects.
    static let serverApp = true
#else
    static let serverApp = false
#endif
    static var appName: String { serverApp ? "Josi" : "Josi Client" }
    static let home = false
    static let talk = false
    static let workflows = false
    static let localWorkspace = false
    /// WhatsApp, Telegram and every other messaging channel. The Josi apps are the channel.
    static let channels = false
    static let apps = false
    static let voiceBox = false
    static let policy = false
    static let integrations = false
    static let storage = false
    static let workspaceAdmin = false
    static let family = false
    static let parentalControls = false
}
