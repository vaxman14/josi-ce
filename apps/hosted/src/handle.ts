// A handle is the person's address: <handle>.heyjosi.com. These rules match what
// the relay accepts in a grant, so an account can't hold a name the relay refuses.

// Copied from services/relay/src/index.js. A test compares the two.
export const RESERVED = new Set(['www', 'relay', 'ce', 'get', 'help', 'api', 'ai', 'app', 'admin', 'account', 'accounts', 'auth', 'billing', 'mail', 'smtp', 'imap', 'status', 'docs', 'blog', 'support', 'cdn', 'assets', 'static', 'dev', 'staging', 'test', 'root', 'josi', 'hey', 'login', 'signup', 'pay', 'stripe', 'google', 'oauth']);

export const HANDLE_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export const validHandle = (handle: string): boolean => HANDLE_RE.test(handle) && !handle.includes('--') && !RESERVED.has(handle);
