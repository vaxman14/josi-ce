import { isAbsolute } from 'node:path';

/** Pinned Claude Code 2.1.258 print interface. The guardian accepts only this
 * shape, never arbitrary CLI options from a request or stored provider.
 *
 * `structured`: the turn carries images, so the prompt goes in as one
 * stream-json user message whose content holds real image blocks next to the
 * text. Claude Code accepts stream-json input only with stream-json output,
 * which in print mode requires --verbose; the result envelope is the same. */
export function claudeSubscriptionArgs(model: string, mcpConfigPath?: string | null, structured = false): string[] {
  return [
    ...(structured
      ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
      : ['--print', '--output-format', 'json']),
    ...(model ? ['--model', model] : []),
    '--restricted', '--tools', '', '--permission-mode', 'dontAsk',
    '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true,"disableClaudeAiConnectors":true,"syncClaudeAiPlugins":false}',
    '--strict-mcp-config', '--mcp-config', mcpConfigPath || '{"mcpServers":{}}',
    ...(mcpConfigPath ? ['--allowed-tools', 'mcp__josi'] : []),
  ];
}

export function validClaudeSubscriptionArgs(args: string[]): boolean {
  const modelIndex = args.indexOf('--model');
  const model = modelIndex < 0 ? '' : args[modelIndex + 1];
  const configIndex = args.indexOf('--mcp-config');
  const config = args[configIndex + 1];
  if (typeof model !== 'string' || model.length > 256 || model.startsWith('-')
    || /[\x00-\x1f\x7f]/.test(model) || configIndex < 0 || typeof config !== 'string') return false;
  const path = config === '{"mcpServers":{}}' ? null : config;
  if (path !== null && (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))) return false;
  const structured = args[1] === '--input-format';
  return JSON.stringify(args) === JSON.stringify(claudeSubscriptionArgs(model, path, structured));
}
