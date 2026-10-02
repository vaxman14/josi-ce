import { describe, expect, it } from 'vitest';
import { prepareDesktopWorkspaceResult } from '../src/http/desktopWorkspaceRoutes.js';

describe('desktop workspace result persistence', () => {
  it('measures JSON without converting the database value into a string', () => {
    const result = { entries: [{ name: 'notes', kind: 'folder' }], permissions: { edit: false } };
    const prepared = prepareDesktopWorkspaceResult(result);

    expect(prepared.result).toEqual(result);
    expect(typeof prepared.result).toBe('object');
    expect(prepared.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
  });
});
