import { describe, expect, it } from 'vitest';
import { normalizePcRequirement } from '@josi-ce/core';
import { cleanPath, within, PC_SHELLS, isMacPc } from '../src/pcDesktopTools.js';

describe('PC Control on a Mac', () => {
  it('accepts exact Mac paths and refuses relative or doubled ones', () => {
    expect(cleanPath('/Users/dana/Projects/')).toBe('/Users/dana/Projects');
    expect(cleanPath('/')).toBe('/');
    for (const bad of ['/Users/../etc', '/Users/./dana', '/Users//dana', 'Users/dana', '/Users/da*na']) expect(cleanPath(bad)).toBeNull();
  });
  it('keeps a grant to its own folder tree, spelled exactly', () => {
    expect(within('/Users/dana/Projects/app', '/Users/dana/Projects')).toBe(true);
    expect(within('/Users/dana/ProjectsOld', '/Users/dana/Projects')).toBe(false);
    expect(within('/Users/dana/projects/app', '/Users/dana/Projects')).toBe(false);
  });
  it('knows a Mac by its id and offers its own shells', () => {
    expect(isMacPc('mac-0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isMacPc('win-0123456789abcdef0123456789abcdef')).toBe(false);
    expect(PC_SHELLS.zsh).toBe('/bin/zsh');
  });
  it('stores Mac scopes, and Windows scopes exactly as before', () => {
    expect(normalizePcRequirement({ action: 'command.run', scope: { kind: 'command', target: '/Users/dana/app/', application: '/bin/zsh' } }).scope)
      .toEqual({ kind: 'command', target: '/Users/dana/app', application: '/bin/zsh' });
    expect(normalizePcRequirement({ action: 'folder.read', scope: { kind: 'folder', target: 'C:\\Users\\dana\\' } }).scope.target).toBe('C:\\Users\\dana');
    expect(() => normalizePcRequirement({ action: 'folder.read', scope: { kind: 'folder', target: '/Users/../etc' } })).toThrow();
  });
});
