// A WebSocket as a tunnel transport. Works anywhere there's a global WebSocket:
// browsers, service workers, Node 22 and later.
import type { Transport } from './client.js';
import { TunnelError } from './client.js';

/** The relay's own status lines arrive as text. They aren't authenticated, so
 * they only ever make a client give up sooner; they can't make it trust
 * anything. Noise frames are always binary. */
interface Status { type?: string; error?: string }

export function webSocketTransport(url: string, opts: { relay: boolean; timeoutMs?: number }): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { socket.close(); reject(new TunnelError('timeout', 'Could not reach that address.')); }, opts.timeoutMs ?? 10_000);
    let settled = false;
    const transport: Transport = {
      onMessage: null,
      onClose: null,
      send: data => socket.send(data as Uint8Array<ArrayBuffer>),
      close: () => socket.close(),
    };
    const ready = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(transport); };
    const fail = (error: TunnelError) => { if (settled) { transport.onClose?.(error.message); return; } settled = true; clearTimeout(timer); reject(error); };
    socket.onopen = () => { if (!opts.relay) ready(); };
    socket.onerror = () => fail(new TunnelError('unreachable', 'Could not reach that address.'));
    socket.onclose = event => {
      if (settled) transport.onClose?.(event.reason || 'closed');
      else fail(new TunnelError('unreachable', event.reason || 'Could not reach that address.'));
    };
    socket.onmessage = event => {
      if (typeof event.data === 'string') {
        let status: Status = {};
        try { status = JSON.parse(event.data) as Status; } catch { return; }
        if (status.type === 'server-online') ready();
        else if (status.type === 'server-offline') { fail(new TunnelError('offline', 'Your Josi server is not connected right now.')); socket.close(); }
        return;
      }
      transport.onMessage?.(new Uint8Array(event.data as ArrayBuffer));
    };
  });
}
