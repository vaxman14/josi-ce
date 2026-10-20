/** Shared screening for known credential shapes in recalled work text.
 * This does not claim that arbitrary secret-looking prose can be identified. */
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'a password', re: /\b(pass(word|wd)|passphrase)\s*[:=]\s*\S+/i },
  // The same thing said in a sentence. "I always use the password hunter2" has
  // no delimiter, and the pattern above missed it entirely — found by the
  // live-turn test, where a person says such a thing in conversation rather
  // than pasting a config line.
  { name: 'a password', re: /\b(pass(word|wd)|passphrase|api key|secret key|access key)\b[\s:=]+\S{6,}/i },
  { name: 'an API key', re: /\b(sk|pk|api[_-]?key|token)[-_:=]\s*[A-Za-z0-9_-]{16,}/i },
  { name: 'a bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'a card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a sealed credential', re: /\bv1\.[A-Za-z0-9+/=]{8,}\./ },
];

export function refuseMemorySecret(content: string): string | null {
  for (const { name, re } of FORBIDDEN) {
    if (re.test(content)) return name;
  }
  return null;
}

