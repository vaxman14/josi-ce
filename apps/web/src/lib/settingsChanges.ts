// Settings changes Josi prepared in conversation (apps/api/src/http/settingsChangeRoutes.ts),
// the web twin of Windows' Notifications.CheckSettingsChanges and
// AppModel.ApplySettingsChange. One poll feeds every card in the chat: PC
// permissions, credential cards and every other proposal. A proposal that
// comes back approved with an `apply` for this person is performed here, with
// this person's session, and reported to /applied, exactly as Windows does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export type CardField = { key: string; label: string; type: 'text' | 'secret' | 'confirm'; help?: string; required?: boolean; placeholder?: string };
export type CredentialCardSpec = { kind: string; provider: string; title: string; intro: string; fields: CardField[]; help: { text: string; url: string | null }; done: string };
export type ApplyRequest = { method: string; path: string; body: unknown };
export type Proposal = {
  id: string; threadId: string | null; proposer: string; mine: boolean; scope: 'personal' | 'administrator'; area: string; sensitive: boolean;
  title: string; summary: string; state: string; createdAt: string; expiresAt: string; canApprove: boolean; canDeny: boolean;
  apply: ApplyRequest | null; card?: CredentialCardSpec | null;
};

export const isPcProposal = (p: Proposal) => p.area.startsWith('pc_control_');
export const isCredentialProposal = (p: Proposal) => p.area === 'credential_card';
/** Every other area, member connector requests included. */
export const isSettingsProposal = (p: Proposal) => !isPcProposal(p) && !isCredentialProposal(p);

/** Waiting on this person: something to approve, or (for an ordinary
 * setting) an approved change that needs their password to go live. */
export function waitingOnMe(p: Proposal, needsPassword: readonly string[]): boolean {
  if (isPcProposal(p)) return p.state === 'proposed' && p.canApprove;
  if (isCredentialProposal(p)) return p.state === 'proposed' && p.canApprove && !!p.card;
  return (p.state === 'proposed' && p.canApprove) || (p.state === 'approved' && !!p.apply && needsPassword.includes(p.id));
}

/** Whether this chat shows the card: its own proposals, plus someone else's
 * that wait on this person (a member's request reaching the owner). */
export function belongsHere(p: Proposal, threadId: string, needsPassword: readonly string[]): boolean {
  return p.threadId === threadId || (!p.mine && isSettingsProposal(p)) || needsPassword.includes(p.id);
}

const errorText = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;
const objectBody = (body: unknown): Record<string, unknown> => body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};

async function perform(method: string, path: string, body: unknown): Promise<unknown> {
  const verb = method.toUpperCase();
  if (verb === 'DELETE') return api.del(path);
  if (verb === 'GET') return api.get(path);
  if (verb === 'PUT') return api.put(path, body ?? {});
  if (verb === 'PATCH') return api.patch(path, body ?? {});
  return api.post(path, body ?? {});
}

// Proposals this page has started applying, so the poll and a card never
// perform the same change twice; and the ones waiting on a password.
const claimed = new Set<string>();
const askingPassword = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Mark a proposal as applied from here. False when something else already is. */
export function claimApply(id: string): boolean {
  if (claimed.has(id)) return false;
  claimed.add(id);
  return true;
}
export function releaseApply(id: string): void { claimed.delete(id); }

export type ApplyOutcome = { ok: true } | { ok: false; error: string } | { password: true };

/** Performs an approved change the way AppModel.ApplySettingsChange does: the
 * route with the stored body; when the route asks for the account password,
 * once more with it (and, if still refused, after a step-up); then reports
 * the outcome. With no password to hand it stops and says so instead,
 * reporting nothing, so the card can ask. */
export async function applyChange(id: string, apply: ApplyRequest, password?: string): Promise<ApplyOutcome> {
  const body = apply.body ?? {};
  let error: string | null = null;
  try {
    await perform(apply.method, apply.path, body);
  } catch (e) {
    const wantsPassword = e instanceof ApiError && e.status === 401 && /password/i.test(e.message);
    if (!wantsPassword) error = errorText(e, 'The change could not be applied.');
    else if (password === undefined) {
      askingPassword.add(id); changed();
      return { password: true };
    } else {
      try {
        await perform(apply.method, apply.path, { password, ...objectBody(body) });
      } catch (again) {
        if (!(again instanceof ApiError && again.status === 401)) error = errorText(again, 'The change could not be applied.');
        else {
          try {
            await api.post('/assistant/step-up', { password });
            await perform(apply.method, apply.path, body);
          } catch (last) { error = errorText(last, 'The change could not be applied.'); }
        }
      }
    }
  }
  askingPassword.delete(id); changed();
  await api.post(`/settings-changes/${id}/applied`, error === null ? { ok: true } : { ok: false, error }).catch(() => undefined);
  return error === null ? { ok: true } : { ok: false, error };
}

/** The proposal list for an open conversation. Polls while the thread is open
 * and right away whenever `poke` changes (pass the latest reply), so a card
 * Josi just opened shows within a second. */
export function useSettingsChanges(threadId: string | undefined, poke: unknown) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [needsPassword, setNeedsPassword] = useState<string[]>(() => [...askingPassword]);
  const pending = useRef(false), alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const listener = () => { if (alive.current) setNeedsPassword([...askingPassword]); };
    listeners.add(listener);
    return () => { alive.current = false; listeners.delete(listener); };
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current || document.hidden) return;
    pending.current = true;
    try {
      const result = await api.get<{ proposals: Proposal[] }>('/settings-changes');
      if (!alive.current) return;
      setProposals(result.proposals);
      // Approved for this person's app, by them elsewhere or by the
      // administrator for them: make it live now (Windows: CheckSettingsChanges).
      for (const p of result.proposals) {
        if (p.state !== 'approved' || !p.apply || !isSettingsProposal(p) || !claimApply(p.id)) continue;
        void applyChange(p.id, p.apply);
      }
    } catch { /* the next poll tries again */ }
    finally { pending.current = false; }
  }, []);

  useEffect(() => {
    if (!threadId) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [threadId, refresh]);

  // Right after each reply lands.
  useEffect(() => { if (threadId) void refresh(); }, [poke, threadId, refresh]);

  return { proposals, needsPassword, refresh };
}
