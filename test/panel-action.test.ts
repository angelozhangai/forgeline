// Integration: the web panel's write gateway (action-gateway plus the server's POST /api/action). It starts a
// real http server and mocks actions to capture what is dispatched.
// It verifies: the state-to-action mapping; a legal action dispatching to the real action (as
// web_actor=lead) with a panel_action audit event; an unknown action or a requirement that cannot be found
// -> !ok; the security gates — a cross-origin Origin -> 403, anything other than application/json -> 415;
// and that GET /api/session's detail carries the actions available in that state.
process.env.FORGE_DB = ':memory:';
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // a dynamic import (never a static one! a static import hoists above FORGE_DB=':memory:', so root.ts would resolve the real database and concurrent tests would share it). The stub falls back to the real config.

const calls: { name: string; id: string; by?: string }[] = [];
const sync = (name: string) => (id: string, by: string) => { calls.push({ name, id, by }); return { ok: true, msg: `ok: ${name}` }; };
const asyncFn = (name: string) => async (id: string, by: string) => { calls.push({ name, id, by }); return { ok: true, msg: `ok: ${name}` }; };
mock.module('../src/actions.ts', {
  namedExports: {
    confirm: sync('confirm'),
    requestGateB: asyncFn('requestGateB'),
    forceGateBGo: asyncFn('forceGateBGo'),
    go: asyncFn('go'),
    deny: sync('deny'),
    requestGateC: sync('requestGateC'),
    requestReviewPr: sync('requestReviewPr'),
    ackMerged: asyncFn('ackMerged'),
    retry: (id: string, by: string) => { calls.push({ name: 'retry', id, by }); return { ok: true, msg: 'ok: retry' }; },
  },
});
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => ({ autonomy: { level: 0, actor: 'M' } }), configForProject: () => loadConfig(), configForSession: () => loadConfig() } });

const sessions = await import('../src/store/sessions.ts');
const { db, prep } = await import('../src/store/db.ts');
const { startHealthServer } = await import('../src/health/server.ts');
const { panelActionsFor } = await import('../src/health/action-gateway.ts');

const PORT = 4398;
let server: ReturnType<typeof startHealthServer>;
before(() => { server = startHealthServer(PORT); });
after(() => server?.close());
beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); calls.length = 0; });

async function mk(id: string, state: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  prep('UPDATE session SET state = ? WHERE id = ?').run(state, id);
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('panelActionsFor: the mapping for the key states; a deterministic gate or a running state offers no button (the red line: the panel never offers a way to skip)', () => {
  assert.deepEqual(panelActionsFor('AWAITING_GO' as never), ['go', 'deny']);
  assert.deepEqual(panelActionsFor('CONFIRMED' as never), ['gateb']);
  assert.deepEqual(panelActionsFor('AWAITING_HUMAN_MERGE' as never), ['merged']);
  assert.deepEqual(panelActionsFor('WRITE_FAILED' as never), ['go']); // planRetry returns null for WRITE_FAILED, so it has to re-run go rather than retry
  assert.deepEqual(panelActionsFor('GATE_C_STALLED' as never), []); // CI is not green, and the panel offers no way to skip that either
  assert.deepEqual(panelActionsFor('GATE_C_LOOP' as never), []); // a running state has no buttons
});

test('POST /api/action: a legal action dispatches to the real action (as web_actor=routing.lead=M), records a panel_action audit event, and returns 200', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await post({ action: 'gateb', slug: 's1' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ name: 'requestGateB', id: 's1', by: 'M' }]); // the real action was called, signed as the lead
  assert.ok((await sessions.events('s1')).some((e) => e.kind === 'panel_action'));
});

test('POST /api/action: an action outside the current state\'s BY_STATE -> !ok 400, never dispatched (SF1: the server backs it up, not just the front end)', async () => {
  await mk('s1', 'CONFIRMED'); // CONFIRMED's only panel button is gateb; go is in DISPATCH and the real go might well allow it, but the panel policy does not offer it -> the server blocks it
  const r = await post({ action: 'go', slug: 's1' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
  assert.equal(calls.length, 0); // it is never dispatched to the real action
});

test('POST /api/action: an unknown action -> !ok 400, never dispatched', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await post({ action: 'nuke', slug: 's1' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
  assert.equal(calls.length, 0);
});

test('POST /api/action: the requirement cannot be found -> !ok 400', async () => {
  const r = await post({ action: 'gateb', slug: 'ghost' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('POST /api/action: a cross-origin Origin -> 403 (the CSRF gate: it stops a malicious web page drive-by POSTing to localhost)', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await post({ action: 'gateb', slug: 's1' }, { Origin: 'http://evil.example.com' });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test('POST /api/action: anything other than application/json -> 415 (a form POST cannot set that content type, which blocks CSRF)', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await fetch(`http://127.0.0.1:${PORT}/api/action`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  assert.equal(calls.length, 0);
});

test('GET /api/session: the detail carries the actions available in that state (which the front end draws its buttons from)', async () => {
  await mk('s1', 'AWAITING_GO');
  const j = await (await fetch(`http://127.0.0.1:${PORT}/api/session?id=s1`)).json();
  assert.deepEqual(j.actions, ['go', 'deny']);
});
