// The exact request sent to a model and the raw reply, for debugging tool
// calling. OFF unless the operator turns it on.
//
// Everything else in this package refuses to carry a prompt anywhere: the
// usage table has no column for one, and errors carry codes rather than the
// provider's prose. This file is the one deliberate exception, and it is
// shaped accordingly: it only writes when the operator switched it on (the
// JOSI_LLM_DEBUG variable, or the flag file on a packaged Linux server),
// it writes to a file on this machine that only the service account can read,
// and it never sends anything anywhere. The Authorization header is not part
// of what is written.
import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The switch on a packaged Linux server, whose services start with a fixed
 * environment and so cannot be given a variable: `sudo touch /etc/josi/llm-debug`
 * turns it on, removing the file turns it off. No restart either way. */
export const LLM_DEBUG_FLAG_FILE = '/etc/josi/llm-debug';

let flagCheckedAt = 0;
let flagOn = false;

export function llmDebugEnabled(): boolean {
  const value = (process.env.JOSI_LLM_DEBUG ?? '').trim().toLowerCase();
  if (value && value !== '0' && value !== 'false' && value !== 'off') return true;
  // Looked at no more than once every few seconds: this runs on every call.
  const now = Date.now();
  if (now - flagCheckedAt > 5000) { flagCheckedAt = now; flagOn = existsSync(LLM_DEBUG_FLAG_FILE); }
  return flagOn;
}

/** Where calls are written. On a packaged server each service account has its
 * own log folder (web and worker are different accounts), so there is one file
 * per service: .../logs/web/llm-debug and .../logs/worker/llm-debug. */
export function llmDebugFile(): string {
  const data = process.env.JOSI_DATA_DIR;
  const role = process.env.TMPDIR ? basename(process.env.TMPDIR) : '';
  const dir = process.env.JOSI_LLM_DEBUG_DIR
    || (data && process.env.JOSI_NATIVE_RUNTIME && role ? join(data, 'logs', role, 'llm-debug')
      : data ? join(data, 'llm-debug') : join(tmpdir(), 'josi-llm-debug'));
  return join(dir, 'model-calls.jsonl');
}

export interface LlmDebugRecord {
  provider: string;
  model: string;
  url: string;
  /** The request body exactly as it was sent. */
  request: unknown;
  status: number | null;
  /** The reply body exactly as it arrived, before any parsing. */
  reply: string | null;
  latencyMs: number;
  error?: string;
}

/** Append one call. Never throws: a full disk must not cost someone a reply. */
export async function writeLlmDebug(record: LlmDebugRecord): Promise<void> {
  if (!llmDebugEnabled()) return;
  try {
    const file = llmDebugFile();
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    // One file, rolled once: the previous one is kept, older ones are not.
    const size = await stat(file).then((s) => s.size).catch(() => 0);
    if (size > MAX_FILE_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`josi-ce: could not write the model debug log: ${(err as Error).message}`);
  }
}
