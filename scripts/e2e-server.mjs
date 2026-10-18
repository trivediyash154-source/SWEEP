// Starts the production server (built web app + API) for end-to-end tests,
// with a throwaway database and rate limiting disabled.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const port = process.argv[2] ?? '8790';
mkdirSync('test-results', { recursive: true });
for (const f of ['test-results/e2e.db', 'test-results/e2e.db-wal', 'test-results/e2e.db-shm']) rmSync(f, { force: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'apps/server/dist/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port, SWEEP_STATIC_DIR: 'apps/web/dist', SWEEP_DB_PATH: 'test-results/e2e.db', SWEEP_RATE_LIMIT: 'off' },
});
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
