import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, TOOL_SPECS_BY_NAME } from '../src/tools.js';

describe('native workflow assistant tools', () => {
  it('registers every offered workflow tool in the execution policy catalogue', () => {
    expect(ALL_TOOLS.map((tool) => tool.def.name)).toContain('list_native_workflows');
    expect(ALL_TOOLS.map((tool) => tool.def.name)).toContain('run_native_workflow');
    expect(TOOL_SPECS_BY_NAME.get('list_native_workflows')?.actionClass).toBeNull();
    expect(TOOL_SPECS_BY_NAME.get('run_native_workflow')?.actionClass).toBe('external_write');
  });
});
