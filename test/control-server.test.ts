// Integration: the control-plane server - a real HTTP loopback exercising the control-plane process of the
// control-plane / runner split: a runner (makeRemoteJobSource / makeRemoteStore) pulls jobs and reads and
// writes central state through it, plus the authentication boundary and both fail-closed guards.
// FORGE_DB must be set before the imports (real node:sqlite, :memory:). FORGE_CONTROL_URL is deliberately
// **not** set (it would make store and jobSource remote and trip fail-closed guard 2) - this process is acting
// as the control plane.
process.env.FORGE_DB = ':memory:';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const { startControlServer } = await import('../src/control/server.ts');
const { store } = await import('../src/store/index.ts');
const { makeRemoteStore } = await import('../src/store/remote.ts');
const { makeRemoteJobSource } = await import('../src/orchestrator/jobs/remote.ts');

async function start(opts: { port: number; host?: string; token?: string }): Promise<{ server: Server; base: string }> {
  const server = await startControlServer(opts); // it resolves once it is listening (the bind succeeded)
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function mk(id: string, state: string): Promise<unknown> {
  return store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

const TOKEN = 'sekret-123';
const { server: authed, base } = await start({ port: 0, token: TOKEN });
after(() => authed.close());

test('control: /healthz needs no authentication -> 200 ok (it is purely a liveness probe)', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('control: /jobs with a token -> pulls the due POLLER_DRIVEN jobs (states waiting on a human are not pulled)', async () => {
  await mk('c-intake', 'INTAKE'); // due
  await mk('c-go', 'AWAITING_GO'); // waiting on a human - it must not be pulled
  const jobs = await makeRemoteJobSource(base, TOKEN).claimDueJobs(100);
  const ids = jobs.map((s) => s.id);
  assert.ok(ids.includes('c-intake'), 'the INTAKE session should be pulled');
  assert.ok(!ids.includes('c-go'), 'the AWAITING_GO session should not be pulled');
});

test('control: the /jobs lease - two runners never claim the same job (A takes it, and B claiming at the same moment gets nothing)', async () => {
  await mk('c-lease', 'GATE_B_REQUESTED'); // POLLER_DRIVEN and due
  const A = makeRemoteJobSource(base, TOKEN, 'runnerA');
  const B = makeRemoteJobSource(base, TOKEN, 'runnerB');
  const a = await A.claimDueJobs(100);
  assert.ok(a.some((s) => s.id === 'c-lease'), 'runnerA should have claimed c-lease');
  const b = await B.claimDueJobs(100);
  assert.ok(!b.some((s) => s.id === 'c-lease'), 'runnerB must not re-claim c-lease (A already holds the lease)');
  // The persisted owner is A (the control plane records the lease against ?runner).
  assert.equal((await store.get('c-lease'))!.lease_owner, 'runnerA');
});

test('control: /store with a token -> the runner reads and writes central state (the same database)', async () => {
  const remote = makeRemoteStore(base, TOKEN);
  await remote.create({ id: 'c-store', slug: 'c-store', title: 'T', branch: 'dev' });
  await remote.transition('c-store', 'GATE_A_RUNNING' as never);
  assert.equal((await remote.get('c-store'))!.state, 'GATE_A_RUNNING');
  // What was written over the control plane's HTTP is readable straight from its backend, proving it really
  // hits the central database rather than keeping two separate sets of state.
  assert.equal((await store.get('c-store'))!.state, 'GATE_A_RUNNING');
});

test('control: /jobs with no token -> 401 (the authentication boundary guards the read path)', async () => {
  await assert.rejects(() => makeRemoteJobSource(base).claimDueJobs(100), /HTTP 401/);
});

test('control: /store with no token -> 401 (the write path is guarded too)', async () => {
  await assert.rejects(() => makeRemoteStore(base).get('whatever'), /HTTP 401/);
});

test('control: the wrong token -> 401 (the shared secret does not match, compared with timingSafeEqual)', async () => {
  await assert.rejects(() => makeRemoteStore(base, 'wrong-token').get('x'), /HTTP 401/);
});

test('control: an unknown path -> 404', async () => {
  const res = await fetch(`${base}/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
});

test('control: loopback with no token -> allowed (local development: unauthenticated, but bound only to 127.0.0.1)', async () => {
  const { server, base: b } = await start({ port: 0 }); // no token, defaulting to loopback
  try {
    const jobs = await makeRemoteJobSource(b).claimDueJobs(100); // it works without an Authorization header
    assert.ok(Array.isArray(jobs));
  } finally {
    server.close();
  }
});

test('control: non-loopback with no token -> fail-closed guard 1 refuses to start (a synchronous throw; read/write access is never exposed unauthenticated)', () => {
  assert.throws(() => startControlServer({ port: 0, host: '0.0.0.0' }), /refusing to start the control plane unauthenticated/);
});

test('control: a configured port that fails to bind (EADDRINUSE) -> reject (fail fast; it never half-starts and lives on with no control plane)', async () => {
  const a = authed.address(); // `authed` already occupies this port
  const occupied = typeof a === 'object' && a ? a.port : 0;
  await assert.rejects(() => startControlServer({ port: occupied, token: TOKEN }), /bind failed|already in use/);
});

test('control: the process has FORGE_CONTROL_URL set -> fail-closed guard 2 refuses to start (a control plane must not be a runner)', () => {
  process.env.FORGE_CONTROL_URL = 'http://somewhere';
  try {
    assert.throws(() => startControlServer({ port: 0, token: TOKEN }), /must not set FORGE_CONTROL_URL/);
  } finally {
    delete process.env.FORGE_CONTROL_URL;
  }
});
