export const PROTOCOL_VERSION = 1 as const;

/** Advertise only implemented capabilities. A contract's existence is not support. */
export const CAPABILITY_IDS = [
  'chat.messages', 'chat.durable-turns', 'tasks.poll', 'notifications.devices',
  'goals.events', 'work-memory', 'automation.devices', 'automation.browser',
  'automation.desktop', 'automation.watch', 'cardinal-rules',
] as const;
export type CapabilityId = typeof CAPABILITY_IDS[number];
export interface Capability { id: string; version: number }
export interface Capabilities {
  product: 'josi-ce';
  protocolVersions: number[];
  capabilities: Capability[];
}
export const BASELINE_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  product: 'josi-ce',
  protocolVersions: [PROTOCOL_VERSION],
  capabilities: [
    { id: 'chat.messages', version: 1 },
    { id: 'chat.durable-turns', version: 1 },
    { id: 'tasks.poll', version: 1 },
    { id: 'notifications.devices', version: 1 },
  ],
});

export type Negotiation =
  | { status: 'ready'; version: 1; capabilities: Capability[] }
  | { status: 'legacy'; capabilities: [] }
  | { status: 'unavailable'; reason: 'authentication' | 'transport' | 'invalid_response' | 'incompatible' };

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 65535;

/** Unknown well-formed future capabilities can be ignored; malformed authority
 * is never repaired, coerced, or treated as a legacy server. */
export function parseCapabilities(input: unknown): Capabilities | null {
  if (!object(input) || input.product !== 'josi-ce') return null;
  if (!Array.isArray(input.protocolVersions) || input.protocolVersions.length < 1 || input.protocolVersions.length > 16
    || !input.protocolVersions.every(version) || new Set(input.protocolVersions).size !== input.protocolVersions.length) return null;
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 64) return null;
  const ids = new Set<string>();
  const capabilities: Capability[] = [];
  for (const candidate of input.capabilities) {
    if (!object(candidate) || typeof candidate.id !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(candidate.id)
      || !version(candidate.version) || ids.has(candidate.id)) return null;
    ids.add(candidate.id);
    capabilities.push({ id: candidate.id, version: candidate.version });
  }
  return { product: 'josi-ce', protocolVersions: [...input.protocolVersions], capabilities };
}

/** Re-negotiate on every connection. Callers must clear prior capabilities before
 * this request; an unavailable server never retains yesterday's executor. */
export function negotiateCapabilities(httpStatus: number | null, body: unknown,
  client: ReadonlyArray<Capability> = BASELINE_CAPABILITIES.capabilities): Negotiation {
  if (httpStatus === 404 || httpStatus === 405) return { status: 'legacy', capabilities: [] };
  if (httpStatus === 401 || httpStatus === 403) return { status: 'unavailable', reason: 'authentication' };
  if (httpStatus !== 200) return { status: 'unavailable', reason: 'transport' };
  const server = parseCapabilities(body);
  if (!server) return { status: 'unavailable', reason: 'invalid_response' };
  if (!server.protocolVersions.includes(PROTOCOL_VERSION)) return { status: 'unavailable', reason: 'incompatible' };
  const known = new Set<string>(CAPABILITY_IDS);
  const offered = new Map(client.filter(c => known.has(c.id) && version(c.version)).map(c => [c.id, c.version]));
  return { status: 'ready', version: PROTOCOL_VERSION,
    capabilities: server.capabilities.filter(c => offered.get(c.id) === c.version && known.has(c.id)) };
}

export function hasCapability(connection: Negotiation, id: CapabilityId, version = 1): boolean {
  return connection.status === 'ready' && connection.capabilities.some(c => c.id === id && c.version === version);
}
