'use strict';
// A browser-side boundary is needed even with a pinned native TCP destination:
// connection reuse does not prove which website an HTTP request addresses.
// Site allowances accompany a reserved native CONNECT relay. Browser timers
// are cleanup only; independent native/server deadlines enforce expiry.
let josiProxyGrant = null, josiNetworkEpoch = 0;
const josiNetworkApi = globalThis.browser ?? globalThis.chrome;
if (globalThis.JOSI_BROWSER_CONFIG?.family === 'chrome') {
  josiNetworkApi.webRequest.onAuthRequired.addListener((details, done) => {
    const grant = josiProxyGrant;
    if (!details.isProxy || details.challenger?.host !== '127.0.0.1' || details.challenger?.port !== 40513) {
      done({}); return;
    }
    let origin;
    try { origin = new URL(details.url).origin; } catch {}
    done(grant && Date.now() < grant.expiresAt && origin === grant.origin
      ? { authCredentials: { username: 'josi', password: grant.password } } : { cancel: true });
  }, { urls: ['https://*/*'] }, ['asyncBlocking']);
}
globalThis.endJosiPageNetwork = async function (api) {
  josiNetworkEpoch++; josiProxyGrant = null;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1001] });
};
globalThis.beginJosiPageNetwork = async function (api, grant) {
  const epoch = ++josiNetworkEpoch, now = Date.now();
  if (globalThis.JOSI_BROWSER_CONFIG?.family !== 'chrome' || !grant || grant.host !== '127.0.0.1'
    || grant.port !== 40513 || grant.username !== 'josi' || typeof grant.password !== 'string'
    || !/^[A-Za-z0-9+/]{43}=$/.test(grant.password) || !Number.isSafeInteger(grant.expiresAt)
    || grant.expiresAt <= now || grant.expiresAt > now + 10000
    || new URL(grant.origin).origin !== grant.origin || !grant.origin.startsWith('https://')) throw new Error('network_grant_invalid');
  const escaped = grant.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  josiProxyGrant = Object.freeze({ ...grant });
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1001], addRules: [{
    id: 1001, priority: 2, action: { type: 'allow' },
    condition: { regexFilter: '^' + escaped + '/', requestMethods: ['get', 'head'],
      resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'xmlhttprequest', 'media', 'other'] },
  }] });
  if (epoch !== josiNetworkEpoch || Date.now() >= grant.expiresAt) {
    await globalThis.endJosiPageNetwork(api); throw new Error('network_grant_expired');
  }
};
globalThis.requireJosiNetworkBoundary = async function (api) {
  const rules = api.declarativeNetRequest;
  if (!rules?.getEnabledRulesets || !rules.getDynamicRules || !rules.getSessionRules
    || !rules.updateEnabledRulesets || !rules.updateDynamicRules || !rules.updateSessionRules) {
    throw new Error('network_boundary_unavailable');
  }
  // The extension owns these rule stores. Never retain a previous process's
  // allowances or treat a browser restart as renewal of server authority.
  await rules.updateEnabledRulesets({ enableRulesetIds: ['josi_network_boundary'] });
  const dynamic = await rules.getDynamicRules();
  const session = await rules.getSessionRules();
  if (!Array.isArray(dynamic) || !Array.isArray(session) || dynamic.length > 512 || session.length > 512
    || [...dynamic, ...session].some(rule => !Number.isSafeInteger(rule.id) || rule.id < 1)) {
    throw new Error('network_boundary_invalid');
  }
  if (dynamic.length) await rules.updateDynamicRules({ removeRuleIds: dynamic.map(rule => rule.id) });
  if (session.length) await rules.updateSessionRules({ removeRuleIds: session.map(rule => rule.id) });
  const enabled = await rules.getEnabledRulesets();
  if (!enabled.includes('josi_network_boundary')) throw new Error('network_boundary_unavailable');
};
