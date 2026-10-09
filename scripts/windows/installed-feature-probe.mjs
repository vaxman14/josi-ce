// Explicit AMSI and OCR requests against the installed, verified candidate.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const [program,data,fixture]=process.argv.slice(2);
const require=createRequire(join(program,'app/package.json'));
const {extractRichSegments,nativeScanner}=require('@josi-ce/storage');
Object.assign(process.env,{JOSI_NATIVE_RUNTIME:'1',JOSI_DATA_DIR:data,JOSI_UPLOAD_DIR:join(data,'chat-attachments'),JOSI_STORAGE_ROOT_BASE:join(data,'roots'),TEMP:join(data,'temp/migrate'),TMP:join(data,'temp/migrate')});
try{
  const segments=await extractRichSegments({extension:'png',bytes:await readFile(fixture),ocrImages:true});
  assert.match(segments.map(segment=>segment.content).join(' '),/JOSI WINDOWS OCR 314159/);
  const scanner=nativeScanner({python:join(program,'python/python.exe'),adapter:join(program,'app/services/scanner/windows_amsi.py'),scratch:join(data,'temp/scanner')});
  try{
    assert.deepEqual(await scanner.scan(Buffer.from('An installed clean document.')),{clean:true});
    const test=Buffer.from(['X5O!P%@AP[4','\\PZX54(P^)7CC)7}','$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''));
    const verdict=await scanner.scan(test);
    assert.equal(verdict.clean,false);assert.match(verdict.signature,/Windows antivirus/);
  }finally{scanner.close();}
  console.log(JSON.stringify({passed:true,ocr:true,explicitAmsiClean:true,explicitAmsiBlocked:true}));
}catch{console.error('Installed OCR/AMSI acceptance failed.');process.exitCode=1;}
