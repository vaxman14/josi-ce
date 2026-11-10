import { describe, expect, it } from 'vitest';
import { TOOL_SPECS_BY_NAME } from '../src/tools.js';
import { SIGN_IN_TOOLS } from '../src/signInTools.js';
import { SEND_FILE_TOOLS } from '../src/sendFileTools.js';
import { PC_DESKTOP_TOOLS } from '../src/pcDesktopTools.js';
import { PC_BROWSER_TOOLS } from '../src/pcBrowserTools.js';

// The agent loop and the MCP server look every offered tool up here before
// running it: a tool that can be offered but is missing from this map is
// handed to the model and then reported as unknown.
describe('every tool Josi can offer is in the registry the loop checks', () => {
  for (const [name, specs] of [['sign-in', SIGN_IN_TOOLS], ['send-file', SEND_FILE_TOOLS], ['PC desktop', PC_DESKTOP_TOOLS], ['PC browser', PC_BROWSER_TOOLS]] as const) {
    it(`${name} tools`, () => {
      for (const spec of specs) expect(TOOL_SPECS_BY_NAME.has(spec.def.name), spec.def.name).toBe(true);
    });
  }
});
