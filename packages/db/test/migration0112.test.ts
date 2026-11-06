import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations=join(dirname(fileURLToPath(import.meta.url)),'../migrations');
const repair='0112_repair_workspace_settings_and_proposal_changes.sql';
const repairSql=readFileSync(join(migrations,repair),'utf8');

describe('migration 0112 repairs double-encoded settings and proposal changes',()=>{
  let pg:PGlite;
  const apply=()=>pg.exec(repairSql);

  beforeAll(async()=>{
    pg=new PGlite();
    const files=readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort();
    for(const file of files.filter(f=>f<repair))await pg.exec(readFileSync(join(migrations,file),'utf8'));
  });

  describe('workspace settings',()=>{
    // What the old policy route sent: postgres.js bound its JSON.stringify output
    // as a jsonb string scalar. pglite would parse the same text into an object,
    // so the scalar is built here and merged with the route's own operator.
    const oldPolicyWrite=(value:string)=>pg.query(`update workspace set settings = settings || to_jsonb($1::text) where id = true`,[JSON.stringify({memberSettingsChanges:value})]);
    const merge=(patch:unknown)=>pg.query(`update workspace set settings = settings || $1::jsonb where id = true`,[JSON.stringify(patch)]);
    const settings=async()=>(await pg.query<{settings:unknown}>(`select settings from workspace`)).rows[0].settings;

    beforeEach(async()=>{
      await pg.exec(`delete from workspace; insert into workspace(id,settings) values(true,'{"keep":1,"publicAddress":"https://josi.example.test"}');`);
    });

    it('builds the array the old write really left behind',async()=>{
      await oldPolicyWrite('super_admin');
      expect(await settings()).toEqual([{keep:1,publicAddress:'https://josi.example.test'},'{"memberSettingsChanges":"super_admin"}']);
    });

    it('restores the object and the chosen policy',async()=>{
      await oldPolicyWrite('super_admin');
      await apply();
      expect(await settings()).toEqual({keep:1,publicAddress:'https://josi.example.test',memberSettingsChanges:'super_admin'});
    });

    it('repairs settings that were empty before the write',async()=>{
      await pg.exec(`update workspace set settings='{}'`);
      await oldPolicyWrite('self');
      await apply();
      expect(await settings()).toEqual({memberSettingsChanges:'self'});
    });

    it('keeps the last policy chosen, in either direction',async()=>{
      await oldPolicyWrite('super_admin');
      await oldPolicyWrite('self');
      await apply();
      expect(await settings()).toMatchObject({memberSettingsChanges:'self'});

      await pg.exec(`update workspace set settings='{}'`);
      await oldPolicyWrite('self');
      await oldPolicyWrite('super_admin');
      await apply();
      expect(await settings()).toEqual({memberSettingsChanges:'super_admin'});
    });

    it('keeps healthy merges that landed in the array, in order',async()=>{
      await oldPolicyWrite('super_admin');
      await merge({keep:2,added:true});
      await oldPolicyWrite('self');
      await merge({keep:3});
      await apply();
      expect(await settings()).toEqual({keep:3,added:true,publicAddress:'https://josi.example.test',memberSettingsChanges:'self'});
    });

    it('lets a public address be saved again',async()=>{
      await oldPolicyWrite('self');
      const save=`update workspace set settings = jsonb_set(coalesce(settings,'{}'::jsonb),'{publicAddress}',to_jsonb('https://new.example.test'::text),true) where id = true`;
      await expect(pg.exec(save)).rejects.toThrow(/not an integer/);
      await apply();
      await pg.exec(save);
      expect(await settings()).toMatchObject({publicAddress:'https://new.example.test',memberSettingsChanges:'self'});
    });

    it('runs twice without changing the result',async()=>{
      await oldPolicyWrite('super_admin');
      await apply();
      const once=await settings();
      await apply();
      expect(await settings()).toEqual(once);
    });

    it('leaves healthy settings alone, down to updated_at',async()=>{
      await merge({memberSettingsChanges:'super_admin'});
      const stamp=`select updated_at::text, settings::text from workspace`;
      const before=(await pg.query(stamp)).rows;
      await apply();
      expect((await pg.query(stamp)).rows).toEqual(before);
    });

    it.each([
      ['an array with no policy write','[{"keep":1},{"more":2}]'],
      ['an array with a stranger value','[{"keep":1},"{\\"memberSettingsChanges\\":\\"self\\"}",7]'],
      ['an unknown policy value','[{"keep":1},"{\\"memberSettingsChanges\\":\\"everyone\\"}"]'],
      ['an empty array','[]'],
      ['a string','"{\\"memberSettingsChanges\\":\\"self\\"}"'],
    ])('does not guess at %s',async(_name,stored)=>{
      await pg.query(`update workspace set settings=$1::text::jsonb`,[stored]);
      const before=await settings();
      await apply();
      expect(await settings()).toEqual(before);
    });

    it('does nothing on an install with no workspace row',async()=>{
      await pg.exec(`delete from workspace`);
      await expect(apply()).resolves.toBeDefined();
      expect((await pg.query(`select 1 from workspace`)).rows).toEqual([]);
    });
  });

  describe('improvement proposal changes',()=>{
    const change={kind:'memory_rule',rule:'say "hi"\nthen stop'};
    const text=JSON.stringify(change);
    const insert=async(value:string,cast:string)=>(await pg.query<{id:string}>(
      `insert into improvement_proposals(title,problem,change_kind,change,state) values('t','p','memory_rule',${cast},'applied') returning id`,[value])).rows[0].id;
    const read=async(id:string)=>(await pg.query<{change:unknown}>(`select change from improvement_proposals where id=$1`,[id])).rows[0].change;

    beforeEach(async()=>{await pg.exec(`delete from improvement_proposals`);});

    it('decodes a change written as a string scalar',async()=>{
      const id=await insert(text,'to_jsonb($1::text)');
      await apply();
      expect(await read(id)).toEqual(change);
    });

    it('decodes a change encoded twice, which 0104 could not match',async()=>{
      // Inserted as a string, then approved: the old update stringified that
      // string, and the driver encoded the result again.
      const id=await insert(JSON.stringify(text),'to_jsonb($1::text)');
      await pg.exec(readFileSync(join(migrations,'0104_repair_double_encoded_evidence.sql'),'utf8'));
      expect(await read(id)).toBe(JSON.stringify(text));
      await apply();
      expect(await read(id)).toEqual(change);
    });

    it('leaves a healthy change alone',async()=>{
      const id=await insert(text,'$1::jsonb');
      const stored=`select change::text from improvement_proposals where id='${id}'`;
      const before=(await pg.query(stored)).rows;
      await apply();
      expect((await pg.query(stored)).rows).toEqual(before);
    });

    it('runs twice without changing the result',async()=>{
      const id=await insert(JSON.stringify(text),'to_jsonb($1::text)');
      await apply();
      await apply();
      expect(await read(id)).toEqual(change);
    });

    // Each of these would abort a plain cast, and a failed migration stops the
    // server starting. \u0000 is the sharp one: it passes `is json` but not jsonb.
    it.each([
      ['plain text','not json at all'],
      ['text that only looks like an object','{not json'],
      ['a quoted string that only looks like an object','"{not json'],
      ['an object holding a NUL escape','{"rule":"\\u0000"}'],
      ['a quoted object holding a NUL escape',JSON.stringify('{"rule":"\\u0000"}')],
    ])('skips %s without failing',async(_name,value)=>{
      const id=await insert(value,'to_jsonb($1::text)');
      await expect(apply()).resolves.toBeDefined();
      expect(typeof await read(id)).toBe('string');
    });
  });
});
