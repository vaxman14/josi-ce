import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { attachmentFailure, validateAttachment, readAttachment, writeAttachment, removeAttachment, probeAttachmentStorage, CHAT_FILE_BYTES } from '../src/chatAttachments.js';
let root:string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'ce-attachment-test-'));});
describe('attachment content and filename controls',()=>{
  it('normalizes Unicode and strips traversal/control characters',()=>{
    expect(validateAttachment('../caf\u0065\u0301.txt','text/plain',Buffer.from('hello')).filename).toBe('_café.txt');
  });
  it.each(['run.exe','x.svg','x.js','x.sh','report.pdf.exe','macro.docm'])('rejects risky %s',name=>expect(()=>validateAttachment(name,'',Buffer.from('data'))).toThrow(/unsupported/));
  it('rejects empty and oversized files',()=>{
    expect(()=>validateAttachment('a.txt','',Buffer.alloc(0))).toThrow(/empty/);
    expect(()=>validateAttachment('a.txt','',Buffer.alloc(CHAT_FILE_BYTES+1))).toThrow(/20 MB/);
  });
  it('rejects MIME mismatch, binary masquerading as text, and image masquerading',()=>{
    expect(()=>validateAttachment('a.txt','image/png',Buffer.from('hello'))).toThrow();
    expect(()=>validateAttachment('a.txt','text/plain',Buffer.from([0,255]))).toThrow();
    expect(()=>validateAttachment('a.png','image/png',Buffer.from('hello'))).toThrow();
  });
  it('rejects credentials irrespective of claimed MIME and malware test content',()=>{
    expect(()=>validateAttachment('a.txt','application/octet-stream',Buffer.from('password=123456789abc'))).toThrow(/password/);
    expect(()=>validateAttachment('a.txt','',Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))).toThrow();
  });
  it('rejects active PDFs and accepts ordinary PDF headers',()=>{
    expect(()=>validateAttachment('a.pdf','application/pdf',Buffer.from('%PDF-1.7 /JavaScript evil'))).toThrow();
    expect(validateAttachment('a.pdf','application/pdf',Buffer.from('%PDF-1.7 normal')).contentType).toBe('application/pdf');
  });
  it('requires office structure and rejects macro payloads',()=>{
    expect(()=>validateAttachment('a.docx','',Buffer.from(zipSync({'fake.txt':strToU8('x')})))).toThrow();
    const archive=Buffer.from(zipSync({'word/document.xml':strToU8('<doc/>')}));
    expect(validateAttachment('a.docx','',archive).extension).toBe('docx');
    expect(()=>validateAttachment('a.docx','',Buffer.from(zipSync({'word/document.xml':strToU8('x'),'word/vbaProject.bin':strToU8('x')})))).toThrow();
  });
});
describe('real persistent filesystem operations',()=>{
  it('probes storage and reports missing provisioning',async()=>{
    expect(await probeAttachmentStorage(root)).toEqual({ok:true});
    expect(await probeAttachmentStorage(join(root,'missing'))).toMatchObject({ok:false,code:'storage_missing'});
  });
  it('uses server IDs and preserves bytes across independent reads',async()=>{
    const id=randomUUID();await writeAttachment(id,Buffer.from('persistent'),root);
    expect((await readAttachment(id,root)).toString()).toBe('persistent');
    await expect(writeAttachment(id,Buffer.from('overwrite'),root)).rejects.toThrow();
    expect((await readAttachment(id,root)).toString()).toBe('persistent');
    await removeAttachment(id,root);
  });
  it('refuses root and leaf symlinks and arbitrary paths',async()=>{
    const outside=join(root,'outside');await writeFile(outside,'private');
    const id=randomUUID();await symlink(outside,join(root,id));
    await expect(readAttachment(id,root)).rejects.toThrow();
    await expect(writeAttachment(id,Buffer.from('replace'),root)).rejects.toThrow();
    await expect(readAttachment('../outside',root)).rejects.toThrow();
    const linked=join(root,'linked');await symlink(root,linked);
    expect(await probeAttachmentStorage(linked)).toMatchObject({ok:false,code:'storage_unsafe'});
    expect(await readFile(outside,'utf8')).toBe('private');
  });
  it.each([['ENOSPC','storage_full'],['EDQUOT','storage_full'],['EROFS','storage_read_only'],['EACCES','storage_permission'],['EPERM','storage_permission']])('classifies %s without paths or raw diagnostics',(code,expected)=>{
    const error=attachmentFailure(Object.assign(new Error('/private/secret'),{code}));
    expect(error.code).toBe(expected);expect(error.message).not.toContain('/private');
  });
});
