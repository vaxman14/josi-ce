// The socket lookup that pins an outbound request to an address that passed
// the public-address check. Node 20 and later ask for a LIST of addresses
// (`all: true`); answering with a single address failed every real request to
// a Custom API, a workflow host and an MCP server with "Invalid IP address".
// The suites inject fetch, so only this test and a real request see it.
import { describe, expect, it } from 'vitest';
import { pinnedLookup } from '../src/customApiRequest.js';

describe('the pinned lookup answers both shapes Node asks in', () => {
  const lookup = pinnedLookup(['203.0.113.7', '2001:db8::7']);

  it('gives a list when asked for all addresses', () => {
    let answer: unknown[] = [];
    lookup('example.test', { all: true, hints: 1024 }, (...args) => { answer = args; });
    expect(answer).toEqual([null, [{ address: '203.0.113.7', family: 4 }, { address: '2001:db8::7', family: 6 }]]);
  });

  it('gives one address and its family otherwise', () => {
    for (const options of [{}, { all: false }, undefined, 4]) {
      let answer: unknown[] = [];
      lookup('example.test', options, (...args) => { answer = args; });
      expect(answer).toEqual([null, '203.0.113.7', 4]);
    }
  });
});
