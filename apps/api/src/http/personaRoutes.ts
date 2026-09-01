// Identity, memory and behaviour over HTTP.
//
// Two boundaries to check when reading this file.
//
// The first is ownership: every personal layer and every memory is read and
// written as `req.user!.id`, never as an id from the body, and a colleague's
// gets 404 rather than 403. That is the Phase 1 rule applied to the most
// personal data in the product — a person's description of themselves.
//
// The second is the one Phase 12 exists to hold: the installation policy layer
// is super-admin only, an import cannot touch it, and nothing any route accepts
// can widen a permission. The routes below move TEXT around. Whether the
// assistant may do something is decided elsewhere, by code that reads approval
// and ownership rows, and none of it consults a profile.
import { Router, type Request, type Response } from 'express';
import { type Db } from '@josi-ce/core';
import {
  CAUTION_ORDER, FIELDS, MemoryError, ProfileError, ProfileTooLarge,
  addMemory, assemblePrompt, confirmMemory, decideSuggestion, deleteMemory,
  exportProfiles, getProfile, importProfiles, listMemories, listVersions,
  loadAll, narrowPolicy, parseProfile, relevantMemories, resetProfile,
  saveProfile, updateMemory, type Layer,
} from '@josi-ce/persona';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

export interface PersonaRoutesCtx {
  db: Db;
  /** The compiled core. A constant in the build; there is no route that sets
   * it and no table that stores it. */
  core?: string;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const PERSONAL: Layer[] = ['soul', 'user', 'agents_user'];
const str = (v: unknown, max = 20000): string => (typeof v === 'string' ? v.slice(0, max) : '');

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) { res.status(err.status).json({ error: err.message }); return; }
      if (err instanceof ProfileTooLarge) { res.status(413).json({ error: err.message }); return; }
      if (err instanceof MemoryError || err instanceof ProfileError) {
        const notFound = /not found/i.test(err.message);
        res.status(notFound ? 404 : 409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
}

/** M-new: "a precise explanation of what each layer can and cannot change."
 *
 * Written per layer, in the second person, and returned with every read so the
 * UI cannot show a field without showing what it does. */
const EXPLANATIONS: Record<Layer, { can: string[]; cannot: string[] }> = {
  soul: {
    can: [
      'Change what you call your assistant and how it sounds',
      'Set how much it says, whether it jokes, and how formal it is',
      'Describe a personality in your own words',
      'List subjects or behaviours you do not want',
    ],
    cannot: [
      'Give the assistant a new ability it does not already have',
      'Skip an approval, or change what needs one',
      'Reach anything belonging to a colleague',
      'Change any security or privacy setting',
    ],
  },
  user: {
    can: [
      'Tell the assistant your name, pronouns, role, language and timezone',
      'Describe how you like to work',
      'List what you are interested in',
    ],
    cannot: [
      'Change what you are allowed to do — that is your account, not your profile',
      'Grant yourself or anyone else access to anything',
    ],
  },
  agents_user: {
    can: [
      'Choose how proactive the assistant is, within what your administrator allows',
      'Choose how answers are laid out',
      'Choose when it looks things up and what it does when a task is unclear',
      'Ask to be consulted MORE often than the installation requires',
    ],
    cannot: [
      'Ask to be consulted LESS often than your administrator has set',
      'Add a tool, or change which tools exist',
      'Alter approvals, ownership or any security policy',
    ],
  },
  agents_admin: {
    can: [
      'Set the working policy everyone starts from',
      'Require the assistant to be more cautious than a person might choose',
    ],
    cannot: [
      'Read anybody’s Soul, About me, or memories',
      'Grant a capability the core does not implement',
      'Weaken approvals, ownership or auditing',
    ],
  },
};

export function personaRoutes(ctx: PersonaRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** What the fields are, what the values may be, and what each layer cannot
   * do. Everything the settings screens need to render honestly. */
  r.get(
    '/schema',
    handle(async (_req, res) => res.json({
      layers: Object.fromEntries(
        (Object.keys(FIELDS) as Layer[]).map((layer) => [layer, {
          fields: FIELDS[layer],
          explanation: EXPLANATIONS[layer],
        }]),
      ),
      // Said once, plainly, at the top of the settings screen.
      boundary:
        'These settings change how Josi talks to you and what it knows about you. '
        + 'They cannot change what it is allowed to do. Permissions, approvals and '
        + 'access to your colleagues’ things are enforced separately and do not read '
        + 'these files.',
    })),
  );

  r.get(
    '/profiles',
    handle(async (req, res) => {
      const all = await loadAll(db, req.user!.id);
      const rows: Record<string, unknown> = {};
      for (const kind of PERSONAL) {
        const p = await getProfile(db, { kind, userId: req.user!.id });
        rows[kind] = {
          content: p?.content ?? '',
          parsed: all[kind],
          ignored: p?.ignored ?? [],
          version: p?.version ?? 0,
          explanation: EXPLANATIONS[kind],
        };
      }
      const admin = await getProfile(db, { kind: 'agents_admin', userId: null });
      // Readable by everyone, because it governs them; writable by nobody but
      // the administrator.
      rows.agents_admin = {
        parsed: all.agents_admin,
        readOnly: req.user!.role !== 'super_admin',
        version: admin?.version ?? 0,
        explanation: EXPLANATIONS.agents_admin,
      };

      const { effective, narrowed } = narrowPolicy(
        all.agents_admin, all.agents_user, CAUTION_ORDER,
      );
      return res.json({
        profiles: rows,
        effectivePolicy: effective,
        // M-new again: say which of their choices the policy overrode, rather
        // than showing a setting that is quietly not in force.
        narrowedByPolicy: narrowed,
      });
    }),
  );

  r.put(
    '/profiles/:kind',
    handle(async (req, res) => {
      const kind = param(req, 'kind') as Layer;
      if (!(kind in FIELDS)) throw new RouteError(404, 'no such profile');

      if (kind === 'agents_admin' && req.user!.role !== 'super_admin') {
        // Not 404: this layer's existence is not a secret, and pretending
        // otherwise would confuse somebody looking at a screen that shows it.
        throw new RouteError(403, 'only an administrator can change the installation policy');
      }

      const { profile, parsed } = await saveProfile(db, {
        kind,
        userId: kind === 'agents_admin' ? null : req.user!.id,
        // NOT truncated here. Silently keeping the first 20 KB of an oversized
        // file and reporting success is the "pretending it applied" the plan
        // forbids — the parser refuses it and the caller gets a 413.
        content: typeof req.body?.content === 'string' ? req.body.content : '',
        actorUserId: req.user!.id,
      });

      return res.json({
        version: profile.version,
        parsed: parsed.values,
        // The two lists that make this honest.
        ignored: parsed.ignored,
        authorityAttempts: parsed.authorityAttempts,
        notice: parsed.authorityAttempts.length
          ? 'Some lines read like instructions about what Josi is allowed to do. They were '
            + 'kept as part of your personality and changed no permissions — Josi\'s '
            + 'abilities are set by your administrator and your account, not by this file.'
          : undefined,
      });
    }),
  );

  r.get(
    '/profiles/:kind/versions',
    handle(async (req, res) => {
      const kind = param(req, 'kind') as Layer;
      if (!(kind in FIELDS)) throw new RouteError(404, 'no such profile');
      const versions = await listVersions(db, {
        kind, userId: kind === 'agents_admin' ? null : req.user!.id,
      });
      return res.json({ versions });
    }),
  );

  r.post(
    '/profiles/:kind/reset',
    handle(async (req, res) => {
      const kind = param(req, 'kind') as Layer;
      if (!(kind in FIELDS)) throw new RouteError(404, 'no such profile');
      if (kind === 'agents_admin' && req.user!.role !== 'super_admin') {
        throw new RouteError(403, 'only an administrator can change the installation policy');
      }
      const toVersion = Number.isInteger(req.body?.toVersion) ? req.body.toVersion : undefined;
      const profile = await resetProfile(db, {
        kind, userId: kind === 'agents_admin' ? null : req.user!.id,
        toVersion, actorUserId: req.user!.id,
      });
      return res.json({
        version: profile.version,
        notice: 'Your conversations and memories were not touched.',
      });
    }),
  );

  /** A live preview: what the assistant would be given, without calling a
   * model. Being able to SEE the assembled context is how a person checks that
   * their file did what they think. */
  r.post(
    '/preview',
    handle(async (req, res) => {
      const all = await loadAll(db, req.user!.id);
      const { effective } = narrowPolicy(all.agents_admin, all.agents_user, CAUTION_ORDER);
      const request = str(req.body?.request, 2000) || 'What should I do today?';
      const memories = await relevantMemories(db, { ownerUserId: req.user!.id, request });

      const prompt = assemblePrompt({
        core: ctx.core ?? '[the compiled Josi core]',
        adminPolicy: all.agents_admin,
        userPolicy: effective,
        soul: all.soul,
        user: all.user,
        memories: memories.map((m) => ({ content: m.content, provenance: m.provenance })),
        request,
      });
      return res.json({ sections: prompt.sections, text: prompt.text });
    }),
  );

  // -------------------------------------------------------------------------
  // Import and export
  // -------------------------------------------------------------------------
  r.get(
    '/export',
    handle(async (req, res) => res.json(
      await exportProfiles(db, { userId: req.user!.id, now: new Date().toISOString() }),
    )),
  );

  r.post(
    '/import',
    handle(async (req, res) => {
      const results = await importProfiles(db, {
        userId: req.user!.id, bundle: req.body, actorUserId: req.user!.id,
      });
      const ignored = Object.entries(results).flatMap(([layer, parsed]) =>
        parsed.ignored.map((i) => ({ layer, ...i })));
      return res.json({
        imported: Object.keys(results),
        ignored,
        // Said explicitly, because an import is a file somebody was sent.
        notice: 'Installation policy is never imported from a personal profile.',
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------
  r.get(
    '/memories',
    handle(async (req, res) => res.json({ memories: await listMemories(db, req.user!.id) })),
  );

  r.post(
    '/memories',
    handle(async (req, res) => {
      const memory = await addMemory(db, {
        ownerUserId: req.user!.id,
        content: str(req.body?.content, 2000),
      });
      return res.status(201).json({ memory });
    }),
  );

  r.put(
    '/memories/:id',
    handle(async (req, res) => {
      const memory = await updateMemory(db, {
        id: param(req, 'id'),
        ownerUserId: req.user!.id,
        content: typeof req.body?.content === 'string' ? str(req.body.content, 2000) : undefined,
        pinned: typeof req.body?.pinned === 'boolean' ? req.body.pinned : undefined,
      });
      return res.json({ memory });
    }),
  );

  r.post(
    '/memories/:id/confirm',
    handle(async (req, res) => res.json({
      memory: await confirmMemory(db, { id: param(req, 'id'), ownerUserId: req.user!.id }),
    })),
  );

  r.delete(
    '/memories/:id',
    handle(async (req, res) => {
      await deleteMemory(db, { id: param(req, 'id'), ownerUserId: req.user!.id });
      return res.json({
        deleted: true,
        // Worth saying, because most products do not mean it.
        notice: 'That memory is gone. It was deleted, not hidden.',
      });
    }),
  );

  r.get(
    '/suggestions',
    handle(async (req, res) => res.json({
      suggestions: await db.query(
        `select id, content, source_kind, confidence, created_at
         from memory_suggestions where owner_user_id = $1 and state = 'pending'
         order by created_at desc limit 100`,
        [req.user!.id],
      ),
    })),
  );

  r.post(
    '/suggestions/:id/decide',
    handle(async (req, res) => res.json(
      await decideSuggestion(db, {
        id: param(req, 'id'),
        ownerUserId: req.user!.id,
        accept: req.body?.accept === true,
      }),
    )),
  );

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  r.get(
    '/settings',
    handle(async (req, res) => {
      const [row] = await db.query(
        `select memory_mode, onboarding_skipped, onboarding_completed_at
         from persona_settings where user_id = $1`,
        [req.user!.id],
      );
      return res.json({
        settings: row ?? { memory_mode: 'manual', onboarding_skipped: false },
        modes: {
          manual: 'Josi suggests things to remember and you decide. This is the default.',
          automatic: 'Josi remembers things from conversations without asking. You can still '
            + 'read, edit and delete anything it kept.',
          off: 'Josi remembers nothing new. Existing memories stay until you delete them.',
        },
      });
    }),
  );

  r.put(
    '/settings',
    handle(async (req, res) => {
      const mode = ['manual', 'automatic', 'off'].includes(req.body?.memoryMode)
        ? req.body.memoryMode : null;
      if (!mode && req.body?.memoryMode !== undefined) {
        throw new RouteError(400, 'choose manual, automatic or off');
      }
      const [row] = await db.query(
        `insert into persona_settings (user_id, memory_mode, onboarding_skipped)
         values ($1, coalesce($2, 'manual'), coalesce($3, false))
         on conflict (user_id) do update set
           memory_mode = coalesce($2, persona_settings.memory_mode),
           onboarding_skipped = coalesce($3, persona_settings.onboarding_skipped)
         returning memory_mode, onboarding_skipped`,
        [req.user!.id, mode, typeof req.body?.skipOnboarding === 'boolean' ? req.body.skipOnboarding : null],
      );
      return res.json({ settings: row });
    }),
  );

  return r;
}

export { requireSuperAdmin, parseProfile };
