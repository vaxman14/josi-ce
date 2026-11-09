// Settings changes Josi proposed in conversation: list, decide, report applied.
//
// Who may make a proposal live:
//   * personal scope: the person it belongs to, unless the super-admin set
//     "member changes wait for me", in which case the super-admin consents
//     first and the person's own app then applies it;
//   * administrator scope: the super-admin only.
// The super-admin can deny anything (override). The client performs the
// stored request with its own session and reports the outcome here, so the
// route's own checks decide, and the proposal is a truthful receipt. A
// sensitive change applied by a member is emailed to every super-admin at
// once when mail is set up. Approving a sensitive change takes the approver's
// password, here on the server, every time: a recent step-up does not count.
import { Router, type Request, type Response } from 'express';
import { checkLoginRate, recordLoginAttempt, verifyPassword, beginPcPasskey, finishPcPasskey, relyingParty, WebAuthnError } from '@josi-ce/auth';
import { createHash } from 'node:crypto';
import { addMessage, json, loadMasterKey, PcControl, type PcPolicy, type PcPreset, type Db, type LoadOptions } from '@josi-ce/core';
import { loadProfile, smtpTransport, type SmtpTransport } from '@josi-ce/mail';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { clientIp } from './cookies.js';

interface Ctx { db: Db; masterKey?: LoadOptions | false; mailTransport?: SmtpTransport; appUrl?:string }
type Policy = 'self' | 'super_admin';
interface Row {
  id: string; proposer_user_id: string; proposer: string; scope: 'personal' | 'administrator'; area: string; sensitive: boolean; title: string; summary: string;
  method: string; path: string; body: unknown; state: string; approved_by: string | null; approved_at: string | null; applied_by: string | null;
  applied_at: string | null; error: string | null; expires_at: string; created_at: string; thread_id: string | null;
}
const COLUMNS = `p.id, p.proposer_user_id, u.username as proposer, p.scope, p.area, p.sensitive, p.title, p.summary, p.method, p.path, p.body, p.state,
  p.approved_by, p.approved_at, p.applied_by, p.applied_at, p.error, p.expires_at, p.created_at, p.thread_id`;

export function settingsChangeRoutes(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    try { return await fn(req, res); } catch (error) {
      if(error instanceof WebAuthnError)return res.status(400).json({error:error.message});
      const status = (error as { status?: number }).status;
      if (status) return res.status(status).json({ error: (error as Error).message });
      throw error;
    }
  });

  /** Throws unless this request carries the approver's password. On one limit
   * per person, so the popup can't be used to guess it. */
  async function confirmPassword(req: Request, res: Response, userId: string) {
    const ip = clientIp(req), identifier = `settings-change:${userId}`;
    const verdict = await checkLoginRate(db, identifier, ip);
    if (verdict.blocked) { res.set('Retry-After', String(verdict.retryAfterSeconds)); throw fail(429, 'Too many wrong passwords. Wait a little and try again.'); }
    const [row] = await db.query<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [userId]);
    if (!row?.password_hash) throw fail(403, 'This change needs your password, and your account does not have one yet. Set a password under Settings, then approve it.');
    const matched = await verifyPassword(row.password_hash, typeof req.body?.password === 'string' ? req.body.password : '');
    await recordLoginAttempt(db, { identifier, ip, success: matched });
    if (!matched) throw fail(401, 'That password did not match.');
  }
  async function policy(): Promise<Policy> {
    const [row] = await db.query<{ settings: Record<string, unknown> }>(`select settings from workspace where id = true`);
    return row?.settings?.memberSettingsChanges === 'super_admin' ? 'super_admin' : 'self';
  }
  async function expire() {
    await db.query(`update settings_change_proposals set state = 'expired' where state in ('proposed', 'approved') and expires_at <= now()`);
  }
  async function load(id: string): Promise<Row> {
    const [row] = await db.query<Row>(`select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.id = $1`, [id]);
    if (!row) throw fail(404, 'That proposal does not exist.');
    return row;
  }
  const visible = (row: Row, user: { id: string; role: string }) => row.proposer_user_id === user.id || user.role === 'super_admin';
  const isPcChange = (row: Row) => row.area.startsWith('pc_control_');
  function checkPcChange(row: Row, user: { id: string }) {
    if (!isPcChange(row)) return;
    if (row.proposer_user_id !== user.id) throw fail(403, 'Only the owner of this PC permission proposal can apply it.');
    const target = new URL(row.path, 'http://josi.invalid');
    if (target.searchParams.get('ownerId') !== row.proposer_user_id || !/^[a-z0-9-]{1,80}$/.test(target.searchParams.get('pcId') ?? '')
      || !/^\d+$/.test(target.searchParams.get('revision') ?? '')) throw fail(409, 'Ask Josi to prepare this PC permission again with its target computer.');
  }
  /** Whether this user is the one whose app applies the change. */
  // The outcome goes back into the conversation that prepared the change, so
  // the thread says what happened instead of "waiting for approval" forever.
  // Best effort: the proposal record is the receipt either way.
  const tell = async (row: Row, body: string) => {
    if (!row.thread_id) return;
    try { await addMessage(db, { threadId: row.thread_id, direction: 'out', body, meta: { settings_change: row.id } }); }
    catch { /* the thread may be gone */ }
  };
  const applier = (row: Row, user: { id: string; role: string }) =>
    isPcChange(row) ? row.proposer_user_id === user.id && user.role === 'super_admin'
      : row.scope === 'administrator' ? user.role === 'super_admin' : row.proposer_user_id === user.id;
  // The stored body is JSON text; the app sends it on as the request body, so
  // it must travel as an object. As text it would arrive double-encoded and
  // the setting's route would reject it with a 400 (the October 22 memory
  // learning proposal "failed" exactly this way).
  const change = (row: Row) => {
    let body: unknown = null;
    if (typeof row.body === 'string') { try { body = JSON.parse(row.body); } catch { body = null; } }
    else body = row.body ?? null;
    return { method: row.method, path: row.path, body };
  };
  const dto = (row: Row, user: { id: string; role: string }, rule: Policy) => ({
    id: row.id, threadId:row.thread_id, proposer: row.proposer, mine: row.proposer_user_id === user.id, scope: row.scope, area: row.area, sensitive: row.sensitive,
    title: row.title, summary: row.summary, state: row.state, createdAt: row.created_at, expiresAt: row.expires_at,
    approvedAt: row.approved_at, appliedAt: row.applied_at, error: row.error,
    // What this viewer can do with it right now.
    canApprove: row.state === 'proposed' && (!isPcChange(row) || row.proposer_user_id === user.id) && (row.scope === 'administrator' ? user.role === 'super_admin'
      : rule === 'super_admin' ? user.role === 'super_admin' : row.proposer_user_id === user.id),
    canDeny: ['proposed', 'approved'].includes(row.state) && visible(row, user),
    // Approved by the super-admin for a member: that member's app applies it.
    apply: row.state === 'approved' && applier(row, user) ? change(row) : null,
  });

  r.get('/', handle(async (req, res) => {
    await expire();
    const user = req.user!; const rule = await policy();
    const rows = await db.query<Row>(user.role === 'super_admin'
      ? `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state in ('proposed','approved') order by p.created_at desc limit 100`
      : `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state in ('proposed','approved') and p.proposer_user_id = $1 order by p.created_at desc limit 100`,
      user.role === 'super_admin' ? [] : [user.id]);
    return res.json({ proposals: rows.map((row) => dto(row, user, rule)), policy: rule, superAdmin: user.role === 'super_admin' });
  }));

  r.get('/history', handle(async (req, res) => {
    await expire();
    const user = req.user!; const rule = await policy();
    const rows = await db.query<Row>(user.role === 'super_admin'
      ? `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state not in ('proposed','approved') order by coalesce(p.applied_at, p.approved_at, p.created_at) desc limit 200`
      : `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state not in ('proposed','approved') and p.proposer_user_id = $1 order by coalesce(p.applied_at, p.approved_at, p.created_at) desc limit 200`,
      user.role === 'super_admin' ? [] : [user.id]);
    return res.json({ proposals: rows.map((row) => dto(row, user, rule)) });
  }));
  const pcDigest=(row:Row)=>createHash('sha256').update(JSON.stringify([row.id,row.proposer_user_id,row.method,row.path,row.body,row.expires_at])).digest('hex');
  async function pcProposal(req:Request){
    const row=await load(param(req,'id'));checkPcChange(row,req.user!);
    if(!isPcChange(row)||req.user!.role!=='super_admin'||row.proposer_user_id!==req.user!.id||row.state!=='proposed'||Date.parse(row.expires_at)<=Date.now())throw fail(409,'This PC permission is no longer awaiting your approval.');
    return row;
  }
  r.post('/:id/pc-passkey/options',handle(async(req,res)=>{
    const row=await pcProposal(req),rp=relyingParty(ctx.appUrl??'');
    if(!rp)throw fail(400,'Use the secure Josi address to approve with a passkey.');
    return res.json(await beginPcPasskey(db,rp,req.user!.id,row.id,pcDigest(row)));
  }));
  // Apply the immutable reviewed change on the server. No reusable step-up
  // token, client-supplied policy or password is returned to the conversation.
  r.post('/:id/pc-apply',handle(async(req,res)=>{
    const row=await pcProposal(req),owner=req.user!.id;
    if(req.body?.passkey){
      const rp=relyingParty(ctx.appUrl??'');if(!rp)throw fail(400,'Passkeys require the secure Josi address.');
      await finishPcPasskey(db,rp,owner,row.id,pcDigest(row),String(req.body.challengeId??''),req.body.passkey);
    }else if(row.sensitive)await confirmPassword(req,res,owner);
    if(ctx.masterKey===false)throw fail(503,'Permission storage is unavailable.');
    const target=new URL(row.path,'http://josi.invalid'),pc=target.searchParams.get('pcId')!,revision=Number(target.searchParams.get('revision'));
    const service=new PcControl(db,loadMasterKey(ctx.masterKey??{}),pc),body=change(row).body as Record<string,unknown>;
    const [claimed]=await db.query('update settings_change_proposals set state=\'approved\',approved_by=$2,approved_at=now() where id=$1 and state=\'proposed\' and expires_at>now() returning id',[row.id,owner]);
    if(!claimed)throw fail(409,'This permission was already decided.');
    try{
      if(row.area==='pc_control_enabled'){await service.setEnabled(owner,body.enabled as boolean,revision);if(body.enabled===true&&body.everyday===true)await service.setFullControl(owner,true);}
      else if(row.area==='pc_control_full_control')await service.setFullControl(owner,body.enabled as boolean,revision);
      else if(row.area==='pc_control_preset')await service.applyPreset(owner,body as PcPreset,revision);
      else if(row.area==='pc_control_scope'){const {approveRequestId,...policy}=body;await service.savePolicy(owner,policy as PcPolicy,{expectedRevision:revision,approveRequestId:approveRequestId as string|undefined});}
      else if(row.area==='pc_control_revoke')await service.revoke(owner,target.pathname.split('/').at(-1)!,revision);
      else if(row.area==='pc_control_decide')await service.decide(owner,target.pathname.split('/').at(-2)!,body.approve as boolean,revision);
      else throw fail(400,'Unsupported PC permission change.');
      await db.query('update settings_change_proposals set state=\'applied\',applied_by=$2,applied_at=now() where id=$1',[row.id,owner]);
      await tell(row,'Done: this change is now live. '+row.summary);
      return res.json({ok:true,state:'applied'});
    }catch(error){
      await db.query('update settings_change_proposals set state=\'failed\',error=$2 where id=$1',[row.id,'The permission could not be applied. Request a fresh review.']);
      throw error;
    }
  }));

  /** Approve or deny. Approving returns the request to perform when this
   * user's app is the one that applies it. */
  r.post('/:id/decide', handle(async (req, res) => {
    if (typeof req.body?.approve !== 'boolean') throw fail(400, 'Choose approve or deny.');
    await expire();
    const user = req.user!; const rule = await policy();
    const row = await load(param(req, 'id'));
    if (!visible(row, user)) throw fail(404, 'That proposal does not exist.');
    if (!req.body.approve) {
      if (!['proposed', 'approved'].includes(row.state)) throw fail(409, `That proposal is already ${row.state}.`);
      await db.query(`update settings_change_proposals set state = 'denied', approved_by = $2, approved_at = now() where id = $1`, [row.id, user.id]);
      await tell(row, `Not changed: this was declined. ${row.summary}`);
      return res.json({ ok: true, state: 'denied' });
    }
    if (row.state !== 'proposed') throw fail(409, `That proposal is already ${row.state}.`);
    checkPcChange(row, user);
    const allowed = row.scope === 'administrator' ? user.role === 'super_admin'
      : rule === 'super_admin' ? user.role === 'super_admin' : row.proposer_user_id === user.id;
    if (!allowed) throw fail(403, row.scope === 'administrator' ? 'Only the super-admin can approve an administrator setting.'
      : 'Changes by members wait for the super-admin on this installation.');
    if (row.sensitive) await confirmPassword(req, res, user.id);
    const claimed = await db.query(`update settings_change_proposals set state = 'approved', approved_by = $2, approved_at = now() where id = $1 and state = 'proposed' and expires_at > now() returning id`, [row.id, user.id]);
    if (!claimed.length) throw fail(409, 'That proposal was already decided or expired.');
    return res.json({ ok: true, state: 'approved', apply: applier(row, user) ? change(row) : null });
  }));

  /** The applier's app reports what the request did. */
  r.post('/:id/applied', handle(async (req, res) => {
    const user = req.user!;
    const row = await load(param(req, 'id'));
    if (!applier(row, user)) throw fail(403, 'Only the person whose app applies this change can report it.');
    if (row.state !== 'approved') throw fail(409, `That proposal is ${row.state}, not approved.`);
    const ok = req.body?.ok === true;
    const error = typeof req.body?.error === 'string' ? req.body.error.slice(0, 500) : null;
    await db.query(`update settings_change_proposals set state = $2, applied_by = $3, applied_at = now(), error = $4 where id = $1`,
      [row.id, ok ? 'applied' : 'failed', user.id, ok ? null : error ?? 'The change could not be applied.']);
    await tell(row, ok ? `Done: this change is now live. ${row.summary}` : `Not applied: ${error ?? 'the change could not be applied.'} ${row.summary}`);
    let notified = false;
    if (ok && row.sensitive && user.role !== 'super_admin') {
      notified = await notifySuperAdmins(ctx, db, row, user);
      if (notified) await db.query(`update settings_change_proposals set notified_at = now() where id = $1`, [row.id]);
    }
    return res.json({ ok: true, state: ok ? 'applied' : 'failed', notified });
  }));

  r.put('/policy', requireSuperAdmin, handle(async (req, res) => {
    const value = req.body?.memberSettingsChanges;
    if (value !== 'self' && value !== 'super_admin') throw fail(400, 'Choose "self" or "super_admin".');
    await db.query(`update workspace set settings = settings || $1::jsonb where id = true`, [json({ memberSettingsChanges: value })]);
    return res.json({ ok: true, policy: value });
  }));
  return r;
}

/** Immediate email to every super-admin when a member applied a sensitive
 * change. Best effort: no mail profile, no email, and the change still
 * stands; the proposal record is the durable receipt. */
async function notifySuperAdmins(ctx: Ctx, db: Db, row: Row, by: { username: string; email: string }): Promise<boolean> {
  if (ctx.masterKey === false) return false;
  try {
    const admins = await db.query<{ email: string }>(`select email from users where role = 'super_admin' and status = 'active' and email <> ''`);
    if (!admins.length) return false;
    const profile = await loadProfile(db, loadMasterKey(ctx.masterKey ?? {}), 'system');
    const transport = ctx.mailTransport ?? smtpTransport(profile);
    const when = new Date().toISOString();
    await transport.send({
      from: `${profile.fromName} <${profile.fromAddress}>`, replyTo: profile.fromAddress,
      to: admins.map((a) => a.email), cc: [], subject: `Josi: ${by.username} changed "${row.title}"`,
      text: `${by.username} (${by.email}) made a sensitive settings change through Josi on ${when}.\n\n`
        + `Setting: ${row.title}\nWhat changed: ${row.summary}\nScope: ${row.scope}\n\n`
        + 'Review it under Approvals in Josi (history of settings changes). As super-admin you can revert it there or under the setting\'s own screen, '
        + 'and under Approvals you can require that member changes wait for you.',
      headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [],
    });
    return true;
  } catch {
    return false;
  }
}
