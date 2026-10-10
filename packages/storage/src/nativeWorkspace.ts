import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { pinMacDirectory, macStat, macReaddir } from './macosDirectory.js';

export function nativeWorkspacePath(path: string): string {
  if (process.platform !== 'darwin' || process.env.JOSI_NATIVE_RUNTIME !== '1'
    || process.env.JOSI_WORKSPACE_ENABLED !== '1' || !(path === '/workspace' || path.startsWith('/workspace/'))) return path;
  const root = process.env.JOSI_WORKSPACE_NATIVE_PATH;
  if (!root?.startsWith('/') || !process.env.JOSI_WORKSPACE_NATIVE_ID) throw new Error('Native workspace is unavailable');
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || `${info.dev}:${info.ino}` !== process.env.JOSI_WORKSPACE_NATIVE_ID) throw new Error('Selected folder was replaced');
  const tail = path.slice('/workspace'.length).split('/').filter(Boolean);
  if (tail.some(p => p === '.' || p === '..' || p.includes('\0'))) throw new Error('Invalid workspace path');
  return join(root, ...tail);
}

/** Pin and compare the original selected directory before traversing children. */
export async function pinNativeWorkspace(path: string) {
  const physical = nativeWorkspacePath('/workspace');
  if (physical === '/workspace') throw new Error('Native workspace is disabled');
  let current = pinMacDirectory(physical);
  try {
    const info = await macStat(current.path);
    if (`${info.dev}:${info.ino}` !== process.env.JOSI_WORKSPACE_NATIVE_ID) throw new Error('Selected folder was replaced');
    const suffix = path.slice('/workspace'.length).split('/').filter(Boolean);
    if (!(path === '/workspace' || path.startsWith('/workspace/')) || suffix.some(p => p === '.' || p === '..')) throw new Error('Invalid workspace scope');
    for (const part of suffix) { const next = pinMacDirectory(current.path + '/' + part); await current.close(); current = next; }
    return current;
  } catch (error) { await current.close(); throw error; }
}

export const nativeWorkspaceProbe = {
  async available(path: string, writable: boolean) {
    if (path !== '/workspace' || writable) return false; // This installer grants read access only.
    try {
      const directory = await pinNativeWorkspace(path);
      try { await macReaddir(directory.path); return true; } finally { await directory.close(); }
    } catch { return false; }
  },
};
