// Test fixture only: a tiny in-memory stand-in for the Josi CE API so the
// Windows client's screens can be exercised without a real server.
//   node test/mock-server.mjs 8787
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] || 8787);
const now = () => new Date().toISOString();
const user = { id: randomUUID(), username: 'roman', displayName: 'Roman Vaxman', role: 'super_admin' };
const threadId = randomUUID();
const threads = [{ id: threadId, title: 'Garage sale photo descriptions' }];
const messages = { [threadId]: [
  { id: randomUUID(), direction: 'in', body: 'Can you help me describe the photos on my garage sale uploads page?', attachments: [] },
  { id: randomUUID(), direction: 'out', body: 'Yes. I will start with the **first photo with an empty description**, describe only what is visible, and stop so you can review it before anything is saved. See [the uploads page](https://romansgaragesale.com/uploads).' },
] };
const turns = { [threadId]: [] };
const goalId = randomUUID();
const goals = [{
  goalId, threadId, title: 'Describe the first garage-sale photo', state: 'needs_instruction', revision: 3,
  verifiedSteps: 1, totalSteps: 3, retiredSteps: 0, activity: 'Automation needs setup', updatedAt: now(),
  criteria: ['The first empty description contains a reviewed draft', 'Existing descriptions are unchanged'],
  steps: [
    { id: randomUUID(), title: 'Open the attached uploads tab', state: 'verified', taskId: '', evidence: '' },
    { id: randomUUID(), title: 'Read the first photo with an empty description', state: 'blocked', blockedReason: 'Connect this PC and attach the Chrome tab.', dependsOn: [] },
    { id: randomUUID(), title: 'Fill and verify the description, then stop for review', state: 'pending', dependsOn: [] },
  ],
  continuation: { kind: 'question', text: 'Connect this PC in Automation, then continue.' },
  checkpoint: { decisions: ['Start with one photo'], facts: ['Photos are already on the page'], assumptions: [], nextAction: 'Attach the Chrome tab' },
  ownerCheckpoint: null, automaticWork: { segmentsSinceVerifiedProgress: 1, segmentLimit: 12, runsUsed: 2, runLimit: null, deadline: null },
}];
const memories = [{ id: randomUUID(), content: 'Roman prefers short, factual product descriptions.', provenance: 'From a conversation', pinned: false, confirmed_at: now() }];

const providerCatalog = [
  { kind: 'openai_subscription', label: 'ChatGPT subscription', fields: [], baseUrlMode: 'none', external: true, residency: 'OpenAI', modelNoun: 'model' },
  { kind: 'anthropic_subscription', label: 'Claude subscription', fields: [], baseUrlMode: 'none', external: true, residency: 'Anthropic', modelNoun: 'model' },
  { kind: 'anthropic', label: 'Anthropic API', baseUrlMode: 'none', external: true, residency: 'United States', docsUrl: 'https://console.anthropic.com/settings/keys', modelNoun: 'model',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 'sk-ant-…', help: 'Create a key in the Anthropic Console.' }] },
  { kind: 'openai', label: 'OpenAI API', baseUrlMode: 'optional', defaultBaseUrl: 'https://api.openai.com/v1', external: true, residency: 'United States', docsUrl: 'https://platform.openai.com/api-keys', modelNoun: 'model',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 'sk-…', help: null }] },
  { kind: 'ollama', label: 'Ollama', baseUrlMode: 'required', defaultBaseUrl: 'http://localhost:11434', external: false, residency: '', modelNoun: 'model', fields: [] },
  ...['xAI', 'DeepSeek', 'Alibaba Qwen', 'Mistral', 'Moonshot (Kimi)', 'Zhipu GLM', 'OpenRouter', 'MiniMax', 'Cohere', 'AWS Bedrock', 'Azure AI', 'Google Vertex AI', 'Baidu ERNIE', 'Tencent Hunyuan']
    .map((label, index) => ({ kind: 'extra_' + index, label, baseUrlMode: 'none', external: true, residency: 'Provider region', modelNoun: 'model',
      fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }] })),
  { kind: 'gemini', label: 'Google Gemini', baseUrlMode: 'none', external: true, residency: 'United States', modelNoun: 'model',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }] },
];
const subscriptionOptions = [
  { id: 'chatgpt_subscription', provider: 'openai_subscription', available: true, label: 'Use my ChatGPT plan through the Codex CLI',
    reason: "Josi runs OpenAI's own Codex CLI with a subscription login saved in the Vault. It shares your own Codex usage limits." },
  { id: 'claude_subscription', provider: 'anthropic_subscription', available: true, label: 'Use my Claude subscription through Claude Code',
    reason: "Josi runs Anthropic's own Claude Code with a subscription token saved in the Vault. It shares your plan's limits." },
];
const llm = {
  primary: { role: 'primary', provider: 'openai_subscription', model: '', baseUrl: null, apiKeySet: false, providerConfig: {}, external: true, externalAcknowledged: true,
    active: true, probedAt: now(), capabilities: { chat: true, toolCalling: true, vision: true, structuredOutput: true, contextTokens: 400000 },
    probeSteps: [{ label: 'Reply', detail: 'Answered a short question.', passed: true }, { label: 'Tools', detail: 'Called a Josi tool.', passed: true }] },
  fallback: null, codexLogin: null, signedIn: { codex: false, claude: false },
};
function subscriptionStatus(which) {
  const signedIn = llm.signedIn[which];
  return { installed: true, signedIn, busy: false, connectionMethod: which === 'claude' ? 'vault_setup_token' : undefined,
    detail: signedIn ? 'Subscription login saved in the Vault.' : 'No subscription login is saved in the Vault.',
    credential: { itemId: randomUUID(), revision: 1, state: signedIn ? 'ready' : 'empty' } };
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function readBody(req) {
  return new Promise(resolve => { let data = ''; req.on('data', c => data += c); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } }); });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;
  if (method !== 'GET' && path !== '/auth/csrf' && req.headers['x-josi-csrf'] !== 'mock-csrf') return send(res, 403, { error: 'Missing CSRF token' });
  const body = method === 'GET' ? {} : await readBody(req);
  let m;
  if (path === '/auth/csrf') return send(res, 200, { csrfToken: 'mock-csrf' }, { 'set-cookie': 'josi_csrf=mock-csrf; Path=/; HttpOnly; SameSite=Strict' });
  if (path === '/onboarding/state') return send(res, 200, { completed: true });
  if (path === '/auth/login' && method === 'POST') {
    if (body.password !== 'correct horse battery') return send(res, 401, { error: 'Incorrect username or password.' });
    return send(res, 200, { user }, { 'set-cookie': 'josi_session=mock; Path=/; HttpOnly; SameSite=Strict' });
  }
  if (path === '/auth/logout') return send(res, 200, {});
  if (path === '/assistant/threads' && method === 'GET') return send(res, 200, { threads });
  if (path === '/assistant/threads' && method === 'POST') {
    const id = randomUUID(); threads.unshift({ id, title: '' }); messages[id] = []; turns[id] = [];
    return send(res, 200, { thread: { id } });
  }
  if ((m = path.match(/^\/assistant\/threads\/([0-9a-f-]{36})$/))) return send(res, 200, { messages: messages[m[1]] || [] });
  if ((m = path.match(/^\/assistant\/threads\/([0-9a-f-]{36})\/turns$/))) {
    const id = m[1];
    if (method === 'GET') return send(res, 200, { turns: turns[id] || [] });
    const inbound = { id: randomUUID(), direction: 'in', body: body.message, attachments: [] };
    messages[id].push(inbound);
    const thread = threads.find(t => t.id === id); if (thread && !thread.title) thread.title = body.message.slice(0, 40);
    const turn = { id: randomUUID(), status: 'running', inbound_message_id: inbound.id, client_message_id: body.client_message_id };
    turns[id].push(turn);
    setTimeout(() => {
      if (/fail/i.test(body.message)) { turn.status = 'failed'; turn.error = { code: 'provider_error' }; return; }
      const reply = { id: randomUUID(), direction: 'out', body: `Got it — you said: *${body.message}*` };
      messages[id].push(reply); turn.status = 'completed'; turn.assistant_message_id = reply.id;
    }, 4000);
    return send(res, 200, { turn: { id: turn.id } });
  }
  if (path === '/assistant/work-goals') return send(res, 200, { goals });
  if (path === '/assistant/work-goals/stream') return send(res, 404, { error: 'Not supported by mock' });
  if ((m = path.match(/^\/assistant\/work-goals\/([0-9a-f-]{36})\/control$/))) {
    const goal = goals.find(g => g.goalId === m[1]); goal.revision++; goal.state = body.action === 'pause' ? 'paused' : body.action === 'cancel' ? 'cancelled' : 'working';
    goal.updatedAt = now(); return send(res, 200, { goal });
  }
  if ((m = path.match(/^\/assistant\/work-goals\/([0-9a-f-]{36})\/(events|plans|outcomes)$/)))
    return send(res, 200, { [m[2]]: [{ sequence: 1, plan_revision: 1, outcome_revision: 1, summary: 'Goal accepted', reason: 'Initial plan', outcome: goals[0].title, created_at: now(), steps: goals[0].steps, criteria: goals[0].criteria }] });
  if (path === '/assistant/tasks') return send(res, 200, { tasks: [] });
  if (path === '/assistant/task-runs') return send(res, 200, { runs: [{ id: randomUUID(), status: 'failed', thread_id: threadId, thread_title: 'Garage sale photo descriptions', updated_at: now(), error_code: 'provider_error' }] });
  if (path === '/admin/llm' && method === 'GET') return send(res, 200, {
    primary: llm.primary, fallback: llm.fallback, localOnly: false,
    caps: { monthly_cost_usd: null, monthly_tokens: 2000000 },
    disabledFeatures: llm.primary?.active ? [] : [{ feature: 'tool_calling', reason: 'the primary model has not passed its capability check' }],
    providerCatalog, subscriptionOptions,
  });
  if ((m = path.match(/^\/admin\/llm\/subscription(\/claude)?\/status$/))) return send(res, 200, { cli: subscriptionStatus(m[1] ? 'claude' : 'codex') });
  if (path === '/admin/llm/subscription/login' && method === 'POST') {
    llm.codexLogin = { state: 'awaiting_approval', challenge: { userCode: 'TEST-CODE1', verificationUrl: 'https://auth.openai.com/codex/device' },
      expiresAt: new Date(Date.now() + 900_000).toISOString(), message: null };
    setTimeout(() => { llm.codexLogin = { state: 'signed_in', challenge: null }; llm.signedIn.codex = true; }, 8000);
    return send(res, 200, llm.codexLogin);
  }
  if (path === '/admin/llm/subscription/claude/connect' && method === 'POST') {
    if (!/^sk-ant-oat01-/.test(body.token ?? '')) return send(res, 400, { error: 'That is not a Claude subscription token.' });
    await new Promise(resolve => setTimeout(resolve, 700));
    llm.signedIn.claude = true;
    return send(res, 200, { cli: subscriptionStatus('claude') });
  }
  if (path === '/admin/llm/subscription/login' && method === 'GET') return send(res, 200, llm.codexLogin ?? { state: 'idle', challenge: null });
  if (path === '/admin/llm/models' && method === 'POST') return send(res, 200, body.provider === 'anthropic'
    ? { ok: true, models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }], fromCatalog: true, allowsCustomModel: true }
    : { ok: true, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini' }], fromCatalog: false, allowsCustomModel: true });
  if ((m = path.match(/^\/admin\/llm\/providers\/(primary|fallback)$/)) && method === 'PUT') {
    llm[m[1]] = { role: m[1], provider: body.provider, model: body.model, baseUrl: body.baseUrl || null, apiKeySet: !!body.apiKey, providerConfig: {},
      external: body.provider !== 'ollama', externalAcknowledged: !!body.externalAcknowledged, active: false, probedAt: null, capabilities: null, probeSteps: [] };
    return send(res, 200, { provider: llm[m[1]] });
  }
  if ((m = path.match(/^\/admin\/llm\/providers\/(primary|fallback)\/probe$/))) {
    const saved = llm[m[1]];
    const steps = [{ label: 'Reply', detail: 'Answered a short question.', passed: true }, { label: 'Tools', detail: 'Called a Josi tool and used its result.', passed: true },
      { label: 'Images', detail: 'Described a test image.', passed: true }, { label: 'Structured answers', detail: 'Returned the requested JSON shape.', passed: true }];
    Object.assign(saved, { active: true, probedAt: now(), probeSteps: steps, capabilities: { chat: true, toolCalling: true, vision: true, structuredOutput: true, contextTokens: 200000 } });
    return send(res, 200, { provider: saved, result: { steps, fatal: null } });
  }
  if (path === '/admin/llm/providers/fallback' && method === 'DELETE') { llm.fallback = null; return send(res, 200, {}); }
  if (path === '/admin/llm/usage') return send(res, 200, { summary: { totalTokens: 18234, calls: 41, reportedCostUsd: 0, estimatedCostUsd: 0.12, subscriptionCalls: 41, selfHostedCalls: 0, notes: [] } });
  if (path === '/voice/status') return send(res, 200, { available: false });
  if (path === '/admin/voice-box') return send(res, 200, { verified: false, helperAvailable: true, releaseAvailable: true, settings: { voice: 'af_heart', model: 'base.en' } });
  if (path === '/persona/memories' && method === 'GET') return send(res, 200, { memories });
  if (path === '/persona/suggestions') return send(res, 200, { suggestions: [] });
  if (path === '/persona/settings') return send(res, 200, { settings: { memory_mode: 'manual' } });
  if (path === '/admin/vault') return send(res, 200, { status: { initialized: true, locked: false, boxes: 1, items: 3, keyVersion: 1, recoveryFingerprint: 'AB12-CD34', recentFailures: 0 } });
  if (path === '/admin/vault/migration') return send(res, 200, { sources: [{ legacyFields: 0 }] });
  if (path === '/vault') return send(res, 200, { status: { initialized: true, locked: false }, box: { unlocked: false, items: [] } });
  if (path === '/auth/mfa') return send(res, 200, { enabled: false });
  if (path.startsWith('/assistant/approval-levels/')) return send(res, 200, { level: 'risky_only', userChoice: 'risky_only', managedPolicy: false });
  if (path === '/admin/doctor') return send(res, 200, { available: true, diagnosis: { healthy: false, checkedAt: now(), checks: [
    { label: 'Database', state: 'pass', detail: 'Ready' }, { label: 'Worker heartbeat', state: 'pass', detail: 'Seen 1s ago' }, { label: 'Backups', state: 'warn', detail: 'No backup in the last 7 days.' }] } });
  if (path === '/assistant/automation/workspaces') return send(res, 200, { workspaces: [], blocker: { code: 'no_device', message: 'No device is connected for automation yet.' } });
  if (path === '/admin/automation') return send(res, 200, { rules: { document: { rules: [] } }, drafts: [], permissions: { document: { policies: [] } }, targets: {} });
  if (path === '/admin/automation/catalog') return send(res, 200, { actions: [], scopeKeys: [] });
  if (path === '/admin/automation/devices') return send(res, 200, { devices: [] });
  if (path === '/ops/admin/backups') return send(res, 200, { backups: [] });
  if (path === '/channels') return send(res, 200, { channels: [], links: [] });
  if (path === '/telegram') return send(res, 200, { channel: { enabled: false }, links: [] });
  return send(res, 404, { error: `Not available in the test fixture: ${method} ${path}` });
}).listen(port, '127.0.0.1', () => console.log(`mock Josi API on http://localhost:${port}`));
