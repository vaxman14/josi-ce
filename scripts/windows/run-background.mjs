// Build-only runner. Never opens a console window or launches the Josi UI.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const [program,...args]=process.argv.slice(2);
if(!program)throw new Error('Choose a build command.');
const root=process.cwd(), temporary=resolve(root,'artifacts/windows-native/build-tmp');
mkdirSync(temporary,{recursive:true});
const env={...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary,NPM_CONFIG_CACHE:resolve(root,'artifacts/windows-native/cache/npm')};
// A PowerShell 7 host can export a module path unsuitable for OS PowerShell
// 5.1. Child packaging scripts need only Microsoft's built-in OS modules.
env.PSModulePath=resolve(env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules');
env.DOTNET_CLI_HOME=resolve(root,'artifacts/windows-native/cache/dotnet-home');
env.NUGET_PACKAGES=resolve(root,'artifacts/windows-native/cache/nuget');
env.DOTNET_CLI_TELEMETRY_OPTOUT='1';env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1';env.DOTNET_GENERATE_ASPNET_CERTIFICATE='false';
const executable=program==='npm'?process.execPath:program;
const parameters=program==='npm'?[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...args]:args;
const child=spawn(executable,parameters,{cwd:root,env,windowsHide:true,stdio:['ignore','inherit','inherit']});
child.on('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
