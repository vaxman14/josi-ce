// Claude subscription model transport. The production registry supplies a
// Vault-managed setup token through the supervised first-party CLI. No personal
// login, Keychain import, API key fallback or independent tool execution.
import { assertCapability, SubscriptionCredentialError, SubscriptionCredentialBusyError } from '@josi-ce/core';
import { claudeSubscriptionArgs } from './claudeVaultPolicy.js';
import {
  openHarnessSession, readExecutedCalls, resolveMcpServerPath, writeClaudeMcpConfig,
  type HarnessSession,
} from '../harness.js';
import {
  LlmError,
  type ChatRequest, type ChatResponse, type LlmProvider, type ProviderKind,
} from '../types.js';
import type { SpawnRunner } from './codexCli.js';

export const DEFAULT_CLAUDE_COMMAND = 'claude';

const DEFAULT_TIMEOUT_MS = 180_000;

/** Legacy names retained for downstream source compatibility. The runtime now
 * disables all built-in tools with --tools "", including future additions. */
export const DENIED_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'SlashCommand', 'KillShell', 'BashOutput',
] as const;

export interface ClaudeCliOptions {
  model: string;
  /** Path or name of the binary. Defaults to `claude` on PATH. */
  command?: string | null;
  /** Deprecated. Production runs always receive a fresh private Vault projection. */
  configDir?: string | null;
  timeoutMs?: number;
  runner?: SpawnRunner;
  /** The MCP tool server entry, for the harness. `undefined` means "look in
   * the environment and the image's known location"; explicit `null` disables
   * the harness (tests use this to assert the refusal path). */
  mcpServerPath?: string | null;
}

/** Compatibility seam for injected test runners. Production ignores this
 * environment and uses the guardian's explicit environment allowlist. */
export function claudeChildEnvironment(
  _configDir: string | null,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { PATH: parent.PATH, NO_COLOR: '1', CI: '1' };
}

export const claudeArgs = claudeSubscriptionArgs;

/** Flattens a chat request into one prompt, exactly as the Codex path does. */
export function renderClaudePrompt(request: ChatRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system);
  for (const message of request.messages) {
    if (!message.content) continue;
    parts.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
  }
  parts.push('Assistant:');
  return parts.join('\n\n');
}

export interface ClaudeResult {
  text: string;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Pull the answer out of `claude --print --output-format json`.
 *
 * THE CLI EXITS ZERO WHEN IT IS NOT SIGNED IN. It prints a normal-looking
 * result envelope with `is_error: true` and `result: "Not logged in · Please
 * run /login"`. A caller that trusted the exit code would hand that sentence to
 * a user as though the model had said it, and every mock-based test would agree
 * that it worked. `is_error` is therefore load-bearing and is checked before
 * the text is used for anything.
 */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

  return {
    text: typeof payload.result === 'string' ? payload.result.trim() : '',
    isError: payload.is_error === true,
    // Real figures, not estimates. Cache reads and writes are input tokens the
    // plan actually accounted for, so they are counted rather than dropped.
    inputTokens:
      num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

/** Turn a refusal into something the operator can act on.
 *
 * Matched, never echoed: the CLI's output can quote the prompt it was given,
 * and the prompt is somebody's private conversation. */
export function classifyClaudeFailure(text: string, command: string): LlmError {
  const lower = text.toLowerCase();
  if (/not logged in|please run \/login|unauthorized|401|no credentials|authentication/.test(lower)) {
    return new LlmError(
      'Claude Code on this installation is not signed in. Connect your Claude subscription from '
      + 'Admin → Model, then test the model again.',
      { needsReconfiguration: true },
    );
  }
  if (/rate limit|too many requests|429|usage limit|quota|out of credit/.test(lower)) {
    return new LlmError(
      'Your Claude plan has hit its usage limit. This shares the same allowance as your own Claude '
      + 'Code sessions.',
      { retryable: true },
    );
  }
  if (/unknown option|unrecognized|not a valid|usage:/.test(lower)) {
    return new LlmError(
      `The "${command}" on this machine does not understand the options Josi uses. Update the `
      + 'Claude Code CLI, or use an Anthropic API key instead.',
      { needsReconfiguration: true },
    );
  }
  if (/network|dns|getaddrinfo|econn|timed? ?out|fetch failed/.test(lower)) {
    return new LlmError('Claude Code could not reach Anthropic.', { retryable: true });
  }
  return new LlmError(
    'Claude Code refused the request. Check the saved model and reconnect its subscription if needed.',
    { needsReconfiguration: true },
  );
}

/** Production must inject the Vault supervisor. Never fall back to an old
 * service directory or the operator's personal CLI/Keychain sign-in. */
const defaultRunner: SpawnRunner = async () => {
  throw new SubscriptionCredentialError('Connect Claude through Josi’s Vault-managed model settings.');
};

/**
 * Builds the provider.
 *
 * Both capabilities are asserted here as well as at the route:
 * `local_command_execution` because this spawns a process, and
 * `subscription_auth` because of what it spawns.
 */
export function claudeCliProvider(opts: ClaudeCliOptions): LlmProvider {
  assertCapability('local_command_execution');
  assertCapability('subscription_auth');

  const command = opts.command?.trim() || DEFAULT_CLAUDE_COMMAND;
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configDir = opts.configDir?.trim() || null;

  return {
    kind: 'anthropic_subscription' as ProviderKind,
    model: opts.model,
    // It reaches Anthropic, by way of Anthropic's own binary. Everything built
    // around `external` — the acknowledgement, the Local-only refusal —
    // therefore applies unchanged.
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      // The harness path, exactly as on Codex: tools are offered to the CLI's
      // own agent loop over MCP, or — when the server is not present — refused
      // rather than silently dropped. An agent that asked for tools and got
      // prose back would report success having done nothing.
      const serverPath = opts.mcpServerPath === undefined ? resolveMcpServerPath() : opts.mcpServerPath;
      let harness: HarnessSession | null = null;
      let mcpConfigPath: string | null = null;
      if (request.tools?.length) {
        if (!serverPath) {
          throw new LlmError(
            'The Claude Code path cannot call tools on this installation — the Josi tool server is '
            + 'not available to it. Configure an API key provider for anything that acts.',
            { needsReconfiguration: true },
          );
        }
        harness = openHarnessSession({
          serverPath,
          tools: request.tools,
          toolContext: request.toolContext,
        });
        mcpConfigPath = writeClaudeMcpConfig(harness);
      }

      const started = Date.now();
      let result: Awaited<ReturnType<SpawnRunner>>;
      let executedToolCalls: ChatResponse['executedToolCalls'];
      try {
        result = await runner({
          command,
          args: claudeArgs(opts.model, mcpConfigPath),
          input: renderClaudePrompt(request),
          env: claudeChildEnvironment(configDir),
          timeoutMs,
        });
      } catch (err) {
        if (err instanceof SubscriptionCredentialError) {
          throw new LlmError(err.message, { needsReconfiguration: !(err instanceof SubscriptionCredentialBusyError),
            retryable: err instanceof SubscriptionCredentialBusyError });
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new LlmError(
            `The Claude Code CLI was not found (looked for "${command}"). A published Josi image `
            + 'includes it; otherwise use an Anthropic API key instead.',
            { needsReconfiguration: true },
          );
        }
        if (code === 'EACCES') {
          throw new LlmError(
            `"${command}" is not executable by the account Josi runs as.`,
            { needsReconfiguration: true },
          );
        }
        throw new LlmError('The Claude Code CLI could not be started.', { needsReconfiguration: true });
      } finally {
        if (harness) {
          // Read before cleanup: the calls file is the ground truth of which
          // tools genuinely reached Josi's server, recorded by our own code
          // rather than parsed out of the CLI's event stream.
          executedToolCalls = readExecutedCalls(harness.callsPath);
          harness.cleanup();
        }
      }

      if (result.cancelled) throw new LlmError('Claude stopped because the current run no longer has authority.');
      if (result.timedOut) {
        throw new LlmError('Claude Code did not answer in time.', { retryable: true });
      }

      const parsed = parseClaudeResult(result.stdout);

      // Exit code FIRST only when there is no envelope to read: a non-zero exit
      // with no JSON is a plain failure.
      if (!parsed) {
        if (result.code !== 0) throw classifyClaudeFailure(result.stderr, command);
        throw new LlmError('Claude Code returned nothing Josi could read.', { retryable: true });
      }

      // The trap. A signed-out CLI exits zero and reports the refusal in here.
      if (parsed.isError || result.code !== 0) {
        throw classifyClaudeFailure(parsed.text || result.stderr, command);
      }
      if (!parsed.text) {
        throw new LlmError('Claude Code returned an empty answer.', { retryable: true });
      }

      return {
        text: parsed.text,
        // Nothing PENDING, ever: on the harness path the CLI's own loop already
        // ran the tools, and what ran is reported below as fact.
        toolCalls: [],
        ...(executedToolCalls?.length ? { executedToolCalls } : {}),
        // REAL counts, unlike the Codex path, because the CLI reports them.
        usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
        latencyMs: Date.now() - started,
        // Zero is the true per-call figure for a flat monthly fee. Inventing an
        // estimate would put a fabricated number into the usage ledger.
        reportedCostUsd: 0,
      };
    },
  };
}
