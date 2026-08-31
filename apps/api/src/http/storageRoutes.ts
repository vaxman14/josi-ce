// Documents and storage over HTTP.
//
// Two things to check when reading this file.
//
// First: there is no admin route that creates, reads, or browses a mapping.
// The administrator's routes below set CAPABILITIES and POLICY and read
// aggregate counts. That is M47's asymmetry made structural — an administrator
// who could create a mapping for someone could read their files by filling in a
// form, and since Josi indexes what it maps, those files would land in a search
// index the administrator also runs.
//
// Second: the owner is always `req.user!.id`. It is never read from the request
// body, in any route, for any reason.
import { Router, type Request, type Response } from 'express';
import { appendEvent, type Db } from '@josi-ce/core';
import {
  MappingError, PathEscape, capabilityFor, consentText, createMapping,
  mappingsBlockingUserRemoval, purgeDerived, setIndexing, setPermissions, unmapFolder,
} from '@josi-ce/storage';
import { requireAuth, requireOwnership, requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

export interface StorageRoutesCtx {
  db: Db;
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: unknown) {
      // A containment failure and a refused grant are both "no". Neither says
      // anything about what is actually on disk.
      if (err instanceof PathEscape) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof MappingError) {
        const code = err.code;
        const status = code === 'not_found' ? 404
          : code === 'not_permitted' ? 403
          : code === 'already_mapped' ? 409
          : 400;
        res.status(status).json({ error: err.message, code });
        return;
      }
      throw err;
    }
  });
}

export function storageRoutes(ctx: StorageRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** The folders the operator has made available, and what this person may do.
   *
   * Deliberately shows roots to everyone who may map: they are operator-declared
   * shared locations with labels chosen for display, not private content. What
   * is inside them is not listed here. */
  r.get(
    '/available',
    handle(async (req, res) => {
      const capability = await capabilityFor(db, req.user!.id);
      const roots = capability.may_map_local
        ? await db.query(
            `select id, label, purpose, writable from storage_roots
             where enabled = true order by label`,
          )
        : [];
      const [policy] = await db.query<{ processing_paused: boolean }>(
        `select processing_paused from storage_policy where id = true`,
      );
      return res.json({ capability, roots, processingPaused: policy?.processing_paused ?? false });
    }),
  );

  /** What agreeing would mean, in words, before anything is created.
   *
   * A separate route rather than a string built in the browser: the sentence a
   * person consents to is a security artefact (M50), and it has to be the same
   * sentence the server would write into the record. */
  r.post(
    '/consent-preview',
    handle(async (req, res) => {
      const [root] = req.body?.rootId
        ? await db.query<{ label: string }>(
            `select label from storage_roots where id = $1 and enabled = true`, [str(req.body.rootId, 64)],
          )
        : [];
      const relative = str(req.body?.relativePath, 1000);
      const displayPath = root
        ? (relative ? `${root.label}/${relative}` : root.label)
        : str(req.body?.displayPath, 500) || 'the selected folder';
      return res.json({
        consent: consentText({
          displayPath,
          recursive: req.body?.recursive === true,
          indexing: req.body?.indexing === true,
        }),
      });
    }),
  );

  r.get(
    '/mappings',
    handle(async (req, res) => {
      const mappings = await db.query(
        `select id, provider, display_path, recursive, may_create, may_edit, may_move, may_delete,
                indexing_enabled, status, paused_reason, created_at
         from folder_mappings where owner_user_id = $1 order by created_at desc`,
        [req.user!.id],
      );
      return res.json({ mappings });
    }),
  );

  r.post(
    '/mappings',
    handle(async (req, res) => {
      const provider = str(req.body?.provider, 32);
      if (provider !== 'local' && provider !== 'google_drive' && provider !== 'onedrive') {
        return res.status(400).json({ error: 'choose local, Google Drive or OneDrive' });
      }
      const mapping = await createMapping(db, {
        // The session, never the body.
        ownerUserId: req.user!.id,
        provider,
        rootId: str(req.body?.rootId, 64) || null,
        relativePath: str(req.body?.relativePath, 1000),
        connectionId: str(req.body?.connectionId, 64) || null,
        remoteFolderId: str(req.body?.remoteFolderId, 200) || null,
        displayPath: str(req.body?.displayPath, 500),
        recursive: req.body?.recursive === true,
      });
      return res.status(201).json({
        mapping,
        consent: consentText({
          displayPath: mapping.display_path,
          recursive: mapping.recursive,
          indexing: false,
        }),
      });
    }),
  );

  /** Reading one mapping accepts a share; changing it does not. */
  r.get(
    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'read' }),
    handle(async (req, res) => {
      const id = param(req, 'id');
      const [mapping] = await db.query(
        `select id, owner_user_id, provider, display_path, recursive,
                may_create, may_edit, may_move, may_delete, indexing_enabled,
                status, paused_reason, created_at
         from folder_mappings where id = $1`,
        [id],
      );
      const [counts] = await db.query(
        `select count(*)::int as total,
                count(*) filter (where state = 'skipped')::int as skipped,
                count(*) filter (where state = 'blocked')::int as blocked
         from documents where mapping_id = $1`,
        [id],
      );
      return res.json({ mapping, counts });
    }),
  );

  r.put(
    '/mappings/:id/permissions',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const mapping = await setPermissions(db, {
        mappingId: param(req, 'id'),
        ownerUserId: req.user!.id,
        create: flag(req.body?.create),
        edit: flag(req.body?.edit),
        move: flag(req.body?.move),
        delete: flag(req.body?.delete),
      });
      return res.json({
        mapping,
        // Said out loud, because granting `delete` is the one people misread.
        notice: mapping.may_delete
          ? 'Josi may ask to delete files in this folder. Every deletion still needs your approval.'
          : undefined,
      });
    }),
  );

  r.put(
    '/mappings/:id/indexing',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const enabled = req.body?.enabled === true;
      const { mapping, purged } = await setIndexing(db, {
        mappingId: param(req, 'id'),
        ownerUserId: req.user!.id,
        enabled,
      });
      return res.json({ mapping, purged });
    }),
  );

  r.delete(
    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const purged = await unmapFolder(db, {
        mappingId: param(req, 'id'),
        ownerUserId: req.user!.id,
      });
      return res.json({ unmapped: true, purged });
    }),
  );

  // -------------------------------------------------------------------------
  // Administrator. Capabilities and policy. No content, no filenames, no paths.
  // -------------------------------------------------------------------------
  r.get(
    '/admin/capabilities',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const rows = await db.query(
        `select u.id as user_id, u.username, u.display_name,
                coalesce(c.may_map_local, false) as may_map_local,
                coalesce(c.may_map_cloud, false) as may_map_cloud,
                coalesce(c.may_index, false) as may_index,
                c.max_files, c.max_bytes,
                (select count(*)::int from folder_mappings m where m.owner_user_id = u.id) as mappings
         from users u
         left join storage_capabilities c on c.user_id = u.id
         where u.status = 'active'
         order by u.username`,
      );
      // A COUNT of mappings is metadata. Their paths are not, and are not here.
      return res.json({ users: rows });
    }),
  );

  r.put(
    '/admin/capabilities/:userId',
    requireSuperAdmin,
    handle(async (req, res) => {
      const userId = param(req, 'userId');
      const [target] = await db.query<{ id: string }>(
        `select id from users where id = $1 and status = 'active'`, [userId],
      );
      if (!target) return res.status(404).json({ error: 'no such person' });

      const [row] = await db.query(
        `insert into storage_capabilities
           (user_id, may_map_local, may_map_cloud, may_index, max_files, max_bytes, granted_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id) do update set
           may_map_local = coalesce($2, storage_capabilities.may_map_local),
           may_map_cloud = coalesce($3, storage_capabilities.may_map_cloud),
           may_index     = coalesce($4, storage_capabilities.may_index),
           max_files     = $5, max_bytes = $6, granted_by = $7, updated_at = now()
         returning *`,
        [
          userId,
          flag(req.body?.mayMapLocal) ?? false,
          flag(req.body?.mayMapCloud) ?? false,
          flag(req.body?.mayIndex) ?? false,
          Number.isInteger(req.body?.maxFiles) ? req.body.maxFiles : null,
          Number.isInteger(req.body?.maxBytes) ? req.body.maxBytes : null,
          req.user!.id,
        ],
      );

      // M47's other half: taking `may_index` away is a revocation, and M54 says
      // a revocation destroys derived data immediately. Turning the capability
      // off while leaving indexed text in place would make the switch a lie.
      let purged = null;
      if (flag(req.body?.mayIndex) === false) {
        const mappings = await db.query<{ id: string }>(
          `update folder_mappings set indexing_enabled = false, indexing_consented_at = null
           where owner_user_id = $1 and indexing_enabled = true returning id`,
          [userId],
        );
        let documents = 0;
        for (const m of mappings) documents += (await purgeDerived(db, m.id)).documents;
        purged = { mappings: mappings.length, documents };
      }

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'storage.capability_changed',
        subjectType: 'user',
        subjectId: userId,
        payload: {
          mayMapLocal: row.may_map_local, mayMapCloud: row.may_map_cloud,
          mayIndex: row.may_index, purged,
        },
      });
      return res.json({ capability: row, purged });
    }),
  );

  /** M72/M74: aggregate health. Counts and states, never a name or a path. */
  r.get(
    '/admin/health',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const byState = await db.query(
        `select state, count(*)::int as n from documents group by state order by state`,
      );
      const byProvider = await db.query(
        `select provider, status, count(*)::int as n from folder_mappings
         group by provider, status order by provider, status`,
      );
      const skips = await db.query(
        `select skip_reason, count(*)::int as n from documents
         where skip_reason is not null group by skip_reason order by n desc`,
      );
      return res.json({ documents: byState, mappings: byProvider, skipped: skips });
    }),
  );

  /** M70: what stops a person being removed. Named so a human can act on it. */
  r.get(
    '/admin/users/:userId/blocking',
    requireSuperAdmin,
    handle(async (req, res) => {
      const blocking = await mappingsBlockingUserRemoval(db, param(req, 'userId'));
      return res.json({
        // The path IS shown here, and only here, because an administrator being
        // asked to transfer or purge a shared folder cannot act on an opaque id.
        // It is already shared with somebody, and the alternative is an
        // administrator guessing.
        blocking: blocking.map((b) => ({ id: b.id, displayPath: b.display_path, sharedWith: b.shared_with })),
        instruction: blocking.length
          ? 'Each of these is shared with someone else. Transfer it to another owner or purge it before removing this person.'
          : 'Nothing shared. Removing this person will delete their mapped folders and everything derived from them.',
      });
    }),
  );

  r.get(
    '/admin/policy',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [policy] = await db.query(`select * from storage_policy where id = true`);
      return res.json({ policy });
    }),
  );

  return r;
}
