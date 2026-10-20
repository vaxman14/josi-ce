import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Db } from '@josi-ce/core';

/** Owner-only invalidation stream. It transmits no goal text or credentials.
 * Clients refetch the durable projection after a change or reconnect; they
 * never infer completion from a stream event or a model token. */
export function workProgressStream(db: Db) {
  const clients = new Map<string, number>();
  let total = 0;
  return async (req: Request, res: Response): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: 'Sign in to follow your work.' }); return; }
    const owner = req.user.id, session = req.user.session_id;
    const thread = typeof req.query.threadId === 'string' ? req.query.threadId : null;
    const includeEnded = req.query.all === '1';
    const endedOnly = req.query.ended === '1';
    if (thread && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(thread)) {
      res.status(400).json({ error: 'Choose an existing conversation.' }); return;
    }
    if (total >= 128 || (clients.get(owner) ?? 0) >= 4) {
      res.set('Retry-After', '15'); res.status(429).json({ error: 'Progress will refresh without a live connection.' }); return;
    }
    clients.set(owner, (clients.get(owner) ?? 0) + 1); total++;
    let closed = false, timer: ReturnType<typeof setTimeout> | null = null;
    let digest: string | null = null, lastSent = 0;
    const deadline = performance.now() + 20 * 60_000;
    const close = () => {
      if (closed) return;
      closed = true; if (timer) clearTimeout(timer);
      const remaining = (clients.get(owner) ?? 1) - 1;
      if (remaining) clients.set(owner, remaining); else clients.delete(owner);
      total--; res.end();
    };
    res.on('close', close); res.on('error', close);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders(); res.write('retry: 5000\n\n');
    const send = (event: string, data: unknown) => {
      if (closed) return;
      // Do not accumulate work for a slow/disconnected viewer.
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) close();
      lastSent = performance.now();
    };
    const update = async () => {
      if (closed) return;
      try {
        // A session cookie checked only when opening an SSE connection would
        // continue leaking activity after logout or account suspension.
        const [valid] = await db.query(`select 1 from sessions s join users u on u.id=s.user_id
          where s.id=$1 and s.user_id=$2 and s.revoked_at is null and s.expires_at>now() and u.status='active'`, [session, owner]);
        if (closed) return;
        if (!valid) { send('access-ended', {}); close(); return; }
        const rows = await db.query<{ id: string; revision: number }>(`select id,revision from work_goals where owner_user_id=$1
          ${thread ? 'and thread_id=$2' : ''} ${endedOnly ? "and state in ('completed','cancelled')" : includeEnded ? '' : "and state not in ('completed','cancelled')"}
          order by (state in ('completed','cancelled')),updated_at desc,id desc limit 100`, [owner, ...(thread ? [thread] : [])]);
        if (closed) return;
        const next = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        if (next !== digest) { digest = next; send('progress', { revision: next }); }
        else if (performance.now() - lastSent >= 12_000) send('heartbeat', {});
        if (performance.now() >= deadline) { close(); return; }
      } catch {
        // No database errors, source text or credentials in stream payloads.
        send('unavailable', {}); close(); return;
      }
      if (!closed) { timer = setTimeout(() => void update(), 2000); timer.unref(); }
    };
    await update();
  };
}
