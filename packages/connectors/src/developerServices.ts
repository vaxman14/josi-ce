// Developer services: GitHub, Netlify, Vercel, Supabase.
//
// Each is one person's own account, reached with a token that person creates
// and pastes. There is no installation-wide application to register and no
// shared credential, which is why the administrator surface for these governs
// PERMISSION rather than configuration — see migration 0033 for why those are
// two tables.
//
// The token check is a real call to the service's own identity endpoint. It is
// the cheapest request that proves the token is valid and tells the owner which
// account they just connected; nothing else about the account is read, and
// nothing is stored from the response but the account's own name.
export type DeveloperService = 'github' | 'netlify' | 'vercel' | 'supabase';

export const DEVELOPER_SERVICES: readonly DeveloperService[] = [
  'github', 'netlify', 'vercel', 'supabase',
];

export function isDeveloperService(value: unknown): value is DeveloperService {
  return typeof value === 'string' && (DEVELOPER_SERVICES as readonly string[]).includes(value);
}

export type PermissionMode = 'not_allowed' | 'everyone' | 'specific_users';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'not_allowed' || value === 'everyone' || value === 'specific_users';
}

export interface DeveloperServiceDescriptor {
  service: DeveloperService;
  label: string;
  /** What the person is pasting, in that service's own words. */
  tokenLabel: string;
  /** Where they get it. A token field with no route to the token is a dead end. */
  tokenHelp: string;
  tokenUrl: string;
  /** What Josi will be able to do with it, so permitting is informed. */
  capability: string;
}

export const DEVELOPER_SERVICE_CATALOG: readonly DeveloperServiceDescriptor[] = [
  {
    service: 'github',
    label: 'GitHub',
    tokenLabel: 'Personal access token',
    tokenHelp:
      'In GitHub open Settings → Developer settings → Personal access tokens and create one. '
      + 'Give it only the repositories and permissions you want Josi to see.',
    tokenUrl: 'https://github.com/settings/tokens',
    capability: 'Read the repositories your token permits, and act on them where you approve it.',
  },
  {
    service: 'netlify',
    label: 'Netlify',
    tokenLabel: 'Personal access token',
    tokenHelp:
      'In Netlify open User settings → Applications → Personal access tokens and create one.',
    tokenUrl: 'https://app.netlify.com/user/applications',
    capability: 'See your sites and their deploy status.',
  },
  {
    service: 'vercel',
    label: 'Vercel',
    tokenLabel: 'Access token',
    tokenHelp: 'In Vercel open Account Settings → Tokens and create one, scoped to the team you want.',
    tokenUrl: 'https://vercel.com/account/tokens',
    capability: 'See your projects and their deployments.',
  },
  {
    service: 'supabase',
    label: 'Supabase',
    tokenLabel: 'Personal access token',
    tokenHelp: 'In Supabase open Account → Access Tokens and generate one.',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    capability: 'See your projects. Josi does not read the contents of your database.',
  },
];

export function describeDeveloperService(
  service: string,
): DeveloperServiceDescriptor | null {
  return DEVELOPER_SERVICE_CATALOG.find((d) => d.service === service) ?? null;
}

/** Where each service answers "whose token is this?", and how to read the name
 * out of the reply. Kept in one table so adding a fifth service is an entry
 * rather than another branch in the check function. */
const IDENTITY: Record<DeveloperService, {
  url: string;
  header: (token: string) => Record<string, string>;
  label: (body: any) => string | null;
}> = {
  github: {
    url: 'https://api.github.com/user',
    header: (t) => ({ authorization: `Bearer ${t}`, accept: 'application/vnd.github+json' }),
    label: (b) => (typeof b?.login === 'string' ? b.login : null),
  },
  netlify: {
    url: 'https://api.netlify.com/api/v1/user',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.email === 'string' ? b.email : typeof b?.slug === 'string' ? b.slug : null),
  },
  vercel: {
    url: 'https://api.vercel.com/v2/user',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.user?.username === 'string' ? b.user.username : null),
  },
  supabase: {
    url: 'https://api.supabase.com/v1/projects',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    // Supabase has no "me" endpoint; a successful project listing is the proof,
    // and the count is the only thing worth showing back.
    label: (b) => (Array.isArray(b) ? `${b.length} project${b.length === 1 ? '' : 's'}` : null),
  },
};

export type DeveloperCheckFailure = 'authentication' | 'authorization' | 'network' | 'unknown';

export interface DeveloperCheck {
  ok: boolean;
  accountLabel?: string | null;
  category?: DeveloperCheckFailure;
  detail: string;
}

export interface DeveloperCheckOptions {
  service: DeveloperService;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Ask the service whose token this is.
 *
 * A token that parses is not a token that works, and storing one without asking
 * would let a person leave this screen believing they had connected something.
 */
export async function checkDeveloperToken(
  opts: DeveloperCheckOptions,
): Promise<DeveloperCheck> {
  const spec = IDENTITY[opts.service];
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(spec.url, {
      method: 'GET',
      headers: { ...spec.header(opts.token), 'user-agent': 'josi-ce' },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return {
        ok: false,
        category: 'authentication',
        detail: 'That token was rejected. Check it was pasted whole and has not expired.',
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        category: 'authorization',
        detail: 'That token is valid but not permitted to read your account. Check its scopes.',
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, category: 'unknown', detail: `The service answered ${res.status}.` };
    }
    const body = await res.json().catch(() => null);
    return {
      ok: true,
      accountLabel: spec.label(body),
      detail: 'Connected.',
    };
  } catch {
    return {
      ok: false,
      category: 'network',
      detail: 'The service could not be reached from this server.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface EffectiveScope {
  mode: PermissionMode;
  /** Only meaningful for `specific_users`. */
  allowedUserIds: string[];
}

/** May this person connect this service?
 *
 * One function so the answer cannot differ between the screen that offers the
 * control and the route that accepts the token. The route is the one that
 * matters — a screen hiding a control is presentation, not authorization. */
export function mayConnect(scope: EffectiveScope, userId: string): boolean {
  if (scope.mode === 'everyone') return true;
  if (scope.mode === 'specific_users') return scope.allowedUserIds.includes(userId);
  return false;
}

/** The scope in a sentence, for the administrator who set it.
 *
 * "Allowed for specific users" tells them nothing about whether they finished
 * choosing; a count and the fact that an empty list permits nobody does. */
export function summarizeScope(scope: EffectiveScope, names: string[] = []): string {
  switch (scope.mode) {
    case 'everyone':
      return 'Anyone with an account here can connect their own.';
    case 'specific_users': {
      if (!scope.allowedUserIds.length) {
        return 'Nobody yet — "specific people" is selected but no one has been chosen.';
      }
      const shown = names.slice(0, 3).join(', ');
      const rest = scope.allowedUserIds.length - Math.min(3, names.length);
      return rest > 0
        ? `${shown} and ${rest} more can connect their own.`
        : `${shown} can connect their own.`;
    }
    default:
      return 'Nobody here can connect this service.';
  }
}
