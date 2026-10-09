import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
const root=process.argv[2];
if(!root.startsWith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/'))throw Error('Disposable fixture required');
assert.equal(JSON.parse(readFileSync(join(root,'data/isolated-test.json'))).purpose,'disposable-native-acceptance');
const cfg=JSON.parse(readFileSync(join(root,'data/config/runtime.json'))),url=`http://localhost:${cfg.publicPort}`;
const bootstrap=readFileSync(join(root,'data/secrets/bootstrap/browser-token'),'utf8');
assert.equal((await fetch(url+'/api/setup')).status,404);
assert.equal((await fetch(url+'/api/onboarding/launch',{method:'POST'})).status,403);
const csrf=await fetch(url+'/api/auth/csrf'),{csrfToken}=await csrf.json();
const headers={'cookie':csrf.headers.get('set-cookie').split(';')[0],'x-josi-csrf':csrfToken,'content-type':'application/json'};
assert.equal((await fetch(url+'/api/onboarding/launch',{method:'POST',headers,body:'{}'})).status,404);
const target=JSON.parse(readFileSync(join(root,'private-handoff.json'))),token=new URL(target).hash.slice('#handoff='.length);
assert.match(token,/^[a-f0-9]{64}$/);
const context=await chromium.launchPersistentContext(join(root,'browser-profile'),{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:{PATH:'/usr/bin:/bin',TMPDIR:join(root,'data/temp/web'),HOME:join(root,'browser-profile')}});
try{
  const page=await context.newPage();
  await page.goto(target);
  await page.waitForFunction(()=>!location.hash.includes('handoff'),{},{timeout:15000});
  const cookies=await context.cookies();assert(cookies.some(x=>x.name==='josi_setup_session'&&x.httpOnly&&x.sameSite==='Strict'));
  assert.equal((await fetch(url+'/api/onboarding/consume',{method:'POST',headers,body:JSON.stringify({token})})).status,410);
  assert.equal(await page.evaluate(value=>Object.values(localStorage).some(x=>x.includes(value)),token),false);
  await page.screenshot({path:join(root,'browser-setup.png')});
  writeFileSync(join(root,'browser-evidence.json'),JSON.stringify({headless:true,handoffConsumed:true,replayRejected:true,httpOnlySession:true,tokenAbsentFromURL:true,physicalBrowserHandoff:false},null,2),{mode:0o600});
  console.log('PASS packaged browser handoff, HttpOnly setup session and replay denial');
}finally{await context.close();}
