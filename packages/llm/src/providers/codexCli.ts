// Noncommercial subscription authentication, by delegation.
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO
//
// It runs OpenAI's official `codex exec` CLI. The production registry injects
// a Vault-managed runner, which serializes refreshes and supervises a private
// temporary CLI home. Personal terminal sign-ins are not imported or used.
//
// It does NOT:
//
//   * implement "Sign in with ChatGPT". There is no OAuth client here, no
//     redirect, no callback, no token.
//   * read a personal CLI home, keychain, browser profile or cookie jar.
//     Credential projection/write-back belongs to codexVaultRuntime, using
//     the one canonical Vault item. The vendor CLI still performs refresh.
//   * make an HTTP request. CE speaks to no OpenAI endpoint on this path.
//
// The distinction matters and it is not pedantic. Scraping a session is
// impersonation; running the vendor's own signed-in binary on the machine its
// owner signed in on is delegation. The first is prohibited everywhere. The
// second is what the CLI is for.
//
// WHY IT IS CE-ONLY
//
// OpenAI's terms confine this to individual productivity and explicitly exclude
// powering a commercial service. CE is one person's own installation; a hosted
// build of this same source would be the thing the terms exclude. So the gate
// is not a setting — `assertCapability` consults the edition stamped into the
// build, and a hosted artefact cannot reach this code at all. See
// `packages/core/src/edition.ts`.
//
// WHAT IT COSTS THE PRODUCT
//
// Honesty, mostly, and the honesty is in the open:
//
//   * It is PER INSTALLATION, not per user. Everyone on the installation shares
//     the operator's plan, and the operator's rolling quota.
//   * It reports NO TOKEN COUNTS and NO COST, so nothing on this path can be
//     billed, estimated or metered against a currency cap. Usage rows record
//     `subscription` as the charge basis and zero as the amount, because zero
//     per-call is the true figure for a flat monthly fee.
//   * Ordinary tool calls use the MCP harness (see `harness.ts`). Native
//     automation instead requests a structured proposal; Josi validates and
//     executes that proposal through its in-process permission gates. The
//     CLI never receives the native runtime or a browser-control capability.
//   * It needs the binary present in the container or on the host, signed in,
//     and it will not be either by default.
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexTurnSchema, parseCodexTurn, renderCodexTurn } from './codexTurn.js';
import type { CodexPrivateFile } from './codexVaultWire.js';
import { assertCapability, privateTemporaryDirectory, SubscriptionCredentialError, SubscriptionCredentialBusyError } from '@josi-ce/core';
import {
  MCP_SERVER_NAME, openHarnessSession, readExecutedCalls, resolveMcpServerPath,
  type HarnessSession,
} from '../harness.js';
import {
  LlmError,
  type ChatRequest, type ChatResponse, type LlmProvider, type ProviderKind,
} from '../types.js';

/** Only paths where the vendor publishes a first-party CLI and a first-party
 * sign-in flow, and where Josi therefore never touches a credential.
 *
 * The Anthropic entry was absent until Phase 14 on the basis that their policy
 * forbade it. Re-reading the current terms showed that what is forbidden is a
 * third party implementing Claude.ai login or intermediating credentials —
 * running the unmodified first-party binary, with the user authenticating
 * through Anthropic's own flow, is the documented arrangement. The date read
 * and the outstanding counsel review are recorded in
 * `docs/SUBSCRIPTION_AUTH.md`; see FI-006 in `docs/FIRST_INSTALL_FINDINGS.md`. */
export const SUBSCRIPTION_PROVIDERS = ['openai_subscription', 'anthropic_subscription'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export function isSubscriptionProvider(kind: string): kind is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(kind);
}

export const DEFAULT_CODEX_COMMAND = 'codex';

/** Runs the child. Injected so the whole path is testable without a real Codex
 * install, and so nothing in the suite ever executes a binary. */
export type SpawnRunner = (args: {
  command: string;
  args: string[];
  input: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Run in the supervising parent immediately before the child starts. */
  beforeStart?: () => Promise<void>;
  /** In-memory assets materialized only in the supervised private CLI home. */
  privateFiles?: CodexPrivateFile[];
}) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled?: boolean }>;

export interface CodexCliOptions {
  model: string;
  /** Path or name of the binary. Defaults to `codex` on PATH. */
  command?: string | null;
  timeoutMs?: number;
  runner?: SpawnRunner;
  /** The MCP tool server entry, for the harness. `undefined` means "look in
   * the environment and the image's known location"; explicit `null` disables
   * the harness (tests use this to assert the refusal path). */
  mcpServerPath?: string | null;
  beforeStart?: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The environment handed to the child.
 *
 * `OPENAI_API_KEY` and its relatives are REMOVED, not merely left unset.
 *
 * This is the single most important line in the file. Codex prefers an API key
 * when one is present in the environment, and the server process may well have
 * one — Phase 4 stores provider keys and something could export one. If that
 * happened, "use my subscription" would quietly bill an API account, which is
 * precisely the misrepresentation this feature exists not to commit. Deleting
 * the variables means the child has no key to prefer and either uses the
 * operator's login or fails visibly.
 */
export function childEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of [
    'OPENAI_API_KEY', 'OPENAI_KEY', 'OPENAI_API_KEY_PATH', 'OPENAI_ORG_ID',
    'OPENAI_BASE_URL', 'OPENAI_API_BASE',
    // Nothing in the child needs the installation's own secrets, and a
    // subprocess is the classic way an environment leaks into a log.
    'PGPASSWORD', 'PGPASSWORD_FILE', 'DATABASE_URL', 'MASTER_KEY_FILE',
    'JOSI_DISABLED_CAPABILITIES',
  ]) {
    delete env[key];
  }
  // Non-interactive: no colour codes to parse out, no pager, no prompt.
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

/**
 * The exact command line.
 *
 * Kept as its own function so a test can assert it is the documented
 * non-interactive form and nothing else. Notably absent: any flag that would
 * let the model touch the filesystem or run commands. `--sandbox read-only`
 * and `--skip-git-repo-check` say plainly that the MODEL may not touch this
 * machine — Josi's own tool permissions are enforced by code reading database
 * rows, and a subprocess that could write files would sit entirely outside
 * them.
 *
 * When a harness session is supplied, the Josi MCP server is added as `-c`
 * overrides. That does NOT weaken the sandbox: the tools act through Josi's
 * API layer in a separate process we own, which is the point of the design.
 * `default_tools_approval_mode = "approve"` is required because `codex exec`
 * runs with approval policy `never` and would otherwise fail every MCP call
 * with "requires approval" (verified against the pinned 0.152.0). Approving
 * at the CLI is safe precisely because the approval that matters — Josi's
 * step-up policy — is enforced inside the server, where the CLI cannot reach.
 */
export function codexArgs(model: string, harness?: HarnessSession | null, imagePaths: string[] = [], schemaPath?: string): string[] {
  const mcp = harness
    ? [
      // process.execPath, not `node`: the CLI spawns the server itself and
      // its PATH is not a promise we rely on. JSON.stringify produces a valid
      // TOML basic string for these paths.
      '-c', `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.${MCP_SERVER_NAME}.args=[${JSON.stringify(harness.serverPath)}]`,
      '-c', `mcp_servers.${MCP_SERVER_NAME}.env={${Object.entries(harness.serverEnvironment).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')}}`,
      '-c', `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
    ]
    : [];
  return [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    // Subscription transport may act only through Josi's MCP permission gates.
    // A read-only shell could still read service secrets or sibling folders.
    '-c', 'features.shell_tool=false',
    '-c', 'features.view_image=false',
    '-c', 'features.multi_agent=false',
    ...(schemaPath ? ['--ephemeral', '--output-schema', schemaPath,
      '-c', 'web_search="disabled"', '-c', 'tools.update_plan.enabled=false',
      '-c', 'tools.experimental_request_user_input.enabled=false',
      '-c', 'features.apps=false', '-c', 'features.plugins=false'] : []),
    ...mcp,
    // An empty model means 'the plan's own default': the CLI chooses, exactly
    // as it does for its interactive users. Passing --model '' would instead
    // ask for a model literally named nothing.
    ...(model ? ['--model', model] : []),
    ...imagePaths.flatMap((path) => ['--image', path]),
    // A single `-` means "the prompt is on stdin", which keeps the prompt out
    // of the process table. An argv is world-readable on most systems, and the
    // prompt is somebody's private conversation.
    '-',
  ];
}

/** No implicit fallback to a legacy or personal CLI home. Registry callers
 * provide the Vault supervisor; fixtures may inject their own inert runner. */
const defaultRunner: SpawnRunner = async () => {
  throw new LlmError('The Vault-managed subscription runner is unavailable. Reconnect through Josi’s model settings.', { needsReconfiguration: true });
};

/**
 * Flattens a chat request into one prompt.
 *
 * `codex exec` takes a single instruction, not a message array, so history is
 * rendered as labelled turns. This is lossy compared with a real chat API and
 * it is one of the reasons this path is the lesser option rather than the
 * default — stated in the docs, not hidden behind a shim that pretends
 * otherwise.
 */
export function renderPrompt(request: ChatRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system);
  for (const message of request.messages) {
    if (!message.content) continue;
    parts.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
  }
  parts.push('Assistant:');
  return parts.join('\n\n');
}

/**
 * Pulls the answer out of `codex exec --json`.
 *
 * The CLI emits JSON Lines. Rather than binding to one event schema — which
 * would break silently the next time the CLI is updated — this walks every
 * parsable line and keeps the last thing that looks like the agent's message,
 * under any of the field names the CLI has used. If nothing matches, the raw
 * stdout is used, which is what a plain `codex exec` prints anyway.
 *
 * Exported and tested directly, because "the reply was empty" is otherwise an
 * unfalsifiable complaint.
 */
export function extractReply(stdout: string): string {
  let latest = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const candidate = agentText(event);
    if (candidate) latest = candidate;
  }
  if (latest) return latest.trim();

  // No JSON at all: the CLI was run without --json, or an older build. Its
  // plain output is the answer, minus anything that is obviously a log line.
  return stdout
    .split('\n')
    .filter((l) => !/^\s*\[?\d{4}-\d{2}-\d{2}/.test(l))
    .join('\n')
    .trim();
}

/** Every shape the CLI has used for "this is what the model said". */
function agentText(event: Record<string, unknown>): string {
  const type = String(event.type ?? '');
  if (type === 'agent_message' || type === 'assistant_message') {
    return asText(event.message) || asText(event.text) || asText(event.content);
  }
  if (type === 'item.completed' || type === 'item.updated') {
    const item = event.item as Record<string, unknown> | undefined;
    if (item && (item.type === 'agent_message' || item.type === 'assistant_message')) {
      return asText(item.text) || asText(item.message) || asText(item.content);
    }
    return '';
  }
  // A final envelope some versions emit.
  if (type === 'turn.completed' || type === 'task_complete') {
    return asText(event.last_agent_message) || asText(event.text);
  }
  return '';
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part
        : typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

/**
 * Builds the provider.
 *
 * The capability assertions are here rather than only at the route, and both of
 * them are checked: `local_command_execution` because this spawns a process,
 * and `subscription_auth` because of what it spawns. A hosted build that
 * somehow reached this function — a row inserted with psql, a route added later
 * that forgot the guard — throws before anything runs.
 */
export function codexCliProvider(opts: CodexCliOptions): LlmProvider {
  assertCapability('local_command_execution');
  assertCapability('subscription_auth');

  const command = opts.command?.trim() || DEFAULT_CODEX_COMMAND;
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    kind: 'openai_subscription' as ProviderKind,
    model: opts.model,
    // It reaches OpenAI, by way of OpenAI's own binary. Everything Phase 4
    // built around `external` — the acknowledgement, the Local-only refusal —
    // therefore applies unchanged, which is the correct answer.
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      // The harness path. Tools were asked for; they are offered to the CLI's
      // own agent loop over MCP, or — when the server is not present — refused
      // rather than silently dropped. An agent that asked for tools and got
      // prose back would report success having done nothing.
      const serverPath = opts.mcpServerPath === undefined ? resolveMcpServerPath() : opts.mcpServerPath;
      let harness: HarnessSession | null = null;
      const callerTools = request.toolExecution === 'caller';
      if (request.tools?.length && !callerTools) {
        if (!serverPath) {
          throw new LlmError(
            'The Codex CLI path cannot call tools on this installation — the Josi tool server is '
            + 'not available to it. Configure an API key provider for anything that acts.',
            { needsReconfiguration: true },
          );
        }
        harness = openHarnessSession({
          serverPath,
          tools: request.tools,
          toolContext: request.toolContext,
        });
      }

      const started = Date.now();
      let result: Awaited<ReturnType<SpawnRunner>>;
      let executedToolCalls: ChatResponse['executedToolCalls'];
      let imageDir: string | null = null;
      try {
        const imagePaths: string[] = [];
        const privateFiles: CodexPrivateFile[] = [];
        let schemaPath: string | undefined;
        if (callerTools) {
          schemaPath = 'josi-response.schema.json';
          privateFiles.push({ name: schemaPath, base64: Buffer.from(JSON.stringify(codexTurnSchema(request))).toString('base64') });
        }
        // Images belong to the current turn. Do not resend old attachments
        // from history on every later message: that wastes plan quota and can
        // make the model answer about yesterday's picture instead of today's.
        const images = request.messages.at(-1)?.images ?? [];
        if (images.length) {
          if (!callerTools) imageDir = privateTemporaryDirectory('josi-codex-images-');
          for (const [index, image] of images.entries()) {
            const extension = image.mediaType === 'image/jpeg' ? 'jpg'
              : image.mediaType === 'image/webp' ? 'webp'
              : image.mediaType === 'image/gif' ? 'gif'
              : 'png';
            const path = callerTools ? `josi-image-${index}.${extension}` : join(imageDir!, `attachment-${index}.${extension}`);
            if (callerTools) privateFiles.push({ name: path, base64: image.base64 });
            else await writeFile(path, Buffer.from(image.base64, 'base64'), { mode: 0o600 });
            imagePaths.push(path);
          }
        }
        result = await runner({
          command,
          args: codexArgs(opts.model, harness, imagePaths, schemaPath),
          input: callerTools ? renderCodexTurn(request) : renderPrompt(request),
          env: childEnvironment(),
          timeoutMs,
          beforeStart: opts.beforeStart,
          ...(privateFiles.length ? { privateFiles } : {}),
        });
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (err instanceof SubscriptionCredentialBusyError) {
          throw new LlmError(err.message, { retryable: true });
        }
        if (err instanceof SubscriptionCredentialError) {
          throw new LlmError(err.message, { needsReconfiguration: true });
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new LlmError(
            `The Codex CLI was not found (looked for "${command}"). Install it and sign in with `
            + '`codex login` on this machine, or use an API key instead.',
            { needsReconfiguration: true },
          );
        }
        if (code === 'EACCES') {
          throw new LlmError(
            `"${command}" is not executable by the account Josi runs as.`,
            { needsReconfiguration: true },
          );
        }
        throw new LlmError('The Codex CLI could not be started.', { needsReconfiguration: true });
      } finally {
        if (harness) {
          // Read before cleanup: the calls file is the ground truth of which
          // tools genuinely reached Josi's server, recorded by our own code
          // rather than parsed out of the CLI's event stream.
          executedToolCalls = readExecutedCalls(harness.callsPath);
          harness.cleanup();
        }
        if (imageDir) await rm(imageDir, { recursive: true, force: true });
      }

      if (result.cancelled && !result.timedOut) {
        throw new LlmError('The subscription run stopped because its current permission or login became unavailable. Review the original task before continuing.', { needsReconfiguration: true });
      }
      if (result.timedOut) {
        throw new LlmError(harness
          ? 'The subscription run timed out. Review the original task’s saved actions before continuing.'
          : 'The Codex CLI did not answer in time.', { retryable: !harness });
      }
      if (result.code !== 0) {
        throw classifyExit(result.stderr, command);
      }

      const text = extractReply(result.stdout);
      if (!text) {
        throw new LlmError('The Codex CLI returned nothing Josi could read.', { retryable: true });
      }
      const proposed = callerTools ? parseCodexTurn(text, request) : null;

      return {
        text: proposed?.text ?? text,
        // Caller-owned tools are proposals. Harness tools have already run
        // and travel separately as executedToolCalls to prevent replay.
        toolCalls: proposed?.toolCalls ?? [],
        ...(executedToolCalls?.length ? { executedToolCalls } : {}),
        // NOT GUESSED. The CLI reports no token counts, and inventing an
        // estimate here would put a fabricated number into the usage ledger and
        // against the cap. Zero with a `subscription` charge basis is the true
        // statement: a flat monthly fee has no per-call token bill.
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: Date.now() - started,
        reportedCostUsd: 0,
      };
    },
  };
}

/**
 * Turns a non-zero exit into something the operator can act on.
 *
 * stderr is matched, never echoed. A CLI's stderr can contain the prompt it was
 * given, and the prompt is somebody's private conversation — the same rule
 * Phase 9 applies to parser errors and Phase 13.1 applies to Telegram
 * descriptions.
 */
export function classifyExit(stderr: string, command: string): LlmError {
  const text = stderr.toLowerCase();
  if (/not logged in|no credentials|please (run )?`?codex login|unauthenticated|401/.test(text)) {
    return new LlmError(
      'The subscription login is unavailable. Sign in through Josi’s model settings, then test the model again.',
      { needsReconfiguration: true },
    );
  }
  if (/rate limit|too many requests|429|usage limit|quota/.test(text)) {
    return new LlmError(
      'Your ChatGPT plan has hit its usage limit. This shares the same allowance as your own '
      + 'Codex sessions.',
      { retryable: true },
    );
  }
  if (/unknown option|unrecognized|no such subcommand|usage:/.test(text)) {
    return new LlmError(
      `The "${command}" on this machine does not understand \`codex exec --json\`. Update the `
      + 'Codex CLI, or use an API key instead.',
      { needsReconfiguration: true },
    );
  }
  if (/network|dns|getaddrinfo|econn|timed? ?out/.test(text)) {
    return new LlmError('The Codex CLI could not reach OpenAI.', { retryable: true });
  }
  return new LlmError('The Codex CLI failed. Check the subscription in Josi’s model settings.', {
    needsReconfiguration: true,
  });
}
