import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('shares first CSRF initialization between authentication and handoff consumption', async () => {
  const token='d'.repeat(64); const values=new Map<string,string>();
  vi.stubGlobal('window',{location:{hash:`#handoff=${token}`,pathname:'/setup',search:''}});
  vi.stubGlobal('history',{replaceState:vi.fn()});
  vi.stubGlobal('sessionStorage',{setItem:(k:string,v:string)=>values.set(k,v),getItem:(k:string)=>values.get(k)??null,removeItem:(k:string)=>values.delete(k)});
  const document={cookie:''};vi.stubGlobal('document',document);
  let requests=0;let complete!:()=>void;
  const ready=new Promise<void>(resolve=>{complete=resolve;});
  vi.stubGlobal('fetch',vi.fn(async (path:string,options?:RequestInit)=>{
    if(path==='/api/auth/csrf'){requests++;await ready;document.cookie='josi_csrf=fixture';return new Response('{}');}
    expect(path).toBe('/api/onboarding/consume');
    expect((options?.headers as Record<string,string>)['x-josi-csrf']).toBe('fixture');
    expect(JSON.parse(options?.body as string)).toEqual({token});
    return new Response(null,{status:204});
  }));
  const api=await import('../../web/src/lib/api.js');
  const auth=api.primeCsrf();const consume=api.consumeSetupHandoff();
  expect(requests).toBe(1);complete();await Promise.all([auth,consume]);
  expect(requests).toBe(1);expect(values.size).toBe(0);
});
