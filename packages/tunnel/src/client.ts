// A device's end of the tunnel: the handshake, then HTTP over the mux. It knows
// nothing about how bytes get to the server, so the same class runs over the
// relay and over the LAN listener.
import { fromB64url, toB64url } from './bytes.js';
import { Frame, decodeFrame, encodeFrame, jsonFrame, jsonPayload, pieces, type RequestHead, type ResponseHead } from './mux.js';
import { Handshake, Session, generateKeyPair, staticKeyFrom, type StaticKey } from './noise.js';
import { decodeJson, encodeJson, type Control, type Hello, type RotationNotice, type Welcome } from './protocol.js';

/** One connection, already open. Binary messages only. */
export interface Transport {
  send(data: Uint8Array): void;
  close(): void;
  onMessage: ((data: Uint8Array) => void) | null;
  onClose: ((reason: string) => void) | null;
}

export class TunnelError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

export interface TunnelResponse extends ResponseHead { body: ReadableStream<Uint8Array> }

interface Pending {
  resolve(response: TunnelResponse): void;
  reject(error: Error): void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

export class TunnelClient {
  private nextStream = 1;
  private readonly streams = new Map<number, Pending>();
  private closed = false;
  private rotation: { resolve(): void; reject(e: Error): void } | null = null;
  /** The server moved to a new key: remember it, and use it next time. */
  onServerRotation: ((notice: RotationNotice) => void) | null = null;
  onRevoked: (() => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  private constructor(private readonly transport: Transport, private readonly session: Session, readonly welcome: Extract<Welcome, { ok: true }>) {
    transport.onMessage = data => this.receive(data);
    transport.onClose = reason => this.shutdown(reason);
  }

  /** Runs the handshake. A refusal from the server throws with its reason. */
  static async connect(args: { transport: Transport; key: StaticKey; serverPublic: Uint8Array; hello: Hello }): Promise<TunnelClient> {
    const { transport } = args;
    const handshake = new Handshake(true, args.key, args.serverPublic);
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => { transport.close(); reject(new TunnelError('timeout', 'The server did not answer.')); }, HANDSHAKE_TIMEOUT_MS);
      transport.onMessage = data => { clearTimeout(timer); resolve(data); };
      transport.onClose = reason => { clearTimeout(timer); reject(new TunnelError('closed', reason)); };
    });
    transport.send(await handshake.writeFirst(encodeJson(args.hello)));
    const welcome = decodeJson<Welcome>(await handshake.readSecond(await reply));
    if (!welcome.ok) { transport.close(); throw new TunnelError(welcome.error); }
    const client = new TunnelClient(transport, Session.from(handshake).framed(), welcome);
    if (welcome.rotate) queueMicrotask(() => client.onServerRotation?.(welcome.rotate!));
    return client;
  }

  /** Sends one request. The promise settles when the response head arrives. */
  async request(head: RequestHead, body?: Uint8Array | ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<TunnelResponse> {
    if (this.closed) throw new TunnelError('closed', 'The tunnel is closed.');
    const stream = this.nextStream++;
    const response = new Promise<TunnelResponse>((resolve, reject) => this.streams.set(stream, { resolve, reject }));
    signal?.addEventListener('abort', () => this.cancel(stream), { once: true });
    this.write(jsonFrame(Frame.ReqHead, stream, head));
    if (body instanceof Uint8Array) {
      for (const piece of pieces(body)) this.write(encodeFrame(Frame.ReqBody, stream, piece));
    } else if (body) {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const piece of pieces(value)) this.write(encodeFrame(Frame.ReqBody, stream, piece));
      }
    }
    this.write(encodeFrame(Frame.ReqEnd, stream));
    return response;
  }

  /** Replaces this device's key. The server keeps the old one a few minutes so
   * a lost reply can't strand the device. */
  rotateDeviceKey(publicKey: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rotation = { resolve, reject };
      this.write(jsonFrame(Frame.Control, 0, { t: 'rotate-device', publicKey: toB64url(publicKey) } satisfies Control));
    });
  }

  ping(): void { if (!this.closed) this.write(encodeFrame(Frame.Ping, 0)); }

  close(): void { this.transport.close(); this.shutdown('closed'); }

  get isClosed(): boolean { return this.closed; }

  private cancel(stream: number): void {
    const pending = this.streams.get(stream);
    if (!pending) return;
    this.streams.delete(stream);
    if (!this.closed) this.write(encodeFrame(Frame.Reset, stream));
    const error = new TunnelError('aborted', 'The request was cancelled.');
    pending.reject(error);
    try { pending.controller?.error(error); } catch { /* already finished */ }
  }

  private write(frame: Uint8Array): void { this.transport.send(this.session.seal(frame)); }

  private receive(data: Uint8Array): void {
    let frame;
    // A frame that fails authentication means the path is being tampered with.
    // Nothing after it can be trusted, so the whole session ends.
    try { frame = decodeFrame(this.session.open(data)); } catch { this.transport.close(); this.shutdown('tampered'); return; }
    const pending = this.streams.get(frame.stream);
    switch (frame.type) {
      case Frame.ResHead: {
        if (!pending) return;
        const head = jsonPayload<ResponseHead>(frame);
        const body = new ReadableStream<Uint8Array>({
          start: controller => { pending.controller = controller; },
          cancel: () => this.cancel(frame.stream),
        });
        pending.resolve({ ...head, body });
        return;
      }
      case Frame.ResBody: try { pending?.controller?.enqueue(frame.payload.slice()); } catch { /* reader gone */ } return;
      case Frame.ResEnd:
        this.streams.delete(frame.stream);
        try { pending?.controller?.close(); } catch { /* reader gone */ }
        return;
      case Frame.Reset: {
        this.streams.delete(frame.stream);
        const error = new TunnelError('reset', 'The server ended this request.');
        pending?.reject(error);
        try { pending?.controller?.error(error); } catch { /* reader gone */ }
        return;
      }
      case Frame.Control: this.control(jsonPayload<Control>(frame)); return;
      case Frame.Ping: this.write(encodeFrame(Frame.Pong, 0)); return;
      default:
    }
  }

  private control(message: Control): void {
    if (message.t === 'rotate-device-ok') { this.rotation?.resolve(); this.rotation = null; }
    else if (message.t === 'rotate-device-refused') { this.rotation?.reject(new TunnelError(message.error)); this.rotation = null; }
    else if (message.t === 'rotate-server') this.onServerRotation?.({ publicKey: message.publicKey, until: message.until });
    else if (message.t === 'revoked') { this.onRevoked?.(); this.close(); }
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new TunnelError('closed', reason);
    for (const pending of this.streams.values()) {
      pending.reject(error);
      try { pending.controller?.error(error); } catch { /* reader gone */ }
    }
    this.streams.clear();
    this.rotation?.reject(error);
    this.onClose?.(reason);
  }
}

/** A fresh device key pair, for callers that keep raw keys (Node, tests). */
export function newDeviceKey(): { privateKey: Uint8Array; key: StaticKey } {
  const { privateKey } = generateKeyPair();
  return { privateKey, key: staticKeyFrom(privateKey) };
}

export { fromB64url, toB64url };
