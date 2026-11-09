// The server's end of the tunnel. One `TunnelHost` takes peers from any path
// (the relay link, the LAN listener) and treats them alike: nothing a path says
// about a peer is believed, only what the Noise handshake proves.
import { fromB64url, toB64url } from './bytes.js';
import { Frame, decodeFrame, encodeFrame, jsonFrame, jsonPayload, type RequestHead } from './mux.js';
import { Handshake, Session, type StaticKey } from './noise.js';
import { HELLO_SKEW_MS, decodeJson, encodeJson, type Control, type Hello, type Welcome } from './protocol.js';

export interface Peer {
  send(data: Uint8Array): void;
  close(reason?: string): void;
  /** Bytes queued on the path. Responses pause above a limit. */
  buffered?(): number;
}

/** Who a finished handshake turned out to be. */
export interface Authorized { device: string; client: string; welcome: Extract<Welcome, { ok: true }> }

export interface HostPolicy {
  /** Current key first, then the previous one during a rotation's overlap. */
  keys(): StaticKey[];
  /** Decides a hello. `keyIndex` says which static key the device reached. */
  authorize(hello: Hello, remotePublic: Uint8Array, keyIndex: number): Promise<Authorized | Extract<Welcome, { ok: false }>>;
  /** Callers who aren't devices (the hosted Google handoff). Answer with a
   * reply, or null if this hello isn't for you. One round trip, then closed. */
  special?(hello: Record<string, unknown>, remotePublic: Uint8Array): Promise<Record<string, unknown> | null>;
  onRequest(call: IncomingCall): void;
  onRotateDevice?(device: string, oldKey: Uint8Array, newKey: Uint8Array): Promise<void>;
  onSeen?(device: string): void;
}

export interface IncomingCall {
  device: string;
  client: string;
  head: RequestHead;
  /** Body pieces as they arrive. Ends at null. */
  onBody: ((piece: Uint8Array | null) => void) | null;
  onCancel: (() => void) | null;
  respond(status: number, headers: Array<[string, string]>): void;
  write(piece: Uint8Array): Promise<void>;
  end(): void;
  reset(): void;
}

interface Live {
  peer: Peer;
  session: Session | null;
  device: string | null;
  client: string;
  remote: Uint8Array | null;
  calls: Map<number, IncomingCall>;
  /** A handshake is async; frames that land meanwhile wait their turn. */
  backlog: Uint8Array[];
  shaking: boolean;
}

const HIGH_WATER = 4 * 1024 * 1024;

export class TunnelHost {
  private readonly peers = new Map<string, Live>();

  constructor(private readonly policy: HostPolicy) {}

  open(id: string, peer: Peer): void {
    this.peers.get(id)?.peer.close('replaced');
    this.peers.set(id, { peer, session: null, device: null, client: '', remote: null, calls: new Map(), backlog: [], shaking: false });
  }

  data(id: string, bytes: Uint8Array): void {
    const live = this.peers.get(id);
    if (!live) return;
    if (live.shaking) { if (live.backlog.length < 256) live.backlog.push(bytes); return; }
    if (live.session) { this.frame(id, live, bytes); return; }
    live.shaking = true;
    void this.handshake(id, live, bytes).finally(() => {
      live.shaking = false;
      for (const queued of live.backlog.splice(0)) this.data(id, queued);
    });
  }

  gone(id: string): void {
    const live = this.peers.get(id);
    if (!live) return;
    this.peers.delete(id);
    for (const call of live.calls.values()) call.onCancel?.();
    live.calls.clear();
  }

  /** Ends every connection of a revoked device, now, and tells it why. */
  disconnectDevice(device: string): number {
    let count = 0;
    for (const [id, live] of this.peers) {
      if (live.device !== device) continue;
      count++;
      try { this.write(live, jsonFrame(Frame.Control, 0, { t: 'revoked' } satisfies Control)); } catch { /* going anyway */ }
      live.peer.close('revoked');
      this.gone(id);
    }
    return count;
  }

  /** Every connected device hears about a new server key. */
  announceRotation(publicKey: Uint8Array, until: string | null): void {
    const message = { t: 'rotate-server', publicKey: toB64url(publicKey), until } satisfies Control;
    for (const live of this.peers.values()) if (live.session && live.device) this.write(live, jsonFrame(Frame.Control, 0, message));
  }

  /** Drops every session. A key destroyed at once must not keep working. */
  disconnectAll(): void {
    for (const [id, live] of this.peers) { live.peer.close('rekeyed'); this.gone(id); }
  }

  connected(): string[] {
    return [...new Set([...this.peers.values()].flatMap(live => live.device ? [live.device] : []))];
  }

  private async handshake(id: string, live: Live, message: Uint8Array): Promise<void> {
    const keys = this.policy.keys();
    let handshake: Handshake | null = null, payload: Uint8Array | null = null, keyIndex = -1;
    // An IK first message only opens under the static key it was sealed to.
    for (let i = 0; i < keys.length && !handshake; i++) {
      const attempt = new Handshake(false, keys[i]);
      try { payload = await attempt.readFirst(message); handshake = attempt; keyIndex = i; } catch { /* try the previous key */ }
    }
    if (!handshake || !payload) { live.peer.close('bad handshake'); this.gone(id); return; }
    const remote = handshake.remoteStatic!;
    let hello: Hello & Record<string, unknown>;
    try { hello = decodeJson(payload); } catch { live.peer.close('bad hello'); this.gone(id); return; }

    let reply: Welcome | Record<string, unknown>;
    let authorized: Authorized | null = null;
    if (Math.abs(Date.now() - Number(hello.ts)) > HELLO_SKEW_MS) reply = { ok: false, error: 'stale' };
    else if (hello.op === 'connect' || hello.op === 'pair') {
      const verdict = await this.policy.authorize(hello, remote, keyIndex).catch(() => ({ ok: false, error: 'busy' }) as const);
      if ('device' in verdict) { authorized = verdict; reply = verdict.welcome; } else reply = verdict;
    } else {
      const answer = await this.policy.special?.(hello, remote).catch(() => null);
      reply = answer ?? { ok: false, error: 'unknown_device' };
    }

    live.peer.send(await handshake.writeSecond(encodeJson(reply)));
    if (!authorized) { live.peer.close('refused'); this.gone(id); return; }
    live.session = Session.from(handshake).framed();
    live.device = authorized.device;
    live.client = authorized.client;
    live.remote = remote;
    this.policy.onSeen?.(authorized.device);
  }

  private write(live: Live, frame: Uint8Array): void { live.peer.send(live.session!.seal(frame)); }

  private frame(id: string, live: Live, data: Uint8Array): void {
    let frame;
    try { frame = decodeFrame(live.session!.open(data)); } catch { live.peer.close('tampered'); this.gone(id); return; }
    const call = live.calls.get(frame.stream);
    switch (frame.type) {
      case Frame.ReqHead:
        if (!call) this.begin(live, frame.stream, jsonPayload<RequestHead>(frame));
        return;
      case Frame.ReqBody: call?.onBody?.(frame.payload.slice()); return;
      case Frame.ReqEnd: call?.onBody?.(null); return;
      case Frame.Reset: live.calls.delete(frame.stream); call?.onCancel?.(); return;
      case Frame.Ping: this.write(live, encodeFrame(Frame.Pong, 0)); return;
      case Frame.Control: void this.control(live, jsonPayload<Control>(frame)); return;
      default:
    }
  }

  private begin(live: Live, stream: number, head: RequestHead): void {
    const finish = () => { live.calls.delete(stream); };
    const call: IncomingCall = {
      device: live.device!, client: live.client, head, onBody: null, onCancel: null,
      respond: (status, headers) => this.write(live, jsonFrame(Frame.ResHead, stream, { status, headers })),
      write: async piece => {
        this.write(live, encodeFrame(Frame.ResBody, stream, piece));
        while ((live.peer.buffered?.() ?? 0) > HIGH_WATER && live.calls.has(stream)) await new Promise(resolve => setTimeout(resolve, 20));
      },
      end: () => { finish(); this.write(live, encodeFrame(Frame.ResEnd, stream)); },
      reset: () => { finish(); this.write(live, encodeFrame(Frame.Reset, stream)); },
    };
    live.calls.set(stream, call);
    this.policy.onRequest(call);
  }

  private async control(live: Live, message: Control): Promise<void> {
    if (message.t !== 'rotate-device' || !live.device || !live.remote) return;
    const refuse = (error: string) => this.write(live, jsonFrame(Frame.Control, 0, { t: 'rotate-device-refused', error } satisfies Control));
    if (!this.policy.onRotateDevice) { refuse('unsupported'); return; }
    try {
      const next = fromB64url(message.publicKey);
      if (next.length !== 32) { refuse('bad_key'); return; }
      await this.policy.onRotateDevice(live.device, live.remote, next);
      live.remote = next;
      this.write(live, jsonFrame(Frame.Control, 0, { t: 'rotate-device-ok' } satisfies Control));
    } catch { refuse('failed'); }
  }
}
