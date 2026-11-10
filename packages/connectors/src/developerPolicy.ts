// One person's standing permission to connect one developer service.
//
// docs/JOSI_IS_THE_INTERFACE.md rule 4: a member asks, the owner approves,
// and the approval is per person, per connector, standing until revoked. This
// is the single write both the approval route and the chat decision use, so
// the two cannot disagree about what "approved" means.
import type { Db } from '@josi-ce/core';
import { isDeveloperService, type DeveloperService } from './developerServices.js';

export async function allowDeveloperServiceFor(db: Db, args: { service: string; userId: string; actorUserId: string }): Promise<{ service: DeveloperService; mode: string }> {
  if (!isDeveloperService(args.service)) throw new Error('no such service');
  const service = args.service;
  const [policy] = await db.query<{ mode: string }>('select mode from developer_service_policy where service = $1', [service]);
  const mode = policy?.mode === 'everyone' ? 'everyone' : 'specific_users';
  // "Everyone" already covers this person; anything else becomes a named list
  // that keeps whoever was on it and adds this person.
  await db.query(
    `insert into developer_service_policy (service, mode, updated_at, updated_by) values ($1, $2, now(), $3)
     on conflict (service) do update set mode = excluded.mode, updated_at = now(), updated_by = excluded.updated_by`,
    [service, mode, args.actorUserId]);
  if (mode === 'specific_users') {
    await db.query('insert into developer_service_allowed_users (service, user_id) values ($1, $2) on conflict do nothing', [service, args.userId]);
  }
  return { service, mode };
}

/** The reverse, also by asking: the person drops off the list; "everyone"
 * stays everyone, because narrowing a whole-installation rule to exclude one
 * person is a different ask. */
export async function revokeDeveloperServiceFor(db: Db, args: { service: string; userId: string }): Promise<void> {
  if (!isDeveloperService(args.service)) throw new Error('no such service');
  await db.query('delete from developer_service_allowed_users where service = $1 and user_id = $2', [args.service, args.userId]);
}
