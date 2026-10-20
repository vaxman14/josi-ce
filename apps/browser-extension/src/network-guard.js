'use strict';
// A browser-side boundary is needed even with a pinned native TCP destination:
// connection reuse does not prove which website an HTTP request addresses.
// This first assembly has NO allow-rule API. A future network reservation
// adapter must provide expiring site allowances plus native socket enforcement.
// Browser timers alone cannot establish permission expiry.
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
