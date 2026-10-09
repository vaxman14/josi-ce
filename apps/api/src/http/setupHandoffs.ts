import { createHash, randomBytes } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const SETUP_SESSION_COOKIE = 'josi_setup_session';
export const HANDOFF_TTL = 10 * 60_000;
export const SETUP_SESSION_TTL = 8 * 60 * 60_000;

/** Process-local capabilities. Restarting invalidates links and cookies, never
 * the persisted wizard answers. The Windows launcher can issue a fresh link. */
export class SetupHandoffs {
  private links = new Map<string, number>();
  private sessions = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  private prune(map: Map<string, number>) {
    for (const [key, expiry] of map) if (expiry <= this.now()) map.delete(key);
  }
  issue(): string {
    this.prune(this.links);
    if (this.links.size >= 32) throw new Error('too many pending setup links');
    const token = randomBytes(32).toString('hex');
    this.links.set(digest(token), this.now() + HANDOFF_TTL);
    return token;
  }
  consume(token: unknown): string | null {
    this.prune(this.links); this.prune(this.sessions);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
        || this.sessions.size >= 32 || !this.links.delete(digest(token))) return null;
    const session = randomBytes(32).toString('hex');
    this.sessions.set(digest(session), this.now() + SETUP_SESSION_TTL);
    return session;
  }
  authorized(session: string | undefined): boolean {
    this.prune(this.sessions);
    return !!session && /^[a-f0-9]{64}$/.test(session) && this.sessions.has(digest(session));
  }
  clear(): void { this.links.clear(); this.sessions.clear(); }
}
