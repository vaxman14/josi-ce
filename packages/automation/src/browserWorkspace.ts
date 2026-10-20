import { isDeepStrictEqual } from 'node:util';

export type BrowserFamily = 'chrome' | 'brave' | 'firefox' | 'safari';
export interface BrowserWorkspaceSession {
  sessionId: string; workspaceId: string; profileId: string; family: BrowserFamily;
  isolatedWorkspace: true; origins: string[]; expiresAt: number;
}
interface BrowserCommandBase { id: string; sessionId: string; profileId: string; expiresAt: number }
export type BrowserWorkspaceCommand = BrowserCommandBase & (
  { kind: 'tabs' }
  | { kind: 'navigate'; tabId: number; url: string }
  | { kind: 'observe'; tabId: number }
  | { kind: 'click'; tabId: number; observationId: string; elementId: string }
  | { kind: 'fill'; tabId: number; observationId: string; elementId: string; valueReference: string }
);
export interface BrowserActualTarget { tabId: number; windowId: number; url: string }
export type BrowserWorkspaceResult =
  | { outcome: 'observed_or_issued'; commandId: string; data: unknown; untrustedContent: true; verificationRequired: true }
  | { outcome: 'denied' | 'uncertain'; commandId: string; code: string; verificationRequired: true };
export interface BrowserWorkspacePorts<Peer> {
  /** The native transport supplies the real peer, outside the request JSON.
   * Verify installed extension identity, signed host and actual isolated guest/
   * browser process/profile. An extension's family/profile claims are not proof. */
  authenticatePeer(peer: Peer, session: Readonly<BrowserWorkspaceSession>): Promise<boolean>;
  /** Resolve current device consent, Vault epoch and the authenticated channel.
   * Can renew expiry, but cannot change the session/profile/origin scope. */
  currentSession(): Promise<BrowserWorkspaceSession | null>;
  /** Recheck this exact command, real target, policy and one-use reservation.
   * Mark durable dispatch BEFORE returning. A lost response is then uncertain.
   * Fill values are short-lived Vault projections, never command/log fields. */
  authorize(command: Readonly<BrowserWorkspaceCommand>, actual: BrowserActualTarget | null,
    signal: AbortSignal): Promise<{ allowed: true; valueReference?: string; value?: string } | null>;
  /** Invalidate the device-control lease and queued input on a local takeover
   * or interrupted/uncertain exchange. This is not a remote grant operation. */
  stop(reason: 'local_takeover' | 'connection_lost' | 'uncertain'): void;
}
interface Request {
  version: 1; requestId: string; sessionId: string | null;
  operation: 'browser.hello' | 'browser.poll' | 'browser.authorize' | 'browser.receipt' | 'browser.stop';
  payload: Record<string, unknown>;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]) => object(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
function webUrl(value: unknown): URL | null {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function bounded(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 192 * 1024; } catch { return false; }
}
function validSession(s: BrowserWorkspaceSession): boolean {
  return exact(s, ['sessionId', 'workspaceId', 'profileId', 'family', 'isolatedWorkspace', 'origins', 'expiresAt'])
    && [s.sessionId, s.workspaceId, s.profileId].every(uuid) && ['chrome', 'brave', 'firefox', 'safari'].includes(s.family)
    && s.isolatedWorkspace === true && integer(s.expiresAt) && s.expiresAt > Date.now() && s.expiresAt <= Date.now() + 60_000
    && Array.isArray(s.origins) && s.origins.length > 0 && s.origins.length <= 128
    && s.origins.every(origin => webUrl(origin)?.origin === origin) && new Set(s.origins).size === s.origins.length;
}
function parseRequest(value: unknown): Request | null {
  if (!exact(value, ['version', 'requestId', 'operation', 'sessionId', 'payload']) || !bounded(value)) return null;
  const r = value as unknown as Request;
  return r.version === 1 && uuid(r.requestId) && (r.sessionId === null || uuid(r.sessionId)) && object(r.payload)
    && ['browser.hello', 'browser.poll', 'browser.authorize', 'browser.receipt', 'browser.stop'].includes(r.operation) ? r : null;
}
function validCommand(c: BrowserWorkspaceCommand, s: BrowserWorkspaceSession): boolean {
  if (!object(c) || !uuid(c.id) || c.sessionId !== s.sessionId || c.profileId !== s.profileId
    || !integer(c.expiresAt) || c.expiresAt <= Date.now() || c.expiresAt > s.expiresAt) return false;
  const keys = ['id', 'sessionId', 'profileId', 'expiresAt', 'kind'];
  if (c.kind === 'tabs') return exact(c, keys);
  keys.push('tabId');
  if (!integer(c.tabId)) return false;
  if (c.kind === 'observe') return exact(c, keys);
  if (c.kind === 'navigate') return exact(c, [...keys, 'url']) && s.origins.includes(webUrl(c.url)?.origin ?? '');
  if (c.kind === 'click' || c.kind === 'fill') return exact(c, [...keys, 'observationId', 'elementId', ...(c.kind === 'fill' ? ['valueReference'] : [])])
    && uuid(c.observationId) && uuid(c.elementId) && (c.kind !== 'fill' || uuid(c.valueReference));
  return false;
}

/** One volatile rendezvous per enrolled, isolated browser session. No listener,
 * enrollment, policy, or execution authority is created here. The device host
 * owns dispatch; only the authenticated native transport may call handle.
 * There is one in-flight command, no automatic retry and no disk persistence. */
export function createBrowserWorkspaceBridge<Peer>(initial: BrowserWorkspaceSession, ports: BrowserWorkspacePorts<Peer>) {
  if (!validSession(initial) || ['authenticatePeer', 'currentSession', 'authorize', 'stop'].some(k => typeof ports[k as keyof BrowserWorkspacePorts<Peer>] !== 'function')) {
    throw new Error('An isolated browser session and verified native boundary are required.');
  }
  let session = structuredClone(initial), connected = false, closed = false, handling = false;
  let lastWall = Date.now(), lastMono = performance.now();
  let leaseMono = lastMono + session.expiresAt - lastWall;
  const requests = new Set<string>(), commands = new Set<string>();
  type Flight = {
    command: BrowserWorkspaceCommand; controller: AbortController; delivered: boolean; authorized: boolean; authorizing: boolean;
    timer: ReturnType<typeof setTimeout>; resolve: (result: BrowserWorkspaceResult) => void; removeAbort: () => void;
  };
  let flight: Flight | null = null;
  function settle(result: BrowserWorkspaceResult) {
    const active = flight; if (!active) return;
    flight = null; clearTimeout(active.timer); active.removeAbort(); active.controller.abort(); active.resolve(result);
  }
  function stop(reason: 'local_takeover' | 'connection_lost' | 'uncertain' = 'connection_lost') {
    if (closed) return;
    closed = true; connected = false;
    if (flight) settle({ outcome: flight.delivered ? 'uncertain' : 'denied', commandId: flight.command.id,
      code: reason, verificationRequired: true });
    ports.stop(reason);
  }
  function live() {
    const wall = Date.now(), mono = performance.now();
    if (closed || wall < lastWall || mono < lastMono || wall >= session.expiresAt || mono >= leaseMono) {
      stop(); throw new Error('session_unavailable');
    }
    lastWall = wall; lastMono = mono;
  }
  async function refresh() {
    live();
    const current = await ports.currentSession();
    live();
    if (!current || !validSession(current) || !isDeepStrictEqual({ ...current, expiresAt: 0 }, { ...session, expiresAt: 0 })
      || current.expiresAt < session.expiresAt) { stop(); throw new Error('authority_changed'); }
    if (current.expiresAt > session.expiresAt) {
      session = structuredClone(current); leaseMono = performance.now() + current.expiresAt - Date.now();
    }
  }
  function acceptableResult(command: BrowserWorkspaceCommand, value: unknown): boolean {
    if (!object(value) || !bounded(value)) return false;
    if (command.kind === 'tabs') return value.kind === 'tabs' && Array.isArray(value.tabs) && value.tabs.length <= 128
      && value.tabs.every(tab => object(tab) && integer(tab.tabId) && integer(tab.windowId) && typeof tab.title === 'string'
        && tab.title.length <= 200 && (tab.url === 'about:blank' || session.origins.includes(webUrl(tab.url)?.origin ?? '')));
    if (command.kind === 'observe') return value.kind === 'observation' && uuid(value.observationId)
      && integer(value.revision) && typeof value.text === 'string' && value.text.length <= 20_000
      && session.origins.includes(webUrl(value.url)?.origin ?? '') && Array.isArray(value.elements) && value.elements.length <= 300
      && value.elements.every(element => object(element) && uuid(element.id));
    return value.kind === (command.kind === 'navigate' ? 'navigation_issued' : 'input_issued') && value.verificationRequired === true;
  }
  return Object.freeze({
    stop,
    state: () => ({ connected: connected && !closed, busy: !!flight, closed, profileId: session.profileId }),
    /** Trusted device-gate adapter only; never expose this method as renderer,
     * web page or native-message IPC. authorize still rechecks before input. */
    dispatch(command: BrowserWorkspaceCommand, signal: AbortSignal): Promise<BrowserWorkspaceResult> {
      live();
      if (!connected || flight || signal.aborted || commands.size >= 4096 || !validCommand(command, session) || commands.has(command.id)) {
        return Promise.resolve({ outcome: 'denied', commandId: command.id, code: 'unavailable_or_invalid', verificationRequired: true });
      }
      commands.add(command.id);
      return new Promise(resolve => {
        const cancelled = () => stop('uncertain');
        const timer = setTimeout(cancelled, Math.max(1, command.expiresAt - Date.now())); timer.unref();
        flight = { command: structuredClone(command), controller: new AbortController(), delivered: false, authorized: false, authorizing: false,
          timer, resolve, removeAbort: () => signal.removeEventListener('abort', cancelled) };
        signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) cancelled();
      });
    },
    async handle(peer: Peer, input: unknown): Promise<unknown> {
      const request = parseRequest(input);
      if (!request) return { version: 1, requestId: null, ok: false, code: 'invalid_request' };
      const reply = (payload: unknown) => ({ version: 1, requestId: request.requestId, ok: true, payload });
      // Concurrent native hosts may be spawned by the browser. Refuse overlap
      // without dropping the active command. A local stop can always interrupt.
      if (handling && request.operation !== 'browser.stop') return { version: 1, requestId: request.requestId, ok: false, code: 'busy' };
      const ownsHandling = !handling; if (ownsHandling) handling = true;
      try {
        live();
        if (requests.size >= 16384 || requests.has(request.requestId)) throw new Error('replay');
        requests.add(request.requestId);
        if (await ports.authenticatePeer(peer, structuredClone(session)) !== true) throw new Error('invalid_peer');
        live();
        if (request.operation === 'browser.stop') {
          if (request.sessionId !== session.sessionId || !exact(request.payload, ['reason']) || request.payload.reason !== 'local_takeover') throw new Error('invalid_stop');
          stop('local_takeover'); return reply({ stopped: true });
        }
        await refresh();
        if (request.operation === 'browser.hello') {
          if (request.sessionId !== null || connected || !exact(request.payload, ['family', 'extensionId']) || request.payload.family !== session.family
            || typeof request.payload.extensionId !== 'string' || request.payload.extensionId.length > 128) throw new Error('invalid_hello');
          connected = true; return reply(structuredClone(session));
        }
        if (!connected || request.sessionId !== session.sessionId) throw new Error('session_changed');
        if (request.operation === 'browser.poll') {
          if (!exact(request.payload, [])) throw new Error('invalid_poll');
          const command = flight && !flight.delivered ? structuredClone(flight.command) : null;
          if (command && flight) flight.delivered = true;
          return reply({ session: structuredClone(session), command });
        }
        if (request.operation === 'browser.authorize') {
          const active = flight;
          if (!active || !active.delivered || active.authorized || active.authorizing || !exact(request.payload, ['command', 'actual'])
            || !isDeepStrictEqual(request.payload.command, active.command)) throw new Error('command_changed');
          const actual = request.payload.actual;
          if (active.command.kind === 'tabs' ? actual !== null
            : !exact(actual, ['tabId', 'windowId', 'url']) || !object(actual) || !integer(actual.tabId) || !integer(actual.windowId)
              || actual.tabId !== active.command.tabId || !(actual.url === 'about:blank' || session.origins.includes(webUrl(actual.url)?.origin ?? ''))) throw new Error('target_changed');
          active.authorizing = true;
          const authorization = await ports.authorize(structuredClone(active.command), actual as BrowserActualTarget | null, active.controller.signal);
          live();
          if (flight !== active || active.controller.signal.aborted || Date.now() >= active.command.expiresAt || authorization?.allowed !== true) throw new Error('authorization_refused');
          if (active.command.kind === 'fill' && (authorization.valueReference !== active.command.valueReference
            || typeof authorization.value !== 'string' || authorization.value.length > 16384)) throw new Error('value_unavailable');
          active.authorized = true;
          return reply({ commandId: active.command.id, sessionId: session.sessionId, allowed: true,
            ...(active.command.kind === 'fill' ? { valueReference: authorization.valueReference, value: authorization.value } : {}) });
        }
        if (request.operation === 'browser.receipt') {
          const active = flight;
          if (!active || !active.delivered || request.payload.commandId !== active.command.id) throw new Error('receipt_changed');
          if (request.payload.outcome !== 'observed_or_issued' || !active.authorized || !acceptableResult(active.command, request.payload.result)) {
            stop('uncertain'); return reply({ recorded: true, verificationRequired: true });
          }
          settle({ outcome: 'observed_or_issued', commandId: active.command.id, data: structuredClone(request.payload.result),
            untrustedContent: true, verificationRequired: true });
          return reply({ recorded: true, verificationRequired: true });
        }
        throw new Error('unsupported_operation');
      } catch {
        // Authorization may already have marked durable dispatch. Do not leave
        // it eligible to be resubmitted after a failed native-message response.
        if (flight?.authorizing) stop('uncertain');
        return { version: 1, requestId: request.requestId, ok: false, code: 'unavailable_or_denied' };
      } finally { if (ownsHandling) handling = false; }
    },
  });
}
