import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePcRequirement, readLocalExecutors, writeLocalTicket } from '@josi-ce/core';
import { cleanPath, within, PC_SHELLS, isLinuxPc, isMacPc, isPosixPc } from '../src/pcDesktopTools.js';

describe('PC Control on a Linux server', () => {
  it('knows a Linux server by its id and gives it POSIX shells', () => {
    const id = 'linux-0123456789abcdef0123456789abcdef';
    expect(isLinuxPc(id)).toBe(true);
    expect(isMacPc(id)).toBe(false);
    expect(isPosixPc(id)).toBe(true);
    expect(isPosixPc('win-0123456789abcdef0123456789abcdef')).toBe(false);
    expect(PC_SHELLS.bash).toBe('/bin/bash');
    expect(PC_SHELLS.sh).toBe('/bin/sh');
  });
  it('accepts exact Linux paths', () => {
    expect(cleanPath('/home/dana/project/')).toBe('/home/dana/project');
    expect(within('/home/dana/project/src', '/home/dana')).toBe(true);
    expect(within('/home/danaX', '/home/dana')).toBe(false);
    expect(cleanPath('/home/../etc')).toBeNull();
  });
  it('stores Linux scopes', () => {
    expect(normalizePcRequirement({ action: 'command.run', scope: { kind: 'command', target: '/home/dana/', application: '/bin/bash' } }).scope)
      .toEqual({ kind: 'command', target: '/home/dana', application: '/bin/bash' });
  });
});

describe('the Linux PC service handoff', () => {
  it('reads valid hellos only and writes a private ticket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-spool-'));
    const previous = process.env.JOSI_PC_SPOOL;
    process.env.JOSI_PC_SPOOL = dir;
    try {
      const pcId = 'linux-' + 'a'.repeat(32);
      writeFileSync(join(dir, pcId + '.hello.json'), JSON.stringify({ pcId, publicKey: 'BAAA', user: 'dana', host: 'box', createdAt: '2026-11-09T00:00:00Z' }));
      writeFileSync(join(dir, 'linux-' + 'b'.repeat(32) + '.hello.json'), JSON.stringify({ pcId: 'linux-other', publicKey: 'BAAA', user: 'dana', host: 'box', createdAt: 'x' }));
      writeFileSync(join(dir, 'win-123.hello.json'), '{}');
      mkdirSync(join(dir, 'linux-' + 'c'.repeat(32) + '.hello.json'));
      const found = readLocalExecutors();
      expect(found.map(h => h.pcId)).toEqual([pcId]);
      writeLocalTicket(pcId, { ownerId: '00000000-0000-4000-8000-000000000000', sessionToken: 'token', publicKey: 'BAAA' });
      const ticket = JSON.parse(readFileSync(join(dir, pcId + '.ticket.json'), 'utf8'));
      expect(ticket).toMatchObject({ pcId, sessionToken: 'token', publicKey: 'BAAA' });
      if (process.platform !== 'win32') expect(statSync(join(dir, pcId + '.ticket.json')).mode & 0o777).toBe(0o640);
      expect(() => writeLocalTicket('win-123', { ownerId: 'x', sessionToken: 't', publicKey: 'k' })).toThrow();
    } finally {
      if (previous === undefined) delete process.env.JOSI_PC_SPOOL; else process.env.JOSI_PC_SPOOL = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
