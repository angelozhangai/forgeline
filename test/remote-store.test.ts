// Integration: a vertical slice of remoteApi - a runner reads and writes the control plane's SessionStore over
// a **real HTTP loopback** (the state lives centrally and the runner accesses it remotely).
// It proves the wire contract between client (the runner, makeRemoteStore) and server (the control plane,
// handleStoreCall(localSqliteStore)) lines up: RPC envelope serialisation + HTTP + parsing + business errors
// and pure predicates surviving the round trip intact. FORGE_DB must be set before the imports (real
// node:sqlite, :memory:).
// FORGE_CONTROL_URL is deliberately not set - this test starts its own server and builds the remote client by
// hand, so it does not pollute the `store` selection point anywhere else.
process.env.FORGE_DB = ':memory:';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';

const { localSqliteStore } = await import('../src/store/sessions.ts');
const { makeRemoteStore, handleStoreCall } = await import('../src/store/remote.ts');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// The control plane: a /store RPC endpoint backed by localSqliteStore (exactly the piece that will later be
// mounted into the control-plane server).
const server: Server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/store') {
    const out = await handleStoreCall(localSqliteStore, await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out);
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

const remote = makeRemoteStore(baseUrl);

test('remoteApi: the create -> get / patch / transition / event chain (over HTTP, against the control plane\'s own database)', async () => {
  const s = await remote.create({ id: 'rm1', slug: 'rm1', title: 'T', branch: 'dev', prd_url: 'https://x.feishu.cn/wiki/rm1' });
  assert.equal(s.state, 'INTAKE');
  assert.equal((await remote.get('rm1'))!.slug, 'rm1');
  // What was written over HTTP is readable straight from the control plane's backend, proving both really hit
  // the same backend rather than keeping two separate sets of state.
  assert.equal((await localSqliteStore.get('rm1'))!.slug, 'rm1');

  await remote.patch('rm1', { title: 'T2' });
  assert.equal((await remote.get('rm1'))!.title, 'T2');

  await remote.transition('rm1', 'GATE_A_RUNNING' as never);
  assert.equal((await remote.get('rm1'))!.state, 'GATE_A_RUNNING');

  await remote.appendEvent('rm1', 'note', { k: 1 });
  const kinds = (await remote.events('rm1')).map((e) => e.kind);
  assert.ok(kinds.includes('intake') && kinds.includes('transition') && kinds.includes('note'));
});

test('remoteApi: an illegal transition -> throw (a business error travels back inside the envelope with its original message, not as an HTTP 4xx)', async () => {
  await remote.create({ id: 'rm2', slug: 'rm2', title: 'T', branch: 'dev' });
  await assert.rejects(() => remote.transition('rm2', 'DONE' as never), /illegal transition/);
});

test('remoteApi: hitting the doc_ref unique index -> reject, and isDuplicateDocRefError can still classify it across the network (the original message survives)', async () => {
  await remote.create({ id: 'rm3a', slug: 'rm3a', title: 'T', branch: 'dev', doc_ref: 'tok-dup' });
  let err: unknown;
  try {
    await remote.create({ id: 'rm3b', slug: 'rm3b', title: 'T', branch: 'dev', doc_ref: 'tok-dup' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the second insert hitting the unique index should throw');
  // The pure predicate runs its regex over the rejected error's message locally on the client, which proves the
  // message survived the server-to-client trip intact.
  assert.equal(remote.isDuplicateDocRefError(err), true);
  assert.equal(remote.isDuplicateIssueRefError(err), false);
});

test('remoteApi: listByStates filters (over HTTP, with the whole Session round-tripping rather than just id and state)', async () => {
  await remote.create({ id: 'rm4', slug: 'rm4', title: 'T', branch: 'dev', state: 'AWAITING_GO' as never });
  const go = await remote.listByStates(['AWAITING_GO'] as never);
  const hit = go.find((s) => s.id === 'rm4');
  assert.ok(hit, 'the AWAITING_GO session should be listed');
  assert.equal(hit.branch, 'dev'); // the fields survive the JSON round trip intact
});

test('remoteApi: every read, lookup and aggregate method round-trips over HTTP with a matching method name (guarding against a mistyped method string in the wrapper failing silently)', async () => {
  // Create one session carrying the deduplication keys, a PRD and a project, so every lookup path is covered.
  await remote.create({
    id: 'rm6', slug: 'rm6-slug', title: 'T', branch: 'dev',
    prd_url: 'https://x.feishu.cn/wiki/rm6', doc_ref: 'tok-rm6',
    source_kind: 'issue', issue_ref: 'owner/repo#6', project_id: 'projX',
  });
  await remote.appendEvent('rm6', 'note', { n: 1 });

  // Fetching through remote with each method proves the wrapper's method string is spelled correctly - a typo
  // would mean the backend has no such dispatch, rm6 would not come back, and it would blow up immediately.
  assert.equal((await remote.findByIssueRef('owner/repo#6'))?.id, 'rm6');
  assert.equal((await remote.getBySlug('rm6-slug'))?.id, 'rm6');
  assert.equal((await remote.findByPrdUrl('https://x.feishu.cn/wiki/rm6'))?.id, 'rm6');
  assert.equal((await remote.findByDocRef('tok-rm6'))?.id, 'rm6');
  assert.equal((await remote.resolve('rm6-slug'))?.id, 'rm6');
  assert.ok((await remote.listAll('projX')).some((s) => s.id === 'rm6'));
  assert.ok((await remote.distinctProjects()).includes('projX'));
  assert.equal(typeof (await remote.countByState()), 'object');
  assert.ok((await remote.countByStates(['INTAKE'] as never)) >= 1);
  assert.equal(typeof (await remote.lastEventTs('rm6', 'note')), 'number');
});

test('remoteApi: the control plane is unreachable -> throw (no silent failures; a runner must never treat a failed read or write as "there is no state")', async () => {
  const dead = makeRemoteStore('http://127.0.0.1:1'); // port 1 is unreachable
  await assert.rejects(() => dead.get('whatever'));
});

test('remoteApi: a non-2xx HTTP response -> throw (keeping transport failures and business errors apart)', async () => {
  const err = createServer((_q, s) => { s.writeHead(500); s.end('boom'); });
  await new Promise<void>((r) => err.listen(0, '127.0.0.1', () => r()));
  const a = err.address();
  const p = typeof a === 'object' && a ? a.port : 0;
  try {
    await assert.rejects(() => makeRemoteStore(`http://127.0.0.1:${p}`).get('x'), /HTTP 500/);
  } finally {
    err.close();
  }
});

test('remoteApi: a trailing slash on baseUrl is normalised away (so it never requests //store)', async () => {
  const r = makeRemoteStore(`${baseUrl}/`);
  await r.create({ id: 'rm5', slug: 'rm5', title: 'T', branch: 'dev' }); // it must hit /store (a 404 would throw)
  assert.equal((await r.get('rm5'))!.id, 'rm5');
});

test('handleStoreCall: a method not on the allowlist is refused (guarding against arbitrary-method and prototype-chain injection)', async () => {
  const out = JSON.parse(await handleStoreCall(localSqliteStore, JSON.stringify({ method: 'constructor', args: [] })));
  assert.equal(out.ok, false);
  assert.match(out.error, /invalid method/);
});

test('handleStoreCall: args that are not an array, or broken JSON -> an ok:false envelope (external input is never trusted)', async () => {
  const bad1 = JSON.parse(await handleStoreCall(localSqliteStore, JSON.stringify({ method: 'get', args: 'nope' })));
  assert.equal(bad1.ok, false);
  assert.match(bad1.error, /args that are not an array/);
  const bad2 = JSON.parse(await handleStoreCall(localSqliteStore, '{bad json'));
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /invalid JSON/);
});
