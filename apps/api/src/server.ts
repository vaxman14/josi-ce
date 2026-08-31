// Josi CE API entrypoint.
import { connectFromEnv, loadMasterKey } from '@josi-ce/core';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 8080);

const { db, close, describe } = await connectFromEnv();
console.log(`josi-ce: database ${describe}`);

// Load the key once at boot so a misconfigured installation fails immediately
// and visibly, rather than at the first request that needs to decrypt something.
// The value is never logged — MasterKey redacts itself on inspection.
try {
  loadMasterKey();
  console.log('josi-ce: master key loaded');
} catch (err) {
  console.error(`josi-ce: ${(err as Error).message}`);
  console.error('josi-ce: refusing to start without a usable master key');
  await close();
  process.exit(1);
}

const app = createApp(db, {
  cookieSecure: (process.env.COOKIE_SECURE ?? 'true') === 'true',
  appUrl: (process.env.APP_URL ?? '').replace(/\/$/, '') || 'http://localhost:8080',
});

const server = app.listen(PORT, () => console.log(`josi-ce api on :${PORT}`));

/** Stop accepting connections, drain, then close the pool. Without this a
 * `docker compose up -d` redeploy cuts requests off mid-flight. */
async function shutdown(signal: string): Promise<void> {
  console.log(`josi-ce: ${signal} received, shutting down`);
  server.close(() => void 0);
  await close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
