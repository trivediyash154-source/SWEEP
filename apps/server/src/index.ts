import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { inlineSolver, workerSolver } from './solver.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const solver = config.solverMode === 'inline' ? inlineSolver() : workerSolver(config.solverTimeoutMs);
const app = createApp({ db, config, solver });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'sweep_server_listening', port: info.port, static: config.staticDir ?? null, solver: config.solverMode }));
});

const shutdown = (): void => {
  server.close();
  void solver.close().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
