'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_READ = 900 * 1024;
const MAX_WRITE = 256 * 1024;
const BLOCKED = /^(?:\.git|\.svn|\.hg|node_modules|\.josi-recovery)$/i;
const SECRET_NAME = /(?:^|[._-])(?:\.env|credentials?|secrets?|tokens?|id_rsa|id_ed25519|keychain|wallet)(?:$|[._-])/i;
const SECRET_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[^\s'"]{12,}/i;

function cleanRelative(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (raw.length > 1000 || raw.includes('\0') || /^[A-Za-z]:/.test(raw) || raw.startsWith('/')) throw new Error('That path is outside the approved folder.');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.startsWith('.') || part.length > 255 || BLOCKED.test(part) || SECRET_NAME.test(part))) throw new Error('That path is protected.');
  return parts.join('/');
}

function inside(root, candidate) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const base = normalize(path.resolve(root));
  const target = normalize(path.resolve(candidate));
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function resolveExisting(root, relative, expected = 'any') {
  const clean = cleanRelative(relative); if (!clean) return root;
  let current = root;
  for (const part of clean.split('/')) {
    const next = path.join(current, part); const stat = fs.lstatSync(next);
    if (stat.isSymbolicLink()) throw new Error('Links and junctions are outside this workspace.');
    current = fs.realpathSync.native(next);
    if (!inside(root, current)) throw new Error('That path escapes the approved folder.');
  }
  const stat = fs.statSync(current);
  if (expected === 'file' && !stat.isFile()) throw new Error('Choose a regular file.');
  if (expected === 'directory' && !stat.isDirectory()) throw new Error('Choose a folder.');
  return current;
}

function resolveNew(root, relative) {
  const clean = cleanRelative(relative); if (!clean) throw new Error('Choose a file or folder name.');
  const parent = resolveExisting(root, path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean), 'directory');
  const target = path.join(parent, path.posix.basename(clean));
  if (!inside(root, target)) throw new Error('That path escapes the approved folder.');
  return target;
}

function receipt() { return crypto.randomUUID(); }
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function identity(file) { const s = fs.lstatSync(file); return `${s.dev}:${s.ino}`; }
function recoveryDirectory(root, source) {
  const directory = path.join(path.dirname(source), '.josi-recovery');
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(root, fs.realpathSync.native(directory))) throw new Error('Recovery folder is not safe.');
  return directory;
}

class LocalWorkspaceBroker {
  constructor({ store, dialog, parentWindow, record }) {
    this.store = store; this.dialog = dialog; this.parentWindow = parentWindow; this.record = record;
    if (!store.get('workspaceClientId')) store.set('workspaceClientId', `desktop_${crypto.randomBytes(24).toString('base64url')}`);
  }
  roots() { return Array.isArray(this.store.get('workspaceRoots')) ? this.store.get('workspaceRoots') : []; }
  publicState() { return { clientId: this.store.get('workspaceClientId'), roots: this.roots().map(({ id, label, writable }) => ({ id, label, writable })) }; }
  async selectFolder(writable = false) {
    const result = await this.dialog.showOpenDialog(this.parentWindow(), { title: 'Choose a Josi CE workspace folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const canonical = fs.realpathSync.native(result.filePaths[0]);
    const stat = fs.statSync(canonical); if (!stat.isDirectory()) throw new Error('Choose a folder.');
    const roots = this.roots(); const existing = roots.find((root) => root.path === canonical);
    const root = existing ?? { id: `root_${crypto.randomBytes(24).toString('base64url')}`, path: canonical, label: path.basename(canonical) || 'Workspace', writable: false };
    root.writable = writable === true; root.label = path.basename(canonical) || 'Workspace';
    this.store.set('workspaceRoots', [...roots.filter((item) => item.id !== root.id), root]);
    this.record('workspace.connected', { rootId: root.id, writable: root.writable });
    return { id: root.id, label: root.label, writable: root.writable };
  }
  revoke(rootId) {
    const roots = this.roots(); const next = roots.filter((root) => root.id !== rootId);
    if (next.length === roots.length) return false;
    this.store.set('workspaceRoots', next); this.record('workspace.revoked', { rootId }); return true;
  }
  root(rootId) {
    const root = this.roots().find((item) => item.id === rootId); if (!root) throw new Error('Workspace permission was revoked.');
    const canonical = fs.realpathSync.native(root.path); if (!inside(root.path, canonical)) throw new Error('Workspace folder moved or changed.');
    return { ...root, path: canonical };
  }
  async approve(root, operation, input) {
    const pathText = String(input.path || ''); const destination = input.destination ? `\nTo: ${input.destination}` : '';
    const choice = await this.dialog.showMessageBox(this.parentWindow(), {
      type: operation === 'delete' ? 'warning' : 'question',
      title: 'Allow Josi CE to change this workspace?',
      message: `${operation.toUpperCase()} in ${root.label}`,
      detail: `${pathText}${destination}\n\nOnly this exact operation will be allowed.`,
      buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (choice.response !== 1) throw new Error('You declined the workspace change.');
  }
  async execute(rootId, operation, input = {}) {
    const root = this.root(rootId); const op = String(operation); const relative = cleanRelative(input.path ?? '');
    if (op === 'list') {
      const directory = resolveExisting(root.path, relative, 'directory'); const entries = fs.readdirSync(directory, { withFileTypes: true });
      if (entries.length > 2000) throw new Error('This folder has more than 2,000 items. Choose a smaller folder.');
      const visible = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') || BLOCKED.test(entry.name) || SECRET_NAME.test(entry.name) || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) continue;
        try { const full = resolveExisting(root.path, [relative, entry.name].filter(Boolean).join('/')); const stat = fs.statSync(full); visible.push({ name: entry.name, kind: stat.isDirectory() ? 'folder' : 'file', size: stat.isFile() ? stat.size : undefined, modified: stat.mtime.toISOString() }); } catch { /* disappearing/protected entries remain hidden */ }
      }
      this.record('workspace.listed', { rootId, pathHash: crypto.createHash('sha256').update(relative).digest('hex').slice(0, 12), count: visible.length });
      return { entries: visible, receipt: receipt(), permissions: { create: root.writable, edit: root.writable, move: root.writable, delete: root.writable } };
    }
    if (op === 'read') {
      const file = resolveExisting(root.path, relative, 'file'); const stat = fs.statSync(file);
      if (stat.size > MAX_READ) throw new Error('Only text files up to 900 KiB can be read.');
      const bytes = fs.readFileSync(file); const body = bytes.toString('utf8');
      if (bytes.includes(0) || SECRET_NAME.test(relative) || SECRET_CONTENT.test(body)) throw new Error('That file is binary or appears to contain credentials.');
      this.record('workspace.read', { rootId, pathHash: crypto.createHash('sha256').update(relative).digest('hex').slice(0, 12), bytes: bytes.length });
      return { text: body, size: bytes.length, modified: stat.mtime.toISOString(), receipt: receipt(), untrustedContent: true };
    }
    if (!root.writable) throw new Error('This workspace is read-only.');
    if (!['create', 'edit', 'mkdir', 'move', 'delete'].includes(op)) throw new Error('Unsupported workspace operation.');
    const source = ['edit', 'move', 'delete'].includes(op) ? resolveExisting(root.path, relative, 'file') : null;
    const before = source ? hashFile(source) : null;
    const content = ['create', 'edit'].includes(op) ? String(input.content ?? '') : null;
    if (content !== null && (Buffer.byteLength(content) > MAX_WRITE || content.includes('\0') || SECRET_NAME.test(relative) || SECRET_CONTENT.test(content))) throw new Error('Only non-secret text up to 256 KiB can be written.');
    const target = ['create', 'mkdir'].includes(op) ? resolveNew(root.path, relative) : source;
    const destination = op === 'move' ? resolveNew(root.path, cleanRelative(input.destination)) : null;
    const rootIdentity = identity(root.path);
    const sourceIdentity = source ? identity(source) : null;
    const targetParentIdentity = identity(path.dirname(target));
    const destinationParentIdentity = destination ? identity(path.dirname(destination)) : null;
    await this.approve(root, op, input);
    // A dialog is an asynchronous gap: revocation or a changed path must take
    // effect before the approved mutation, not at the next tool invocation.
    const currentRoot = this.root(rootId);
    if (!currentRoot.writable || currentRoot.path !== root.path || identity(currentRoot.path) !== rootIdentity) throw new Error('Workspace permission changed while approval was open.');
    const currentTarget = source ? resolveExisting(root.path, relative, 'file') : resolveNew(root.path, relative);
    const currentDestination = destination ? resolveNew(root.path, cleanRelative(input.destination)) : null;
    if (currentTarget !== target || currentDestination !== destination || identity(path.dirname(target)) !== targetParentIdentity
      || (source && identity(source) !== sourceIdentity)
      || (destination && identity(path.dirname(destination)) !== destinationParentIdentity)) throw new Error('The selected path changed while approval was open.');
    if (source && hashFile(source) !== before) throw new Error('The file changed while approval was open. Try again.');
    const id = receipt();
    if (op === 'create') fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    if (op === 'mkdir') fs.mkdirSync(target, { mode: 0o700 });
    if (op === 'edit') {
      const recovery = recoveryDirectory(root.path, source);
      fs.copyFileSync(source, path.join(recovery, id), fs.constants.COPYFILE_EXCL);
      const temporary = `${source}.josi-${crypto.randomBytes(8).toString('hex')}.tmp`;
      try { fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, source); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    if (op === 'move') { if (fs.existsSync(destination)) throw new Error('A file already exists at the destination.'); fs.renameSync(source, destination); }
    if (op === 'delete') { const recovery = recoveryDirectory(root.path, source); fs.renameSync(source, path.join(recovery, id)); }
    this.record('workspace.changed', { rootId, operation: op, receipt: id });
    return { completed: true, receipt: id };
  }
}

module.exports = { LocalWorkspaceBroker, cleanRelative, inside };
