import { join } from 'node:path';

// Resolve only bundled CLIs, with their own durable sign-in configuration.
export function subscriptionEnvironment(program, data, role) {
  return {
    PATH: `${join(program, 'subscription-cli/bin')}:${join(program, 'node/bin')}:/usr/bin:/bin`,
    HOME: join(data, 'profiles', role),
    CODEX_HOME: join(data, 'codex'),
    // This shared inherited-ACL directory lets the worker use the connection
    // established by the web service without depending on the owner's shell.
    CLAUDE_CONFIG_DIR: join(data, 'codex', 'claude-code'),
  };
}
