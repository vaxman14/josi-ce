// The assistant's HTTP surface: conversations, tasks, approvals, step-up.
//
// Every route here touches somebody's private content, so every one of them
// resolves ownership through the Phase 1 spine rather than filtering by user id
// inline. Two rules, and the tests attack both:
//
//   * Another member's thread, task or contact is 404. Never 403 — that would
//     confirm a colleague has one.
//   * The super admin gets nothing here. Not a thread, not a task, not a
//     message. Their surface is `/api/admin/assistant`, which returns counts.
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  addMessage, appendEvent, createContact, createTask, createThread, decideActionApproval, markActionsPresented,
  getTask, getTemplate, getThread, listContactsFor, listMessages, listPendingApprovals,
  listTasksFor, listTemplates, listThreadsFor, missingSlots, resolveAccess, setSlots,
  setUserApprovalLevel, getApprovalLevel, taskMetrics, transition, verifyStepUp,
  canWrite, checkStepUp, enqueue, recordExchange, reminderOverview, cancelReminder,
  checkChildAccess, encodeTurnCursor, json, submitDurableTurn, listDurableTurns, upsertMobileDevice, revokeMobileDevice, MobileError, consume, LIMITS,
  type ApprovalLevel, type Db, type TaskState,
} from '@josi-ce/core';
import { verifyPassword } from '@josi-ce/auth';
import { runAssistantTurn, type RecallLookup } from '@josi-ce/agent';
import type { LoadOptions } from '@josi-ce/core';
import { loadMasterKey } from '@josi-ce/core';
import { capabilitiesOf, loadStoredProvider } from '@josi-ce/llm';
import {
  ChatImageError, IMAGE_MEDIA_TYPES, extractRichSegments, AttachmentError,
  attachmentFailure, attachmentRoot, normalizeChatImage, validateAttachment,
  writeAttachment, readAttachment, removeAttachment, CHAT_FILE_BYTES,
} from '@josi-ce/storage';
import { asyncRoute, param } from './async.js';
import { accessorOf, requireAuth, requireOwnership, requireSuperAdmin } from './authz.js';

export interface AssistantRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  /** Injected in tests so no suite ever executes the Codex binary. */
  codexRunner?: import('@josi-ce/llm').SpawnRunner;
  /** HTTP for connected-provider (Gmail, Graph…) calls the data tools make.
   * Injected by tests; unset in production. */
  connectorFetch?: typeof fetch;
  customApiFetch?: typeof fetch;
  outboundResolve?: (hostname: string) => Promise<string[]>;
  recall?: RecallLookup;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const mobileLifecycleState=(status:string):'accepted_queued'|'reconciling'|'completed'|'terminal_failed'=>
  status==='queued'?'accepted_queued':status==='running'?'reconciling':status==='completed'?'completed':'terminal_failed';

function registryOptions(ctx: AssistantRoutesCtx) {
  let masterKey = null;
  try {
    masterKey = ctx.masterKey === false ? null : loadMasterKey(ctx.masterKey ?? {});
  } catch {
    // A missing key is not fatal here: a provider with no stored secret (a
    // self-hosted endpoint) still works, and one with a secret fails later with
    // a message that says so.
    masterKey = null;
  }
  return {
    db: ctx.db, masterKey, fetchImpl: ctx.fetchImpl, resolve: ctx.resolve,
    codexRunner: ctx.codexRunner,
  };
}

const CALENDAR_CONTINUITY_TOOLS = new Set(['query_calendar', 'get_event', 'draft_calendar_event']);

/** Preserve only verified calendar receipts needed to resolve a follow-up.
 * They stay in owner-scoped message metadata and are shown only to the model,
 * never appended to the visible chat body. */
function calendarContinuity(actions: Array<{ tool: string; result: unknown }>): Array<{ tool: string; result: unknown }> {
  return actions.filter((action) => CALENDAR_CONTINUITY_TOOLS.has(action.tool)).slice(-6);
}

function historyContent(message: { direction: 'in' | 'out'; body: string; meta: Record<string, unknown> }): string {
  if (message.direction !== 'out' || !Array.isArray(message.meta?.calendar_receipts) || !message.meta.calendar_receipts.length) {
    return message.body;
  }
  return `${message.body}\n\n[Verified calendar receipts from this prior turn. Preserve the named event, event_id, source_id, account, and calendar in follow-up actions; do not transfer a requested edit to another event.]\n${JSON.stringify(message.meta.calendar_receipts).slice(0, 12_000)}`;
}

/** Public message shape. Metadata is private by default: only fields the chat
 * UI deliberately renders cross the HTTP presentation boundary. */
function presentMessage<T extends { meta: Record<string, unknown> }>(message: T): T {
  const attachments = Array.isArray(message.meta?.attachments) ? message.meta.attachments : undefined;
  return { ...message, meta: attachments ? { attachments } : {} };
}

export function assistantRoutes(ctx: AssistantRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);
  const uploadDir = attachmentRoot();
  const receive = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHAT_FILE_BYTES, files: 1, fields: 0, parts: 2 } });

  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    asyncRoute(async (req: Request, res: Response) => {
      try {
        return await fn(req, res);
      } catch (err: unknown) {
        if (err instanceof AttachmentError) return res.status(err.status).json({ error: err.message, code: err.code });
        if (err instanceof MobileError) {if(err.code==='turn_queue_full')res.set('Retry-After','30');return res.status(err.code==='idempotency_conflict'?409:err.code==='turn_queue_full'?429:400).json({error:err.message,code:err.code});}
        if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    });

  // ----------------------------------------------------------- step-up
  /** Re-authenticate this session for consequential actions.
   *
   * Deliberately NOT a "give me a token" endpoint: the unlock is recorded
   * server-side against the session key, so a client cannot mint or extend
   * one. */
  r.post(
    '/step-up',
    handle(async (req, res) => {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const result = await verifyStepUp(db, {
        userId: req.user!.id,
        // A browser may never choose which server-side session receives the
        // elevation. Otherwise a stolen session id can be elevated from a
        // different authenticated browser.
        sessionKey: req.user!.session_id,
        password,
        verifyPassword: async (userId, plain) => {
          const rows = await db.query<{ password_hash: string | null }>(
            `select password_hash from users where id = $1`,
            [userId],
          );
          return verifyPassword(rows[0]?.password_hash ?? null, plain);
        },
      });
      // A wrong password and a locked-out session both answer 401 with the
      // same shape; only `reason` differs, and neither says anything about the
      // password itself.
      return res.status(result.ok ? 200 : 401).json(result);
    }),
  );

  // ---------------------------------------------------------- threads
  r.get(
    '/threads',
    handle(async (req, res) =>
      res.json({ threads: await listThreadsFor(db, { ownerUserId: req.user!.id }) })),
  );

  r.post('/threads/:id/attachments', requireOwnership({ db }, { type: 'thread', need: 'write' }),
    // Upload ownership is narrower than thread sharing: sharing a conversation
    // never grants permission to spend another person's storage quota.
    handle(async (req, res) => {
      const thread = await getThread(db, param(req, 'id'));
      if (!thread || thread.owner_user_id !== req.user!.id) throw new RouteError(404, 'not found');
      await new Promise<void>((resolve, reject) => receive.single('file')(req, res, error => error ? reject(error) : resolve())).catch(error => {
        if (error instanceof multer.MulterError) throw new AttachmentError(413, error.code,
          error.code === 'LIMIT_FILE_SIZE' ? 'Choose a file no larger than 20 MB.' : 'Upload one file at a time without additional fields.');
        throw new AttachmentError(400, 'invalid_upload', 'The upload could not be read. Choose a file and retry.');
      });
      if (!req.file) throw new RouteError(400, 'choose a file first');
      let originalname = req.file.originalname;
      // Multipart headers conventionally arrive as Latin-1; recover UTF-8
      // names without accepting invalid byte sequences.
      try { originalname = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.from(originalname,'latin1')); } catch { /* retain the supplied name */ }
      let normalized;
      try {
        normalized = await normalizeChatImage({
          filename: originalname,
          declaredContentType: req.file.mimetype || 'application/octet-stream',
          bytes: req.file.buffer,
        });
      } catch (error) {
        if (error instanceof ChatImageError) throw new AttachmentError(400, 'invalid_heic', error.message);
        throw error;
      }
      const { bytes } = normalized;
      const { filename, contentType, extension } = validateAttachment(
        normalized.filename,
        normalized.contentType,
        bytes,
      );
      const id = randomUUID();
      // Reserve counts/bytes in one database statement before writing bytes.
      // Database triggers serialize concurrent upload/delete quota changes.
      try {
        await db.query(`insert into chat_attachments
          (id,owner_user_id,thread_id,filename,content_type,byte_size,storage_path,storage_state)
          values($1,$2,$3,$4,$5,$6,$7,'pending')`,
          [id,req.user!.id,thread.id,filename,contentType,bytes.length,join(uploadDir,id)]);
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes('attachment_thread_quota')) throw new AttachmentError(413, 'thread_quota', 'This conversation has reached its 100-file limit. Delete an unused attachment or start another conversation.');
        if (message.includes('attachment_user_quota')) throw new AttachmentError(413, 'user_quota', 'Your attachments have reached the 200 MB or 1,000-file limit. Delete unused attachments.');
        if (message.includes('attachment_tenant_quota')) throw new AttachmentError(413, 'tenant_quota', 'Installation attachments have reached the 2 GB or 10,000-file limit. Ask the administrator to review storage retention.');
        throw error;
      }
      try {
        await writeAttachment(id, bytes, uploadDir);
        let segments;
        try {
          segments = await extractRichSegments({ extension, bytes });
        } catch (error) {
          // A broken parser/runtime is not the same thing as a valid file with
          // no text layer. Keep the underlying detail in server logs and give
          // the person an honest, retryable error instead of telling the model
          // that a readable document contained no text.
          console.error('chat attachment extraction failed', {
            extension,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new AttachmentError(422, 'extraction_failed',
            'Josi could not process this file because its document parser failed. Retry once; if it fails again, ask the administrator to check the application logs.');
        }
        await db.query(`update chat_attachments set storage_state='ready',extracted_text=$2 where id=$1`,
          [id,segments?.map(s => s.content).join('\n').slice(0,100_000) || null]);
      } catch (error) {
        await db.query(`delete from chat_attachments where id=$1 and storage_state='pending'`, [id]);
        await removeAttachment(id, uploadDir).catch(() => undefined);
        throw attachmentFailure(error);
      }
      await appendEvent(db,{actorUserId:req.user!.id,actor:'user',kind:'attachment.uploaded',subjectType:'thread',subjectId:thread.id,payload:{attachmentId:id,bytes:bytes.length}});
      return res.status(201).json({ attachment: { id, filename, contentType, byteSize: bytes.length } });
    }));

  r.get('/attachments/:attachmentId', handle(async (req, res) => {
    const [attachment] = await db.query<{ id:string; filename:string; content_type:string }>(
      `select a.id,a.filename,a.content_type from chat_attachments a join threads t on t.id=a.thread_id
       where a.id=$1 and a.owner_user_id=$2 and t.owner_user_id=$2 and a.storage_state='ready'`,
      [param(req,'attachmentId'),req.user!.id]);
    if (!attachment) throw new RouteError(404,'not found');
    const bytes = await readAttachment(attachment.id,uploadDir);
    res.type(attachment.content_type);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    return res.send(bytes);
  }));

  r.delete('/attachments/:attachmentId', handle(async (req,res) => {
    const [attachment] = await db.query<{ id:string; referenced:boolean }>(
      `select a.id,(a.referenced_at is not null or exists(select 1 from messages m
        where m.thread_id=a.thread_id and m.meta->'attachments' @> jsonb_build_array(jsonb_build_object('id',a.id::text)))) as referenced
       from chat_attachments a join threads t on t.id=a.thread_id
       where a.id=$1 and a.owner_user_id=$2 and t.owner_user_id=$2`,[param(req,'attachmentId'),req.user!.id]);
    if (!attachment) throw new RouteError(404,'not found');
    if (attachment.referenced) throw new RouteError(409,'This attachment is referenced by a conversation and is retained with it.');
    // Mark unavailable atomically with reference checking before removing bytes.
    const deleted = await db.query(`delete from chat_attachments where id=$1 and referenced_at is null returning id`,[attachment.id]);
    if (!deleted.length) throw new RouteError(409,'This attachment is now referenced by a conversation.');
    await removeAttachment(attachment.id,uploadDir);
    await appendEvent(db,{actorUserId:req.user!.id,actor:'user',kind:'attachment.deleted',payload:{attachmentId:attachment.id}});
    return res.json({deleted:true});
  }));

  r.post(
    '/threads',
    handle(async (req, res) => {
      const thread = await createThread(db, {
        ownerUserId: req.user!.id,
        title: str(req.body?.title, 200) || null,
      });
      return res.status(201).json({ thread });
    }),
  );

  r.get(
    '/threads/:id',
    requireOwnership({ db }, { type: 'thread', need: 'read' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      return res.json({
        thread: await getThread(db, threadId),
        messages: (await listMessages(db, { threadId })).map(presentMessage),
      });
    }),
  );

  /** Durable native submission. The thread owner is authoritative: unlike the
   * legacy shared-web route, a shared writer cannot enqueue work under another
   * person's native device identity. Acceptance never waits for a model. */
  r.post('/threads/:id/turns',requireOwnership({db},{type:'thread',need:'owner'}),handle(async(req,res)=>{
    const threadId=param(req,'id');
    const wireBodyKey=typeof req.body?.client_message_id==='string'?req.body.client_message_id:'';
    const wireHeaderKey=typeof req.get('Idempotency-Key')==='string'?req.get('Idempotency-Key')!:'';
    if(wireBodyKey.length>128||wireHeaderKey.length>128)throw new MobileError('invalid_idempotency_key','A client_message_id of at most 128 characters is required.');
    const bodyKey=wireBodyKey.trim();
    const headerKey=wireHeaderKey.trim();
    if(bodyKey&&headerKey&&bodyKey!==headerKey)throw new MobileError('idempotency_conflict','The Idempotency-Key and client_message_id must match.');
    const clientMessageId=bodyKey||headerKey;
    if(!clientMessageId)throw new MobileError('invalid_idempotency_key','A client_message_id of at most 128 characters is required.');
    const duplicate=clientMessageId?!!(await db.query(`select 1 from assistant_turns where owner_user_id=$1 and thread_id=$2 and client_message_id=$3`,[req.user!.id,threadId,clientMessageId])).length:false;
    if(!duplicate){const rate=await consume(db,{limit:LIMITS.durable_turn,subject:`durable_turn:${req.user!.id}`});if(!rate.ok){res.set('Retry-After',String(rate.retryAfterSeconds));throw new RouteError(429,'Too many turns were submitted. Reconcile existing work before retrying.');}}
    const accepted=await submitDurableTurn(db,{
      ownerUserId:req.user!.id,sessionId:req.user!.session_id,threadId,
      clientMessageId,
      message:str(req.body?.message,8000),
      replyToMessageId:str(req.body?.reply_to_message_id,80)||null,
      attachmentIds:Array.isArray(req.body?.attachment_receipts)?req.body.attachment_receipts.map((x:unknown)=>str(x,80)):[],
      attemptOf:str(req.body?.attempt_of,80)||null,
    });
    res.set('Cache-Control','no-store');
    res.set('Location',`/api/assistant/threads/${threadId}/turns`);
    const lifecycleState=mobileLifecycleState(accepted.turn.status);
    return res.status(202).json({turn:{id:accepted.turn.id,job_id:accepted.turn.id,status:accepted.turn.status,lifecycle_state:lifecycleState,thread_id:threadId,client_message_id:accepted.turn.client_message_id,attempt_of:accepted.turn.attempt_of,error:accepted.turn.status==='failed'?{code:accepted.turn.error_code,retryable:accepted.turn.error_retryable}:null},duplicate:accepted.duplicate,telemetry:{state:lifecycleState,turn_id:accepted.turn.id,thread_id:threadId}});
  }));

  r.get('/threads/:id/turns',requireOwnership({db},{type:'thread',need:'owner'}),handle(async(req,res)=>{
    const threadId=param(req,'id');
    const legacyAfter=typeof req.query.after==='string'?req.query.after:null;
    if(legacyAfter&&Number.isNaN(Date.parse(legacyAfter)))throw new MobileError('invalid_reconciliation_cursor','Choose a valid reconciliation cursor.');
    if(legacyAfter)throw new MobileError('invalid_reconciliation_cursor','Timestamp cursors are not stable; use the returned opaque cursor.');
    const cursor=typeof req.query.cursor==='string'?req.query.cursor:null;
    const turnId=typeof req.query.turn_id==='string'?req.query.turn_id:null;
    const turns=await listDurableTurns(db,{ownerUserId:req.user!.id,threadId,cursor,turnId});
    res.set('Cache-Control','no-store');
    return res.json({turns:turns.map(t=>{const lifecycleState=mobileLifecycleState(t.status);return{id:t.id,job_id:t.id,status:t.status,lifecycle_state:lifecycleState,client_message_id:t.client_message_id,attempt_of:t.attempt_of,inbound_message_id:t.inbound_message_id,assistant_message_id:t.assistant_message_id,error:t.status==='failed'?{code:t.error_code,retryable:t.error_retryable}:null,telemetry:{state:lifecycleState,turn_id:t.id,thread_id:threadId},created_at:t.created_at,updated_at:t.updated_at};}),next_cursor:turns.length?encodeTurnCursor(turns[turns.length-1]):cursor});
  }));

  r.put('/devices',handle(async(req,res)=>{
    let key;try{key=ctx.masterKey===false?null:loadMasterKey(ctx.masterKey??{});}catch{key=null;}
    if(!key)throw new RouteError(503,'Push registration is unavailable because secure token storage is unavailable.');
    const device=await upsertMobileDevice(db,key,req.user!.id,{
      deviceIdentity:str(req.body?.device_identity,200),platform:req.body?.platform,
      expoToken:typeof req.body?.expo_token==='string'?req.body.expo_token:'',appState:req.body?.app_state,
      privacyLocked:req.body?.privacy_locked===true,categories:req.body?.categories,
      quietStart:str(req.body?.quiet_start,8)||null,quietEnd:str(req.body?.quiet_end,8)||null,
      timezone:str(req.body?.timezone,100)||'UTC',
    });
    return res.status(200).json({device:{id:device.id}});
  }));
  r.delete('/devices/:deviceId',handle(async(req,res)=>{
    if(!await revokeMobileDevice(db,req.user!.id,param(req,'deviceId')))throw new RouteError(404,'not found');
    return res.status(204).end();
  }));
  r.get('/devices',handle(async(req,res)=>res.json({devices:await db.query(`select id,device_identity,platform,app_state,privacy_locked,categories,quiet_start,quiet_end,timezone,revoked_at,last_seen_at from mobile_devices where owner_user_id=$1 order by last_seen_at desc`,[req.user!.id])})));

  /** One turn of conversation.
   *
   * `need: 'write'` — a thread shared read-only lets a colleague follow the
   * conversation, not speak into it as its owner. */
  r.post(
    '/threads/:id/talk',
    requireOwnership({ db }, { type: 'thread', need: 'write' }),
    handle(async (req, res) => {
      const threadId = param(req, 'id');
      const inbound = str(req.body?.message, 8000);
      if (Array.isArray(req.body?.attachmentIds) && req.body.attachmentIds.length > 10) throw new AttachmentError(413,'attachment_count','Attach no more than 10 files per message.');
      const attachmentIds = Array.isArray(req.body?.attachmentIds)
        ? req.body.attachmentIds.map((id: unknown) => str(id, 80)).filter(Boolean).slice(0, 10) : [];
      if (attachmentIds.some((id:string) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) throw new RouteError(400,'Choose valid, distinct attachments.');
      if (!inbound && !attachmentIds.length) throw new RouteError(400, 'say something or attach a file');

      const thread = await getThread(db, threadId);
      if (!thread) throw new RouteError(404, 'not found');

      // Parental Controls, asked about the PERSON TYPING rather than the
      // thread's owner. A managed child writing into a thread somebody shared
      // with them is still spending their own day; an adult answering in a
      // child's thread is not spending the child's. `runAssistantTurn` asks the
      // same question about the owner, which is what covers Telegram and the
      // other channels — this one exists so the web app gets a plain 403 and a
      // sentence rather than a refusal that reads like an outage.
      const childAccess = await checkChildAccess(db, { userId: req.user!.id });
      if (!childAccess.allowed) {
        throw new RouteError(403, childAccess.opensAgain
          ? `${childAccess.message} Josi is back at ${childAccess.opensAgain}.`
          : (childAccess.message ?? 'Josi is not available on this account right now.'));
      }

      // The turn runs as the THREAD'S OWNER, not as the caller. A colleague
      // with write access can continue the conversation; anything it creates
      // still belongs to the person whose thread it is, so a share cannot be
      // used to make Josi act under someone else's name.
      const history = (await listMessages(db, { threadId, limit: 40 })).map((m) => ({
        role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: historyContent(m),
      }));

      const attachments = attachmentIds.length ? await db.query<{
        id: string; filename: string; content_type: string; extracted_text: string | null; storage_path: string;
      }>(
        `select id, filename, content_type, extracted_text, storage_path from chat_attachments
         where id = any($1::uuid[]) and thread_id = $2 and owner_user_id = $3 and storage_state = 'ready'`,
        [attachmentIds, threadId, thread.owner_user_id],
      ) : [];
      if (attachments.length !== attachmentIds.length) throw new RouteError(404, 'one of those attachments is not available');

      if (attachments.length) {
        const pinned = await db.query(`update chat_attachments set referenced_at=coalesce(referenced_at,now())
          where id=any($1::uuid[]) and thread_id=$2 and owner_user_id=$3 and storage_state='ready' returning id`, [attachmentIds,threadId,thread.owner_user_id]);
        if (pinned.length !== attachments.length) throw new RouteError(404,'one of those attachments is no longer available');
      }

      // Whether THIS turn's model can actually be shown a picture. Read once,
      // up front, so every attachment this turn is judged against the same
      // answer rather than a stale one from an earlier probe run.
      const primaryProvider = await loadStoredProvider(db, 'primary');
      const primaryCapabilities = capabilitiesOf(primaryProvider);
      const hasVision = primaryCapabilities?.vision === true;

      const extensionOf = (filename: string): string => extname(filename).replace(/^\./, '').toLowerCase();
      const imageAttachments = attachments.filter((a) => IMAGE_MEDIA_TYPES[extensionOf(a.filename)]);
      const nonImageAttachments = attachments.filter((a) => !IMAGE_MEDIA_TYPES[extensionOf(a.filename)]);

      // Non-image attachments keep working exactly as before: their extracted
      // text (never run through OCR-as-description — that path is images
      // only) rides along as context in the message.
      const attachmentContext = nonImageAttachments.map((a) => a.extracted_text
        ? `Attached file ${a.filename}:\n${a.extracted_text}`
        : `Attached file ${a.filename} (${a.content_type}); no readable text was extracted.`).join('\n\n');

      // Image attachments are never described from pre-extracted text. Either
      // the bytes are read and handed to a model PROVEN to have vision, or
      // nothing about their content is claimed at all — the system prompt
      // (built inside `runAssistantTurn`) tells the model to say so honestly.
      let images: Array<{ mediaType: string; base64: string }> | undefined;
      if (imageAttachments.length && hasVision) {
        images = [];
        for (const a of imageAttachments) {
          try {
            const bytes = await readAttachment(a.id, uploadDir);
            images.push({ mediaType: IMAGE_MEDIA_TYPES[extensionOf(a.filename)], base64: bytes.toString('base64') });
          } catch (err) {
            // A file that vanished from disk between upload and this turn is
            // an infrastructure fault, not a reason to fail the whole turn —
            // it is simply not attached to the model call.
            throw attachmentFailure(err);
          }
        }
      }

      const modelInbound = [inbound, attachmentContext].filter(Boolean).join('\n\n');
      const attachmentMeta = attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type }));
      const inboundMessage=await addMessage(db,{threadId,direction:'in',body:inbound||'Sent an attachment',meta:{attachments:attachmentMeta}});
      const result = await runAssistantTurn({
        db,
        registry: registryOptions(ctx),
        userId: thread.owner_user_id,
        threadId,
        history,
        inbound: modelInbound,
        inboundMessageId: inboundMessage.id,
        images,
        recall: ctx.recall,
        connectorFetch: ctx.connectorFetch,
        customApiFetch: ctx.customApiFetch,
        outboundResolve: ctx.outboundResolve,
        channel: 'web',
        sessionKey: req.user!.session_id,
      });

      if (result.refusal) {
        // A refusal because somebody is outside their agreed hours is the
        // server saying no, not the server being broken. 503 would have it
        // read as an outage on the one screen where that would be a lie.
        return res.status(result.refusal.reason === 'restricted' ? 403 : 503)
          .json({ refusal: result.refusal });
      }

      const calendarReceipts = calendarContinuity(result.actions);
      const actionStatusDomain=result.actions.find(action=>action.tool==='assistant_action_state'&&action.result&&typeof action.result==='object')?.result as {domain?:unknown}|undefined;
      const outboundMeta:Record<string,unknown>={};
      if(result.mediaRequest)await db.query(
        `update messages set meta=meta || $2 where id=$1 and thread_id=$3`,
        [inboundMessage.id,json({media_request:result.mediaRequest}),threadId]);
      if(calendarReceipts.length)outboundMeta.calendar_receipts=calendarReceipts;
      if(actionStatusDomain?.domain==='email'||actionStatusDomain?.domain==='calendar')outboundMeta.action_status_domain=actionStatusDomain.domain;
      if(result.retry)outboundMeta.retry=result.retry;
      if(result.mediaResult)outboundMeta.media_result=result.mediaResult;
      const outboundMessage=await addMessage(db, { threadId, direction: 'out', body: result.reply,
        meta: Object.keys(outboundMeta).length ? outboundMeta : undefined });
      const presentedTaskIds=result.actions.map(action=>action.result).filter((value):value is {state:string;task_id:string}=>
        !!value&&typeof value==='object'&&['collecting','prepared'].includes(String((value as {state?:unknown}).state))&&typeof (value as {task_id?:unknown}).task_id==='string').map(value=>value.task_id);
      await markActionsPresented(db,{ownerUserId:thread.owner_user_id,threadId,taskIds:presentedTaskIds,messageId:outboundMessage.id});
      await appendEvent(db, { actorUserId: thread.owner_user_id, actor: 'user', kind: 'thread.exchange',
        subjectType: 'thread', subjectId: threadId,
        payload: { channel: 'web', inboundChars: inbound.length, attachmentCount: attachments.length, replyChars: result.reply.length } });
      return res.json({ reply: result.reply });
    }),
  );

  // ------------------------------------------------------------ tasks
  r.get(
    '/tasks',
    handle(async (req, res) =>
      res.json({
        tasks: await listTasksFor(db, {
          ownerUserId: req.user!.id,
          includeClosed: req.query.all === '1',
        }),
      })),
  );

  r.get('/task-types', handle(async (_req, res) => res.json({ types: await listTemplates(db) })));

  r.post(
    '/tasks',
    handle(async (req, res) => {
      const templateKey = str(req.body?.templateKey, 80);
      if (!templateKey) throw new RouteError(400, 'a task type is required');
      let template;
      try {
        template = await getTemplate(db, templateKey);
      } catch (err) {
        throw new RouteError(400, (err as Error).message);
      }
      const slots = (req.body?.slots ?? {}) as Record<string, unknown>;
      const task = await createTask(db, { ownerUserId: req.user!.id, templateKey, slots });
      return res.status(201).json({
        task,
        missingSlots: missingSlots(template.contract, task.slots),
        waitingOn: template.requiresCapability,
      });
    }),
  );

  r.get(
    '/tasks/:id',
    requireOwnership({ db }, { type: 'task', need: 'read' }),
    handle(async (req, res) => res.json({ task: await getTask(db, param(req, 'id')) })),
  );

  r.patch(
    '/tasks/:id',
    requireOwnership({ db }, { type: 'task', need: 'write' }),
    handle(async (req, res) => {
      const taskId = param(req, 'id');
      const slots = req.body?.slots as Record<string, unknown> | undefined;
      if (slots && typeof slots === 'object') {
        await setSlots(db, taskId, slots, { actor: 'user', actorUserId: req.user!.id });
      }
      const state = str(req.body?.state, 40) as TaskState | '';
      if (state) {
        if (state === 'ready') {
          const stepUp = await checkStepUp(db, { userId: req.user!.id, sessionKey: req.user!.session_id, action: 'approve_task' });
          if (!stepUp.allowed) throw new RouteError(401, stepUp.message ?? 'Confirm your password before approving this action.');
        }
        try {
          await transition(db, taskId, state, { actor: 'user', actorUserId: req.user!.id });
          if (state === 'ready') await enqueue(db, { kind: 'task.wake', payload: { taskId } });
        } catch (err) {
          // An illegal transition is the caller's mistake, not a server fault.
          throw new RouteError(409, (err as Error).message);
        }
      }
      return res.json({ task: await getTask(db, taskId) });
    }),
  );

  // ---------------------------------------------------------- reminders
  // The window into what the assistant scheduled (round-2 item 13). Same
  // owner-scoping as tasks: the queries resolve by owner_user_id, so knowing
  // another member's reminder id earns a 404, never a 403.
  r.get(
    '/reminders',
    handle(async (req, res) =>
      res.json(await reminderOverview(db, { ownerUserId: req.user!.id }))),
  );

  r.post(
    '/reminders/:id/cancel',
    handle(async (req, res) => {
      const cancelled = await cancelReminder(db, {
        ownerUserId: req.user!.id,
        reminderId: param(req, 'id'),
      });
      // Somebody else's, already settled, or never existed: one answer.
      if (!cancelled) throw new RouteError(404, 'not found');
      return res.json({ reminder: cancelled });
    }),
  );

  // -------------------------------------------------------- approvals
  r.get(
    '/approvals',
    handle(async (req, res) =>
      res.json({ approvals: await listPendingApprovals(db, req.user!.id) })),
  );

  r.post(
    '/approvals/:id/decide',
    handle(async (req, res) => {
      try {
        const {approval} = await decideActionApproval(db, {
          approvalId: param(req, 'id'),
          decidedBy: req.user!.id,
          approve: req.body?.approve === true,
        });
        return res.json({ approval });
      } catch (err) {
        // "Not yours" and "does not exist" answer the same way here too.
        throw new RouteError(404, 'not found');
      }
    }),
  );

  r.get(
    '/approval-levels/:actionClass',
    handle(async (req, res) =>
      res.json(await getApprovalLevel(db, {
        userId: req.user!.id,
        actionClass: param(req, 'actionClass'),
      }))),
  );

  r.put(
    '/approval-levels/:actionClass',
    handle(async (req, res) => {
      const level = str(req.body?.level, 20) as ApprovalLevel;
      if (!['always_ask', 'risky_only', 'automatic'].includes(level)) {
        throw new RouteError(400, 'choose always_ask, risky_only or automatic');
      }
      await setUserApprovalLevel(db, {
        userId: req.user!.id,
        actionClass: param(req, 'actionClass'),
        level,
      });
      // Returns the EFFECTIVE level, not the stored preference: if the admin's
      // ceiling is stricter, the person is told what will actually happen
      // rather than what they asked for.
      return res.json(await getApprovalLevel(db, {
        userId: req.user!.id, actionClass: param(req, 'actionClass'),
      }));
    }),
  );

  // --------------------------------------------------------- contacts
  r.get(
    '/contacts',
    handle(async (req, res) =>
      res.json({ contacts: await listContactsFor(db, { ownerUserId: req.user!.id }) })),
  );

  r.post(
    '/contacts',
    handle(async (req, res) => {
      const contact = await createContact(db, {
        ownerUserId: req.user!.id,
        name: str(req.body?.name, 200) || null,
        phone: str(req.body?.phone, 40) || null,
        email: str(req.body?.email, 320) || null,
      });
      return res.status(201).json({ contact });
    }),
  );

  r.get(
    '/contacts/:id',
    requireOwnership({ db }, { type: 'contact', need: 'read' }),
    handle(async (req, res) => {
      const rows = await db.query(`select * from contacts where id = $1`, [param(req, 'id')]);
      return res.json({ contact: rows[0] });
    }),
  );

  // ---------------------------------------------------------- metrics
  r.get(
    '/metrics',
    handle(async (req, res) =>
      res.json({ metrics: await taskMetrics(db, { ownerUserId: req.user!.id }) })),
  );

  return r;
}

// ------------------------------------------------------------------ admin

/** What the super admin may know about the assistant.
 *
 * Counts and health. No thread, no message, no task, no slot, no contact. The
 * test asserts the response contains none of a member's content, because the
 * comment above is not a control. */
export function adminAssistantRoutes(ctx: AssistantRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  r.get(
    '/',
    asyncRoute(async (_req, res) => {
      const [counts] = await db.query<{
        threads: string; messages: string; tasks: string; open_tasks: string; contacts: string;
      }>(
        `select
           (select count(*) from threads)::text as threads,
           (select count(*) from messages)::text as messages,
           (select count(*) from tasks)::text as tasks,
           (select count(*) from tasks where state not in ('closed','confirmed','cancelled','failed'))::text as open_tasks,
           (select count(*) from contacts)::text as contacts`,
      );
      const perUser = await db.query(
        `select u.id as user_id, u.username,
                count(distinct t.id)::int as tasks,
                count(distinct th.id)::int as threads
         from users u
         left join tasks t on t.owner_user_id = u.id
         left join threads th on th.owner_user_id = u.id
         group by u.id, u.username order by u.username`,
      );
      return res.json({
        counts: {
          threads: Number(counts.threads), messages: Number(counts.messages),
          tasks: Number(counts.tasks), openTasks: Number(counts.open_tasks),
          contacts: Number(counts.contacts),
        },
        perUser,
        // Installation-wide health: rates over state transitions, which say
        // nothing about what any task was about.
        metrics: await taskMetrics(db),
      });
    }),
  );

  /** The deny-only ceiling. M33: an admin may force a stricter approval level
   * and may never loosen one a user chose. The enforcement is
   * `effectiveApprovalLevel`, not this route — but this is where the value the
   * function reads gets set. */
  r.put(
    '/approval-policy/:actionClass',
    asyncRoute(async (req, res) => {
      const maxLevel = typeof req.body?.maxLevel === 'string' ? req.body.maxLevel : '';
      if (!['always_ask', 'risky_only', 'automatic'].includes(maxLevel)) {
        return res.status(400).json({ error: 'choose always_ask, risky_only or automatic' });
      }
      const { setAdminApprovalCeiling, ApprovalError } = await import('@josi-ce/core');
      try {
        const result = await setAdminApprovalCeiling(db, {
          actorUserId: req.user!.id,
          actionClass: param(req, 'actionClass'),
          maxLevel: maxLevel as ApprovalLevel,
          // Loosening is refused unless the client says it means to. The client
          // cannot set this by accident: the admin page asks, and a direct API
          // caller has to state it.
          confirmRelaxation: req.body?.confirmRelaxation === true,
        });
        return res.json({
          actionClass: param(req, 'actionClass'),
          maxLevel,
          previousMaxLevel: result.previous,
          relaxed: result.relaxed,
        });
      } catch (err) {
        if (err instanceof ApprovalError) return res.status(409).json({ error: err.message });
        throw err;
      }
    }),
  );

  /** The classes an administrator can set a ceiling for, with what each one is
   * currently set to and what a fresh installation would use.
   *
   * Served rather than hardcoded in the client so a class added to the server
   * appears in the admin page without a matching front-end change — the failure
   * mode being a class that exists, is enforced, and is invisible to configure. */
  r.get(
    '/approval-policy',
    asyncRoute(async (_req, res) => {
      const { ACTION_CLASSES, DEFAULT_ADMIN_CEILING, pendingPolicyMigration } = await import('@josi-ce/core');
      const rows = await db.query<{ action_class: string; max_level: ApprovalLevel }>(
        `select action_class, max_level from admin_approval_policy`,
      );
      const set = new Map(rows.map((row) => [row.action_class, row.max_level]));
      return res.json({
        defaultCeiling: DEFAULT_ADMIN_CEILING,
        classes: ACTION_CLASSES.map((c) => ({
          key: c.key,
          label: c.label,
          description: c.description,
          impact: c.impact,
          factoryCeiling: c.factoryCeiling,
          maxLevel: set.get(c.key) ?? DEFAULT_ADMIN_CEILING,
          explicit: set.has(c.key),
        })),
        // What migration 0016 changed and nobody has acknowledged yet.
        migration: await pendingPolicyMigration(db),
      });
    }),
  );

  r.post(
    '/approval-policy/acknowledge-migration',
    asyncRoute(async (req, res) => {
      const { acknowledgePolicyMigration } = await import('@josi-ce/core');
      return res.json({ acknowledged: await acknowledgePolicyMigration(db, req.user!.id) });
    }),
  );

  return r;
}
