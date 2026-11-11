// What this build shows, mirroring apps/windows-native/src/Flags.cs (and
// JosiFlags.swift on the Mac): the same names, the same values. Everything set
// to false stays in the source and comes back by flipping it here. Linux is web
// only, so this file is how a Linux owner sees the same lean beta as Windows.
//
// Hiding is convenience, not security: the server still decides what each
// person may do. A hidden page's route redirects to chat (App.tsx).

export const Flags = {
  /** Pairing, the relay, heyjosi.com addresses and the hosted account service. */
  Relay: false,
  Talk: false,
  Workflows: false,
  /** Desktop and browser control through PC Control. */
  LocalWorkspace: true,
  /** WhatsApp, Telegram and every other messaging channel. The Josi apps are the channel. */
  Channels: false,
  Apps: false,
  VoiceBox: false,
  Policy: false,
  Integrations: true,
  Storage: false,
  WorkspaceAdmin: false,
  Family: true,
  ParentalControls: true,
  /** Sections the beta menu leaves out and no other flag covers. */
  ExtraSections: false,
} as const;

/** Section names as Flags.cs spells them, plus the web-only ones (`relay`). */
const NEEDS: Record<string, boolean> = {
  workflows: Flags.Workflows, 'workflow-providers': Flags.Workflows,
  automation: Flags.LocalWorkspace, 'pc-control': Flags.LocalWorkspace,
  channels: Flags.Channels, apps: Flags.Apps, 'voice-box': Flags.VoiceBox, policy: Flags.Policy,
  connectors: Flags.Integrations, integrations: Flags.Integrations, 'custom-apis': Flags.Integrations,
  storage: Flags.Storage, workspace: Flags.WorkspaceAdmin, family: Flags.Family, parental: Flags.ParentalControls,
  files: Flags.ExtraSections, reminders: Flags.ExtraSections, memory: Flags.ExtraSections,
  personalization: Flags.ExtraSections, templates: Flags.ExtraSections, migration: Flags.ExtraSections,
  usage: Flags.ExtraSections, checklist: Flags.ExtraSections, 'mail-settings': Flags.ExtraSections,
  improvements: Flags.ExtraSections, maintenance: Flags.ExtraSections, audit: Flags.ExtraSections,
  relay: Flags.Relay, talk: Flags.Talk,
};

/** Whether this build shows a section. Anything not listed shows. */
export function shows(section: string | undefined): boolean {
  if (!section) return true;
  return NEEDS[section] ?? true;
}
