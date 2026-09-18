import { describe, expect, it } from 'vitest';
import { MUTATING_TOOLS } from '../src/durableEffects.js';

describe('durable effect catalogue', () => {
  it('fences workspace cancellation even though status reads are otherwise harmless', () => {
    expect(MUTATING_TOOLS.has('workspace_code_status')).toBe(true);
  });
});
