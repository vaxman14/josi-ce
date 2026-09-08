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
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  addMessage, appendEvent, createContact, createTask, createThread, decideApproval,
  getTask, getTemplate, getThread, listContactsFor, listMessages, listPendingApprovals,
  listTasksFor, listTemplates, listThreadsFor, missingSlots, resolveAccess, setSlots,
  setUserApprovalLevel, getApprovalLevel, taskMetrics, transition, verifyStepUp,
  canWrite, checkStepUp, enqueue, recordExchange, reminderOverview, cancelReminder,
  checkChildAccess,
  type ApprovalLevel, type Db, type TaskState,
} from '@josi-ce/core';
import { verifyPassword } from '@josi-ce/auth';
import { runAssistantTurn, type RecallLookup } from '@josi-ce/agent';
import type { LoadOptions } from '@josi-ce/core';
import { loadMasterKey } from '@josi-ce/core';
import { capabilitiesOf, loadStoredProvider } from '@josi-ce/llm';
import {
  IMAGE_MEDIA_TYPES, extractRichSegments, isExtractableExtension, looksLikeCredentialFile,
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
  /** HTTP for administrator-defined custom APIs the assistant may call.
   * Injected by tests; unset in production. */
  customApiFetch?: typeof fetch;
  /** HTTP for external MCP servers the person connected. Injected by tests;
   * unset in production. */
  mcpFetch?: typeof fetch;
  /** DNS for those calls, injected by the tests. Unset in production, where
   * the host's own resolver is used and re-consulted on every request. */
  outboundResolve?: (hostname: string) => Promise<string[]>;
  recall?: RecallLookup;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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

export function assistantRoutes(ctx: AssistantRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);
  const uploadDir = process.env.JOSI_UPLOAD_DIR ?? (process.env.NODE_ENV === 'test' ? join(tmpdir(), 'josi-chat-attachments') : '/data/chat-attachments');
  const receive = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    asyncRoute(async (req: Request, res: Response) => {
      try {
        return await fn(req, res);
      } catch (err: unknown) {
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
      const sessionKey = str(req.body?.sessionKey, 200) || req.user!.session_id;
      const result = await verifyStepUp(db, {
        userId: req.user!.id,
        sessionKey,
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

  r.post('/threads/:id/attachments', requireOwnership({ db }, { type: 'thread', need: 'write' }), receive.single('file'),
    handle(async (req, res) => {
      if (!req.file) throw new RouteError(400, 'choose a file first');
      const filename = req.file.originalname.slice(0, 240);
      if (looksLikeCredentialFile(filename, req.file.mimetype.startsWith('text/') ? req.file.buffer.toString('utf8') : '')) {
        throw new RouteError(400, 'That looks like a password, key, token, or recovery-code file. Josi will not upload it.');
      }
      const extension = extname(filename).replace(/^\./, '').toLowerCase();
      if (!isExtractableExtension(extension)) {
        throw new RouteError(400, 'Josi cannot read that file type yet. Choose an image, PDF, Office document, or text file.');
      }
      const [usage] = await db.query<{ bytes: number }>(
        `select coalesce(sum(byte_size), 0)::bigint as bytes from chat_attachments where owner_user_id = $1`,
        [req.user!.id],
      );
      if (Number(usage?.bytes ?? 0) + req.file.size > 200 * 1024 * 1024) {
        throw new RouteError(413, 'Your chat attachments have reached the 200 MB limit. Remove old conversations before uploading more.');
      }
      // Images deliberately get `ocrImages` left at its default (false) here:
      // this is the chat composer's attach button, not the document-ingestion
      // pipeline. An attached photo is not run through OCR and stamped into
      // `extracted_text` as if recognized text were a description of the
      // picture — that was the bug (a portrait producing "AW BR Ge / SADIE /
      // HAGA"). `extracted_text` stays null for an image; the /talk route
      // decides at question time whether the model can actually see it.
      const segments = await extractRichSegments({ extension, bytes: req.file.buffer }).catch(() => null);
      const id = randomUUID(); const storagePath = join(uploadDir, id);
      mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
      await import('node:fs/promises').then((fs) => fs.writeFile(storagePath, req.file!.buffer, { mode: 0o600 }));
      await db.query(
        `insert into chat_attachments (id, owner_user_id, thread_id, filename, content_type, byte_size, storage_path, extracted_text)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, req.user!.id, param(req, 'id'), filename, req.file.mimetype || 'application/octet-stream', req.file.size,
          storagePath, segments?.map((s) => s.content).join('\n').slice(0, 100_000) || null],
      );
      return res.status(201).json({ attachment: { id, filename, contentType: req.file.mimetype, byteSize: req.file.size } });
    }));

  r.get('/attachments/:attachmentId', handle(async (req, res) => {
    const [attachment] = await db.query<{ filename: string; content_type: string; storage_path: string }>(
      `select filename, content_type, storage_path from chat_attachments where id = $1 and owner_user_id = $2`,
      [param(req, 'attachmentId'), req.user!.id],
    );
    if (!attachment) throw new RouteError(404, 'not found');
    res.type(attachment.content_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    return res.sendFile(attachment.storage_path, { dotfiles: 'deny' });
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
        messages: await listMessages(db, { threadId }),
      });
    }),
  );

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
      const attachmentIds = Array.isArray(req.body?.attachmentIds)
        ? req.body.attachmentIds.map((id: unknown) => str(id, 80)).filter(Boolean).slice(0, 10) : [];
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
        content: m.body,
      }));

      const attachments = attachmentIds.length ? await db.query<{
        id: string; filename: string; content_type: string; extracted_text: string | null; storage_path: string;
      }>(
        `select id, filename, content_type, extracted_text, storage_path from chat_attachments
         where id = any($1::uuid[]) and thread_id = $2 and owner_user_id = $3`,
        [attachmentIds, threadId, thread.owner_user_id],
      ) : [];
      if (attachments.length !== attachmentIds.length) throw new RouteError(404, 'one of those attachments is not available');

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
        const fs = await import('node:fs/promises');
        images = [];
        for (const a of imageAttachments) {
          try {
            const bytes = await fs.readFile(a.storage_path);
            images.push({ mediaType: IMAGE_MEDIA_TYPES[extensionOf(a.filename)], base64: bytes.toString('base64') });
          } catch (err) {
            // A file that vanished from disk between upload and this turn is
            // an infrastructure fault, not a reason to fail the whole turn —
            // it is simply not attached to the model call.
            console.error('could not read chat attachment bytes', (err as Error).message);
          }
        }
      }

      const modelInbound = [inbound, attachmentContext].filter(Boolean).join('\n\n');
      const attachmentMeta = attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type }));
      const result = await runAssistantTurn({
        db,
        registry: registryOptions(ctx),
        userId: thread.owner_user_id,
        threadId,
        history,
        inbound: modelInbound,
        images,
        recall: ctx.recall,
        connectorFetch: ctx.connectorFetch,
        customApiFetch: ctx.customApiFetch,
        mcpFetch: ctx.mcpFetch,
        outboundResolve: ctx.outboundResolve,
        channel: 'web',
        sessionKey: req.user!.session_id,
      });

      if (result.refusal) {
        // Recorded as an inbound message so the conversation is not silently
        // missing what the person said, but no reply is fabricated.
        await addMessage(db, { threadId, direction: 'in', body: inbound || 'Sent an attachment', meta: { attachments: attachmentMeta } });
        // A refusal because somebody is outside their agreed hours is the
        // server saying no, not the server being broken. 503 would have it
        // read as an outage on the one screen where that would be a lie.
        return res.status(result.refusal.reason === 'restricted' ? 403 : 503)
          .json({ refusal: result.refusal, actions: result.actions });
      }

      await addMessage(db, { threadId, direction: 'in', body: inbound || 'Sent an attachment', meta: { attachments: attachmentMeta } });
      await addMessage(db, { threadId, direction: 'out', body: result.reply });
      await appendEvent(db, { actorUserId: thread.owner_user_id, actor: 'user', kind: 'thread.exchange',
        subjectType: 'thread', subjectId: threadId,
        payload: { channel: 'web', inboundChars: inbound.length, attachmentCount: attachments.length, replyChars: result.reply.length } });
      return res.json({ reply: result.reply, actions: result.actions });
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
        const approval = await decideApproval(db, {
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
