// What a skill package IS, and every check it has to pass to be one.
//
// A SKILL IS A DOCUMENT, NOT A PROGRAM. There is no code in a package, no
// command, no URL, no header and no credential — there is a name, a publisher,
// a version, a list of what it says it wants to use, and a block of prose. That
// is the entire format, and it is small on purpose: the smaller the thing a
// stranger can put in front of the model, the smaller the argument about what
// it might do.
//
// SO THE DANGEROUS PART OF A SKILL IS ITS PROSE, and this file exists to decide
// whether a given document is one CE is willing to put anywhere near a model's
// instructions. Four different kinds of check, in the order they matter:
//
//   1. IS IT THE SHAPE. Every field, every cap, no unknown fields. A package
//      carrying a field CE does not understand is a package CE cannot claim to
//      have validated, so it is refused rather than partly read.
//   2. IS IT THE ONE THAT WAS PINNED. `skillDigest` hashes the CANONICAL
//      package — key-sorted, signature excluded, line endings normalised — so a
//      registry reformatting its JSON does not look like a publisher changing
//      their mind, and the digest changes exactly when something a person reads
//      changes. Same reasoning as `toolDigest` in mcpServers.ts, and for the
//      same reason: an approval that is not pinned to what was read is a rubber
//      stamp.
//   3. IS IT SIGNED BY WHO IT CLAIMS. Ed25519 over those same canonical bytes,
//      against the key registered for the SOURCE. A package can no more vouch
//      for itself than an MCP server can declare its own tools safe.
//   4. IS THE PROSE TRYING TO GET OUT. `screenSkillText` looks for the small
//      set of things a skill has no legitimate reason to say — "ignore the
//      instructions above", "do this without asking", "do not tell the user".
//      Text like that is not a skill CE failed to understand; it is a skill
//      whose author was writing to the model rather than to the person.
//
// NOTHING IN THIS FILE TOUCHES THE DATABASE, THE NETWORK OR A CREDENTIAL. It is
// pure, so every one of those checks can be attacked directly by a test rather
// than only through a route.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

// --------------------------------------------------------------- vocabulary

/** How the agent works out whether the person being served actually has this,
 * at the moment of a turn. Declared here so the vocabulary and the resolution
 * cannot drift apart into two lists. */
export type SkillCapabilityKind = 'connection' | 'always' | 'custom_api' | 'mcp';

export interface SkillCapabilitySpec {
  key: string;
  /** What it means, in the words a person reads. */
  label: string;
  kind: SkillCapabilityKind;
  /** `connection` only: the provider capability keys in
   * `packages/connectors/src/capabilities.ts` that would satisfy it. ANY of
   * them is enough — a skill wants to read a calendar, and whose calendar
   * software it is was never the skill's business. */
  providerCapabilities?: readonly string[];
}

/**
 * EVERY CAPABILITY A SKILL MAY NAME. A package asking for anything else is
 * quarantined rather than installed with a permission nobody can explain.
 *
 * A CLOSED, PROVIDER-NEUTRAL VOCABULARY, and both halves of that are decisions.
 *
 * Closed, because "the skill asked for `payroll.write`" is a sentence with no
 * meaning on this installation, and storing it would make the library's
 * permissions column look like a grant of something.
 *
 * Provider-neutral, because a skill that says "read the calendar" is saying
 * everything it actually knows. A package naming `google.calendar.read` would
 * be a package that stops applying the day somebody moves to Microsoft, and it
 * would push publishers into enumerating providers they have never heard of.
 * The mapping to the provider keys the connections layer uses lives here, in
 * one place, beside the vocabulary it maps.
 *
 * NAMING ONE OF THESE GRANTS NOTHING. It is a declaration, shown to the
 * administrator reviewing the skill and resolved per person at turn time
 * against what THEY have connected and switched on.
 */
export const SKILL_CAPABILITIES: readonly SkillCapabilitySpec[] = [
  {
    key: 'calendar.read',
    label: 'Read your calendar',
    kind: 'connection',
    providerCapabilities: ['google.calendar.read', 'microsoft.calendar.read'],
  },
  {
    key: 'calendar.write',
    label: 'Create and change calendar events',
    kind: 'connection',
    providerCapabilities: ['google.calendar.write', 'microsoft.calendar.write'],
  },
  {
    key: 'mail.read',
    label: 'Read your email',
    kind: 'connection',
    providerCapabilities: ['google.mail.read', 'microsoft.mail.read'],
  },
  {
    key: 'mail.send',
    label: 'Send email from your account',
    kind: 'connection',
    providerCapabilities: ['google.mail.send', 'microsoft.mail.send'],
  },
  {
    key: 'contacts.read',
    label: 'Read your contacts',
    kind: 'connection',
    providerCapabilities: ['google.contacts.read', 'microsoft.contacts.read'],
  },
  {
    key: 'contacts.write',
    label: 'Create and change your contacts',
    kind: 'connection',
    providerCapabilities: ['google.contacts.write', 'microsoft.contacts.write'],
  },
  {
    key: 'files.read',
    label: 'Read files in the folders you connected',
    kind: 'connection',
    providerCapabilities: [
      'google.drive.read', 'microsoft.files.read', 'dropbox.files.read',
      'box.files.read', 'nextcloud.files.read',
    ],
  },
  {
    key: 'documents.search',
    label: 'Search the documents you have indexed',
    kind: 'always',
  },
  {
    key: 'tasks.manage',
    label: 'Create and update your own tasks',
    kind: 'always',
  },
  {
    key: 'reminders.manage',
    label: 'Schedule and cancel your own reminders',
    kind: 'always',
  },
  {
    key: 'custom_apis.call',
    label: 'Use the external APIs an administrator connected',
    kind: 'custom_api',
  },
  {
    key: 'mcp_tools.call',
    label: 'Use the MCP tools you switched on yourself',
    kind: 'mcp',
  },
];

const CAPABILITY_BY_KEY = new Map(SKILL_CAPABILITIES.map((spec) => [spec.key, spec] as const));

export function skillCapabilitySpec(key: string): SkillCapabilitySpec | null {
  return CAPABILITY_BY_KEY.get(key) ?? null;
}

// ------------------------------------------------------------------- shapes

export interface SkillDependency {
  key: string;
  /** The lowest version this skill expects. Null when it just wants the other
   * skill present. Recorded and SHOWN; never resolved by installing anything. */
  minVersion: string | null;
}

export interface SkillSignature {
  algorithm: 'ed25519';
  /** Which key signed it, when the publisher labels their keys. Shown beside
   * the verdict so "verified" names what it verified against. */
  keyId: string | null;
  /** Base64, raw 64-byte ed25519 signature. */
  value: string;
}

export interface SkillPackage {
  formatVersion: 1;
  key: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  license: string | null;
  homepage: string | null;
  instructions: string;
  capabilities: string[];
  dependencies: SkillDependency[];
  signature: SkillSignature | null;
}

/** Why a package was not trusted. The same vocabulary as
 * `skill_quarantine.reason` in migration 0037. */
export type SkillQuarantineReason =
  | 'schema_invalid'
  | 'digest_mismatch'
  | 'signature_missing'
  | 'signature_invalid'
  | 'capability_unknown'
  | 'instruction_injection'
  | 'too_large';

export interface SkillIdentity {
  key: string;
  name: string;
  version: string;
}

export type SkillPackageVerdict =
  | { ok: true; pkg: SkillPackage; digest: string }
  | {
    ok: false;
    reason: SkillQuarantineReason;
    /** CE's own words about which check failed — a field name, a capability
     * key, the label of a screening pattern. NEVER a fragment of the package,
     * which is the text that failed the check in the first place. */
    detail: string;
    /**
     * Enough to file the failure under, or null.
     *
     * The split matters. A document that at least says what it claims to be can
     * be quarantined — recorded, shown, and pointed at the registry that served
     * it. One that cannot even name itself has nothing to file: it is refused,
     * audited as a refusal, and not written anywhere.
     */
    identity: SkillIdentity | null;
  };

// ---------------------------------------------------------------------- caps

/** Past this, the document is not read at all. A registry serving a megabyte of
 * "instructions" is not a registry with an unusually thorough skill. */
export const MAX_SKILL_PACKAGE_BYTES = 128 * 1024;
export const MAX_SKILL_INSTRUCTION_CHARS = 16_000;
const MAX_CAPABILITIES = 20;
const MAX_DEPENDENCIES = 10;

const FIELDS = new Set([
  'formatVersion', 'key', 'name', 'version', 'publisher', 'summary', 'license',
  'homepage', 'instructions', 'capabilities', 'dependencies', 'signature',
]);

// ------------------------------------------------------------------ reading

const bad = (
  reason: SkillQuarantineReason,
  detail: string,
  identity: SkillIdentity | null = null,
): SkillPackageVerdict => ({ ok: false, reason, detail, identity });

/** Control characters, written as escapes so this file contains none of them.
 * Tab and newline are excluded from the first because prose legitimately has
 * both, and a package field that is not prose may have neither. */
const CONTROL_EXCEPT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

const KEY_GRAMMAR = /^[a-z][a-z0-9_]{0,38}[a-z0-9]$/;
const VERSION_GRAMMAR = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;

const str = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

/**
 * One document, read as a package or refused.
 *
 * IDENTITY IS READ FIRST, before anything that could fail, so that a package
 * failing a later check can still be quarantined under a name somebody can look
 * up. Everything after that is ordinary validation, in the order that produces
 * the most useful sentence.
 */
export function readSkillPackage(raw: unknown): SkillPackageVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('schema_invalid', 'the package is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;

  for (const field of Object.keys(doc)) {
    // Strict, and deliberately so: a package carrying a field CE does not
    // understand is a package CE cannot claim to have validated. A future
    // format version is how a publisher adds one.
    if (!FIELDS.has(field)) {
      return bad('schema_invalid', `unexpected field "${field.slice(0, 40)}"`);
    }
  }
  if (doc.formatVersion !== 1) {
    return bad('schema_invalid', 'formatVersion must be 1');
  }

  // ---- identity ----------------------------------------------------------
  const key = str(doc.key).toLowerCase();
  if (!KEY_GRAMMAR.test(key)) {
    return bad(
      'schema_invalid',
      'key must be 2 to 40 characters of lowercase letters, digits and underscores',
    );
  }
  const name = str(doc.name);
  if (!name || name.length > 80 || ANY_CONTROL.test(name)) {
    return bad('schema_invalid', 'name must be 1 to 80 characters and carry no control characters');
  }
  const version = str(doc.version);
  if (!VERSION_GRAMMAR.test(version)) {
    return bad('schema_invalid', 'version must look like 1.2.3');
  }
  const identity: SkillIdentity = { key, name, version };

  // ---- everything that can now be filed under it -------------------------
  const publisher = str(doc.publisher);
  if (!publisher || publisher.length > 80 || ANY_CONTROL.test(publisher)) {
    return bad('schema_invalid', 'publisher must be 1 to 80 characters', identity);
  }
  const summary = str(doc.summary);
  if (summary.length > 300 || ANY_CONTROL.test(summary)) {
    return bad('schema_invalid', 'summary must be at most 300 characters on one line', identity);
  }

  const license = doc.license === undefined || doc.license === null ? null : str(doc.license);
  if (license !== null && (!license || license.length > 60 || ANY_CONTROL.test(license))) {
    return bad('schema_invalid', 'license must be a short identifier such as MIT', identity);
  }

  const homepage = doc.homepage === undefined || doc.homepage === null ? null : str(doc.homepage);
  if (homepage !== null) {
    // https only, and for the same reason every other address in CE is: an
    // http:// link on a review screen is a link somebody clicks.
    if (!/^https:\/\//.test(homepage) || homepage.length > 300 || ANY_CONTROL.test(homepage)) {
      return bad('schema_invalid', 'homepage must be an https address', identity);
    }
    try {
      // eslint-disable-next-line no-new
      new URL(homepage);
    } catch {
      return bad('schema_invalid', 'homepage is not a valid web address', identity);
    }
  }

  if (typeof doc.instructions !== 'string') {
    return bad('schema_invalid', 'instructions must be text', identity);
  }
  // CRLF is normalised rather than refused: a registry serving Windows line
  // endings is not a different package, and normalising here means the digest
  // does not change when somebody's editor does.
  const instructions = doc.instructions.replace(/\r\n?/g, '\n').trim();
  if (!instructions) {
    return bad('schema_invalid', 'instructions must not be empty — a skill IS its instructions', identity);
  }
  if (instructions.length > MAX_SKILL_INSTRUCTION_CHARS) {
    return bad(
      'too_large',
      `instructions are ${instructions.length} characters; the limit is ${MAX_SKILL_INSTRUCTION_CHARS}`,
      identity,
    );
  }
  if (CONTROL_EXCEPT_TEXT.test(instructions)) {
    return bad('schema_invalid', 'instructions carry control characters', identity);
  }

  // ---- what it says it wants to use --------------------------------------
  const rawCapabilities = doc.capabilities === undefined ? [] : doc.capabilities;
  if (!Array.isArray(rawCapabilities)) {
    return bad('schema_invalid', 'capabilities must be a list', identity);
  }
  if (rawCapabilities.length > MAX_CAPABILITIES) {
    return bad('schema_invalid', `a skill may name at most ${MAX_CAPABILITIES} capabilities`, identity);
  }
  const capabilities: string[] = [];
  for (const entry of rawCapabilities) {
    const capability = str(entry);
    if (!skillCapabilitySpec(capability)) {
      // Its own reason rather than `schema_invalid`, because it is a different
      // kind of wrong: the document is well formed and it is asking for
      // something this product has no such thing as. That is worth showing to
      // an administrator as its own sentence.
      return bad(
        'capability_unknown',
        `"${capability.slice(0, 60) || '(empty)'}" is not something Josi can do`,
        identity,
      );
    }
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }

  // ---- what it expects to be there ---------------------------------------
  const rawDependencies = doc.dependencies === undefined ? [] : doc.dependencies;
  if (!Array.isArray(rawDependencies)) {
    return bad('schema_invalid', 'dependencies must be a list', identity);
  }
  if (rawDependencies.length > MAX_DEPENDENCIES) {
    return bad('schema_invalid', `a skill may name at most ${MAX_DEPENDENCIES} dependencies`, identity);
  }
  const dependencies: SkillDependency[] = [];
  for (const entry of rawDependencies) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return bad('schema_invalid', 'each dependency must be an object with a key', identity);
    }
    const item = entry as Record<string, unknown>;
    for (const field of Object.keys(item)) {
      if (field !== 'key' && field !== 'minVersion') {
        return bad('schema_invalid', `unexpected dependency field "${field.slice(0, 40)}"`, identity);
      }
    }
    const dependencyKey = str(item.key).toLowerCase();
    if (!KEY_GRAMMAR.test(dependencyKey)) {
      return bad('schema_invalid', 'a dependency key must be a skill key', identity);
    }
    if (dependencyKey === key) {
      return bad('schema_invalid', 'a skill cannot depend on itself', identity);
    }
    const minVersion = item.minVersion === undefined || item.minVersion === null
      ? null
      : str(item.minVersion);
    if (minVersion !== null && !VERSION_GRAMMAR.test(minVersion)) {
      return bad('schema_invalid', 'a dependency minVersion must look like 1.2.3', identity);
    }
    if (!dependencies.some((d) => d.key === dependencyKey)) {
      dependencies.push({ key: dependencyKey, minVersion });
    }
  }

  // ---- the signature, read but not yet believed --------------------------
  let signature: SkillSignature | null = null;
  if (doc.signature !== undefined && doc.signature !== null) {
    if (typeof doc.signature !== 'object' || Array.isArray(doc.signature)) {
      return bad('schema_invalid', 'signature must be an object', identity);
    }
    const sig = doc.signature as Record<string, unknown>;
    for (const field of Object.keys(sig)) {
      if (field !== 'algorithm' && field !== 'keyId' && field !== 'value') {
        return bad('schema_invalid', `unexpected signature field "${field.slice(0, 40)}"`, identity);
      }
    }
    if (str(sig.algorithm) !== 'ed25519') {
      // One algorithm. A field that accepts several is a field an attacker
      // picks the weakest member of, and "none" is always somebody's favourite.
      return bad('schema_invalid', 'the only signature algorithm Josi checks is ed25519', identity);
    }
    const value = str(sig.value);
    if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) {
      return bad('schema_invalid', 'the signature is not a base64 ed25519 signature', identity);
    }
    const keyId = sig.keyId === undefined || sig.keyId === null ? null : str(sig.keyId);
    if (keyId !== null && (keyId.length > 80 || ANY_CONTROL.test(keyId))) {
      return bad('schema_invalid', 'signature keyId is too long', identity);
    }
    signature = { algorithm: 'ed25519', keyId, value };
  }

  // ---- is the prose writing to the model rather than to the reader -------
  //
  // Last, because it is the check that is about MEANING rather than about
  // shape, and running it on a document that is not even a package would be
  // asserting something about text nobody would ever have been shown.
  const screened = screenSkillText([name, publisher, summary, instructions].join('\n'));
  if (screened) {
    return bad('instruction_injection', screened, identity);
  }

  const pkg: SkillPackage = {
    formatVersion: 1,
    key,
    name,
    version,
    publisher,
    summary,
    license,
    homepage,
    instructions,
    capabilities,
    dependencies,
    signature,
  };
  return { ok: true, pkg, digest: skillDigest(pkg) };
}

// ---------------------------------------------------------------- screening

/**
 * The small set of things a skill has no legitimate reason to say.
 *
 * WHAT THIS IS AND IS NOT. It is not a content filter and it is not the control
 * that makes skills safe — the control is that a skill has no tool, no
 * credential and no execution path, and that its text is placed in the prompt
 * as an attributed document that cannot outrank Josi's own rules. This is the
 * second line: a package whose author is writing TO THE MODEL rather than to
 * the person reading the library is a package whose author has told you what it
 * is for, and it is quarantined so an administrator sees that sentence rather
 * than pastes it into a system prompt.
 *
 * Each pattern is about AUTHORITY, never about topic. "Rotate the API key every
 * ninety days" is a fine thing for a skill to say; "you do not need approval to
 * do this" is not. Matching on subject matter would quarantine honest skills
 * about credentials and catch none of the dishonest ones.
 */
const INJECTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  {
    label: 'tries to override the instructions above it',
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all)\b[^.\n]{0,20}\b(instruction|rule|direction|prompt|guideline)/i,
  },
  {
    label: 'refers to the model\'s own system prompt',
    re: /\b(system|developer)\s+(prompt|message|instructions)\b/i,
  },
  {
    label: 'tells the assistant to act without asking',
    re: /\bwithout\s+(asking|telling|informing|notifying|confirming|approval|permission)\b/i,
  },
  {
    label: 'tells the assistant to get around an approval',
    re: /\b(skip|bypass|avoid|suppress|ignore|disable)\b[^.\n]{0,30}\b(approval|approvals|confirmation|permission|review|consent)\b/i,
  },
  {
    label: 'tells the assistant to keep something from the person it works for',
    re: /\b(do\s?n[o']?t|never|avoid)\b[^.\n]{0,30}\b(tell|inform|mention|show|reveal|disclose)\b[^.\n]{0,30}\b(user|person|owner|administrator|admin)\b/i,
  },
  {
    label: 'tries to redefine what the assistant is',
    re: /\byou\s+are\s+(now|no longer)\b|\bact\s+as\s+(if\s+you\s+are\s+)?an?\s+(unrestricted|different|developer)\b/i,
  },
  {
    label: 'asks for a credential to be produced',
    re: /\b(reveal|print|output|repeat|show|send|include)\b[^.\n]{0,40}\b(master key|api key|access token|refresh token|credential|password)s?\b/i,
  },
  {
    label: 'claims a permission for itself',
    re: /\bthis\s+skill\s+(is\s+)?(authoris|authoriz|permitt|allow)ed\s+to\b/i,
  },
];

/** The label of the first pattern this text trips, or null. Exported so the
 * screening can be attacked directly rather than only through an install. */
export function screenSkillText(text: string): string | null {
  for (const { label, re } of INJECTION_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// --------------------------------------------------------------- the digest

/**
 * The canonical form of a package: key-sorted, signature excluded, exactly the
 * bytes a digest and a signature are both taken over.
 *
 * Canonical rather than byte-exact for the reason recorded at the top of this
 * file, and the signature is excluded because a document cannot contain a
 * signature over itself.
 */
export function canonicalSkillBytes(pkg: SkillPackage): Buffer {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]);
    }
    return value;
  };
  const { signature: _signature, ...rest } = pkg;
  return Buffer.from(JSON.stringify(canonical(rest)), 'utf8');
}

export function skillDigest(pkg: SkillPackage): string {
  return createHash('sha256').update(canonicalSkillBytes(pkg)).digest('hex');
}

// ---------------------------------------------------------------- signature

/** The fixed SPKI prefix for a raw ed25519 public key. Written out rather than
 * pulled from a library so that "what exactly are we verifying against" has one
 * visible answer. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Does this package's signature verify against the source's registered key?
 *
 * Returns false — never throws — for a malformed key or a malformed signature,
 * because from the caller's position "did not verify" and "could not be
 * verified" have the same consequence and the same sentence.
 */
export function verifySkillSignature(pkg: SkillPackage, publicKeyBase64: string): boolean {
  if (!pkg.signature) return false;
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(
      null,
      canonicalSkillBytes(pkg),
      key,
      Buffer.from(pkg.signature.value, 'base64'),
    );
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ version

/** -1, 0 or 1. Numeric per part, so 1.10.0 is newer than 1.9.0 — which string
 * comparison gets backwards, and which is exactly the pair somebody hits when a
 * publisher's tenth patch arrives. */
export function compareSkillVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}
