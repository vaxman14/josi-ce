import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const login = readFileSync(new URL('../src/pages/Login.tsx', import.meta.url), 'utf8');

describe('login presentation', () => {
  it('presents Google sign-in as a full-size control', () => {
    expect(login).toContain('min-h-11 w-full');
    expect(login).toContain('Sign in with Google');
    expect(login).toContain('/api/auth/google/start');
  });

  it('does not hard-code a stale product version', () => {
    expect(login).not.toContain('Josi CE 0.1');
    expect(login).toContain('Josi CE — Community Preview');
  });
});
