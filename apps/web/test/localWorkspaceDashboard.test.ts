import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/LocalWorkspace.tsx', import.meta.url), 'utf8');
const relay = readFileSync(new URL('../src/lib/desktopWorkspace.ts', import.meta.url), 'utf8');

describe('Local Workspace dashboard', () => {
  it('uses the selected dashboard hierarchy and makes access choices explicit', () => {
    expect(page).toContain('Connected folders');
    expect(page).toContain('Folder permissions');
    expect(page).toContain('Read only');
    expect(page).toContain('Recommended');
    expect(page).toContain('Read and write');
    expect(page).toContain('Every write still needs your native one-time approval');
    expect(page).toContain('Folders on this device, plus storage attached to your Josi server.');
    expect(page).toContain('Create or edit a text file');
    expect(page).toContain('Load a text file (256 KiB maximum)');
    expect(page).not.toContain('Folders available to your Josi account.');
    expect(page).not.toContain('Create or upload text');
    expect(page).not.toContain('Upload text (256 KiB maximum)');
  });

  it('refreshes the native state and reconciles revoked roots while the relay is running', () => {
    expect(relay).toContain('state=await bridge.state()');
    expect(relay).toContain('rootIds:state.roots.map(root=>root.id)');
    expect(page).toContain("await api.del(`/desktop-workspace/mappings/${mapping.id}`)");
  });
});
