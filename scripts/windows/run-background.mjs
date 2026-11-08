// Build-only runner. Never opens a console window or launches the Josi UI.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const [program,...args]=process.argv.slice(2);
if(!program)throw new Error('Choose a build command.');
const root=process.cwd(), temporary=resolve(root,'artifacts/windows-native/build-tmp');
mkdirSync(temporary,{recursive:true});
const env={...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary,NPM_CONFIG_CACHE:resolve(root,'artifacts/windows-native/cache/npm')};
const executable=program==='npm'?process.execPath:program;
const parameters=program==='npm'?[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...args]:args;
const child=spawn(executable,parameters,{cwd:root,env,windowsHide:true,stdio:['ignore','inherit','inherit']});
child.on('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
