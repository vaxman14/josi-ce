// Parental controls are included for everybody for now (owner's decision,
// 2026-11-10). No licence, and the module is live; taking it out of the
// included list makes it a paid module again.
import { afterAll, describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { entitlementStatus, isIncludedModule, setIncludedModules } from '../src/entitlements.js';
import { parentalModuleLive } from '../src/parental.js';

afterAll(() => setIncludedModules(['parental_controls']));

describe('parental controls are on without a licence, for now', () => {
  it('is live on a fresh installation with no licence at all', async () => {
    const db = await testDb();
    expect(isIncludedModule('parental_controls')).toBe(true);
    expect(await entitlementStatus(db, 'parental_controls')).toMatchObject({ state: 'included', entitled: true, licenseId: null });
    expect(await parentalModuleLive(db)).toBe(true);
  });

  it('goes back to needing a licence when it is taken out of the list', async () => {
    const db = await testDb();
    setIncludedModules([]);
    expect(await entitlementStatus(db, 'parental_controls')).toMatchObject({ state: 'absent', entitled: false });
    expect(await parentalModuleLive(db)).toBe(false);
    setIncludedModules(['parental_controls']);
    expect(await parentalModuleLive(db)).toBe(true);
  });
});
