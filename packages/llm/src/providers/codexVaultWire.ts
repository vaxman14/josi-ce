/** Private parent/guardian IPC. Never expose these envelopes through an API,
 * event, log, argv or task receipt. The credential fields travel only over the
 * inherited IPC pipe and are wrapped in Secret immediately on receipt. */
export interface CodexGuardianStart {
  type: 'start';
  command: string;
  args: string[];
  input: string;
  auth: string | null;
  timeoutMs: number;
}
export type CodexGuardianInput = CodexGuardianStart | { type: 'renew' } | { type: 'stop' };
export type CodexGuardianOutput =
  | { type: 'ready' }
  | { type: 'output'; text: string }
  | { type: 'result'; code: number | null; stdout: string; stderr: string;
      timedOut: boolean; cancelled: boolean; spawnError: boolean;
      stopped: boolean; cleaned: boolean; auth: string | null };
