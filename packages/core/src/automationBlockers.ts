/** Stable, non-secret recovery text from verified discovery/operation receipts.
 * Never use model prose or a remote error body as a saved recovery instruction. */
export const automationBlockers = {
  vault_locked: 'Open Vault and unlock it, then return to Automation. Josi needs the saved device and permission settings before it can connect to the separate desktop.',
  status_unavailable: 'Josi could not read the automation status. Open Automation and refresh to see the connection error. Your original instructions are saved; you do not need to rewrite them.',
  runtime_unavailable: 'The server has no automation control connection. Open Server and check its health, then open Automation to connect the separate desktop.',
  no_workspaces: 'No separate automation desktop is connected to this account. Open Automation, select your enrolled Mac and open the existing desktop, or complete its setup if none exists.',
  device_offline: 'The separate automation desktop is offline. Open Automation and open that desktop, then connect Josi Companion inside it.',
  human_takeover: 'Automation is paused while you control the separate desktop. Resume automation from its local Josi controls when you are ready.',
  local_consent_required: 'Open Automation, show the separate desktop and connect Josi Companion. Select Chrome and enable automation from the local controls for this workspace.',
  permission_required: 'Open Automation → Permissions and review the permission for this site and the current ChatGPT model. Josi will keep the original task and resume within the permissions you grant.',
  connection_refreshing: 'The separate desktop connection needs to refresh before Josi can continue. Open Automation and check that the desktop and Companion are connected.',
} as const;
export type AutomationBlockerCode = keyof typeof automationBlockers;
export function automationBlockerFromReceipts(receipts: unknown): { code: AutomationBlockerCode; message: string } | null {
  if (!Array.isArray(receipts)) return null;
  for (const entry of [...receipts].reverse()) {
    if (!entry || typeof entry !== 'object' || !['get_automation_workspaces', 'connect_automation_workspace',
      'open_automation_browser', 'observe_automation_workspace', 'browser_control', 'computer_control'].includes(entry.tool)) continue;
    const result = entry.result;
    if (!result || typeof result !== 'object') continue;
    // A later successful operation supersedes an older discovery refusal.
    if (result.status === 'succeeded') return null;
    const code = result.blocker?.code ?? result.code;
    if (typeof code === 'string' && Object.hasOwn(automationBlockers, code)) {
      return { code: code as AutomationBlockerCode, message: automationBlockers[code as AutomationBlockerCode] };
    }
    if (entry.tool === 'get_automation_workspaces' && result.controlAvailable === true
      && result.workspaces?.some((item: { state?: string }) => item.state === 'ready')) return null;
  }
  return null;
}
