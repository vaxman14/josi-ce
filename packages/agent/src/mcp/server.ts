// The Josi MCP tool server — the executable half of the subscription harness.
//
// Spawned BY the vendor CLI (Codex or Claude Code), not by Josi: the provider
// in packages/llm configures the CLI with this file's path and a context file,
// and the CLI starts it over stdio for the length of one `chat()` call. See
// packages/llm/src/harness.ts for what travels where and why.
//
// WHAT IT ENFORCES, because a tool server that skips the rules is a bypass:
//
//   * Only the tools offered THIS turn (plus the two probe tools) are listed.
//     The tool list is the promise; an absent tool is an absent promise.
//   * Every user-scoped call goes through `checkStepUp` with the same session
//     key the in-process loop would use. A refusal is returned to the model as
//     text — the same sentence the loop would relay — never bypassed and never
//     dressed up as a crash.
//   * Execution is `executeAssistantTool`, the exact code the in-process loop
//     runs, ownership checks and all.
//   * Every call is appended to the calls file BEFORE it runs, so the provider
//     reports what was attempted even if the tool then fails. That file is how
//     the capability probe proves a call genuinely reached us.
//
// The two probe tools are contextless by design. `record_number` exists so the
// standard capability probe measures the real end-to-end harness rather than a
// special case; `josi_health` is the smoke-test handle. Neither touches the
// database, so a context with no user can still prove the plumbing.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { checkStepUp, connectFromEnv } from '@josi-ce/core';
import type { Db } from '@josi-ce/core';
import { executeAssistantTool } from '../execute.js';
import { TASK_TOOLS } from '../tools.js';
import { handleMcpMessage, type McpCore, type McpToolDescriptor, type McpToolOutcome } from './protocol.js';

interface HarnessContext {
  databaseUrl: string | null;
  passwordFile: string | null;
  userId: string | null;
  sessionKey: string | null;
  threadId: string | null;
  tools: string[];
  callsPath: string;
}

const PROBE_TOOLS: McpToolDescriptor[] = [
  {
    // Mirrors PROBE_TOOL in packages/llm/src/probe.ts by name and shape, so
    // the one capability probe works unchanged across HTTP and CLI providers.
    name: 'record_number',
    description: 'Record a single number. Call this with the number 7.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number', description: 'The number to record.' } },
      required: ['value'],
    },
  },
  {
    name: 'josi_health',
    description: 'Echo a message back, to verify the Josi tool server is reachable.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

/** Builds the protocol core for a context. Exported for the tests; the
 * process wiring below is the only other caller. */
export function buildCore(ctx: HarnessContext, connect: () => Promise<Db>): McpCore {
  const offered = new Set(ctx.tools);
  const tools: McpToolDescriptor[] = [
    ...PROBE_TOOLS,
    // Only what this turn offered. TASK_TOOLS is the catalogue; the context
    // file is the turn's actual promise.
    ...TASK_TOOLS.filter((t) => offered.has(t.def.name)).map((t) => ({
      name: t.def.name,
      description: t.def.description,
      inputSchema: t.def.parameters,
    })),
  ];

  let db: Promise<Db> | null = null;

  const execute = async (name: string, input: Record<string, unknown>, callId: string): Promise<McpToolOutcome> => {
    // Ground truth first: recorded before execution so even a failing call is
    // visible to the provider that reads this file back.
    appendFileSync(ctx.callsPath, `${JSON.stringify({ id: callId, name, input })}\n`);

    if (name === 'josi_health') {
      return { text: JSON.stringify({ ok: true, echo: input.message ?? null }) };
    }
    if (name === 'record_number') {
      // A no-op on purpose. The probe asks whether a call ARRIVES, not whether
      // it changes anything — recording it above already answered.
      return { text: JSON.stringify({ ok: true, recorded: input.value ?? null }) };
    }

    if (!ctx.userId) {
      // Honest refusal, phrased for the model to relay. No user means no owner
      // for the work, and inventing one is the thing this file must never do.
      return { text: JSON.stringify({ ok: false, error: 'no_user', message: 'This session has no signed-in person attached, so no work can be created or changed.' }) };
    }

    db ??= connect();
    const conn = await db;

    // The same gate, the same key, the same sentence as the in-process loop.
    const decision = await checkStepUp(conn, {
      userId: ctx.userId,
      sessionKey: ctx.sessionKey ?? ctx.threadId ?? 'mcp',
      action: name,
    });
    if (!decision.allowed) {
      return { text: JSON.stringify({ ok: false, error: decision.reason, message: decision.message }) };
    }

    const result = await executeAssistantTool(conn, { userId: ctx.userId, threadId: ctx.threadId }, name, input);
    return { text: JSON.stringify(result) };
  };

  return { tools, execute };
}

function loadContext(): HarnessContext {
  const path = process.env.JOSI_MCP_CONTEXT;
  if (!path) throw new Error('JOSI_MCP_CONTEXT is not set — this server is only started by the Josi harness');
  // The path came from our own provider; its content is ours. Parse errors are
  // fatal and say the path, never the content: the file names a person.
  const ctx = JSON.parse(readFileSync(path, 'utf8')) as HarnessContext;
  if (!ctx.callsPath || !Array.isArray(ctx.tools)) {
    throw new Error(`the harness context at ${path} is not the expected shape`);
  }
  return ctx;
}

async function main(): Promise<void> {
  const ctx = loadContext();
  let close: (() => Promise<void>) | null = null;
  const core = buildCore(ctx, async () => {
    // The connection string reaches this process through the 0600 context
    // file, not through the vendor CLI's environment — the CLI holds no secret
    // of ours. connectFromEnv is fed a synthetic env for exactly that reason.
    const conn = await connectFromEnv({
      DATABASE_URL: ctx.databaseUrl ?? undefined,
      PGPASSWORD_FILE: ctx.passwordFile ?? undefined,
    } as NodeJS.ProcessEnv, { max: 2 });
    close = conn.close;
    return conn.db;
  });

  // Replies still in flight. stdin closing is how the CLI says goodbye, and
  // it can arrive while a tool is mid-execution — exiting then would swallow
  // the answer AND the calls-file line the provider is about to read.
  const pending = new Set<Promise<void>>();

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // Not JSON-RPC; nothing to answer.
    }
    const job = handleMcpMessage(core, msg).then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  rl.on('close', () => {
    // The CLI is done with us: finish what was asked, close the pool, exit.
    void Promise.allSettled([...pending])
      .then(() => (close ? close() : undefined))
      .finally(() => process.exit(0));
  });
}

// This module is an entry point, spawned by path. It still guards on the
// context variable rather than import shape, so importing `buildCore` in a
// test never starts a server.
if (process.env.JOSI_MCP_CONTEXT) {
  main().catch((err) => {
    // stderr goes to the vendor CLI's log. The message names files and shapes,
    // never conversation content.
    console.error(`josi mcp server failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
