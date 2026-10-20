import { describe, expect, it } from 'vitest';
import { Secret, validateClaudeSubscriptionToken } from '@josi-ce/core';
import { claudeSubscriptionArgs, validClaudeSubscriptionArgs } from '../src/providers/claudeVaultPolicy.js';

describe('Claude Vault consumer boundary', () => {
  it('rejects alternate endpoints, user settings, built-in tools and injected command options', () => {
    const permitted = claudeSubscriptionArgs('sonnet', '/private/tmp/josi-harness/mcp.json');
    expect(validClaudeSubscriptionArgs(permitted)).toBe(true);
    for (const extra of [
      ['--settings', '{"apiKeyHelper":"print-key"}'], ['--tools', 'Bash'],
      ['--setting-sources', 'user'], ['--chrome'], ['--resume', 'old-session'],
      ['--mcp-config', '/elsewhere/mcp.json'], ['--dangerously-skip-permissions'],
    ]) expect(validClaudeSubscriptionArgs([...permitted, ...extra])).toBe(false);
    expect(validClaudeSubscriptionArgs(claudeSubscriptionArgs('--chrome'))).toBe(false);
    expect(validClaudeSubscriptionArgs(claudeSubscriptionArgs('sonnet', 'relative/mcp.json'))).toBe(false);
  });
  it('accepts an opaque token without claiming expiry or account verification', () => {
    const value = 'synthetic-subscription-token';
    expect(validateClaudeSubscriptionToken(new Secret(value)).reveal()).toBe(value);
    for (const invalid of ['short', 'sk-ant-api' + '-synthetic-key', 'token with whitespace', 'token-with-newline\n']) {
      expect(() => validateClaudeSubscriptionToken(new Secret(invalid))).toThrow();
    }
  });
});
