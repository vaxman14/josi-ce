// Reaching a person's server from here: as a tunnel peer through the relay, with
// the hosted static key, one hello and one answer. The server pinned that key
// when it was linked and refuses it otherwise, so this side can ask for only what
// the server's `special` handler chooses to answer.
import { TunnelClient, TunnelError, fromB64url, type Hello, type HostedHello } from '@josi-ce/tunnel';
import type { Ctx } from './context.js';

export interface ServerAddress { site: string; noise_public: string }

/** Throws a TunnelError if the server is offline or says no. A server that
 * answers `{ok:false}` comes back as that error's code. */
export async function askServer(ctx: Ctx, server: ServerAddress, hello: HostedHello): Promise<Record<string, unknown>> {
  const url = `${ctx.config.relayUrl.replace(/^http/, 'ws')}/v1/sites/${server.site}/peer`;
  const transport = await ctx.peerTransport(url);
  // TunnelClient's hello type covers device hellos. The handshake doesn't care.
  try {
    const client = await TunnelClient.connect({ transport, key: ctx.noiseKey, serverPublic: fromB64url(server.noise_public), hello: hello as unknown as Hello });
    const reply = client.welcome as unknown as Record<string, unknown>;
    client.close();
    return reply;
  } catch (error) {
    transport.close();
    throw error;
  }
}

export const isOffline = (error: unknown): boolean => error instanceof TunnelError && ['offline', 'unreachable', 'timeout', 'closed'].includes(error.code);
