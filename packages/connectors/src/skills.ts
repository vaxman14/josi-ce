// The installed library: the rows, the lifecycle, and the two rules that make
// a skill safe to have.
//
//   1. INSTALLING IS NOT ACTIVATING. Everything arrives at `state = 'review'`,
//      which is stored, readable and INERT — no turn reads it, and there is no
//      argument to any function here that installs something switched on.
//   2. ACTIVATION IS PINNED TO WHAT WAS READ. `reviewed_digest` is the digest
//      the administrator had on screen, it travels with the decision, and
//      migration 0037 refuses the `enabled` state unless it equals the
//      package's own digest. An UPDATE therefore cannot inherit an activation:
//      new instructions mean a new digest, which means the row goes back to
//      review by arithmetic rather than by a code path remembering to send it
//      there.
//
// WHAT THIS FILE DELIBERATELY CANNOT DO, because a skills feature is judged by
// what its installer is unable to reach:
//
//   * It never opens a credential. There is no `MasterKey` parameter anywhere
//     in this file, no `openSealed`, and nothing here that could be handed one.
//   * It never writes a capability. `connection_capabilities`,
//     `admin_capability_policy` and every other permission table are read by
//     other code and written by their owners; installing a skill changes none
//     of them, whatever the skill's `capabilities` list says it wants.
//   * It never decides a pending write. `custom_api_pending_calls` and
//     `mcp_pending_calls` are approved by a signed-in person on one route each,
//     and no skill, enabled or otherwise, is on that route.
//
// Those three are asserted by a test that reads this source rather than only by
// this comment, because a comment does not fail when somebody adds an import.
import { appendEvent, json, type Db } from '@josi-ce/core';
import {
  compareSkillVersions, readSkillPackage, verifySkillSignature,
  type SkillIdentity, type SkillPackage, type SkillQuarantineReason,
} from './skillPackage.js';
import type { SkillCatalogueEntry, SkillSourceRow } from './skillRegistry.js';

// ------------------------------------------------------------------- shapes

/**   review    installed, inert, waiting for somebody to read it.
 *    enabled   read, activated, and part of every turn.
 *    disabled  was activated, switched off. Still reviewed. */
export type SkillState = 'review' | 'enabled' | 'disabled';

/**   builtin     shipped inside this release; its integrity is the release's.
 *    verified    signed, and checked against the source's registered key.
 *    unverified  signed, but this source registered no key, so nothing could be
 *                checked. Said plainly rather than shown as a tick.
 *    unsigned    no signature at all. */
export type SkillSignatureState = 'builtin' | 'verified' | 'unverified' | 'unsigned';

export interface SkillRow {
  id: string;
  source_id: string;
  origin_kind: 'builtin' | 'registry' | 'repository';
  origin_name: string;
  origin_url: string | null;
  skill_key: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  license: string | null;
  homepage: string | null;
  instructions: string;
  capabilities: string[];
  dependencies: Array<{ key: string; minVersion: string | null }>;
  package_digest: string;
  signature_state: SkillSignatureState;
  signature_key_id: string | null;
  state: SkillState;
  reviewed_digest: string | null;
  installed_at: string;
  activated_at: string | null;
  last_update_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillHistoryRow {
  id: string;
  /** Monotonic. What actually orders the list — see migration 0037. */
  seq: string;
  skill_id: string;
  action: 'installed' | 'updated' | 'reviewed' | 'enabled' | 'disabled' | 'update_checked';
  version: string;
  package_digest: string;
  signature_state: SkillSignatureState;
  origin_name: string;
  actor_user_id: string | null;
  created_at: string;
}

export interface SkillQuarantineRow {
  id: string;
  source_id: string | null;
  origin_name: string;
  skill_key: string;
  name: string;
  version: string;
  package_digest: string | null;
  reason: SkillQuarantineReason;
  detail: string | null;
  created_at: string;
}

export class SkillError extends Error {
  constructor(message: string, readonly status: number = 409) {
    super(message);
  }
}

/** How many skills one installation may install.
 *
 * A ceiling rather than a setting, and a real one rather than a formality:
 * every enabled skill's prose is read into EVERY member's turn, so an unbounded
 * library is an unbounded per-message cost that nobody chose. The prompt budget
 * in the agent is the second half of the same argument. */
export const MAX_SKILLS = 50;

const UUID = /^[0-9a-fA-F-]{36}$/;

// ------------------------------------------------------------------ reading

/** Every row, whatever its state. Rendered by the library page, which is the
 * one surface that should show something in review as clearly as something on. */
export async function listSkills(db: Db): Promise<SkillRow[]> {
  return db.query<SkillRow>(`select * from skills order by name`);
}

export async function skillById(db: Db, id: string): Promise<SkillRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<SkillRow>(`select * from skills where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function skillByKey(db: Db, key: string): Promise<SkillRow | null> {
  const rows = await db.query<SkillRow>(`select * from skills where skill_key = $1`, [key]);
  return rows[0] ?? null;
}

/**
 * What a turn may actually be told about.
 *
 * `state = 'enabled'` and nothing else. Not "not disabled", not "reviewed" —
 * the one state that means somebody read this and switched it on. Written as
 * its own function so that the question "what does the assistant see?" has
 * exactly one query behind it, and a page that wants to show more calls
 * `listSkills` instead.
 */
export async function enabledSkills(db: Db): Promise<SkillRow[]> {
  return db.query<SkillRow>(`select * from skills where state = 'enabled' order by name`);
}

export async function skillHistory(db: Db, skillId: string): Promise<SkillHistoryRow[]> {
  if (!UUID.test(skillId)) return [];
  return db.query<SkillHistoryRow>(
    `select * from skill_history where skill_id = $1 order by seq desc limit 50`,
    [skillId],
  );
}

export async function listSkillQuarantine(db: Db): Promise<SkillQuarantineRow[]> {
  return db.query<SkillQuarantineRow>(
    `select * from skill_quarantine order by created_at desc limit 100`,
  );
}

/**
 * Which of a skill's dependencies are not satisfied, in the words the library
 * page shows.
 *
 * REPORTED, NEVER RESOLVED. An installer that pulls in packages nobody chose is
 * how a reviewed library becomes an unreviewed one: the dependency is named by
 * a publisher, and installing it on their say-so would let one reviewed package
 * bring in an arbitrary number of unreviewed ones. So a missing dependency is a
 * sentence on the screen and, for the model, a skill that says what it needs.
 */
export async function missingSkillDependencies(db: Db, skill: SkillRow): Promise<string[]> {
  const missing: string[] = [];
  for (const dependency of skill.dependencies ?? []) {
    const other = await skillByKey(db, dependency.key);
    if (!other) {
      missing.push(`${dependency.key} is not installed`);
      continue;
    }
    if (dependency.minVersion && compareSkillVersions(other.version, dependency.minVersion) < 0) {
      missing.push(`${dependency.key} is ${other.version}; this expects ${dependency.minVersion} or newer`);
      continue;
    }
    if (other.state !== 'enabled') {
      missing.push(`${dependency.key} is installed but not switched on`);
    }
  }
  return missing;
}

// -------------------------------------------------------------- the verdict

export interface AcceptedSkillPackage {
  pkg: SkillPackage;
  digest: string;
  signatureState: SkillSignatureState;
  signatureKeyId: string | null;
}

export type SkillPackageAssessment =
  | { ok: true; accepted: AcceptedSkillPackage }
  | {
    ok: false;
    reason: SkillQuarantineReason;
    detail: string;
    identity: SkillIdentity | null;
  };

/**
 * Everything between "some JSON arrived" and "this may be stored".
 *
 * Four checks in this order, and the order is the argument:
 *
 *   1. IS IT A PACKAGE. `readSkillPackage` — shape, caps, closed capability
 *      vocabulary, and the screening that catches prose written to the model
 *      rather than to the reader.
 *   2. IS IT THE ONE THE INDEX PINNED. The canonical digest must equal the
 *      digest the catalogue entry carried. Without this, "install skill X from
 *      registry Y" means "install whatever that address serves at the moment
 *      you press the button".
 *   3. IS IT SIGNED BY WHO IT CLAIMS. A source that publishes a key means every
 *      package from it must be signed AND verify; a source without one means
 *      nothing can be checked and the row says so rather than showing a tick.
 *   4. NOTHING. There is no fourth check, and that is worth saying: there is no
 *      allowance, no override, and no "trusted publisher" flag that skips any
 *      of the three above. The built-in catalogue takes this same path.
 */
export function assessSkillPackage(args: {
  source: SkillSourceRow;
  entry: SkillCatalogueEntry;
  document: unknown;
}): SkillPackageAssessment {
  const verdict = readSkillPackage(args.document);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason, detail: verdict.detail, identity: verdict.identity };
  }
  const { pkg, digest } = verdict;

  // The catalogue said one thing and the document is another. That is either a
  // stale index or somebody serving a different package to the fetch than to
  // the listing, and CE cannot tell which — so it is treated as the worse one.
  if (digest !== args.entry.digest) {
    return {
      ok: false,
      reason: 'digest_mismatch',
      detail: 'the package does not match the digest its catalogue pinned',
      identity: { key: pkg.key, name: pkg.name, version: pkg.version },
    };
  }
  // A catalogue that lists one key and serves a package claiming another is
  // pointing somewhere nobody chose, whatever the digest says.
  if (pkg.key !== args.entry.key) {
    return {
      ok: false,
      reason: 'schema_invalid',
      detail: `the catalogue listed "${args.entry.key}" and the package calls itself something else`,
      identity: { key: pkg.key, name: pkg.name, version: pkg.version },
    };
  }

  const identity: SkillIdentity = { key: pkg.key, name: pkg.name, version: pkg.version };

  if (args.source.kind === 'builtin') {
    // Shipped in the release. Not "trusted so the checks are skipped" — every
    // check above has already run — but there is no signature to verify and
    // claiming one would be a lie told in a column.
    return {
      ok: true,
      accepted: { pkg, digest, signatureState: 'builtin', signatureKeyId: null },
    };
  }

  if (args.source.public_key) {
    if (!pkg.signature) {
      return {
        ok: false,
        reason: 'signature_missing',
        detail: 'this source publishes a signing key, and the package is not signed',
        identity,
      };
    }
    if (!verifySkillSignature(pkg, args.source.public_key)) {
      return {
        ok: false,
        reason: 'signature_invalid',
        detail: 'the signature did not verify against the key registered for this source',
        identity,
      };
    }
    return {
      ok: true,
      accepted: {
        pkg, digest, signatureState: 'verified', signatureKeyId: pkg.signature.keyId,
      },
    };
  }

  return {
    ok: true,
    accepted: {
      pkg,
      digest,
      // A signature nobody can check is not a signature. Said in the column and
      // said on the screen, rather than quietly presented as one.
      signatureState: pkg.signature ? 'unverified' : 'unsigned',
      signatureKeyId: pkg.signature?.keyId ?? null,
    },
  };
}

// ----------------------------------------------------------------- writing

async function recordHistory(
  db: Db,
  args: {
    skillId: string;
    action: SkillHistoryRow['action'];
    version: string;
    digest: string;
    signatureState: SkillSignatureState;
    originName: string;
    actorUserId: string;
  },
): Promise<void> {
  await db.query(
    `insert into skill_history
       (skill_id, action, version, package_digest, signature_state, origin_name, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.skillId, args.action, args.version, args.digest, args.signatureState,
      args.originName, args.actorUserId,
    ],
  );
}

/**
 * Writes an accepted package. IT ARRIVES AT `review`, ALWAYS.
 *
 * There is no argument to this function that switches it on, and the column
 * that would have to be set for that — `reviewed_digest` — is not written here.
 * So an installation is a stored document and nothing else until somebody has
 * read it and said so.
 */
export async function installSkill(
  db: Db,
  args: {
    actorUserId: string;
    source: SkillSourceRow;
    entry: SkillCatalogueEntry;
    accepted: AcceptedSkillPackage;
  },
): Promise<SkillRow> {
  const { pkg, digest, signatureState, signatureKeyId } = args.accepted;
  const rows = await db.query<SkillRow>(
    `insert into skills
       (source_id, origin_kind, origin_name, origin_url, skill_key, name, version, publisher,
        summary, license, homepage, instructions, capabilities, dependencies, package_digest,
        signature_state, signature_key_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     returning *`,
    [
      args.source.id, args.source.kind, args.source.name, args.entry.packageUrl,
      pkg.key, pkg.name, pkg.version, pkg.publisher, pkg.summary, pkg.license, pkg.homepage,
      pkg.instructions,
      // `json()`, never a hand-serialised string: postgres.js types a string as
      // text, so a pre-stringified array reaches jsonb as a scalar string.
      // Invisible under pglite, permanent in production.
      json(pkg.capabilities), json(pkg.dependencies),
      digest, signatureState, signatureKeyId,
    ],
  );
  await recordHistory(db, {
    skillId: rows[0].id,
    action: 'installed',
    version: pkg.version,
    digest,
    signatureState,
    originName: args.source.name,
    actorUserId: args.actorUserId,
  });
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.installed',
    subjectType: 'skill',
    subjectId: rows[0].id,
    // Provenance and integrity. Never the instructions — those are the whole
    // package and an audit row records what happened, not what it said.
    payload: {
      skillKey: pkg.key,
      version: pkg.version,
      publisher: pkg.publisher,
      sourceKind: args.source.kind,
      originName: args.source.name,
      digest,
      signatureState,
      capabilitiesRequested: pkg.capabilities.length,
      // Stated in the trail because "it is installed" and "it is doing
      // anything" are different facts and this is the one people assume.
      active: false,
    },
  });
  return rows[0];
}

/**
 * Records a package CE would not trust, and stores NOTHING ELSE about it.
 *
 * No instructions column exists on `skill_quarantine` and none is passed here.
 * The whole reason a package lands in quarantine is that something about it
 * could not be trusted; keeping its prose would mean holding untrusted text in
 * a table somebody eventually renders to see what it said.
 */
export async function quarantineSkill(
  db: Db,
  args: {
    actorUserId: string;
    source: SkillSourceRow;
    identity: SkillIdentity;
    reason: SkillQuarantineReason;
    detail: string;
    digest?: string | null;
  },
): Promise<SkillQuarantineRow> {
  const rows = await db.query<SkillQuarantineRow>(
    `insert into skill_quarantine
       (source_id, origin_name, skill_key, name, version, package_digest, reason, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      args.source.id, args.source.name,
      args.identity.key.slice(0, 60), args.identity.name.slice(0, 80),
      args.identity.version.slice(0, 40),
      args.digest ?? null, args.reason, args.detail.slice(0, 300),
    ],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.quarantined',
    subjectType: 'skill_quarantine',
    subjectId: rows[0].id,
    payload: {
      skillKey: args.identity.key,
      version: args.identity.version,
      sourceKind: args.source.kind,
      originName: args.source.name,
      reason: args.reason,
    },
  });
  return rows[0];
}

export async function clearSkillQuarantine(
  db: Db,
  args: { actorUserId: string; id: string },
): Promise<void> {
  if (!UUID.test(args.id)) throw new SkillError('not found', 404);
  await db.query(`delete from skill_quarantine where id = $1`, [args.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.quarantine_cleared',
    subjectType: 'skill_quarantine',
    subjectId: args.id,
    payload: {},
  });
}

/**
 * Review, recorded and pinned.
 *
 * `seenDigest` is what the page had on screen. It travels with the decision so
 * the activation lands on the exact words somebody read: a skill that was
 * updated between the page rendering and the button being pressed is refused
 * rather than switched on. Same mechanism as approving an MCP tool, and for the
 * same reason — an approval that does not pin what it approved is a rubber
 * stamp.
 */
export async function activateSkill(
  db: Db,
  args: { actorUserId: string; skill: SkillRow; seenDigest: string },
): Promise<SkillRow> {
  if (args.seenDigest !== args.skill.package_digest) {
    throw new SkillError(
      'this skill changed while you were looking at it. Read it again and decide on the new version.',
      409,
    );
  }
  const rows = await db.query<SkillRow>(
    `update skills set state = 'enabled', reviewed_digest = $2, activated_at = now()
      where id = $1 returning *`,
    [args.skill.id, args.seenDigest],
  );
  for (const action of ['reviewed', 'enabled'] as const) {
    await recordHistory(db, {
      skillId: args.skill.id,
      action,
      version: args.skill.version,
      digest: args.skill.package_digest,
      signatureState: args.skill.signature_state,
      originName: args.skill.origin_name,
      actorUserId: args.actorUserId,
    });
  }
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.activated',
    subjectType: 'skill',
    subjectId: args.skill.id,
    payload: {
      skillKey: args.skill.skill_key,
      version: args.skill.version,
      publisher: args.skill.publisher,
      digest: args.skill.package_digest,
    },
  });
  return rows[0];
}

/**
 * On and off, for something already reviewed.
 *
 * Enabling refuses unless the reviewed digest still matches, which is the same
 * CHECK the database holds. Two places, deliberately: the database one is what
 * makes the rule true, and this one is what turns it into a sentence somebody
 * can act on instead of a constraint-violation page.
 */
export async function setSkillEnabled(
  db: Db,
  args: { actorUserId: string; skill: SkillRow; enabled: boolean },
): Promise<SkillRow> {
  if (args.enabled && args.skill.reviewed_digest !== args.skill.package_digest) {
    throw new SkillError(
      'read this skill first. Josi will not put instructions nobody here has read in front of the '
      + 'assistant, and this version has not been reviewed.',
      400,
    );
  }
  const rows = await db.query<SkillRow>(
    `update skills set state = $2, activated_at = case when $3 then now() else activated_at end
      where id = $1 returning *`,
    [args.skill.id, args.enabled ? 'enabled' : 'disabled', args.enabled],
  );
  await recordHistory(db, {
    skillId: args.skill.id,
    action: args.enabled ? 'enabled' : 'disabled',
    version: args.skill.version,
    digest: args.skill.package_digest,
    signatureState: args.skill.signature_state,
    originName: args.skill.origin_name,
    actorUserId: args.actorUserId,
  });
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: args.enabled ? 'skill.enabled' : 'skill.disabled',
    subjectType: 'skill',
    subjectId: args.skill.id,
    payload: { skillKey: args.skill.skill_key, version: args.skill.version },
  });
  return rows[0];
}

/**
 * A new version, written over the old one — and back to review, always.
 *
 * THIS IS THE FUNCTION MOST LIKELY TO BE GOT WRONG, so it is written to be
 * wrong-proof rather than careful. `state` is set to 'review' and
 * `reviewed_digest` to null in the same UPDATE that writes the new digest;
 * migration 0037's CHECK would refuse the row if either were left alone. An
 * update is new instructions from somebody outside this installation, and the
 * fact that an older version of the same skill was once read is not consent to
 * the new one.
 */
export async function updateSkill(
  db: Db,
  args: {
    actorUserId: string;
    skill: SkillRow;
    source: SkillSourceRow;
    entry: SkillCatalogueEntry;
    accepted: AcceptedSkillPackage;
  },
): Promise<SkillRow> {
  const { pkg, digest, signatureState, signatureKeyId } = args.accepted;
  const rows = await db.query<SkillRow>(
    `update skills set
       name = $2, version = $3, publisher = $4, summary = $5, license = $6, homepage = $7,
       instructions = $8, capabilities = $9, dependencies = $10, package_digest = $11,
       signature_state = $12, signature_key_id = $13, origin_url = $14,
       origin_name = $15,
       state = 'review', reviewed_digest = null, last_update_check_at = now()
     where id = $1
     returning *`,
    [
      args.skill.id, pkg.name, pkg.version, pkg.publisher, pkg.summary, pkg.license, pkg.homepage,
      pkg.instructions, json(pkg.capabilities), json(pkg.dependencies), digest,
      signatureState, signatureKeyId, args.entry.packageUrl, args.source.name,
    ],
  );
  await recordHistory(db, {
    skillId: args.skill.id,
    action: 'updated',
    version: pkg.version,
    digest,
    signatureState,
    originName: args.source.name,
    actorUserId: args.actorUserId,
  });
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.updated',
    subjectType: 'skill',
    subjectId: args.skill.id,
    payload: {
      skillKey: pkg.key,
      fromVersion: args.skill.version,
      version: pkg.version,
      publisher: pkg.publisher,
      digest,
      signatureState,
      // The consequence, in the trail, because it is the thing an operator will
      // otherwise discover by wondering why a skill stopped applying.
      returnedToReview: true,
      wasActive: args.skill.state === 'enabled',
    },
  });
  return rows[0];
}

export async function recordSkillUpdateCheck(db: Db, skillId: string): Promise<void> {
  await db.query(`update skills set last_update_check_at = now() where id = $1`, [skillId]);
}

export async function removeSkill(
  db: Db,
  args: { actorUserId: string; skill: SkillRow },
): Promise<void> {
  // History goes with it, by cascade. The `events` trail does not: an audit
  // that can be deleted by removing the thing it audits is not an audit.
  await db.query(`delete from skills where id = $1`, [args.skill.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.removed',
    subjectType: 'skill',
    subjectId: args.skill.id,
    payload: {
      skillKey: args.skill.skill_key,
      version: args.skill.version,
      publisher: args.skill.publisher,
      wasActive: args.skill.state === 'enabled',
    },
  });
}

// ------------------------------------------------------------- conflicts

/**
 * Whether this installation can take this package at all, in the words the
 * refusal will use.
 *
 * THE ONE THAT MATTERS IS THE PUBLISHER CHECK. A skill key is a name the whole
 * installation shares, and two registries offering `weekly_review` from two
 * publishers is the name-squatting attack this feature has: the second one
 * would arrive wearing a name people already trust. The unique index in
 * migration 0037 is what makes it impossible; this is what makes it
 * explicable.
 */
export async function skillInstallConflict(
  db: Db,
  args: { source: SkillSourceRow; entry: SkillCatalogueEntry },
): Promise<string | null> {
  const existing = await skillByKey(db, args.entry.key);
  if (!existing) return null;
  if (existing.source_id === args.source.id) {
    return `"${existing.name}" is already installed from ${existing.origin_name} at version `
      + `${existing.version}. Use Check for updates rather than installing it again.`;
  }
  return `A skill with the key "${args.entry.key}" is already installed — "${existing.name}", `
    + `published by ${existing.publisher} from ${existing.origin_name}. Two skills cannot share a `
    + 'key. Remove that one first if you mean to replace it.';
}

/**
 * Whether this package is an update to that row, in the words the refusal will
 * use.
 *
 * A PUBLISHER CHANGE IS REFUSED, not accepted quietly. The same key from the
 * same registry under a new publisher is that registry handing a name somebody
 * already trusted to somebody else; the honest answer is to say so and let an
 * administrator remove and reinstall deliberately.
 *
 * A VERSION THAT IS NOT NEWER is refused too. Serving an older package to a
 * client that already has a newer one is how a fixed skill gets replaced by the
 * version that needed fixing.
 */
export function skillUpdateConflict(
  skill: SkillRow,
  entry: SkillCatalogueEntry,
  pkg: SkillPackage,
): string | null {
  if (pkg.publisher !== skill.publisher) {
    return `${skill.origin_name} is now offering "${skill.skill_key}" under a different publisher `
      + `(${pkg.publisher} rather than ${skill.publisher}). Josi will not update into a change of `
      + 'publisher. Remove this skill and install the new one deliberately if that is what you want.';
  }
  const direction = compareSkillVersions(pkg.version, skill.version);
  if (direction < 0) {
    return `${skill.origin_name} is offering version ${entry.version}, which is older than the `
      + `${skill.version} already installed. Nothing was changed.`;
  }
  if (direction === 0) return null;
  return null;
}
