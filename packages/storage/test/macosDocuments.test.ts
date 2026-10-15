import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ingestFile, storagePolicy } from '../src/ingest.js';
import { extractRichSegments, storeExtraction } from '../src/extract.js';
import { searchDocuments } from '../src/search.js';
import { scanRequired } from '../src/gates.js';

describe.skipIf(process.platform !== 'darwin')('native macOS documents without a scanner', () => {
  let db: TestDb, owner: string, mapping: string;
  beforeAll(async () => {
    db = await testDb();
    const [u] = await db.query<{id:string}>("insert into users(email,username,role) values('mac-document@test.invalid','mac_document','member') returning id"); owner = u.id;
    const [r] = await db.query<{id:string}>("insert into storage_roots(container_path,label) values('/data/roots/macdocs','Mac documents') returning id");
    const [m] = await db.query<{id:string}>("insert into folder_mappings(owner_user_id,provider,root_id,relative_path,display_path) values($1,'local',$2,'','Documents') returning id", [owner,r.id]); mapping = m.id;
  });
  beforeEach(async () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME','1'); vi.stubEnv('JOSI_SCANNER_SOCKET','');
    await db.query('delete from documents');
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([false,true])('indexes and searches text without consulting a scanner, including legacy enabled=%s', async legacy => {
    await db.query('update storage_policy set clamav_enabled=$1 where id=true',[legacy]);
    const policy = await storagePolicy(db), bytes = Buffer.from('Scannerfree document content 271828');
    const scanner = {scan:vi.fn().mockRejectedValue(new Error('No scanner should be called'))};
    for (const event of ['index','change'] as const) expect(scanRequired(policy,event)).toBe(false);
    const outcome = await ingestFile(db,{mappingId:mapping,ownerUserId:owner,candidate:{filename:'notes.txt',relativePath:'notes.txt',byteSize:bytes.length,header:bytes},deps:{policy,scanner}});
    expect(outcome.kind).toBe('accepted'); expect(scanner.scan).not.toHaveBeenCalled();
    const segments = await extractRichSegments({extension:'txt',bytes}); expect(segments).not.toBeNull();
    await storeExtraction(db,{documentId:outcome.documentId,ownerUserId:owner,segments:segments!});
    expect(await searchDocuments(db,{ownerUserId:owner,query:'Scannerfree'})).toMatchObject([{documentId:outcome.documentId,filename:'notes.txt'}]);
    expect(await searchDocuments(db,{ownerUserId:'00000000-0000-4000-8000-000000000001',query:'Scannerfree'})).toEqual([]);
    expect(await db.query('select 1 from malware_findings')).toEqual([]);
  });
  it('retains the file-type and size limits before extraction', async () => {
    const policy=await storagePolicy(db);
    for (const [filename,byteSize,reason] of [['program.exe',5,'extension_not_allowed'],['notes.txt',Number(policy.max_file_bytes)+1,'too_large']] as const) {
      const result=await ingestFile(db,{mappingId:mapping,ownerUserId:owner,candidate:{filename,relativePath:filename,byteSize},deps:{policy}});
      expect(result).toMatchObject({kind:'skipped',reason});
    }
  });
});
