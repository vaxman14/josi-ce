import { describe, expect, it } from 'vitest';
import { cleanPath, within, PC_DESKTOP_TOOLS, PC_DESKTOP_TOOL_NAMES, PC_SHELLS } from '../src/pcDesktopTools.js';
import { normalizePcRequirement } from '@josi-ce/core';

describe('PC desktop tools: paths and scopes', () => {
  it('accepts exact absolute Windows paths and normalizes them to one spelling', () => {
    expect(cleanPath('C:\\Users\\Roman\\project\\')).toBe('C:\\Users\\Roman\\project');
    expect(cleanPath('C:\\')).toBe('C:\\');
    expect(cleanPath('c:\\Dev')).toBe('c:\\Dev');
  });
  it('refuses relative parts, wildcards, streams, forward slashes and trailing dots or spaces', () => {
    for (const bad of ['C:\\Users\\..\\Windows', 'C:\\Users\\.\\x', 'C:\\Users\\*', 'C:/Users', 'Users\\x', 'C:\\file.txt:stream', 'C:\\Users\\name.', 'C:\\Users\\name ', '\\\\server\\share', ''])
      expect(cleanPath(bad)).toBeNull();
  });
  it('treats a scope folder as a tree root', () => {
    expect(within('C:\\Users\\Roman\\Dev\\app', 'C:\\Users\\Roman')).toBe(true);
    expect(within('C:\\Users\\Roman', 'C:\\Users\\Roman')).toBe(true);
    expect(within('c:\\users\\roman\\x', 'C:\\Users\\Roman')).toBe(true);
    expect(within('C:\\Users\\Romana', 'C:\\Users\\Roman')).toBe(false);
    expect(within('D:\\Users\\Roman', 'C:\\Users\\Roman')).toBe(false);
    expect(within('C:\\Anything', 'C:\\')).toBe(true);
  });
  it('builds command scopes PC Control accepts', () => {
    for (const shell of Object.values(PC_SHELLS)) {
      const r = normalizePcRequirement({ action: 'command.run', scope: { kind: 'command', target: cleanPath('C:\\Users\\Roman\\')!, application: shell } });
      expect(r.scope).toEqual({ kind: 'command', target: 'C:\\Users\\Roman', application: shell });
    }
  });
  it('offers the command, file and program tools with the desktop ones, each with a bounded schema', () => {
    for (const name of ['pc_environment', 'pc_find_app', 'pc_run_command', 'pc_list_folder', 'pc_read_file', 'pc_write_file', 'desktop_launch', 'desktop_check_request'])
      expect(PC_DESKTOP_TOOL_NAMES.has(name)).toBe(true);
    for (const tool of PC_DESKTOP_TOOLS) {
      const schema = tool.def.parameters as { additionalProperties: boolean; properties: Record<string, { maxLength?: number; type: string; enum?: string[]; format?: string }> };
      expect(schema.additionalProperties).toBe(false);
      for (const p of Object.values(schema.properties)) if (p.type === 'string') expect(p.maxLength !== undefined || p.enum !== undefined || p.format === 'uuid').toBe(true);
    }
    const run = PC_DESKTOP_TOOLS.find(t => t.def.name === 'pc_run_command')!;
    expect(run.actionClass).toBe('automation_control');
    expect((run.def.parameters as { required: string[] }).required).toEqual(['command', 'working_folder']);
  });
});
