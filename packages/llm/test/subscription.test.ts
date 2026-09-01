// Noncommercial subscription authentication (L3).
//
// Three things are under test and only one of them is "does it work":
//
//   1. It delegates rather than impersonates — the exact documented command,
//      the operator's own login, no credential touched anywhere.
//   2. It is honest — no invented token counts, no invented cost, no tool
//      calling pretended into existence.
//   3. It cannot exist outside CE — the boundary is asserted from a hosted
//      profile, since no hosted build exists to try.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityUnavailable, computeProfile } from '@josi-ce/core';
import {
  DEFAULT_CODEX_COMMAND, childEnvironment, classifyExit, codexArgs, codexCliProvider,
  extractReply, isSubscriptionProvider, renderPrompt,
  type SpawnRunner,
} from '../src/providers/codexCli.js';
import { EXTERNAL_PROVIDERS, LlmError, isExternalProvider } from '../src/types.js';
import { priceCall } from '../src/metering.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A runner that records what it was asked to do and answers. */
function fakeRunner(over: Partial<{ stdout: string; stderr: string; code: number; timedOut: boolean }> = {}) {
  const calls: Array<Parameters<SpawnRunner>[0]> = [];
  const runner: SpawnRunner = async (args) => {
    calls.push(args);
    return {
      code: over.code ?? 0,
      stdout: over.stdout ?? JSON.stringify({ type: 'agent_message', message: 'Hello from Codex.' }),
      stderr: over.stderr ?? '',
      timedOut: over.timedOut ?? false,
    };
  };
  return { runner, calls };
}

describe('it delegates to the documented CLI and nothing else (L3.2)', () => {
  it('runs the exact non-interactive form OpenAI documents', () => {
    expect(codexArgs('gpt-5-codex')).toEqual([
      'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--model', 'gpt-5-codex', '-',
    ]);
  });

  it('gives the model no way to touch the machine', () => {
    const args = codexArgs('m');
    // Josi's tool permissions are enforced by routes reading database rows. A
    // subprocess that could write files or run commands would sit entirely
    // outside them.
    expect(args).toContain('read-only');
    expect(args.join(' ')).not.toContain('--full-auto');
    expect(args.join(' ')).not.toContain('workspace-write');
    expect(args.join(' ')).not.toContain('danger');
  });

  it('sends the prompt on stdin, never in argv', async () => {
    const { runner, calls } = fakeRunner();
    const provider = codexCliProvider({ model: 'm', runner });
    await provider.chat({ messages: [{ role: 'user', content: 'my private question' }] });
    // An argv is world-readable in the process table on most systems, and the
    // prompt is somebody's private conversation.
    expect(calls[0].args.join(' ')).not.toContain('my private question');
    expect(calls[0].input).toContain('my private question');
  });

  it('defaults to `codex` on PATH and honours an operator-set path', async () => {
    const a = fakeRunner();
    await codexCliProvider({ model: 'm', runner: a.runner }).chat({ messages: [] });
    expect(a.calls[0].command).toBe(DEFAULT_CODEX_COMMAND);

    const b = fakeRunner();
    await codexCliProvider({ model: 'm', command: '/opt/codex/bin/codex', runner: b.runner })
      .chat({ messages: [] });
    expect(b.calls[0].command).toBe('/opt/codex/bin/codex');
  });

  it('makes no HTTP request of its own', () => {
    const source = readFileSync(
      join(ROOT, 'packages/llm/src/providers/codexCli.ts'), 'utf8',
    );
    // CE speaks to no OpenAI endpoint on this path. The CLI does.
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('https://api.openai.com');
    expect(source).not.toContain('XMLHttpRequest');
  });
});

describe('it never touches a credential (L3.3)', () => {
  it('strips every OpenAI key variable from the child environment', () => {
    // THE most important assertion in this file. Codex prefers an API key when
    // one is in the environment, and the server process may well have one — so
    // "use my subscription" would quietly bill an API account. Deleting the
    // variables means the child has no key to prefer.
    const env = childEnvironment({
      OPENAI_API_KEY: 'sk-should-not-survive',
      OPENAI_KEY: 'also-not',
      OPENAI_BASE_URL: 'https://elsewhere.example',
      OPENAI_ORG_ID: 'org-1',
      PATH: '/usr/bin',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_ORG_ID).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('should-not-survive');
    // And it keeps what the child legitimately needs.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips the installation\'s own secrets too', () => {
    const env = childEnvironment({
      PGPASSWORD: 'dbpass', DATABASE_URL: 'postgres://u:p@h/db', MASTER_KEY_FILE: '/run/secrets/k',
    });
    // A subprocess is the classic way an environment leaks into a log.
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MASTER_KEY_FILE).toBeUndefined();
  });

  it('cannot be narrowed out of its own boundary by the child', () => {
    // If the child inherited JOSI_DISABLED_CAPABILITIES it could not widen
    // anything, but leaving Josi's own configuration in a foreign process is
    // needless.
    expect(childEnvironment({ JOSI_DISABLED_CAPABILITIES: 'x' }).JOSI_DISABLED_CAPABILITIES)
      .toBeUndefined();
  });
});

/**
 * The repository-wide guard.
 *
 * L3.3 says "never scrape browser cookies", and a test that only checks the new
 * file proves nothing about the next one. So this walks every source file in
 * the repository and fails on any reference to a credential store.
 */
describe('no code path in the repository reads a credential store (L3.3)', () => {
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/\.codex\/auth\.json/, "the Codex CLI's credential file"],
    [/\.claude\/\.credentials\.json/, "Claude Code's credential file"],
    [/\.config\/gh\/hosts\.yml/, "the gh CLI's credential file"],
    [/Library\/Application Support\/Google\/Chrome/, "Chrome's profile"],
    [/Library\/Keychains|security find-generic-password/, 'the macOS keychain'],
    [/libsecret|gnome-keyring|secret-tool/, 'the Linux keyring'],
    [/Cookies\b.*sqlite|cookies\.sqlite/, 'a browser cookie jar'],
    [/\bkeytar\b/, 'the keytar credential module'],
  ];

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'docs-site'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !full.includes('/test/')) out.push(full);
    }
    return out;
  }

  it('finds nothing, anywhere', () => {
    const findings: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(text)) findings.push(`${file.slice(ROOT.length + 1)}: ${what}`);
      }
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('and the guard itself would notice', () => {
    // A scanner that matches nothing is indistinguishable from a scanner that
    // is broken.
    const sample = 'const p = homedir() + "/.codex/auth.json";';
    expect(FORBIDDEN.some(([pattern]) => pattern.test(sample))).toBe(true);
  });
});

describe('it is honest about what it cannot do (L3.4)', () => {
  it('reports no tokens and no cost rather than inventing them', async () => {
    const { runner } = fakeRunner();
    const response = await codexCliProvider({ model: 'm', runner })
      .chat({ messages: [{ role: 'user', content: 'hi' }] });
    // Inventing an estimate here would put a fabricated number into the usage
    // ledger and against a currency cap.
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(response.reportedCostUsd).toBe(0);
  });

  it('prices a call as `subscription`, not as `estimated` or `none`', async () => {
    const db = { query: async () => [] };
    const cost = await priceCall(db as never, {
      provider: 'openai_subscription', model: 'm',
      usage: { inputTokens: 0, outputTokens: 0 }, external: true,
    });
    expect(cost.source).toBe('subscription');
    expect(cost.costUsd).toBe(0);
    // A subscription IS a provider charge, just not a per-call one. The note
    // has to say that rather than "no provider charge".
    expect(cost.note).toContain('ChatGPT plan');
    expect(cost.note).not.toContain('No provider charge');
  });

  it('refuses a tool call rather than silently dropping it', async () => {
    const { runner } = fakeRunner();
    const provider = codexCliProvider({ model: 'm', runner });
    // An agent that asked for tools and got prose back would report success
    // having done nothing.
    await expect(provider.chat({
      messages: [{ role: 'user', content: 'book it' }],
      tools: [{ name: 'x', description: 'x', parameters: {} }],
    })).rejects.toThrow(/cannot call tools/);
  });

  it('is EXTERNAL, so Local-only refuses it and acknowledgement is required', () => {
    // The bytes reach OpenAI. Which binary carries them changes who holds the
    // credential and changes nothing about where the conversation goes.
    expect(isExternalProvider('openai_subscription')).toBe(true);
    expect(EXTERNAL_PROVIDERS).toContain('openai_subscription');
    expect(codexCliProvider({ model: 'm', runner: fakeRunner().runner }).external).toBe(true);
  });

  it('is recognised as a subscription provider, and nothing else is', () => {
    expect(isSubscriptionProvider('openai_subscription')).toBe(true);
    for (const other of ['openai', 'anthropic', 'anthropic_subscription', 'xai', 'openai_compatible']) {
      expect(isSubscriptionProvider(other), other).toBe(false);
    }
  });
});

describe('reading the CLI\'s answer', () => {
  it('takes the last agent message from JSON Lines', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', id: 't1' }),
      JSON.stringify({ type: 'agent_message', message: 'first' }),
      JSON.stringify({ type: 'agent_message', message: 'final answer' }),
    ].join('\n');
    expect(extractReply(stdout)).toBe('final answer');
  });

  it('understands the item-envelope shape too', () => {
    const stdout = JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: 'from an item' },
    });
    expect(extractReply(stdout)).toBe('from an item');
  });

  it('understands a content-array shape', () => {
    const stdout = JSON.stringify({
      type: 'agent_message', content: [{ text: 'part one ' }, { text: 'part two' }],
    });
    expect(extractReply(stdout)).toBe('part one part two');
  });

  it('falls back to plain output when there is no JSON', () => {
    // An older CLI, or one run without --json. Binding to one event schema
    // would break silently the next time the CLI is updated.
    expect(extractReply('Just the answer.\n')).toBe('Just the answer.');
  });

  it('drops obvious log lines from the fallback', () => {
    expect(extractReply('2026-09-01T00:00:00Z starting\nThe answer.\n')).toBe('The answer.');
  });

  it('ignores unparsable lines instead of throwing', () => {
    expect(extractReply('{not json\n{"type":"agent_message","message":"ok"}')).toBe('ok');
  });

  it('treats an empty answer as a failure rather than an empty reply', async () => {
    const { runner } = fakeRunner({ stdout: '   \n  ' });
    await expect(codexCliProvider({ model: 'm', runner }).chat({ messages: [] }))
      .rejects.toThrow(/returned nothing/);
  });
});

describe('failures say what to do, and never quote the CLI', () => {
  it('names the sign-in step when the CLI is not logged in', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'error: not logged in, run `codex login`' });
    await expect(codexCliProvider({ model: 'm', runner }).chat({ messages: [] }))
      .rejects.toThrow(/not signed in/);
  });

  it('names the shared quota when the plan is exhausted', async () => {
    const err = classifyExit('You have hit your usage limit (429)', 'codex');
    expect(err.message).toContain('usage limit');
    // Shared with the operator's own Codex sessions, which is the surprising
    // part and therefore the part worth saying.
    expect(err.message).toContain('same allowance');
    expect(err.retryable).toBe(true);
  });

  it('tells the operator to update an old CLI', () => {
    expect(classifyExit('error: unknown option `--json`', 'codex').message)
      .toContain('Update the Codex CLI');
  });

  it('never echoes stderr, which can contain the prompt', () => {
    const stderr = 'failed while processing: "my bank pin is 1234"';
    for (const err of [
      classifyExit(stderr, 'codex'),
      classifyExit(`network error while sending ${stderr}`, 'codex'),
    ]) {
      expect(err.message).not.toContain('1234');
      expect(err.message).not.toContain('bank pin');
    }
  });

  it('reports a timeout as retryable rather than as a broken install', async () => {
    const { runner } = fakeRunner({ timedOut: true });
    await expect(codexCliProvider({ model: 'm', runner }).chat({ messages: [] }))
      .rejects.toMatchObject({ retryable: true });
  });
});

describe('the prompt it builds', () => {
  it('flattens the conversation into labelled turns', () => {
    const prompt = renderPrompt({
      system: 'You are Josi.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'what next' },
      ],
    });
    expect(prompt).toContain('You are Josi.');
    expect(prompt).toContain('User: hello');
    expect(prompt).toContain('Assistant: hi');
    expect(prompt.trimEnd().endsWith('Assistant:')).toBe(true);
  });

  it('skips empty turns', () => {
    expect(renderPrompt({ messages: [{ role: 'user', content: '' }] })).toBe('Assistant:');
  });
});

describe('the edition boundary refuses it outside CE (L3.6, L4.3)', () => {
  it('CE may build it', () => {
    expect(() => codexCliProvider({ model: 'm', runner: fakeRunner().runner })).not.toThrow();
  });

  it('a build without the capability cannot, and says so', () => {
    // The factory reads the process's own profile, so this asserts the shape
    // of the refusal rather than substituting a profile — the substituted-
    // profile case is covered in `packages/core/test/edition.test.ts` and, over
    // the wire, in `apps/api/test/subscription.test.ts`.
    const hosted = computeProfile({ stamp: 'hosted', env: {} });
    expect(hosted.capabilities).toEqual([]);
    const err = new CapabilityUnavailable('subscription_auth', 'hosted');
    expect(err.message).toContain('no setting can add it');
  });

  it('the provider file asserts BOTH capabilities, not just one', () => {
    const source = readFileSync(join(ROOT, 'packages/llm/src/providers/codexCli.ts'), 'utf8');
    // Spawning a process and spawning THIS process are two different
    // permissions, and a hosted build must fail the first one too.
    expect(source).toContain("assertCapability('local_command_execution')");
    expect(source).toContain("assertCapability('subscription_auth')");
  });
});

describe('there is no Anthropic path, and the absence is deliberate (L3.5)', () => {
  it('no subscription provider exists for Anthropic', () => {
    expect(isSubscriptionProvider('anthropic_subscription')).toBe(false);
    expect(isSubscriptionProvider('claude_subscription')).toBe(false);
  });

  it('nothing in the LLM package tries to run Claude Code', () => {
    const dir = join(ROOT, 'packages/llm/src');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (f.endsWith('.ts')) out.push(f);
      }
      return out;
    };
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      // A comment may explain why it is absent; a spawn of it may not exist.
      expect(text, file).not.toMatch(/spawn\([^)]*['"]claude['"]/);
      expect(text, file).not.toMatch(/claude-agent-sdk/);
    }
  });
});

describe('LlmError shape is preserved', () => {
  it('a not-found binary asks for an install rather than reporting a crash', async () => {
    const runner: SpawnRunner = async () => {
      const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const error = await codexCliProvider({ model: 'm', runner })
      .chat({ messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain('was not found');
    expect((error as LlmError).needsReconfiguration).toBe(true);
  });
});
