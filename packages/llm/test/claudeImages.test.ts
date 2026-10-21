import { describe, expect, it } from 'vitest';
import { claudeSubscriptionArgs, validClaudeSubscriptionArgs } from '../src/providers/claudeVaultPolicy.js';
import { claudeImages, parseClaudeResult, renderClaudeStructuredInput } from '../src/providers/claudeCli.js';

const image = { mediaType: 'image/png', base64: 'iVBORw0KGgo=' };

describe('Claude Code image turns', () => {
  it('permits the structured shape only as a whole, with the same restrictions', () => {
    const structured = claudeSubscriptionArgs('sonnet', null, true);
    expect(structured.slice(0, 6)).toEqual(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    expect(validClaudeSubscriptionArgs(structured)).toBe(true);
    expect(validClaudeSubscriptionArgs([...structured, '--tools', 'Read'])).toBe(false);
    // Half a structured shape is not accepted.
    const mixed = [...claudeSubscriptionArgs('sonnet')]; mixed.splice(1, 0, '--input-format', 'stream-json');
    expect(validClaudeSubscriptionArgs(mixed)).toBe(false);
  });

  it('sends the last user turn images as image blocks before the prompt', () => {
    const request = { messages: [{ role: 'user' as const, content: 'What is this?', images: [image, { mediaType: 'image/bmp', base64: 'Qk0=' }] }] };
    expect(claudeImages(request)).toEqual([image]);
    const line = JSON.parse(renderClaudeStructuredInput(request).trim());
    expect(line.type).toBe('user');
    expect(line.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.base64 } });
    expect(line.message.content[1].type).toBe('text');
    expect(line.message.content[1].text).toContain('What is this?');
  });

  it('reads the result event from stream-json output, including the signed-out trap', () => {
    const ok = '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{}}\n{"type":"result","result":"Red","is_error":false,"usage":{"input_tokens":10,"output_tokens":2}}\n';
    expect(parseClaudeResult(ok)).toEqual({ text: 'Red', isError: false, inputTokens: 10, outputTokens: 2 });
    const refused = '{"type":"system"}\n{"type":"result","result":"Not logged in · Please run /login","is_error":true}\n';
    expect(parseClaudeResult(refused)?.isError).toBe(true);
  });
});
