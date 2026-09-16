import { readdir, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export interface ObsidianVault {
  /** Workspace-relative only. Never expose the container or host path. */
  path: string;
  name: string;
}

/** Discover Obsidian vaults inside the installer-owned workspace mount.
 *
 * Obsidian is a filesystem integration, not a cloud credential. Discovery is
 * deliberately bounded and never follows symlinks; a `.obsidian` directory is
 * the native on-disk identity of a vault. */
export async function discoverObsidianVaults(
  workspaceRoot = '/workspace',
  limits: { maxDepth?: number; maxDirectories?: number } = {},
): Promise<ObsidianVault[]> {
  const root = await realpath(workspaceRoot);
  const maxDepth = Math.max(0, Math.min(limits.maxDepth ?? 6, 12));
  const maxDirectories = Math.max(1, Math.min(limits.maxDirectories ?? 5000, 20_000));
  const found: ObsidianVault[] = [];
  let visited = 0;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || ++visited > maxDirectories) return;
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.name === '.obsidian' && entry.isDirectory())) {
      const rel = relative(root, current);
      if (!rel.startsWith(`..${sep}`) && rel !== '..') {
        found.push({ path: rel || '.', name: current.split(sep).filter(Boolean).at(-1) ?? 'Workspace' });
      }
      // Nested vaults are valid, so discovery continues.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.obsidian') continue;
      const child = resolve(current, entry.name);
      // `Dirent` plus the realpath containment check protects against a path
      // being swapped for a symlink between listing and descent.
      let actual: string;
      try { actual = await realpath(child); } catch { continue; }
      if (actual !== root && !actual.startsWith(`${root}${sep}`)) continue;
      const info = await stat(actual);
      if (info.isDirectory()) await walk(actual, depth + 1);
    }
  }

  await walk(root, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
