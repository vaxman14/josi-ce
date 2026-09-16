import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverObsidianVaults } from '../src/obsidian.js';

let roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

describe('native Obsidian workspace discovery',()=>{
  it('finds vault markers and returns workspace-relative identities only',async()=>{
    const root=await mkdtemp(join(tmpdir(),'josi-obsidian-'));roots.push(root);
    await mkdir(join(root,'notes','.obsidian'),{recursive:true});
    await mkdir(join(root,'projects','client','.obsidian'),{recursive:true});
    await expect(discoverObsidianVaults(root)).resolves.toEqual([
      {path:'notes',name:'notes'},{path:'projects/client',name:'client'},
    ]);
  });

  it('does not follow a workspace symlink to a vault outside the mount',async()=>{
    const root=await mkdtemp(join(tmpdir(),'josi-obsidian-root-'));roots.push(root);
    const outside=await mkdtemp(join(tmpdir(),'josi-obsidian-outside-'));roots.push(outside);
    await mkdir(join(outside,'.obsidian'));
    await symlink(outside,join(root,'escape'));
    await expect(discoverObsidianVaults(root)).resolves.toEqual([]);
  });
});
