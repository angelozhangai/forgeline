// Integration: a vertical slice of remotePull - a runner pulls due jobs from the control plane's /jobs over a
// **real HTTP loopback** (the GitHub-runner model).
// It proves the wire contract between client (the runner) and server (the control plane, via
// dueJobsPayload(localJobSource)) lines up: serialisation + HTTP + parsing.
// FORGE_DB must be set before the imports (real node:sqlite, :memory:).
process.env.FORGE_DB = ':memory:';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const { store } = await import('../src/store/index.ts');
const { localJobSource } = await import('../src/orchestrator/jobs/local.ts');
const { makeRemoteJobSource, dueJobsPayload } = await import('../src/orchestrator/jobs/remote.ts');

// The control plane: a /jobs HTTP endpoint backed by localJobSource (exactly the piece that will later be
// mounted into the control-plane server).
const server: Server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/jobs') {
    const limit = Number(u.searchParams.get('limit')) || 100; // the capacity the runner sent for this round (generous when absent)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(await dueJobsPayload(localJobSource, limit));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const baseUrl = `http://127.0.0.1:${port}`;
after(() => server.close());

function mk(id: string, state: string): void {
  store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

test('remotePull: pulls due jobs from the control plane\'s /jobs over HTTP (POLLER_DRIVEN only, and the cross-process serialisation round-trips intact)', async () => {
  mk('r-intake', 'INTAKE'); // due
  mk('r-dloop', 'GATE_D_LOOP'); // due
  mk('r-go', 'AWAITING_GO'); // waiting on a human - it must not be pulled
  const remote = makeRemoteJobSource(baseUrl);
  const jobs = await remote.claimDueJobs(100);
  assert.deepEqual(jobs.map((s) => s.id).sort(), ['r-dloop', 'r-intake']);
  // The fields survive the JSON round trip intact (not just id and state): slug, branch and the rest come back
  // too.
  const intake = jobs.find((s) => s.id === 'r-intake');
  assert.equal(intake?.slug, 'r-intake');
  assert.equal(intake?.branch, 'dev');
});

test('remotePull: a trailing slash on baseUrl is normalised away (so it never requests //jobs)', async () => {
  const remote = makeRemoteJobSource(`${baseUrl}/`);
  const jobs = await remote.claimDueJobs(100); // it must hit /jobs (a 404 would throw)
  assert.ok(Array.isArray(jobs));
});

test('remotePull: the control plane is unreachable -> throw (no silent failures; a runner must never treat a failed pull as "there is no work")', async () => {
  const dead = makeRemoteJobSource('http://127.0.0.1:1'); // port 1 is unreachable
  await assert.rejects(() => dead.claimDueJobs(100));
});

test('remotePull: a bad payload (not an array) -> throw (external input is never trusted)', async () => {
  const bad = createServer((_q, s) => {
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end('{"not":"an array"}');
  });
  await new Promise<void>((r) => bad.listen(0, '127.0.0.1', () => r()));
  const a = bad.address();
  const p = typeof a === 'object' && a ? a.port : 0;
  try {
    await assert.rejects(() => makeRemoteJobSource(`http://127.0.0.1:${p}`).claimDueJobs(100), /did not return an array/);
  } finally {
    bad.close();
  }
});

test('remotePull: a non-2xx HTTP response -> throw', async () => {
  const remote = makeRemoteJobSource(baseUrl);
  // The server returns 404 for paths other than /jobs, but remotePull always requests /jobs - so a server that
  // always returns 500 is used here to exercise the non-2xx path.
  const err = createServer((_q, s) => { s.writeHead(500); s.end('boom'); });
  await new Promise<void>((r) => err.listen(0, '127.0.0.1', () => r()));
  const a = err.address();
  const p = typeof a === 'object' && a ? a.port : 0;
  try {
    await assert.rejects(() => makeRemoteJobSource(`http://127.0.0.1:${p}`).claimDueJobs(100), /HTTP 500/);
  } finally {
    err.close();
  }
  void remote;
});
