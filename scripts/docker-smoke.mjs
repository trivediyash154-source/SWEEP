// Smoke test for a running SWEEP server (used against the Docker image in CI and locally).
//   node scripts/docker-smoke.mjs http://127.0.0.1:8787 create .smoke-state.json   # optimise, register, store a scenario + run
//   node scripts/docker-smoke.mjs http://127.0.0.1:8787 check  .smoke-state.json   # after a restart: sign in, find them again
// Exits non-zero on the first failed expectation.
import { readFileSync, writeFileSync } from 'node:fs';

const [base = 'http://127.0.0.1:8787', phase = 'create', stateFile = '.smoke-state.json'] = process.argv.slice(2);
const jar = new Map();

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  if (jar.has('sweep_csrf')) headers['x-csrf-token'] = jar.get('sweep_csrf');
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const sc of res.headers.getSetCookie()) {
    const [kv] = sc.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

function expect(cond, message) {
  if (!cond) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  console.log(`ok   ${message}`);
}

const health = await call('GET', '/api/health');
expect(health.status === 200 && health.json?.data?.database === 'ok', 'health endpoint reports a working database');
const page = await fetch(`${base}/workspace`);
expect(page.status === 200 && (await page.text()).includes('<div id="root">'), 'web app is served at /workspace');
await call('GET', '/api/auth/csrf');

if (phase === 'create') {
  const ex = await call('GET', '/api/examples/greedy-trap');
  const opt = await call('POST', '/api/optimize', { graph: ex.json.data });
  expect(opt.status === 200 && opt.json.data.ok && opt.json.data.route.totalDistance === 360, 'optimise Crescent Quay gives the exact 360 m route');
  expect(opt.json.data.checks.every((c) => c.passed), 'every verification check passes');
  const email = `smoke-${Date.now()}@example.test`;
  const password = `Smoke-${Math.random().toString(36).slice(2)}-Route`;
  const reg = await call('POST', '/api/auth/register', { email, password, displayName: 'Smoke Test' });
  expect(reg.status === 201, 'register an account');
  const sc = await call('POST', '/api/scenarios', { name: 'Smoke scenario', graph: ex.json.data });
  expect(sc.status === 201, 'store a scenario');
  const run = await call('POST', `/api/scenarios/${sc.json.data.id}/runs`, {});
  expect(run.status === 201, 'store a reproducible run');
  writeFileSync(stateFile, JSON.stringify({ email, password, id: sc.json.data.id }));
} else {
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const login = await call('POST', '/api/auth/login', { email: st.email, password: st.password });
  expect(login.status === 200, 'sign in with the account created before the restart');
  const list = await call('GET', '/api/scenarios');
  expect(list.json?.data?.some((s) => s.id === st.id), 'the scenario survived the restart');
  const runs = await call('GET', `/api/scenarios/${st.id}/runs`);
  expect(runs.json?.data?.length === 1, 'the stored run survived the restart');
}
