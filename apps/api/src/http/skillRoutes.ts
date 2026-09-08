// The Skills library over HTTP.
//
// The whole surface, and who may reach it:
//
//   EVERY MEMBER — reads the library. Nothing here changes anything.
//     GET    /skills                        installed skills, in full, resolved
//                                           against MY OWN connections
//
//   ADMINISTRATOR — runs the library.
//     GET    /admin/skills                  sources, installed, quarantine
//     GET    /admin/skills/:id/history      one skill's update history
//     POST   /admin/skills/sources          add a registry or a repository
//     POST   /admin/skills/sources/:id/enable | /disable
//     DELETE /admin/skills/sources/:id
//     GET    /admin/skills/sources/:id/catalogue   what it offers right now
//     POST   /admin/skills/install          { sourceId, skillKey }
//     POST   /admin/skills/:id/activate     { digest } — having read it
//     POST   /admin/skills/:id/enable | /disable
//     POST   /admin/skills/:id/update       re-fetch, then back to review
//     DELETE /admin/skills/:id
//     DELETE /admin/skills/quarantine/:id
//
// Six claims, each with a test attacking it:
//
//   * NOTHING IS PRESET. A fresh installation has an empty library. The
//     built-in catalogue is four documents in the source tree, and installing
//     one is two deliberate presses.
//   * THERE IS NO ROUTE THAT TAKES A PACKAGE. Not a body, not a URL, not an
//     upload. `POST /install` names a SOURCE ROW and a KEY inside that source's
//     index; every byte of the request that follows is built from the row.
//   * INSTALLING IS NOT ACTIVATING, AND ACTIVATION IS PINNED. A skill arrives
//     inert. Activating it carries the digest the page displayed, so a package
//     that changed between the reading and the pressing is refused.
//   * AN UPDATE GOES BACK THROUGH REVIEW, EVEN IF IT WAS SWITCHED ON. New
//     instructions from outside this installation are not covered by somebody
//     having read the old ones.
//   * A SKILL IS NOT AN AUTHORITY. Nothing in this file opens a credential,
//     writes a capability, or touches a pending approval — and the member view
//     resolves what a skill wants against THAT MEMBER'S own connections, so two
//     people see two honest, different answers.
//   * WHAT FAILED A CHECK IS QUARANTINED, NOT INSTALLED. It is recorded with a
//     reason and without its prose, and there is no route that promotes a
//     quarantined package into the library.
import { Router, type Request, type Response } from 'express';
import { appendEvent, type Db } from '@josi-ce/core';
import {
  ConnectorError,
  MAX_SKILLS, MAX_SKILL_SOURCES, SKILL_CAPABILITIES, SkillError, SkillFetchError, SkillInputError,
  activateSkill, assessSkillPackage, builtinSkillSource, clearSkillQuarantine, createSkillSource,
  deleteSkillSource, fetchSkillPackage, installSkill, listSkillQuarantine, listSkillSources,
  listSkills, missingSkillDependencies, quarantineSkill, recordSkillUpdateCheck, removeSkill,
  setSkillEnabled, setSkillSourceEnabled, skillById, skillCatalogue, skillHistory,
  skillInstallConflict, skillSourceById, skillUpdateConflict, updateSkill,
  validateSkillIndexUrl, validateSkillPublicKey, validateSkillSourceKind, validateSkillSourceName,
  type SkillCatalogueEntry, type SkillRow, type SkillSourceRow,
} from '@josi-ce/connectors';
import { skillGuidanceFor } from '@josi-ce/agent';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

export interface SkillRoutesCtx {
  db: Db;
  /** Injected by the tests. No suite contacts a real registry. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof SkillInputError) return res.status(400).json({ error: err.message });
      if (err instanceof SkillError) return res.status(err.status).json({ error: err.message });
      // A registry's refusal is a 502 with a category: the request was fine,
      // the answer was not. The message is one CE wrote — never the registry's.
      if (err instanceof SkillFetchError) {
        return res.status(502).json({ error: err.message, category: err.category });
      }
      if (err instanceof ConnectorError) {
        return res.status(502).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  });

// -------------------------------------------------------------------- views

/**
 * What a MEMBER sees about an installed skill.
 *
 * The full instructions, deliberately. A skill shapes how the assistant answers
 * this person, so "what is it actually told about me and my work?" is a
 * question they are entitled to see the answer to without asking an
 * administrator — and a library that showed a title and a summary would be
 * asking people to trust a review they cannot check.
 *
 * `capabilities` is resolved for THE PERSON ASKING, not for the installation.
 * Two members with different connections get two different, honest lists.
 */
function memberSkillView(
  row: SkillRow,
  resolved: Array<{ key: string; label: string; available: boolean; hint?: string }>,
  missingDependencies: string[],
) {
  return {
    key: row.skill_key,
    name: row.name,
    version: row.version,
    publisher: row.publisher,
    summary: row.summary,
    license: row.license,
    homepage: row.homepage,
    instructions: row.instructions,
    capabilities: resolved,
    dependencies: row.dependencies ?? [],
    missingDependencies,
    provenance: {
      originKind: row.origin_kind,
      originName: row.origin_name,
      signatureState: row.signature_state,
      signatureKeyId: row.signature_key_id,
      digest: row.package_digest,
    },
    skillState: row.state,
    installedAt: row.installed_at,
    activatedAt: row.activated_at,
  };
}

/** What an ADMINISTRATOR sees, which is the member view plus the levers and the
 * provenance detail the levers need. */
function adminSkillView(row: SkillRow, missingDependencies: string[], history: unknown[]) {
  return {
    id: row.id,
    key: row.skill_key,
    name: row.name,
    version: row.version,
    publisher: row.publisher,
    summary: row.summary,
    license: row.license,
    homepage: row.homepage,
    // The whole text. Reviewing a skill IS reading this, so a page that
    // truncated it would be a page that made review impossible.
    instructions: row.instructions,
    // What it says it wants. Named as a request rather than a grant, here and
    // on the screen.
    capabilitiesRequested: (row.capabilities ?? []).map((key) => ({
      key,
      label: SKILL_CAPABILITIES.find((spec) => spec.key === key)?.label ?? key,
    })),
    dependencies: row.dependencies ?? [],
    missingDependencies,
    provenance: {
      sourceId: row.source_id,
      originKind: row.origin_kind,
      originName: row.origin_name,
      originUrl: row.origin_url,
    },
    digest: row.package_digest,
    // Travels to the browser and back with an activation, so the decision lands
    // on the exact text that was on the screen.
    reviewedDigest: row.reviewed_digest,
    reviewed: row.reviewed_digest === row.package_digest,
    signatureState: row.signature_state,
    signatureKeyId: row.signature_key_id,
    skillState: row.state,
    installedAt: row.installed_at,
    activatedAt: row.activated_at,
    lastUpdateCheckAt: row.last_update_check_at,
    history,
  };
}

function sourceView(row: SkillSourceRow) {
  return {
    id: row.id,
    sourceKind: row.kind,
    name: row.name,
    indexUrl: row.index_url,
    host: row.host,
    // WHETHER a key is registered, and the key itself — a public key is not a
    // secret, and an administrator who cannot see which key a source publishes
    // cannot tell whether it is the one they were given.
    publicKey: row.public_key,
    signed: !!row.public_key,
    enabled: row.enabled,
    lastIndexAt: row.last_index_at,
    lastIndexOk: row.last_index_ok,
    lastErrorCategory: row.last_error_category,
    removable: row.kind !== 'builtin',
  };
}

// ------------------------------------------------------------------ member

export function skillRoutes(ctx: SkillRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /**
   * The library, as it applies to me.
   *
   * `skillGuidanceFor` is the SAME function the agent calls to build a turn, so
   * this page cannot drift from what the assistant is actually told: if it says
   * a skill's calendar access is unavailable to you, that is because the turn
   * would say so too. Skills still in review are listed separately and plainly
   * — installed, read by nobody, doing nothing.
   */
  r.get(
    '/',
    handle(async (req, res) => {
      const rows = await listSkills(db);
      const guidance = await skillGuidanceFor(db, req.user!.id);
      const byKey = new Map(guidance.skills.map((s) => [s.key, s] as const));

      const skills = [];
      for (const row of rows) {
        const active = byKey.get(row.skill_key);
        skills.push(memberSkillView(
          row,
          active
            ? active.capabilities
            // Not enabled, so nothing was resolved for this turn. The list is
            // still shown, as a request rather than a verdict.
            : (row.capabilities ?? []).map((key) => ({
              key,
              label: SKILL_CAPABILITIES.find((spec) => spec.key === key)?.label ?? key,
              available: false,
              hint: 'This skill is not switched on, so nothing was checked.',
            })),
          active ? active.missingDependencies : await missingSkillDependencies(db, row),
        ));
      }

      return res.json({
        skills,
        note: 'A skill is a set of instructions an administrator installed and read. It cannot give '
          + 'Josi anything it did not already have: what it says it uses is checked against your own '
          + 'connections every time, and anything you have not switched on stays off.',
      });
    }),
  );

  return r;
}

// ------------------------------------------------------------------- admin

export function adminSkillRoutes(ctx: SkillRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  const fetchOpts = { fetchImpl: ctx.fetchImpl, resolve: ctx.resolve };

  async function sourceOr404(id: string): Promise<SkillSourceRow> {
    const row = await skillSourceById(db, id);
    if (!row) throw new RouteError(404, 'not found');
    return row;
  }

  async function skillOr404(id: string): Promise<SkillRow> {
    const row = await skillById(db, id);
    if (!row) throw new RouteError(404, 'not found');
    return row;
  }

  /** One entry out of a source's catalogue, by key.
   *
   * The ONLY way a package address is ever produced. A caller names a source
   * and a key; the address comes from that source's own index. There is no
   * parameter here that a URL could be passed in. */
  async function entryOr404(source: SkillSourceRow, skillKey: string): Promise<SkillCatalogueEntry> {
    const catalogue = await skillCatalogue(db, source, fetchOpts);
    const entry = catalogue.find((item) => item.key === skillKey);
    if (!entry) {
      throw new RouteError(404, `${source.name} is not offering a skill called "${skillKey.slice(0, 60)}"`);
    }
    return entry;
  }

  /** The library, whole. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const sources = await listSkillSources(db);
      const rows = await listSkills(db);
      const skills = [];
      for (const row of rows) {
        skills.push(adminSkillView(
          row,
          await missingSkillDependencies(db, row),
          await skillHistory(db, row.id),
        ));
      }
      return res.json({
        sources: sources.map(sourceView),
        skills,
        limit: MAX_SKILLS,
        sourceLimit: MAX_SKILL_SOURCES,
        quarantine: (await listSkillQuarantine(db)).map((row) => ({
          id: row.id,
          key: row.skill_key,
          name: row.name,
          version: row.version,
          originName: row.origin_name,
          reason: row.reason,
          // CE's own words about which check failed. The package's own text is
          // not stored and is not here.
          detail: row.detail,
          digest: row.package_digest,
          at: row.created_at,
        })),
      });
    }),
  );

  r.get(
    '/:id/history',
    handle(async (req, res) => {
      const skill = await skillOr404(param(req, 'id'));
      return res.json({
        history: (await skillHistory(db, skill.id)).map((row) => ({
          action: row.action,
          version: row.version,
          digest: row.package_digest,
          signatureState: row.signature_state,
          originName: row.origin_name,
          at: row.created_at,
        })),
      });
    }),
  );

  // ------------------------------------------------------------- sources

  r.post(
    '/sources',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = validateSkillSourceKind(body.sourceKind);
      const name = validateSkillSourceName(body.name);
      const { indexUrl, host } = validateSkillIndexUrl(body.indexUrl);
      const publicKey = validateSkillPublicKey(body.publicKey);

      const existing = await listSkillSources(db);
      if (existing.length >= MAX_SKILL_SOURCES) {
        throw new RouteError(
          409,
          `you can add up to ${MAX_SKILL_SOURCES} sources. Remove one you no longer use first.`,
        );
      }
      if (existing.some((source) => source.name === name)) {
        throw new RouteError(409, `there is already a source called "${name}"`);
      }
      if (existing.some((source) => source.index_url === indexUrl)) {
        throw new RouteError(409, 'that address is already on the list');
      }

      const row = await createSkillSource(db, {
        actorUserId: req.user!.id, kind, name, indexUrl, host, publicKey,
      });
      return res.status(201).json({
        source: sourceView(row),
        note: publicKey
          ? 'Added. Every package from here must be signed by that key or it goes to quarantine.'
          : 'Added. This source publishes no signing key, so Josi can check that a package matches '
            + 'the digest its catalogue pinned but cannot check who wrote it. Every skill from here '
            + 'will say so.',
      });
    }),
  );

  for (const [suffix, enabled] of [['enable', true], ['disable', false]] as const) {
    r.post(
      `/sources/:id/${suffix}`,
      handle(async (req, res) => {
        const source = await sourceOr404(param(req, 'id'));
        const row = await setSkillSourceEnabled(db, {
          actorUserId: req.user!.id, source, enabled,
        });
        return res.json({
          source: sourceView(row),
          // Said outright, because the alternative reading is the frightening
          // one and somebody will assume it.
          note: enabled
            ? undefined
            : 'Nothing new can be installed or updated from this source. Skills already installed '
              + 'from it are untouched — each was reviewed on its own merits.',
        });
      }),
    );
  }

  r.delete(
    '/sources/:id',
    handle(async (req, res) => {
      const source = await sourceOr404(param(req, 'id'));
      if (source.kind === 'builtin') {
        throw new RouteError(
          409,
          'the starter catalogue ships with Josi and cannot be removed. Switch it off instead if you '
          + 'do not want anything installed from it.',
        );
      }
      const installed = (await listSkills(db)).filter((skill) => skill.source_id === source.id);
      if (installed.length) {
        throw new RouteError(
          409,
          `${installed.length} installed skill(s) came from this source: `
          + `${installed.map((s) => s.name).join(', ')}. Remove them first — a skill with no `
          + 'provenance is worse than one from a source you no longer use.',
        );
      }
      await deleteSkillSource(db, { actorUserId: req.user!.id, source });
      return res.json({ ok: true });
    }),
  );

  /** What a source is offering right now, with what is already installed marked.
   *
   * A catalogue entry carries no instructions — browsing never puts a
   * stranger's prose in front of anybody. Reading one is what installing does,
   * and reviewing it is a separate press after that. */
  r.get(
    '/sources/:id/catalogue',
    handle(async (req, res) => {
      const source = await sourceOr404(param(req, 'id'));
      const catalogue = await skillCatalogue(db, source, fetchOpts);
      const installed = new Map((await listSkills(db)).map((skill) => [skill.skill_key, skill] as const));
      return res.json({
        source: sourceView((await skillSourceById(db, source.id))!),
        available: catalogue.map((entry) => {
          const already = installed.get(entry.key);
          return {
            key: entry.key,
            name: entry.name,
            version: entry.version,
            publisher: entry.publisher,
            summary: entry.summary,
            capabilities: entry.capabilities.map((key) => ({
              key,
              label: SKILL_CAPABILITIES.find((spec) => spec.key === key)?.label ?? key,
            })),
            digest: entry.digest,
            installed: !!already,
            installedVersion: already?.version ?? null,
            // Set when this source is offering something the installed row does
            // not have. `installed` alone would leave "there is a new version"
            // as something to work out by comparing two strings on screen.
            updateAvailable: !!already && already.source_id === source.id
              && already.version !== entry.version,
          };
        }),
      });
    }),
  );

  // ------------------------------------------------------------ installing

  /**
   * Install one skill, named by source and key.
   *
   * NO PACKAGE CROSSES THIS BOUNDARY. The body carries two identifiers; the
   * document is fetched from the address the source's own index gives, checked
   * against the digest that index pinned, and either stored inert or
   * quarantined. There is no branch that stores something that failed a check.
   */
  r.post(
    '/install',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
      const skillKey = (typeof body.skillKey === 'string' ? body.skillKey : '').trim().toLowerCase();
      const source = await sourceOr404(sourceId);
      if (!source.enabled) {
        throw new RouteError(403, `${source.name} is switched off, so nothing can be installed from it.`);
      }
      if ((await listSkills(db)).length >= MAX_SKILLS) {
        throw new RouteError(
          409,
          `this installation already has ${MAX_SKILLS} skills. Remove one you no longer use first.`,
        );
      }

      const entry = await entryOr404(source, skillKey);
      const conflict = await skillInstallConflict(db, { source, entry });
      if (conflict) throw new RouteError(409, conflict);

      const document = await fetchSkillPackage(source, entry, fetchOpts);
      const assessment = assessSkillPackage({ source, entry, document });

      if (!assessment.ok) {
        if (!assessment.identity) {
          // Nothing to file it under. Refused, audited, and not written
          // anywhere: a quarantine row that cannot name what it quarantined is
          // a row nobody can act on.
          await appendEvent(db, {
            actorUserId: req.user!.id,
            actor: 'super_admin',
            kind: 'skill.install_refused',
            subjectType: 'skill_source',
            subjectId: source.id,
            payload: { skillKey, originName: source.name, reason: assessment.reason },
          });
          throw new RouteError(
            422,
            `${source.name} served something that is not a skill package (${assessment.detail}). `
            + 'Nothing was installed.',
          );
        }
        const quarantined = await quarantineSkill(db, {
          actorUserId: req.user!.id,
          source,
          identity: assessment.identity,
          reason: assessment.reason,
          detail: assessment.detail,
        });
        return res.status(422).json({
          error: `That package did not pass its checks, so Josi quarantined it and installed `
            + `nothing: ${assessment.detail}.`,
          quarantineId: quarantined.id,
          reason: assessment.reason,
        });
      }

      const skill = await installSkill(db, {
        actorUserId: req.user!.id, source, entry, accepted: assessment.accepted,
      });
      return res.status(201).json({
        skill: adminSkillView(skill, await missingSkillDependencies(db, skill), await skillHistory(db, skill.id)),
        note: 'Installed and doing nothing. Read what it tells Josi to do, then switch it on — Josi '
          + 'will not put instructions nobody here has read in front of the assistant.',
      });
    }),
  );

  /**
   * Activate, having read it.
   *
   * `digest` is what the page had on screen, and it travels with the decision
   * so the activation lands on the exact text somebody read. A skill updated
   * between the page rendering and the button being pressed is refused rather
   * than switched on.
   */
  r.post(
    '/:id/activate',
    handle(async (req, res) => {
      const skill = await skillOr404(param(req, 'id'));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const digest = typeof body.digest === 'string' ? body.digest : '';
      if (!digest) {
        throw new RouteError(
          400,
          'the review has to name the version it read. Reload the page and try again.',
        );
      }
      const row = await activateSkill(db, { actorUserId: req.user!.id, skill, seenDigest: digest });
      return res.json({
        skill: adminSkillView(row, await missingSkillDependencies(db, row), await skillHistory(db, row.id)),
      });
    }),
  );

  for (const [suffix, enabled] of [['enable', true], ['disable', false]] as const) {
    r.post(
      `/:id/${suffix}`,
      handle(async (req, res) => {
        const skill = await skillOr404(param(req, 'id'));
        const row = await setSkillEnabled(db, { actorUserId: req.user!.id, skill, enabled });
        return res.json({
          skill: adminSkillView(row, await missingSkillDependencies(db, row), await skillHistory(db, row.id)),
        });
      }),
    );
  }

  /**
   * Check the source for a newer version, and take it — back to review.
   *
   * From ITS OWN source, always. There is no parameter naming where to update
   * from: a skill that could be updated out of a different registry is a skill
   * whose name can be taken over by whoever an administrator adds next.
   */
  r.post(
    '/:id/update',
    handle(async (req, res) => {
      const skill = await skillOr404(param(req, 'id'));
      const source = await sourceOr404(skill.source_id);
      if (!source.enabled) {
        throw new RouteError(403, `${source.name} is switched off, so Josi did not contact it.`);
      }

      const entry = await entryOr404(source, skill.skill_key);
      if (entry.version === skill.version && entry.digest === skill.package_digest) {
        await recordSkillUpdateCheck(db, skill.id);
        return res.json({
          skill: adminSkillView(skill, await missingSkillDependencies(db, skill), await skillHistory(db, skill.id)),
          note: `${source.name} is offering the same version you already have (${skill.version}).`,
        });
      }

      const document = await fetchSkillPackage(source, entry, fetchOpts);
      const assessment = assessSkillPackage({ source, entry, document });
      if (!assessment.ok) {
        if (assessment.identity) {
          const quarantined = await quarantineSkill(db, {
            actorUserId: req.user!.id,
            source,
            identity: assessment.identity,
            reason: assessment.reason,
            detail: assessment.detail,
          });
          return res.status(422).json({
            // The half people assume wrongly, said first: a failed update leaves
            // the working version exactly as it was.
            error: `That update did not pass its checks, so Josi quarantined it and changed nothing. `
              + `The version you have is still installed and untouched: ${assessment.detail}.`,
            quarantineId: quarantined.id,
            reason: assessment.reason,
          });
        }
        throw new RouteError(
          422,
          `${source.name} served something that is not a skill package (${assessment.detail}). `
          + 'The version you have is still installed and untouched.',
        );
      }

      const refusal = skillUpdateConflict(skill, entry, assessment.accepted.pkg);
      if (refusal) {
        await recordSkillUpdateCheck(db, skill.id);
        throw new RouteError(409, refusal);
      }

      const row = await updateSkill(db, {
        actorUserId: req.user!.id, skill, source, entry, accepted: assessment.accepted,
      });
      return res.json({
        skill: adminSkillView(row, await missingSkillDependencies(db, row), await skillHistory(db, row.id)),
        note: skill.state === 'enabled'
          ? `Updated to ${row.version} and SWITCHED OFF until it is read again. The old version was `
            + 'the one somebody reviewed; these are new instructions from outside this installation.'
          : `Updated to ${row.version}. Read it and switch it on when you are ready.`,
      });
    }),
  );

  r.delete(
    '/:id',
    handle(async (req, res) => {
      const skill = await skillOr404(param(req, 'id'));
      await removeSkill(db, { actorUserId: req.user!.id, skill });
      return res.json({
        ok: true,
        note: 'Removed. Josi stops using it on the next message — there is nothing else to undo, '
          + 'because a skill never had anything of its own.',
      });
    }),
  );

  /** Clearing a quarantine record deletes the RECORD. There is deliberately no
   * route that promotes one into the library: a package that failed a check is
   * installed by fixing what failed and installing it again, not by overruling
   * the check from a screen. */
  r.delete(
    '/quarantine/:id',
    handle(async (req, res) => {
      await clearSkillQuarantine(db, { actorUserId: req.user!.id, id: param(req, 'id') });
      return res.json({ ok: true });
    }),
  );

  return r;
}

/** Exported for the readiness of the starter catalogue: the built-in source is
 * seeded by migration 0037, and a route that could not find it would leave the
 * page with nothing to offer and no explanation. */
export async function starterCatalogueAvailable(db: Db): Promise<boolean> {
  return !!(await builtinSkillSource(db));
}
