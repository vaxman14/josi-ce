// Turning stored configuration into a usable provider.
//
// Every rule that governs whether a model may be called at all lives here, so
// there is one place to read and one place to test:
//
//   * Local-only mode refuses external providers. Enforced HERE, in the layer
//     that builds the client — not in the UI, and not at the route. A feature
//     added later that forgets to check gets a refusal anyway.
//   * A fallback is used only when it was explicitly enabled AND the primary
//     failed in a way a second attempt could fix.
//   * Caps are checked before the call, not after.
import { openSealed, type Db, type MasterKey } from '@josi-ce/core';
import { anthropicProvider } from './providers/anthropic.js';
import { codexCliProvider, isSubscriptionProvider, type SpawnRunner } from './providers/codexCli.js';
import { claudeCliProvider } from './providers/claudeCli.js';
import { openAiCompatibleProvider } from './providers/openaiCompatible.js';
import { checkCaps, priceCall, recordUsage, type CapVerdict } from './metering.js';
import {
  LlmError, isExternalProvider,
  type Capabilities, type ChatRequest, type ChatResponse, type LlmProvider, type ProviderKind,
} from './types.js';

export interface StoredProvider {
  role: 'primary' | 'fallback';
  provider: ProviderKind;
  model: string;
  base_url: string | null;
  api_key_enc: string | null;
  external_acknowledged: boolean;
  activated_at: string | null;
  probed_at: string | null;
  cap_chat: boolean | null;
  cap_structured_output: boolean | null;
  cap_tool_calling: boolean | null;
  cap_context_tokens: number | null;
  /** Phase 13.3. Which local binary to run, for a subscription provider. Null
   * for every other kind, and never a credential. */
  subscription_command?: string | null;
}

export class LocalOnlyViolation extends LlmError {}

export interface RegistryOptions {
  db: Db;
  masterKey: MasterKey | null;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  /** How a subscription provider's local binary is run. Injected by the tests
   * so no suite ever executes a program; unset in production, where the real
   * `spawn` is used. */
  codexRunner?: SpawnRunner;
}

export async function isLocalOnly(db: Db): Promise<boolean> {
  const rows = await db.query<{ local_only: boolean }>(
    `select local_only from security_policy where id = true`,
  );
  return rows[0]?.local_only ?? false;
}

export async function loadStoredProvider(
  db: Db,
  role: 'primary' | 'fallback',
): Promise<StoredProvider | null> {
  const rows = await db.query<StoredProvider>(
    `select role, provider, model, base_url, api_key_enc, external_acknowledged, activated_at,
            probed_at, cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens,
            subscription_command
     from llm_providers where role = $1`,
    [role],
  );
  return rows[0] ?? null;
}

export function capabilitiesOf(stored: StoredProvider | null): Capabilities | null {
  if (!stored || !stored.probed_at) return null;
  return {
    chat: stored.cap_chat === true,
    structuredOutput: stored.cap_structured_output === true,
    toolCalling: stored.cap_tool_calling === true,
    contextTokens: stored.cap_context_tokens,
  };
}

/** Builds a client for a stored row.
 *
 * Refuses rather than returns null when a rule is broken, so a caller cannot
 * treat "not allowed" and "not configured" as the same thing. */
export async function buildProvider(
  opts: RegistryOptions,
  stored: StoredProvider,
): Promise<LlmProvider> {
  const external = isExternalProvider(stored.provider);

  if (external && (await isLocalOnly(opts.db))) {
    // The whole point of Local-only. A badge in the UI is a promise; this is
    // the thing that keeps it.
    throw new LocalOnlyViolation(
      'Local-only mode is on, so Josi will not send anything to a hosted model provider.',
      { needsReconfiguration: true },
    );
  }
  if (external && !stored.external_acknowledged) {
    // M89. The wizard enforces this too, but a row edited by any other means
    // must not become usable.
    throw new LlmError(
      'this provider sends data off the server and has not been acknowledged',
      { needsReconfiguration: true },
    );
  }

  // The subscription path. Checked BEFORE the key is opened, because there is
  // no key: the credential lives in the operator's own Codex login and never
  // enters this process. `codexCliProvider` asserts the edition capability
  // again on its way in — this is the third of four layers, and it is the one
  // that catches a row somebody inserted with psql on a hosted build.
  if (isSubscriptionProvider(stored.provider)) {
    if (stored.api_key_enc) {
      // A database constraint refuses this shape too. Both, because a
      // constraint added in a migration is a promise about new rows and this
      // is a promise about every call.
      throw new LlmError(
        'a subscription provider must not have an API key stored — that would bill an API '
        + 'account while calling itself a subscription',
        { needsReconfiguration: true },
      );
    }
    if (stored.provider === 'anthropic_subscription') {
      return claudeCliProvider({
        model: stored.model,
        command: stored.subscription_command ?? null,
        // Where the CLI keeps its own login. Read from the environment rather
        // than stored, because it is a property of how this container was run.
        configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
        timeoutMs: opts.timeoutMs,
        runner: opts.codexRunner,
      });
    }
    return codexCliProvider({
      model: stored.model,
      command: stored.subscription_command ?? null,
      timeoutMs: opts.timeoutMs,
      runner: opts.codexRunner,
    });
  }

  let apiKey: string | null = null;
  if (stored.api_key_enc) {
    if (!opts.masterKey) {
      throw new LlmError('the installation master key is unavailable, so the stored API key cannot be opened', {
        needsReconfiguration: true,
      });
    }
    apiKey = openSealed<{ apiKey: string }>(opts.masterKey, stored.api_key_enc).apiKey;
  }

  const shared = {
    model: stored.model,
    apiKey,
    baseUrl: stored.base_url,
    fetchImpl: opts.fetchImpl,
    resolve: opts.resolve,
    timeoutMs: opts.timeoutMs,
  };

  if (stored.provider === 'anthropic') return anthropicProvider(shared);
  return openAiCompatibleProvider({ ...shared, kind: stored.provider, external });
}

/** Prices a completed call and writes the usage row.
 *
 * Tokens and cost, never content — there is no column for a prompt and no
 * argument here that could carry one. */
async function meterCall(
  db: Db,
  stored: StoredProvider,
  role: 'primary' | 'fallback',
  external: boolean,
  response: ChatResponse,
  chatOpts: ChatOptions,
): Promise<void> {
  const cost = await priceCall(db, {
    provider: stored.provider,
    model: stored.model,
    usage: response.usage,
    reportedCostUsd: response.reportedCostUsd,
    external,
  });
  await recordUsage(db, {
    userId: chatOpts.userId,
    provider: stored.provider,
    model: stored.model,
    role,
    usage: response.usage,
    cost,
    latencyMs: response.latencyMs,
    purpose: chatOpts.purpose,
  });
}

/** Wraps a provider so every call it makes is metered.
 *
 * The capability probe uses this. A probe against a hosted provider is four
 * real requests that appear on a real invoice, so hiding them from the usage
 * report would make the report wrong in the direction that flatters us. The cap
 * is deliberately NOT enforced on them: an operator who has hit their cap still
 * has to be able to test a replacement model. */
export function meteredProvider(
  db: Db,
  stored: StoredProvider,
  role: 'primary' | 'fallback',
  provider: LlmProvider,
  chatOpts: ChatOptions = {},
): LlmProvider {
  return {
    kind: provider.kind,
    model: provider.model,
    external: provider.external,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await provider.chat(request);
      await meterCall(db, stored, role, provider.external, response, chatOpts);
      return response;
    },
  };
}

export interface ChatOutcome {
  response: ChatResponse;
  /** Which configured provider answered. */
  usedRole: 'primary' | 'fallback';
  cap: CapVerdict;
}

export interface ChatOptions {
  userId?: string | null;
  purpose?: string;
  /** Set false to skip cap enforcement for a system call that must not be
   * billed to anyone — the capability probe, for instance. */
  enforceCaps?: boolean;
}

/** The one way anything in CE talks to a model.
 *
 * Order: cap check, primary, then fallback only if it is enabled and the
 * failure was the kind a different provider could survive. */
export async function chat(
  opts: RegistryOptions,
  request: ChatRequest,
  chatOpts: ChatOptions = {},
): Promise<ChatOutcome> {
  const cap = await checkCaps(opts.db, chatOpts.userId);
  if (chatOpts.enforceCaps !== false && !cap.allowed) {
    throw new LlmError(cap.message, { needsReconfiguration: true });
  }

  const primary = await loadStoredProvider(opts.db, 'primary');
  if (!primary) throw new LlmError('no model provider is configured');
  if (!primary.activated_at) {
    throw new LlmError('the configured model has not been tested yet, so Josi will not use it', {
      needsReconfiguration: true,
    });
  }

  const runOne = async (stored: StoredProvider, role: 'primary' | 'fallback'): Promise<ChatOutcome> => {
    const provider = await buildProvider(opts, stored);
    const response = await provider.chat(request);
    await meterCall(opts.db, stored, role, provider.external, response, chatOpts);
    return { response, usedRole: role, cap };
  };

  try {
    return await runOne(primary, 'primary');
  } catch (err) {
    const fallback = await loadStoredProvider(opts.db, 'fallback');
    const retryable = err instanceof LlmError && err.retryable;

    // Three conditions, all required. A fallback that fires on a bad API key
    // would quietly move a workspace onto a second provider — and a second
    // bill — because someone mistyped a character.
    if (!fallback || !fallback.activated_at || !retryable) throw err;

    // Local-only and acknowledgment are re-checked inside buildProvider, so a
    // fallback cannot be the way an external provider sneaks in.
    return await runOne(fallback, 'fallback');
  }
}
