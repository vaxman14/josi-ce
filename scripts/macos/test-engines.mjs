// Isolated engine tests are independent of ingestion policy. The installed
// Runtime.mjs always enforces native scanning; no runtime switch disables it.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];assert(root.startsWith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/'));
assert.equal(JSON.parse(readFileSync(join(root,'data/isolated-test.json'))).purpose,'disposable-native-acceptance');
const program=resolve(dirname(process.execPath),'../..'),require=createRequire(join(program,'app/package.json'));
const {hash,verify}=require('@node-rs/argon2');assert(await verify(await hash('isolated synthetic acceptance input'),'isolated synthetic acceptance input'));
const {createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(1200,160),ctx=canvas.getContext('2d');
ctx.fillStyle='white';ctx.fillRect(0,0,1200,160);ctx.fillStyle='black';ctx.font='64px Helvetica';ctx.fillText('NATIVE OCR 314159',30,100);
const bytes=canvas.toBuffer('image/png'),png=join(root,'engine-fixture.png'),heic=join(root,'engine-fixture.heic');writeFileSync(png,bytes,{mode:0o600});
const {extractRichSegments}=await import(pathToFileURL(join(program,'app/packages/storage/dist/extract.js')));
process.env.JOSI_NATIVE_RUNTIME='1';process.env.JOSI_SCANNER_SOCKET='';
await assert.rejects(extractRichSegments({extension:'png',bytes,ocrImages:true}),/blocked/);
const {createWorker}=require('tesseract.js');
const worker=await createWorker('eng',undefined,{langPath:require('@tesseract.js-data/eng').langPath,cacheMethod:'none'});
try{assert.match((await worker.recognize(bytes)).data.text,/OCR 314159/);}finally{await worker.terminate();}
execFileSync('/usr/bin/sips',['-s','format','heic',png,'--out',heic],{stdio:'pipe'});
const convert=require('heic-convert');const converted=Buffer.from(await convert({buffer:readFileSync(heic),format:'PNG'}));assert.equal(converted.subarray(1,4).toString(),'PNG');
console.log('PASS packaged arm64 Argon2/canvas, offline OCR, HEIF conversion and native ingestion denial');
