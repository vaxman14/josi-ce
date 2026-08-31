// Re-exported so test files import their fixtures from one place rather than
// reaching across the workspace into package internals.
export { ensureWorkspace } from '../../../packages/core/src/workspace.js';
export { createUser } from '../../../packages/auth/src/users.js';
