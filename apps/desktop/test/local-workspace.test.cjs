'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalWorkspaceBroker, cleanRelative } = require('../src/local-workspace.cjs');

function fixture(writable = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'josi-workspace-')));
  const state = { workspaceClientId: 'desktop_abcdefghijklmnopqrstuvwxyz', workspaceRoots: [{ id:'root_abcdefghijklmnopqrstuvwxyz', path:root, label:'Test', writable }] };
  const store = { get:key=>state[key], set:(key,value)=>{state[key]=value;} };
  const dialog = { showMessageBox:async()=>({response:1}) };
  return {root,broker:new LocalWorkspaceBroker({store,dialog,parentWindow:()=>null,record:()=>{}})};
}

test('blocks traversal, hidden paths, credentials, and symlinks', async () => {
  assert.throws(()=>cleanRelative('../outside'));
  assert.throws(()=>cleanRelative('.git/config'));
  assert.throws(()=>cleanRelative('credentials.json'));
  const {root,broker}=fixture();fs.writeFileSync(path.join(root,'safe.txt'),'safe');
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'josi-outside-'));fs.writeFileSync(path.join(outside,'secret.txt'),'nope');
  fs.symlinkSync(outside,path.join(root,'link'),'dir');
  const listed=await broker.execute('root_abcdefghijklmnopqrstuvwxyz','list',{});
  assert.deepEqual(listed.entries.map(entry=>entry.name),['safe.txt']);
  await assert.rejects(()=>broker.execute('root_abcdefghijklmnopqrstuvwxyz','read',{path:'link/secret.txt'}));
});

test('reads text and requires a native one-shot approval for writes', async () => {
  const {root,broker}=fixture();fs.writeFileSync(path.join(root,'note.txt'),'hello');
  assert.equal((await broker.execute('root_abcdefghijklmnopqrstuvwxyz','read',{path:'note.txt'})).text,'hello');
  await broker.execute('root_abcdefghijklmnopqrstuvwxyz','create',{path:'new.txt',content:'created'});
  assert.equal(fs.readFileSync(path.join(root,'new.txt'),'utf8'),'created');
});

test('read-only roots refuse changes', async () => {
  const {broker}=fixture(false);
  await assert.rejects(()=>broker.execute('root_abcdefghijklmnopqrstuvwxyz','create',{path:'no.txt',content:'x'}),/read-only/);
});

test('revocation while a native approval is open prevents its write', async () => {
  const {root,broker}=fixture();
  broker.dialog.showMessageBox = async () => { broker.revoke('root_abcdefghijklmnopqrstuvwxyz'); return {response:1}; };
  await assert.rejects(()=>broker.execute('root_abcdefghijklmnopqrstuvwxyz','create',{path:'revoked.txt',content:'x'}),/revoked/);
  assert.equal(fs.existsSync(path.join(root,'revoked.txt')),false);
});

test('a parent replaced by a symlink during approval cannot redirect a write', async () => {
  const {root,broker}=fixture(); const child=path.join(root,'child'); fs.mkdirSync(child);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'josi-outside-'));
  broker.dialog.showMessageBox = async () => { fs.rmdirSync(child);fs.symlinkSync(outside,child,'dir');return {response:1}; };
  await assert.rejects(()=>broker.execute('root_abcdefghijklmnopqrstuvwxyz','create',{path:'child/new.txt',content:'x'}),/Links/);
  assert.equal(fs.existsSync(path.join(outside,'new.txt')),false);
});

test('recovery never follows a symlink and repeat edits retain recovery', async () => {
  const {root,broker}=fixture(); const file=path.join(root,'note.txt'); fs.writeFileSync(file,'original');
  await broker.execute('root_abcdefghijklmnopqrstuvwxyz','edit',{path:'note.txt',content:'second'});
  await broker.execute('root_abcdefghijklmnopqrstuvwxyz','edit',{path:'note.txt',content:'third'});
  assert.equal(fs.readFileSync(file,'utf8'),'third');
  const recovery=path.join(root,'.josi-recovery'); assert.equal(fs.readdirSync(recovery).length,2);
  fs.renameSync(recovery,path.join(root,'.saved-recovery'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'josi-outside-'));fs.symlinkSync(outside,recovery,'dir');
  await assert.rejects(()=>broker.execute('root_abcdefghijklmnopqrstuvwxyz','delete',{path:'note.txt'}),/Recovery/);
  assert.equal(fs.readFileSync(file,'utf8'),'third');assert.deepEqual(fs.readdirSync(outside),[]);
});
