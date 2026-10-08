// Verify the Windows primitive needed to replace Linux descriptor-pinned paths.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rename, symlink, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
const koffi = require('../../artifacts/windows-native/tools/koffi-spike/node_modules/koffi');
const k32 = koffi.load('kernel32.dll');
const create = k32.func('intptr_t __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, intptr_t)');
const close = k32.func('int __stdcall CloseHandle(intptr_t)');
const info = k32.func('int __stdcall GetFileInformationByHandle(intptr_t, _Out_ void *)');
const root = await mkdtemp(resolve('artifacts/windows-native/test-installations/handles-'));
const inside = join(root, 'inside'); const outside = join(root, 'outside');
await mkdir(inside); await mkdir(outside);
let handle;
try {
  handle = create(inside, 0x80000000, 3, null, 3, 0x02200000, 0);
  assert.notEqual(handle, -1);
  const details = Buffer.alloc(52);
  assert.equal(info(handle, details), 1);
  assert.equal(details.readUInt32LE(0) & 0x400, 0);
  assert.equal(details.readUInt32LE(0) & 0x10, 0x10);
  await assert.rejects(rename(inside, join(root, 'swapped')));
  assert.equal(close(handle), 1); handle = undefined;
  await rename(inside, join(root, 'swapped'));
  await symlink(outside, inside, 'junction');
  handle = create(inside, 0x80000000, 3, null, 3, 0x02200000, 0);
  assert.notEqual(handle, -1);
  assert.equal(info(handle, details), 1);
  assert.equal(details.readUInt32LE(0) & 0x400, 0x400);
  await writeFile(resolve('artifacts/windows-native/evidence/windows-file-handles.json'), JSON.stringify({
    recordedAt: new Date().toISOString(), passed: true, koffi: '3.3.2',
    directoryRenameBlockedWhileHeld: true, junctionOpenedWithoutTraversalAndIdentified: true,
    completeStorageAdapter: false,
  }, null, 2) + '\n');
  console.log('Windows file-handle pinning and junction detection passed.');
} finally {
  if (handle !== undefined) close(handle);
  // Root is a unique mkdtemp directory beneath the explicit workspace test area.
  if (!root.startsWith(resolve('artifacts/windows-native/test-installations') + '\\')) throw new Error('Unsafe cleanup');
  await rm(root, { force: true, recursive: true });
}
