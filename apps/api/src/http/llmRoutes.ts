// Model configuration, capability probing, spending caps and usage.
//
// Two routers, split by what they are allowed to reveal:
//
//   * The admin router configures the installation. It never returns a key, a
//     prompt, or a reply — only whether a key is set and what a probe observed.
//   * The member router answers one question: what can Josi do for me right
//     now, and how much of my own allowance is left. A member cannot see the
//     provider's key, the workspace's other members' usage, or the caps of
//     anyone but themselves.
//
// Every rule that decides whether a model may be called lives in
// packages/llm/src/registry.ts, not here. A route is a bad place for a security
// control: the next route forgets it.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, asSecret, loadMasterKey, seal,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  UnsafeEndpointError, buildProvider, capabilitiesOf, checkCaps, disabledFeatures,
  isExternalProvider, isLocalOnly, loadStoredProvider, meteredProvider, probeProvider, usageSummary,
  validateEndpoint, LlmError,
} from '@josi-ce/llm';
import { asyncRoute, param } from './async.js';
import { assertMetadataOnly, requireAuth, requireSuperAdmin } from './authz.js';

export interface LlmRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected in tests so no provider is ever contacted by the suite. */
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const KNOWN_PROVIDERS = ['openai', 'anthropic', 'xai', 'openai_compatible'];

function requireMasterKey(ctx: LlmRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    // The loader's message names a filesystem path. The operator gets the
    // actionable half without it.
    throw new RouteError(
      503,
      'the installation master key is missing or unusable, so nothing can be saved securely.',
    );
  }
}

/** M83. These exist in the product conversation, so they are named rather than
 * hidden — but every one of them is unavailable, with the actual reason.
 *
 * Reusing a Claude Pro, ChatGPT Plus or Copilot subscription from a server
 * means driving a session that was issued to a person, in a browser, under
 * terms that do not permit it. There is no compliant path, so there is no
 * enabled button. Saying "coming soon" here would be a lie with a date on it. */
const SUBSCRIPTION_OPTIONS = [
  { id: 'claude_subscription', label: 'Use my Claude subscription' },
  { id: 'chatgpt_subscription', label: 'Use my ChatGPT subscription' },
  { id: 'copilot_subscription', label: 'Use my GitHub Copilot subscription' },
].map((o) => ({
  ...o,
  available: false,
  reason:
    'Consumer subscriptions are licensed for one person using an app, not for a server answering on their behalf. '
    + 'Josi will not drive one from here, so this needs an API key from the same provider instead.',
}));

interface ProviderDto {
  role: 'primary' | 'fallback';
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Whether a key is stored. Never the key, never its length or prefix. */
  apiKeySet: boolean;
  external: boolean;
  externalAcknowledged: boolean;
  active: boolean;
  probedAt: string | null;
  capabilities: ReturnType<typeof capabilitiesOf>;
  probeSteps: unknown;
}

async function providerDto(db: Db, role: 'primary' | 'fallback'): Promise<ProviderDto | null> {
  const stored = await loadStoredProvider(db, role);
  if (!stored) return null;
  const [steps] = await db.query<{ probe_steps: unknown }>(
    `select probe_steps from llm_providers where role = $1`,
    [role],
  );
  const dto: ProviderDto = {
    role,
    provider: stored.provider,
    model: stored.model,
    baseUrl: stored.base_url,
    apiKeySet: !!stored.api_key_enc,
    external: isExternalProvider(stored.provider),
    externalAcknowledged: stored.external_acknowledged,
    active: !!stored.activated_at,
    probedAt: stored.probed_at,
    capabilities: capabilitiesOf(stored),
    probeSteps: steps?.probe_steps ?? [],
  };
  // Belt and braces: a careless `...stored` spread added later throws here
  // rather than serialising the sealed key.
  assertMetadataOnly(dto as unknown as Record<string, unknown>);
  return dto;
}

// ------------------------------------------------------------------- admin

export function adminLlmRoutes(ctx: LlmRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** Turns the two expected refusals into responses an operator can act on, and
   * lets anything unexpected reach the error handler — which says nothing at
   * all, because an unexpected error's message is not ours to publish. */
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    asyncRoute(async (req: Request, res: Response) => {
      try {
        return await fn(req, res);
      } catch (err: unknown) {
        if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
        if (err instanceof UnsafeEndpointError) return res.status(400).json({ error: err.message });
        throw err;
      }
    });

  r.get(
    '/',
    handle(async (_req, res) => {
      const primary = await providerDto(db, 'primary');
      const [caps] = await db.query(
        `select monthly_cost_usd, monthly_tokens from llm_caps where id = true`,
      );
      return res.json({
        primary,
        fallback: await providerDto(db, 'fallback'),
        localOnly: await isLocalOnly(db),
        // What CE will and will not do right now, with the reason attached.
        disabledFeatures: disabledFeatures(primary?.capabilities ?? null),
        caps,
        subscriptionOptions: SUBSCRIPTION_OPTIONS,
      });
    }),
  );

  /** Configure a provider.
   *
   * Saving ALWAYS clears the probe result and deactivates. A model that was
   * proven to call tools yesterday says nothing about the one whose name was
   * just typed in — and leaving the old capabilities attached would silently
   * re-enable features against an untested model. */
  r.put(
    '/providers/:role',
    handle(async (req, res) => {
      const role = param(req, 'role');
      if (role !== 'primary' && role !== 'fallback') throw new RouteError(404, 'no such provider slot');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = str(body.provider, 32);
      const model = str(body.model, 120);
      const baseUrl = str(body.baseUrl, 500);
      const apiKey = asSecret(body.apiKey);
      const acknowledged = body.externalAcknowledged === true;

      if (!KNOWN_PROVIDERS.includes(provider)) throw new RouteError(400, 'choose a model provider');
      if (!model) throw new RouteError(400, 'a model name is required');

      const external = isExternalProvider(provider);
      if (external && (await isLocalOnly(db))) {
        // Refusing at save time as well as at call time. Storing a provider
        // that can never be used is a trap for whoever configures it next.
        throw new RouteError(
          409,
          'Local-only mode is on, so a hosted provider cannot be configured. Turn Local-only off first if that is what you want.',
        );
      }
      if (external && !acknowledged) {
        throw new RouteError(
          400,
          'to use a hosted model provider you must acknowledge that the data needed for each request leaves this server '
          + "and is processed under that provider's terms",
        );
      }
      if (external && apiKey.isEmpty) throw new RouteError(400, 'an API key is required for this provider');

      if (provider === 'openai_compatible') {
        if (!baseUrl) throw new RouteError(400, 'a base URL is required for a self-hosted endpoint');
        // Resolves and classifies. Loopback and LAN pass; cloud metadata does
        // not. See packages/llm/src/ssrf.ts for why that split is the right one.
        await validateEndpoint(baseUrl, { resolve: ctx.resolve });
      }

      const existing = await loadStoredProvider(db, role);
      // An empty key field on an update means "leave it alone", not "delete it".
      const sealedKey = apiKey.isEmpty
        ? existing?.api_key_enc ?? null
        // `seal` unwraps the Secret itself; nothing here ever calls reveal().
        : seal(requireMasterKey(ctx), { apiKey });

      await db.query(
        `insert into llm_providers
           (role, provider, model, base_url, api_key_enc, external_acknowledged, external_acknowledged_at,
            activated_at, probed_at, probe_steps,
            cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
         values ($1, $2, $3, $4, $5, $6, $7, null, null, '[]', null, null, null, null)
         on conflict (role) do update set
           provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
           api_key_enc = excluded.api_key_enc,
           external_acknowledged = excluded.external_acknowledged,
           external_acknowledged_at = excluded.external_acknowledged_at,
           activated_at = null, probed_at = null, probe_steps = '[]',
           cap_chat = null, cap_structured_output = null, cap_tool_calling = null,
           cap_context_tokens = null`,
        [
          role, provider, model,
          provider === 'openai_compatible' ? baseUrl : null,
          sealedKey,
          external ? true : acknowledged,
          external ? new Date().toISOString() : null,
        ],
      );

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'llm.configured',
        // The provider and model are configuration. The key is not recorded in
        // any form, not even as a hash.
        payload: { role, provider, model, external },
      });

      return res.json({ provider: await providerDto(db, role), needsProbe: true });
    }),
  );

  r.delete(
    '/providers/fallback',
    handle(async (req, res) => {
      await db.query(`delete from llm_providers where role = 'fallback'`);
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.fallback_removed',
      });
      return res.status(204).end();
    }),
  );

  /** Run the capability probe and store what it observed.
   *
   * This is the ONLY thing that sets `activated_at`. Nothing is inferred from
   * the model name, and a probe that cannot hold a basic conversation leaves
   * the provider inactive. */
  r.post(
    '/providers/:role/probe',
    handle(async (req, res) => {
      const role = param(req, 'role');
      if (role !== 'primary' && role !== 'fallback') throw new RouteError(404, 'no such provider slot');

      const stored = await loadStoredProvider(db, role);
      if (!stored) throw new RouteError(404, 'that provider is not configured');

      let result;
      try {
        const provider = await buildProvider(
          { db, masterKey: ctx.masterKey === false ? null : loadMasterKey(ctx.masterKey ?? {}), fetchImpl: ctx.fetchImpl, resolve: ctx.resolve },
          stored,
        );
        // Metered. Probing a hosted provider is four real requests on a real
        // invoice; leaving them out of the usage report would understate spend.
        result = await probeProvider(meteredProvider(db, stored, role, provider, { purpose: 'probe' }));
      } catch (err) {
        // A refusal (Local-only, missing acknowledgment, unusable key) is not a
        // failed probe — nothing was asked. Say which it was.
        const message = err instanceof LlmError ? err.message : 'the probe could not run';
        return res.status(409).json({ error: message });
      }

      await db.query(
        `update llm_providers set
           probed_at = $2, probe_steps = $3::jsonb,
           cap_chat = $4, cap_structured_output = $5, cap_tool_calling = $6, cap_context_tokens = $7,
           activated_at = case when $4 then coalesce(activated_at, now()) else null end
         where role = $1`,
        [
          role, result.probedAt, JSON.stringify(result.steps),
          result.capabilities.chat, result.capabilities.structuredOutput,
          result.capabilities.toolCalling, result.capabilities.contextTokens,
        ],
      );

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'llm.probed',
        payload: { role, capabilities: result.capabilities, passed: result.capabilities.chat },
      });

      const dto = await providerDto(db, role);
      return res.json({
        provider: dto,
        result: { steps: result.steps, fatal: result.fatal },
        // The consequence, stated plainly, rather than four booleans the
        // operator has to interpret.
        disabledFeatures: role === 'primary' ? disabledFeatures(dto?.capabilities ?? null) : [],
      });
    }),
  );

  // -------------------------------------------------------------- local-only
  r.put(
    '/local-only',
    handle(async (req, res) => {
      const enabled = (req.body ?? {}).enabled === true;

      if (enabled) {
        // Turning it on while a hosted provider is configured would leave an
        // installation that claims to be local and cannot answer anything.
        const rows = await db.query<{ role: string; provider: string }>(
          `select role, provider from llm_providers`,
        );
        const hosted = rows.filter((row) => isExternalProvider(row.provider));
        if (hosted.length) {
          throw new RouteError(
            409,
            `remove the hosted provider${hosted.length > 1 ? 's' : ''} first (${hosted.map((h) => h.role).join(', ')}), `
            + 'otherwise Local-only mode would leave this installation with no usable model.',
          );
        }
      }

      await db.query(`update security_policy set local_only = $1 where id = true`, [enabled]);
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.local_only_changed',
        payload: { enabled },
      });
      return res.json({ localOnly: enabled });
    }),
  );

  // -------------------------------------------------------------------- caps
  const capValue = (v: unknown, field: string): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    // 0 is refused rather than silently meaning "unlimited": an operator who
    // types 0 means "stop everything", and null already means "no cap".
    if (!Number.isFinite(n) || n <= 0) throw new RouteError(400, `${field} must be a positive number, or empty for no cap`);
    return n;
  };

  r.put(
    '/caps',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cost = capValue(body.monthlyCostUsd, 'the monthly spend cap');
      const tokens = capValue(body.monthlyTokens, 'the monthly token cap');
      await db.query(
        `update llm_caps set monthly_cost_usd = $1, monthly_tokens = $2 where id = true`,
        [cost, tokens],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.caps_changed',
        payload: { monthlyCostUsd: cost, monthlyTokens: tokens },
      });
      return res.json({ caps: { monthly_cost_usd: cost, monthly_tokens: tokens } });
    }),
  );

  r.put(
    '/caps/users/:userId',
    handle(async (req, res) => {
      const userId = param(req, 'userId');
      const users = await db.query<{ id: string }>(`select id from users where id = $1`, [userId]);
      if (!users.length) throw new RouteError(404, 'no such user');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const cost = capValue(body.monthlyCostUsd, "the member's monthly spend cap");
      const tokens = capValue(body.monthlyTokens, "the member's monthly token cap");

      if (cost === null && tokens === null) {
        await db.query(`delete from llm_user_caps where user_id = $1`, [userId]);
      } else {
        await db.query(
          `insert into llm_user_caps (user_id, monthly_cost_usd, monthly_tokens) values ($1, $2, $3)
           on conflict (user_id) do update set
             monthly_cost_usd = excluded.monthly_cost_usd, monthly_tokens = excluded.monthly_tokens`,
          [userId, cost, tokens],
        );
      }
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'llm.user_cap_changed',
        subjectType: 'user', subjectId: userId,
        payload: { monthlyCostUsd: cost, monthlyTokens: tokens },
      });
      return res.json({ userId, monthlyCostUsd: cost, monthlyTokens: tokens });
    }),
  );

  // ------------------------------------------------------------------- usage
  r.get(
    '/usage',
    handle(async (_req, res) => {
      // Aggregate token counts and cost, split by source, per member. How much
      // someone spent is administration; what they said is not, and no prompt
      // or reply is stored anywhere to return.
      const perUser = await db.query(
        `select u.id as user_id, u.username,
                sum(l.input_tokens + l.output_tokens)::bigint as tokens,
                sum(case when l.cost_source = 'reported' then l.cost_usd else 0 end)::float8 as reported_cost_usd,
                sum(case when l.cost_source = 'estimated' then l.cost_usd else 0 end)::float8 as estimated_cost_usd,
                count(*)::int as calls
         from llm_usage l join users u on u.id = l.user_id
         where l.created_at >= date_trunc('month', now())
         group by u.id, u.username
         order by tokens desc`,
      );
      return res.json({
        summary: await usageSummary(db),
        perUser,
        cap: await checkCaps(db),
      });
    }),
  );

  return r;
}

// ------------------------------------------------------------------ member

/** What a signed-in member is allowed to know about the model.
 *
 * Deliberately thin. A member needs to know which features work and how much of
 * their own allowance is left; they do not need the provider, the model name,
 * the endpoint, or anyone else's usage. */
export function llmRoutes(ctx: LlmRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  r.get(
    '/status',
    asyncRoute(async (req, res) => {
      const primary = await loadStoredProvider(db, 'primary');
      const capabilities = capabilitiesOf(primary);
      return res.json({
        // Whether Josi can answer at all, and if not, why not.
        ready: !!primary?.activated_at && capabilities?.chat === true,
        localOnly: await isLocalOnly(db),
        disabledFeatures: disabledFeatures(capabilities),
        // Scoped to the caller. `req.user!.id` is from the session cookie, not
        // from a parameter, so a member cannot ask about somebody else.
        usage: await usageSummary(db, req.user!.id),
        cap: await checkCaps(db, req.user!.id),
      });
    }),
  );

  return r;
}
