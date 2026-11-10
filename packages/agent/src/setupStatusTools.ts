// Josi knows her own setup.
//
// "Josi is the interface" (docs/JOSI_IS_THE_INTERFACE.md, rule 1): any question
// about Josi's own configuration is answered by Josi in chat. This read tool
// gives the model the facts a settings screen would show: the address, the
// connectors and what each needs (including the exact redirect URIs to paste
// into Google's or Microsoft's console), the models and their checked
// capabilities, mail, PC control and the version.
//
// Metadata only. No secret, sealed or not, is ever selected here: client IDs
// are public by design, a token or password appears only as "set" or "not set".
// The owner (super-admin) sees the installation; a member sees their own
// connections and the facts everyone may know (address, model names, version).
import { networkInterfaces } from 'node:os';
import type { Db } from '@josi-ce/core';
import { OAUTH_PROVIDERS, clientStatuses, sharedGoogleAvailable, systemMailAccount, DEVELOPER_SERVICE_CATALOG, type OAuthProvider } from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';

export const SETUP_TOPICS = ['all', 'address', 'connectors', 'models', 'mail', 'pc_control', 'members', 'version'] as const;
export type SetupTopic = (typeof SETUP_TOPICS)[number];

export const SETUP_STATUS_TOOLS: ToolSpec[] = [
  { def: { name: 'josi_setup_status',
    description: 'Read how this Josi installation is set up, so you can answer any question about Josi herself: her address and how she is reached; each connector (Google, Microsoft, Dropbox, Box, Nextcloud, GitHub and the other developer services), whether it is ready, what credential it still needs and the exact redirect URIs to register; the models in use and what they passed; whether mail is configured; PC control; members; the version. Call it whenever the person asks about Josi\'s setup, before answering. It changes nothing and never returns a secret.',
    parameters: { type: 'object', properties: {
      topic: { type: 'string', enum: [...SETUP_TOPICS], description: 'Narrow the answer to one area, or "all".' },
    }, additionalProperties: false } }, actionClass: null },
];
export const SETUP_STATUS_TOOL_NAMES = new Set(SETUP_STATUS_TOOLS.map((t) => t.def.name));

export const SETUP_STATUS_PROMPT = 'You are the way Josi is configured. When the person asks anything about Josi\'s own setup (her address, a redirect URI, which model is active, what is connected or what a connector needs, mail, PC control, the version), call josi_setup_status and answer from it directly, in plain words, quoting values such as addresses and redirect URIs exactly. '
  + 'Never answer "check the Josi app" or send them to a screen: you have the facts, and a change is made by asking you (propose_josi_setting_change or a credential card). A screen may be mentioned only as an extra after the answer. '
  + 'When something is not set up, say what it needs in one sentence and offer to set it up now.';

/** The address this installation is reached at: the running APP_URL, or the
 * stored domain when APP_URL is only a local address. Mirrors the API's own
 * deployment resolution so the redirect URIs shown here are the ones the
 * callback routes actually answer on. */
export async function installationOrigin(db: Db, fallback = (process.env.APP_URL ?? '').replace(/\/$/, '') || 'http://localhost:8080'): Promise<{ origin: string; publicHttpsBase: string | null; mode: 'this_pc' | 'network' | 'public' }> {
  const configured = fallback.replace(/\/$/, '');
  let parsed: URL | null = null;
  try { parsed = new URL(configured); } catch { parsed = null; }
  const isPublicHost = (host: string) => host !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !/\.local$/i.test(host);
  const publicOrigin = parsed?.protocol === 'https:' && isPublicHost(parsed.hostname) ? parsed.origin : null;
  let domain: string | undefined;
  try {
    const [deployment] = await db.query<{ domain: string | null }>('select domain from deployment_config where id = true');
    domain = deployment?.domain?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '') || undefined;
  } catch { domain = undefined; }
  const origin = publicOrigin ?? (domain ? `https://${domain}` : configured);
  const publicHttpsBase = publicOrigin ?? (domain && isPublicHost(domain) ? `https://${domain}` : null);
  const host = (() => { try { return new URL(origin).hostname; } catch { return 'localhost'; } })();
  const mode = host === 'localhost' || host === '127.0.0.1' ? 'this_pc' : publicHttpsBase ? 'public' : 'network';
  return { origin, publicHttpsBase, mode };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
  }
  return out;
}

/** What each OAuth provider needs from the owner, in the words of the console
 * they will be looking at. The URIs come from `installationOrigin`. */
export function connectorRequirement(provider: OAuthProvider | 'nextcloud', origin: string): { needs: string; redirectUris: string[]; console: string | null; steps: string } {
  const callback = `${origin}/api/connections/${provider}/callback`;
  switch (provider) {
    case 'google': return { needs: 'An OAuth client ID and client secret (Web application) from Google Cloud Console.',
      redirectUris: [callback, `${origin}/api/auth/google/callback`], console: 'https://console.cloud.google.com/apis/credentials',
      steps: 'In Google Cloud Console create an OAuth client of type Web application, add both redirect URIs exactly, enable the Gmail, Calendar, People and Drive APIs you want, then paste the client ID and secret into the cards Josi opens.' };
    case 'microsoft': return { needs: 'An application (client) ID and a client secret from Microsoft Entra (Azure AD) app registrations.',
      redirectUris: [callback], console: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      steps: 'Register an application for personal and work accounts, add the redirect URI as a Web platform, create a client secret, then paste the application ID and the secret value into the cards Josi opens.' };
    case 'dropbox': return { needs: 'An app key and app secret from the Dropbox App Console.', redirectUris: [callback], console: 'https://www.dropbox.com/developers/apps',
      steps: 'Create a scoped app with full Dropbox access, add the redirect URI, then paste the app key and app secret into the cards Josi opens.' };
    case 'box': return { needs: 'A client ID and client secret from the Box Developer Console.', redirectUris: [callback], console: 'https://app.box.com/developers/console',
      steps: 'Create a custom app with user authentication (OAuth 2.0), add the redirect URI, then paste the client ID and secret into the cards Josi opens.' };
    default: return { needs: 'Nothing to register: the person signs in to their own Nextcloud server when connecting.', redirectUris: [], console: null, steps: 'Ask Josi to connect Nextcloud and give the server address; the person approves in their Nextcloud.' };
  }
}

interface Viewer { id: string; role: string }

export async function executeSetupStatusTool(db: Db, userId: string, name: string, input: Record<string, unknown>) {
  if (name !== 'josi_setup_status') return { ok: false, code: 'unknown_tool' };
  const topic = (SETUP_TOPICS as readonly string[]).includes(String(input.topic ?? '')) ? String(input.topic) as SetupTopic : 'all';
  const [user] = await db.query<Viewer>('select id, role from users where id = $1', [userId]);
  const admin = user?.role === 'super_admin';
  const want = (t: SetupTopic) => topic === 'all' || topic === t;
  const deployment = await installationOrigin(db);
  const out: Record<string, unknown> = { ok: true, observedAt: new Date().toISOString(), viewer: admin ? 'owner' : 'member' };

  if (want('version')) {
    out.version = { josi: process.env.JOSI_VERSION ?? 'development', platform: process.platform, node: process.versions.node };
  }
  if (want('address')) {
    out.address = {
      url: deployment.origin,
      reachable: deployment.mode === 'this_pc' ? 'Only on this PC.' : deployment.mode === 'network' ? 'On this network (or over a VPN such as Tailscale); not from the public internet.' : 'From anywhere, over HTTPS.',
      https: deployment.origin.startsWith('https://'),
      publicHttpsBase: deployment.publicHttpsBase,
      lanAddresses: admin ? lanAddresses() : undefined,
      note: deployment.publicHttpsBase ? null : 'Google and Microsoft accept a redirect URI only on an HTTPS address with a real domain name. Until the address is one, those two connectors cannot be registered; the others work.',
      changeBy: admin ? 'propose_josi_setting_change with area network_address' : 'Only the administrator can change the address.',
    };
  }
  if (want('connectors')) {
    const clients = admin ? await clientStatuses(db) : [];
    const shared = await sharedGoogleAvailable(db).catch(() => false);
    const mine = await db.query<{ provider: string; account_email: string | null; status: string; last_check_ok: boolean | null }>(
      'select provider, account_email, status, last_check_ok from connections where owner_user_id = $1 order by provider', [userId]);
    const oauth = [...OAUTH_PROVIDERS, 'nextcloud' as const].map((provider) => {
      const client = clients.find((c) => c.provider === provider);
      const requirement = connectorRequirement(provider, deployment.origin);
      const configured = provider === 'nextcloud' ? true : (client?.configured ?? false) || (provider === 'google' && shared);
      const connections = mine.filter((c) => c.provider === provider).map((c) => ({ account: c.account_email, status: c.status, lastCheckOk: c.last_check_ok }));
      return {
        provider,
        ready: admin ? configured : undefined,
        registeredBy: provider === 'google' && shared && !client?.configured ? 'heyjosi.com shared application' : client?.configured ? 'this installation' : null,
        clientId: admin ? client?.clientId ?? null : undefined,
        needs: admin && !configured ? requirement.needs : null,
        redirectUris: admin ? requirement.redirectUris : undefined,
        console: admin ? requirement.console : undefined,
        setupSteps: admin && !configured ? requirement.steps : undefined,
        myConnections: connections,
        connected: connections.some((c) => c.status === 'active'),
      };
    });
    const dev = await db.query<{ service: string; account_label: string | null; status: string; last_check_ok: boolean | null }>(
      'select service, account_label, status, last_check_ok from developer_connections where owner_user_id = $1', [userId]);
    const policy = admin ? await db.query<{ service: string; mode: string }>('select service, mode from developer_service_policy') : [];
    const developer = DEVELOPER_SERVICE_CATALOG.map((d) => {
      const connection = dev.find((c) => c.service === d.service);
      return {
        service: d.service, label: d.label, needs: d.tokenLabel, whereToGetIt: d.tokenUrl, help: d.tokenHelp, letsJosi: d.capability,
        connected: connection?.status === 'active', account: connection?.account_label ?? null, lastCheckOk: connection?.last_check_ok ?? null,
        membersMayConnect: admin ? (policy.find((p) => p.service === d.service)?.mode ?? 'not_allowed') : undefined,
      };
    });
    out.connectors = { oauth, developer,
      howToSetUp: 'Each connector is available to the owner by default. To set one up, ask Josi: she asks for each credential with a card the person pastes into (request_credential_card); the value goes to the Vault and never through the conversation. Members ask Josi, and the owner approves from chat, the app or their phone.' };
  }
  if (want('models')) {
    const providers = await db.query<{ role: string; provider: string; model: string; base_url: string | null; activated_at: string | null; external_acknowledged: boolean; has_key: boolean }>(
      'select role, provider, model, base_url, activated_at::text as activated_at, external_acknowledged, api_key_enc is not null as has_key from llm_providers order by role');
    const probes = await db.query<{ provider: string; model: string; base_url: string; probed_at: string; cap_chat: boolean | null; cap_structured_output: boolean | null; cap_tool_calling: boolean | null; cap_vision: boolean | null; cap_context_tokens: number | null }>(
      'select provider, model, base_url, probed_at::text as probed_at, cap_chat, cap_structured_output, cap_tool_calling, cap_vision, cap_context_tokens from llm_probe_memory').catch(() => []);
    const [security] = await db.query<{ local_only: boolean }>('select local_only from security_policy where id = true').catch(() => []);
    out.models = {
      slots: providers.map((p) => {
        const probe = probes.find((x) => x.provider === p.provider && x.model === p.model && (x.base_url ?? '') === (p.base_url ?? ''));
        return { role: p.role, provider: p.provider, model: p.model, baseUrl: p.base_url, active: !!p.activated_at,
          apiKey: admin ? (p.has_key ? 'set' : 'not set') : undefined, externalAcknowledged: admin ? p.external_acknowledged : undefined,
          checked: probe ? { at: probe.probed_at, chat: probe.cap_chat, toolCalling: probe.cap_tool_calling, structuredOutput: probe.cap_structured_output, vision: probe.cap_vision, contextTokens: probe.cap_context_tokens } : null };
      }),
      checkedModels: admin ? probes.map((x) => ({ provider: x.provider, model: x.model, toolCalling: x.cap_tool_calling, vision: x.cap_vision })) : undefined,
      localOnly: security?.local_only ?? false,
      changeBy: admin ? 'propose_josi_setting_change with area model_provider (the model picker in the chat bar switches instantly too). An API key is pasted into a card, never typed in chat.' : 'Only the administrator can change the model.',
    };
  }
  if (want('mail') && admin) {
    const profiles = await db.query<{ kind: string; copy_from_system: boolean; host: string | null; port: number | null; security: string | null; username: string | null; has_password: boolean; from_name: string | null; from_address: string | null; verified_at: string | null }>(
      'select kind, copy_from_system, host, port, security, username, password_enc is not null as has_password, from_name, from_address, verified_at::text as verified_at from smtp_profiles order by kind');
    const account = await systemMailAccount(db);
    out.mail = {
      smtp: profiles.map((p) => ({ profile: p.kind, copiesSystem: p.copy_from_system, host: p.host, port: p.port, security: p.security, username: p.username, password: p.has_password ? 'set' : 'not set', from: p.from_address ? `${p.from_name ?? ''} <${p.from_address}>`.trim() : null, verified: !!p.verified_at })),
      // Josi's own email can go out through a connected Google or Microsoft account instead of a mail server.
      account: account?.active ? { provider: account.provider, from: account.accountEmail } : null,
      configured: !!account?.active || profiles.some((p) => p.kind === 'system' && p.host),
      note: account?.active || profiles.some((p) => p.kind === 'system' && p.host) ? null : 'No mail server yet: invitations, sign-in codes and reports cannot be emailed. Set it up by asking Josi; the password goes into a card.',
    };
  }
  if (want('pc_control') && admin) {
    const pcs = await db.query<{ pc_id: string; enabled: boolean; online: boolean; paired: boolean; policies: number; pending: number }>(
      `select s.pc_id, s.enabled,
         exists(select 1 from pc_control_presence pr where pr.owner_user_id = s.owner_user_id and pr.pc_id = s.pc_id and pr.expires_at > now()) as online,
         exists(select 1 from pc_executor_identity i where i.owner_user_id = s.owner_user_id and i.pc_id = s.pc_id) as paired,
         (select count(*)::int from pc_control_policies p where p.owner_user_id = s.owner_user_id and p.pc_id = s.pc_id) as policies,
         (select count(*)::int from pc_control_requests r where r.owner_user_id = s.owner_user_id and r.pc_id = s.pc_id and r.state = 'pending') as pending
       from pc_control_settings s where s.owner_user_id = $1 order by s.pc_id`, [userId]).catch(() => []);
    out.pcControl = {
      computers: pcs.map((pc) => ({ pcId: pc.pc_id, enabled: pc.enabled, appOpenNow: pc.online, paired: pc.paired, savedPermissions: pc.policies, waitingRequests: pc.pending })),
      note: pcs.length ? null : 'No computer is registered yet. Open the Josi app on the PC and approve it under PC Control, or ask Josi to register this PC.',
      detailsBy: 'pc_get_permissions for the exact permissions, catalog and pending requests.',
    };
  }
  if (want('members') && admin) {
    const people = await db.query<{ display_name: string | null; email: string | null; role: string; status: string }>(
      'select display_name, email, role, status from users order by role desc, created_at').catch(() => []);
    out.members = people.map((p) => ({ name: p.display_name, email: p.email, role: p.role, status: p.status }));
  }
  if (!admin && (topic === 'mail' || topic === 'pc_control' || topic === 'members')) {
    out.note = 'That part of the setup belongs to the administrator; a member sees their own connections, the address, the models and the version.';
  }
  return out;
}
