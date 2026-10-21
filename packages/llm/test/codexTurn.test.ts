import { describe, expect, it } from 'vitest';
import { codexCliProvider, type SpawnRunner } from '../src/providers/codexCli.js';
import { parseCodexTurn, renderCodexTurn } from '../src/providers/codexTurn.js';
import type { ChatRequest } from '../src/types.js';

const request: ChatRequest = { toolExecution: 'caller', messages: [
  { role: 'user', content: 'Describe the photo', images: [{ mediaType: 'image/jpeg', base64: Buffer.from('photo bytes').toString('base64') }] },
], tools: [{ name: 'fill', description: 'Fill the observed field', parameters: {
  type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 20 } },
} }] };
const proposal = (name = 'fill', args: unknown = { text: 'Red chair' }) => JSON.stringify({ reply: '', tool: { name, arguments: JSON.stringify(args) } });

describe('ChatGPT caller-owned steps', () => {
  it('attaches bytes and a strict response schema without granting the CLI an MCP tool server', async () => {
    const runner: SpawnRunner = async call => {
      expect(call.args).toContain('--ephemeral');
      expect(call.args).toContain('--output-schema');
      expect(call.args).toContain('--image');
      expect(call.args).toContain('josi-image-0.jpg');
      expect(call.args.join(' ')).not.toContain('mcp_servers');
      expect(call.input).not.toContain(request.messages[0].images![0].base64);
      expect(call.privateFiles?.find(f => f.name === 'josi-image-0.jpg')?.base64).toBe(request.messages[0].images![0].base64);
      const schema = JSON.parse(Buffer.from(call.privateFiles!.find(f => f.name.endsWith('.json'))!.base64, 'base64').toString());
      expect(schema.additionalProperties).toBe(false);
      return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ type: 'agent_message', message: proposal() }) };
    };
    const result = await codexCliProvider({ model: 'test-model', runner, mcpServerPath: null }).chat(request);
    expect(result.toolCalls).toEqual([{ id: expect.any(String), name: 'fill', input: { text: 'Red chair' } }]);
    expect(result.executedToolCalls).toBeUndefined();
  });

  it.each([
    ['unoffered tool', proposal('shell')],
    ['wrong argument type', proposal('fill', { text: 7 })],
    ['extra argument', proposal('fill', { text: 'chair', publish: true })],
    ['oversized text', proposal('fill', { text: 'x'.repeat(21) })],
    ['missing argument', proposal('fill', {})],
    ['invalid JSON', 'done'],
    ['extra response field', JSON.stringify({ reply: 'done', tool: null, executed: true })],
  ])('refuses %s without creating an executable step', (_label, text) => {
    expect(() => parseCodexTurn(text, request)).toThrow(/invalid work step/);
  });

  it('retains actual receipts and never labels a historical image as attached', () => {
    const prompt = renderCodexTurn({ ...request, messages: [
      ...request.messages,
      { role: 'user', content: '', toolResults: [{ toolCallId: 'fill-1', name: 'fill', content: '{"status":"refused"}' }] },
    ] });
    expect(prompt).toContain('refused');
    expect(prompt).not.toContain('attachedImageCount');
    expect(parseCodexTurn('{"reply":"The field could not be filled.","tool":null}', request).toolCalls).toEqual([]);
  });
});

