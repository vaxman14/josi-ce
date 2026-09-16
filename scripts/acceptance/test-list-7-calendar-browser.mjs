// Real rendered UI with synthetic provider responses; no live account or credentials.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
const results=[];
try {
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const page=await browser.newPage({viewport,timezoneId:'America/Los_Angeles'});let empty=false,fail=false;
  const source={id:'source-a',name:'Team',account:'calendar-fixture@example.test',provider:'google',selected:true,primary:false,color:'#ea580c'};
  const event=(id,title,start,end,allDay=false)=>({eventId:id,sourceId:source.id,sourceName:source.name,account:source.account,provider:source.provider,sourceColor:source.color,title,start,end,allDay});
  const events=[event('a','Morning meeting','2026-03-08T09:30:00Z','2026-03-08T11:30:00Z'),event('b','Overlapping meeting','2026-03-08T10:00:00Z','2026-03-08T12:00:00Z'),event('c','All day workshop','2026-03-08','2026-03-09',true),event('series-1','Recurring meeting','2026-03-09T16:00:00Z','2026-03-09T17:00:00Z')];
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
   if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'proof',username:'owner',role:'super_admin'}}});
   if(path==='/api/calendar/sources')return route.fulfill({json:{sources:[source]}});
   if(path==='/api/calendar/events'){await new Promise(resolve=>setTimeout(resolve,150));return fail?route.fulfill({status:503,json:{error:'Calendar temporarily unavailable'}}):route.fulfill({json:{events:empty?[]:events}});}
   if(path.startsWith('/api/calendar/events/'))return route.fulfill({json:{event:{...events[0],description:'Synthetic acceptance fixture'}}});
   return route.fulfill({json:{}});
  });
  await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18492')+'/app/calendar');
  await page.getByLabel('Calendar date').fill('2026-03-08');
  await page.getByRole('button',{name:/^Day$/i}).click();
  await page.getByText('Loading…',{exact:true}).waitFor();
  await page.getByRole('button',{name:/Morning meeting/}).waitFor();
  const positions=await page.getByRole('button',{name:/Morning meeting|Overlapping meeting/}).evaluateAll(nodes=>nodes.map(n=>({left:n.parentElement.style.left,width:n.parentElement.style.width})));
  assert.deepEqual(positions.map(p=>p.width),['50%','50%']);assert.notEqual(positions[0].left,positions[1].left);
  assert.equal(await page.getByRole('button',{name:/All day workshop/}).count(),1);
  await page.getByRole('button',{name:/Morning meeting/}).click();await page.getByRole('region',{name:'Event details'}).waitFor();assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Event details');await page.getByRole('button',{name:'Close',exact:true}).click();assert((await page.locator(':focus').innerText()).includes('Morning meeting'));
  await page.getByRole('button',{name:/^Month$/i}).click();
  await page.getByRole('button',{name:'Open 2026-03-08',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Open 2026-03-09');
  assert.equal(await page.locator('button[data-day]').count(),42);
  await page.getByRole('button',{name:/^List$/i}).click();await page.getByRole('button',{name:/Recurring meeting/}).waitFor();
  await page.getByRole('button',{name:/^Week$/i}).click();await page.getByRole('heading',{name:'2026-03-08',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:/2026-03-0[8-9]|2026-03-1[0-4]/}).count(),7);
  await page.getByRole('button',{name:'Today',exact:true}).click();
  assert.equal(await page.getByLabel('Calendar date').inputValue(),await page.evaluate(()=>new Intl.DateTimeFormat('en-CA').format(new Date())));
  await page.getByLabel('Calendar timezone').selectOption('UTC');
  empty=true;await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('No events in this range.',{exact:true}).waitFor();
  fail=true;await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('alert').filter({hasText:'Calendar temporarily unavailable'}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  results.push({viewport,checks:['list/month/week/day','overlap columns','all-day','recurrence instance','month keyboard arrows','detail focus and return','loading','today in local timezone','timezone selector','empty','error','no page horizontal overflow']});await page.close();
 }
 console.log(JSON.stringify({pass:true,provider:'synthetic fixtures',results},null,2));
} finally {await browser.close();}
