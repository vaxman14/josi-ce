import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macScanner, macScannerHealth, requireMacScan, scannerExchange } from '../src/macosScanner.js';
import { scanRequired } from '../src/gates.js';

let server:Server|undefined,folder:string|undefined;
afterEach(async()=>{vi.unstubAllEnvs();if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;if(folder)await rm(folder,{recursive:true,force:true});folder=undefined;});
describe.skipIf(process.platform!=='darwin')('native macOS scanner boundary',()=>{
  it('blocks absent scanner even when legacy scanning is disabled',async()=>{
    vi.stubEnv('JOSI_NATIVE_RUNTIME','1');vi.stubEnv('JOSI_SCANNER_SOCKET','');
    expect(scanRequired({clamav_enabled:false,clamav_scan_mode:'on_index'} as any,'upload' as any)).toBe(true);
    expect(await macScannerHealth()).toMatchObject({required:true,enforced:true,status:'unavailable'});
    await expect(requireMacScan(Buffer.from('document'))).rejects.toThrow('blocked');
    await expect(macScanner.scan(Buffer.from('document'))).rejects.toThrow('blocked');
  });
  it('never accepts a user-controlled socket as the supported production scanner',async()=>{
    vi.stubEnv('JOSI_NATIVE_RUNTIME','1');vi.stubEnv('JOSI_SCANNER_SOCKET','/tmp/untrusted-scanner');
    await expect(requireMacScan(Buffer.from('document'))).rejects.toThrow('blocked');
  });
  it('sends bounded exact-byte INSTREAM frames, distinct from PING',async()=>{
    // Test transport uses an injected path; product exports only fixed macScanner.
    // Relative socket names avoid Darwin's 104-byte sockaddr_un path limit.
    folder=await mkdtemp(join(process.cwd(),'.scanner-test-'));const path='./'+folder.split('/').at(-1)+'/s';
    const input=Buffer.alloc(170001,0x61);let received=Buffer.alloc(0);
    server=createServer(socket=>{
      let pending=Buffer.alloc(0),command=false;
      socket.on('data',part=>{
        pending=Buffer.concat([pending,part]);
        if(!command){if(pending.length<10)return;expect(pending.subarray(0,10).toString()).toBe('zINSTREAM\0');pending=pending.subarray(10);command=true;}
        while(pending.length>=4){const n=pending.readUInt32BE(0);if(pending.length<4+n)return;expect(n).toBeLessThanOrEqual(65536);received=Buffer.concat([received,pending.subarray(4,4+n)]);pending=pending.subarray(4+n);if(!n){socket.end('stream: OK\0');return;}}
      });
    });await new Promise<void>(r=>server!.listen(path,r));
    expect(await scannerExchange(()=>path,input)).toBe('stream: OK');expect(received.equals(input)).toBe(true);
  });
});
