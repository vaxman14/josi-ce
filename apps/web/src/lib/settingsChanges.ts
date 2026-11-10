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
/** "Sign in for Josi" cards (docs/LIVE_SIGN_IN.md). */
export const isSignInProposal = (p: Proposal) => p.area === 'sign_in_card';
/** Every other area, member connector requests included. */
export const isSettingsProposal = (p: Proposal) => !isPcProposal(p) && !isCredentialProposal(p) && !isSignInProposal(p);

export type SignInCardSpec = {
  kind: 'sign_in'; mode: 'browser' | 'terminal'; pcId: string; title: string; intro: string;
  url: string | null; command: string | null; runAs: string | null; done: string;
};
export function signInCard(p: Proposal): SignInCardSpec | null {
  const card = p.card as unknown as Partial<SignInCardSpec> | null | undefined;
  return p.area === 'sign_in_card' && card && card.kind === 'sign_in' && (card.mode === 'browser' || card.mode === 'terminal') ? card as SignInCardSpec : null;
}
/** A credential card with nothing to type: one button that signs in at the provider. */
export function accountConnectionProvider(p: Proposal): string | null {
  const card = p.card as unknown as { kind?: string; provider?: string } | null | undefined;
  return isCredentialProposal(p) && card?.kind === 'account_connection' && typeof card.provider === 'string' ? card.provider : null;
}

/** Waiting on this person: something to approve, or (for an ordinary
 * setting) an approved change that needs their password to go live. */
export function waitingOnMe(p: Proposal, needsPassword: readonly string[]): boolean {
  if (isPcProposal(p)) return p.state === 'proposed' && p.canApprove;
  if (isCredentialProposal(p)) return p.state === 'proposed' && p.canApprove && !!p.card;
  if (isSignInProposal(p)) return p.state === 'proposed' && p.canApprove && !!signInCard(p);
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

// A web sign-in at a provider leaves this page and comes back to /app, so the
// card that started it is remembered across the redirect and reported then.
const ACCOUNT_RETURN_KEY = 'josi_account_card';
export function rememberAccountCard(id: string, provider: string): void {
  try { sessionStorage.setItem(ACCOUNT_RETURN_KEY, JSON.stringify({ id, provider, at: Date.now() })); } catch { /* the card then stays open */ }
}
let finishingAccount = false;
/** Called when the app opens: if a provider sign-in this card started has just
 * come back, say how it went to /applied (Windows: AwaitConnection). */
export async function finishAccountCard(): Promise<void> {
  if (finishingAccount) return;
  let saved: { id: string; provider: string; at: number } | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(ACCOUNT_RETURN_KEY) ?? 'null'); } catch { saved = null; }
  if (!saved || typeof saved.id !== 'string' || typeof saved.provider !== 'string') return;
  finishingAccount = true;
  try {
    const query = new URLSearchParams(window.location.search);
    const refused = query.get('error');
    let error: string | null = null;
    if (refused) error = refused === 'declined' ? 'You cancelled at the provider, so nothing was connected.' : 'The sign-in could not be completed.';
    else if (Date.now() - saved.at > 15 * 60_000) error = 'The sign-in was not finished in the browser. Start again.';
    else {
      const view = await api.get<{ providers: Array<{ provider: string; connection: { status: string } | null }> }>('/connections');
      const connected = view.providers.find((v) => v.provider === saved!.provider)?.connection?.status === 'active';
      if (!connected) error = 'The account does not look connected. Start again.';
    }
    await api.post(`/settings-changes/${saved.id}/applied`, error === null ? { ok: true } : { ok: false, error }).catch(() => undefined);
    sessionStorage.removeItem(ACCOUNT_RETURN_KEY);
    if (refused) { query.delete('error'); const rest = query.toString(); window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '')); }
  } catch { /* the next page load tries again */ }
  finally { finishingAccount = false; }
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

  useEffect(() => { void finishAccountCard(); }, []);

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
