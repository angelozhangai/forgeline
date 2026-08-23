// Integration: how worker.applyAutonomy is wired - a session parked at an authorisation point has its matching
// action triggered automatically, according to its **project's** autonomy level, and an audit event recorded.
// It verifies: the default level 0 does nothing; level 2 triggers requestGateB and go but nothing higher;
// level 4 triggers all of them; the red-line states (a merge, or a deterministic stall) are never triggered; an
// action returning !ok (a permission or lint check not passing) leaves the session to a human; and the actions
// are signed with the configured actor. projects (which controls the level and actor) and actions (which
// captures the calls) are mocked.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // a dynamic import (never a static one! a static import hoists above FORGE_DB=':memory:', so root.ts would resolve the real database and concurrent tests would share it). The stub falls back to the real config.

let autonomyLevel = 0;
let autonomyActor = 'M';
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    project: () => ({ autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    projectForChat: () => undefined,
    defaultProjectId: () => 'demo',
    configForProject: () => loadConfig(),
    configForSession: () => loadConfig(),
  },
});

// Capture the four actions autonomy can trigger; markReviewActive and autoAssignOnGo are stubs the worker also
// imports.
let calls: { fn: string; by: string }[] = [];
let actionOk = true;
const cap = (fn: string) => (_slug: string, by: string) => { calls.push({ fn, by }); return { ok: actionOk, msg: actionOk ? 'ok' : 'no permission, or lint did not pass' }; };
mock.module('../src/actions.ts', {
  namedExports: {
    markReviewActive: () => {},
    autoAssignOnGo: async () => {},
    requestGateB: async (slug: string, by: string) => cap('requestGateB')(slug, by),
    go: async (slug: string, by: string) => cap('go')(slug, by),
    requestGateC: (slug: string, by: string) => cap('requestGateC')(slug, by),
    requestReviewPr: (slug: string, by: string) => cap('requestReviewPr')(slug, by),
  },
});
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db } = await import('../src/store/db.ts');
const worker = await import('../src/orchestrator/worker.ts');

// The legal transition path through every authorisation resting point and the red-line states (in pipeline
// order, stopping at the target state).
const PATH = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'];
let n = 0;
async function mkAt(target: string): Promise<string> {
  const id = `a${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of PATH) {
    await sessions.transition(id, st as never);
    if (st === target) return id;
  }
  return id;
}
// GATE_C_STALLED takes a side branch (GATE_C_LOOP -> GATE_C_STALLED)
async function mkStalled(): Promise<string> {
  const id = `a${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_STALLED']) {
    await sessions.transition(id, st as never);
  }
  return id;
}

// Clearing the tables for isolation: the database is shared across tests, and the mocked actions do not really
// advance the state, so without clearing them the sessions at authorisation points would accumulate and
// pollute later assertions.
beforeEach(() => {
  db().exec('DELETE FROM session; DELETE FROM event_log;');
  calls = []; actionOk = true; autonomyLevel = 0; autonomyActor = 'M';
});

test('level 0 (the default): with all four authorisation points parked it still takes no action and records no audit event (behaviour is unchanged)', async () => {
  const ids = await Promise.all(['CONFIRMED', 'AWAITING_GO', 'DONE', 'AWAITING_GATE_D'].map(mkAt));
  await worker.applyAutonomy();
  assert.deepEqual(calls, []);
  for (const id of ids) assert.ok(!(await sessions.events(id)).some((e) => e.kind === 'autonomy_auto_triggered'));
});

test('level 2: triggers requestGateB (CONFIRMED) and go (AWAITING_GO), but not the higher requestGateC or requestReviewPr', async () => {
  autonomyLevel = 2;
  const cId = await mkAt('CONFIRMED');
  await mkAt('AWAITING_GO');
  await mkAt('DONE');
  await mkAt('AWAITING_GATE_D');
  await worker.applyAutonomy();
  assert.deepEqual(calls.map((c) => c.fn).sort(), ['go', 'requestGateB']); // exactly the two at level <= 2
  assert.ok((await sessions.events(cId)).some((e) => e.kind === 'autonomy_auto_triggered')); // the audit event is recorded
});

test('level 4: all four authorisation points trigger their own action', async () => {
  autonomyLevel = 4;
  await mkAt('CONFIRMED');
  await mkAt('AWAITING_GO');
  await mkAt('DONE');
  await mkAt('AWAITING_GATE_D');
  await worker.applyAutonomy();
  assert.deepEqual(calls.map((c) => c.fn).sort(), ['go', 'requestGateB', 'requestGateC', 'requestReviewPr']);
});

test('the red line: AWAITING_HUMAN_MERGE and GATE_C_STALLED are never triggered automatically, even at level 4', async () => {
  autonomyLevel = 4;
  const mergeId = await mkAt('AWAITING_HUMAN_MERGE');
  const stalledId = await mkStalled();
  await worker.applyAutonomy();
  assert.deepEqual(calls, [], 'the red-line states are not in the authorisation-point set, so applyAutonomy never touches them');
  assert.ok(!(await sessions.events(mergeId)).some((e) => e.kind === 'autonomy_auto_triggered'));
  assert.ok(!(await sessions.events(stalledId)).some((e) => e.kind === 'autonomy_auto_triggered'));
});

test('an action returning !ok (a permission or lint check not passing): the "attempted" audit event is recorded first, the result records !ok, and it is left to a human (the blocker fix: the audit comes before the side effect)', async () => {
  autonomyLevel = 1;
  actionOk = false;
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  assert.equal(calls.length, 1, 'it did attempt the call'); // the call happened
  const evs = await sessions.events(id);
  assert.ok(evs.some((e) => e.kind === 'autonomy_auto_triggered'), 'the "attempted" audit event is recorded first, so even an action that later fails leaves a trace');
  const res = evs.find((e) => e.kind === 'autonomy_auto_result');
  assert.equal(JSON.parse(res!.detail ?? '{}').ok, false, 'the result event records !ok');
});

test('the debounce (SF1): an !ok leaves it parked -> another tick in the same state does not retry and does not spam events', async () => {
  autonomyLevel = 1;
  actionOk = false;
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  await worker.applyAutonomy(); // the second round: the session has not changed (the mocked action does not transition, and appendEvent does not bump updated_at) -> the debounce skips it
  assert.equal(calls.length, 1, 'it attempts once, and the second round is skipped by the debounce');
  assert.equal((await sessions.events(id)).filter((e) => e.kind === 'autonomy_auto_triggered').length, 1, 'there is exactly one attempt audit event');
});

test('signing with the actor: an automatic action is called as the configured actor, and the audit event records by=actor', async () => {
  autonomyLevel = 1;
  autonomyActor = 'EO';
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  assert.equal(calls[0].by, 'EO');
  const ev = (await sessions.events(id)).find((e) => e.kind === 'autonomy_auto_triggered');
  assert.equal(JSON.parse(ev!.detail ?? '{}').by, 'EO'); // the audit detail records by=actor

});
