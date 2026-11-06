import { connectFromEnv } from '@josi-ce/core';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createContext } from './context.js';
import { mailerFor } from './mailer.js';
import { sweep } from './sweep.js';

const SWEEP_MS = 60_000;

try {
  const config = loadConfig();
  const { db, close, describe } = await connectFromEnv(process.env);
  const ctx = createContext({ db, config, mailer: mailerFor(config.mail) });
  const server = createApp(ctx).listen(config.port, () => ctx.log('listening', { port: config.port, database: describe }));
  const timer = setInterval(() => void sweep(ctx), SWEEP_MS);
  const stop = () => { clearInterval(timer); server.close(() => void close().then(() => process.exit(0))); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : 'Could not start.');
  process.exit(1);
}
