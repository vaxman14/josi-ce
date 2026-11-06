// Just enough of the Workers runtime to run services/relay/src/index.js in a
// test: Durable Objects with storage and the hibernation socket calls, and
// WebSocketPair. Everything that crosses a socket is recorded, which is how the
// suites prove what the relay did and didn't get to see.
export class FakeSocket {
  peer!: FakeSocket;
  tags: string[] = [];
  attachment: unknown = null;
  closed = false;
  owner: FakeDurable | null = null;
  onmessage: ((data: string | ArrayBuffer) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.closed) return;
    const copy = typeof data === 'string' ? data : (data instanceof ArrayBuffer ? data.slice(0) : data.slice().buffer);
    queueMicrotask(() => this.peer.deliver(copy as string | ArrayBuffer));
  }
  deliver(data: string | ArrayBuffer): void {
    if (this.closed) return;
    if (this.owner) void (this.owner.instance as { webSocketMessage(ws: FakeSocket, m: string | ArrayBuffer): Promise<void> }).webSocketMessage(this, data);
    else this.onmessage?.(data);
  }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.owner?.sockets.delete(this);
    queueMicrotask(() => this.peer.closedByPeer(code, reason));
  }
  closedByPeer(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.owner?.sockets.delete(this);
    if (this.owner) void (this.owner.instance as { webSocketClose(ws: FakeSocket, c: number): Promise<void> }).webSocketClose(this, code);
    else this.onclose?.(code, reason);
  }
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}

class Storage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get(key: string) { return this.data.get(key); }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { this.data.delete(key); }
  async deleteAll() { this.data.clear(); }
  async setAlarm(at: number) { this.alarm = at; }
}

export class FakeDurable {
  sockets = new Set<FakeSocket>();
  storage = new Storage();
  instance!: { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> };
  ctx = {
    storage: this.storage,
    acceptWebSocket: (ws: FakeSocket, tags: string[]) => { ws.tags = tags; ws.owner = this; this.sockets.add(ws); },
    getWebSockets: (tag?: string) => [...this.sockets].filter(ws => !tag || ws.tags.includes(tag)),
    getTags: (ws: FakeSocket) => ws.tags,
    waitUntil: (_p: Promise<unknown>) => undefined,
  };
}

type DurableClass = new (ctx: FakeDurable['ctx'], env: Record<string, unknown>) => FakeDurable['instance'];

class Namespace {
  objects = new Map<string, FakeDurable>();
  constructor(private readonly type: DurableClass, private readonly env: Record<string, unknown>) {}
  idFromName(name: string) { return name; }
  get(id: string) {
    let object = this.objects.get(id);
    if (!object) {
      object = new FakeDurable();
      object.instance = new this.type(object.ctx, this.env);
      this.objects.set(id, object);
    }
    const instance = object.instance;
    return { fetch: (input: string | Request, init?: RequestInit) => instance.fetch(input instanceof Request ? input : new Request(input, init)) };
  }
}

/** A Response that can carry status 101 and a socket, as Workers' does. */
class WorkerResponse extends Response {
  webSocket?: FakeSocket;
  private override_?: number;
  constructor(body: BodyInit | null, init?: ResponseInit & { webSocket?: FakeSocket }) {
    const status = init?.status === 101 ? 200 : init?.status;
    super(body, { ...init, status });
    if (init?.status === 101) this.override_ = 101;
    this.webSocket = init?.webSocket;
  }
  get status() { return this.override_ ?? super.status; }
}

export interface FakeRelayOptions { env?: Record<string, unknown> }

export async function fakeRelay(opts: FakeRelayOptions = {}) {
  const realResponse = globalThis.Response;
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    0: FakeSocket; 1: FakeSocket;
    constructor() { const a = new FakeSocket(), b = new FakeSocket(); a.peer = b; b.peer = a; this[0] = a; this[1] = b; }
  };
  (globalThis as unknown as { Response: unknown }).Response = WorkerResponse;
  // @ts-expect-error plain JavaScript Worker
  const relay = await import('../../../services/relay/src/index.js');
  const env: Record<string, unknown> = { PUBLIC_DOMAIN: 'heyjosi.test', ALLOW_TEST_HOST: '1', ...opts.env };
  env.SITES = new Namespace(relay.Site, env);
  env.LIMITS = new Namespace(relay.Limit, env);
  env.INVITES = new Namespace(relay.Invite, env);
  env.NAMES = new Namespace(relay.Name, env);
  /** Every binary frame in either direction, as the relay held it. */
  const seen: Uint8Array[] = [];
  return {
    relay, env, seen,
    restore() { globalThis.Response = realResponse; },
    fetch: (url: string, init?: RequestInit & { testHost?: string }) => {
      const headers = new Headers(init?.headers);
      if (init?.testHost) headers.set('x-josi-test-host', init.testHost);
      return relay.default.fetch(new Request(url, { ...init, headers }), env) as Promise<Response & { webSocket?: FakeSocket }>;
    },
    /** Opens a WebSocket route and returns the far end. */
    async connect(url: string, init?: { headers?: Record<string, string>; testHost?: string }) {
      const headers = new Headers(init?.headers);
      headers.set('Upgrade', 'websocket');
      if (init?.testHost) headers.set('x-josi-test-host', init.testHost);
      const res = await relay.default.fetch(new Request(url, { headers }), env) as Response & { webSocket?: FakeSocket };
      if (res.status !== 101 || !res.webSocket) throw new Error(`relay answered ${res.status}: ${await res.text()}`);
      const socket = res.webSocket;
      const send = socket.send.bind(socket);
      socket.send = data => { if (typeof data !== 'string') seen.push(new Uint8Array(data instanceof ArrayBuffer ? data : data.slice())); send(data); };
      return socket;
    },
  };
}
