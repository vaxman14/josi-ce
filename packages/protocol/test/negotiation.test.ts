import { describe, expect, it } from 'vitest';
import { BASELINE_CAPABILITIES, hasCapability, negotiateCapabilities, parseCapabilities } from '../src/index.js';

describe('CE capability negotiation', () => {
  it('preserves ordinary remote features without advertising unimplemented executors', () => {
    const result = negotiateCapabilities(200, BASELINE_CAPABILITIES);
    expect(hasCapability(result, 'chat.durable-turns')).toBe(true);
    expect(hasCapability(result, 'tasks.poll')).toBe(true);
    expect(hasCapability(result, 'automation.browser')).toBe(false);
    expect(hasCapability(result, 'automation.desktop')).toBe(false);
    expect(hasCapability(result, 'cardinal-rules')).toBe(false);
  });
  it('keeps old-server compatibility separate from missing authentication or transport', () => {
    for (const code of [404, 405]) expect(negotiateCapabilities(code, null)).toEqual({ status: 'legacy', capabilities: [] });
    for (const code of [401, 403]) expect(negotiateCapabilities(code, null)).toEqual({ status: 'unavailable', reason: 'authentication' });
    for (const code of [null, 302, 429, 500]) expect(negotiateCapabilities(code, null)).toEqual({ status: 'unavailable', reason: 'transport' });
    expect(negotiateCapabilities(200, '<html>login</html>')).toEqual({ status: 'unavailable', reason: 'invalid_response' });
  });
  it('does not invent compatibility or inherit stale capabilities on reconnect', () => {
    expect(negotiateCapabilities(200, { ...BASELINE_CAPABILITIES, protocolVersions: [2] })).toEqual({ status: 'unavailable', reason: 'incompatible' });
    const server = { ...BASELINE_CAPABILITIES, capabilities: [...BASELINE_CAPABILITIES.capabilities,
      { id: 'automation.browser', version: 1 }, { id: 'future.feature', version: 1 }] };
    expect(hasCapability(negotiateCapabilities(200, server), 'automation.browser')).toBe(false);
    const client = [{ id: 'automation.browser', version: 1 }];
    expect(hasCapability(negotiateCapabilities(200, server, client), 'automation.browser')).toBe(true);
    expect(hasCapability(negotiateCapabilities(null, null, client), 'automation.browser')).toBe(false);
    expect(hasCapability(negotiateCapabilities(200, server, [{ id: 'automation.browser', version: 2 }]), 'automation.browser')).toBe(false);
  });
  it('rejects malformed and ambiguous advertisements', () => {
    for (const body of [null, [], {}, { ...BASELINE_CAPABILITIES, product: 'other' },
      { ...BASELINE_CAPABILITIES, protocolVersions: [1, 1] },
      { ...BASELINE_CAPABILITIES, protocolVersions: ['1'] },
      { ...BASELINE_CAPABILITIES, capabilities: [{ id: 'chat.messages', version: true }] },
      { ...BASELINE_CAPABILITIES, capabilities: [{ id: 'chat.messages', version: 1 }, { id: 'chat.messages', version: 2 }] },
      { ...BASELINE_CAPABILITIES, capabilities: [{ id: 'chat.messages', version: NaN }] },
    ]) expect(parseCapabilities(body)).toBeNull();
  });
  it('returns a detached projection rather than a mutable input reference', () => {
    const body = structuredClone(BASELINE_CAPABILITIES);
    const parsed = parseCapabilities(body)!;
    body.protocolVersions[0] = 99;
    body.capabilities[0].version = 99;
    expect(parsed.protocolVersions).toEqual([1]);
    expect(parsed.capabilities[0].version).toBe(1);
  });
});
