// Integration (codex SF4): worker.applyAutonomy is wired to the **real** actions, not mocks, proving the
// autonomous path really inherits the production action's permission gate, assignment gate and state-machine
// red lines -- rather than merely checking that some function name was called. Only the external boundaries
// are mocked: doWrites (counted, to assert nothing was written), project resolution (to control the autonomy
// level and actor), notify and load. Real: actions.ts, the real config (go_approvers and
// gate_b_allowed=[M, ...]), the state machine and sessions.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // imported dynamically -- never statically! A static import hoists above FORGE_DB=':memory:', so root.ts lands on the real database and concurrent tests collide. The stub falls back to the real config.

let autonomyLevel = 0;
let autonomyActor = 'M';
const projStub = { id: 'demo', root: '/proj', repos: ['demo'], repoPath: (r: string) => `/proj/${r}`, repoMap: { C: 'demo' }, umbrella: 'example-project', scripts: {}, deliveryDir: '/proj/docs/delivery', autonomy: { level: autonomyLevel, actor: autonomyActor } };
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ ...projStub, autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    project: () => ({ ...projStub, autonomy: { level: autonomyLevel, actor: autonomyActor } }),
    projectForChat: () => undefined,
    defaultProjectId: () => 'demo',
    configForProject: () => loadConfig(),
    configForSession: () => loadConfig(),
  },
});
// The write boundary: doWrites is counted, so a go the autonomy layer blocked can be asserted to have
// written nothing at all.
let doWritesCalls = 0;
mock.module('../src/writes.ts', {
  namedExports: {
    doWrites: async () => { doWritesCalls++; return { ok: true, stdout: '', issues: [] }; },
    maybeCommitDeliveryDocs: async () => ({ ok: true, committed: false }),
  },
});
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db } = await import('../src/store/db.ts');
const worker = await import('../src/orchestrator/worker.ts');

const PATH = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'];
let n = 0;
async function mkAt(target: string): Promise<string> {
  const id = `r${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of PATH) { await sessions.transition(id, st as never); if (st === target) return id; }
  return id;
}
async function mkStalled(): Promise<string> {
  const id = `r${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_STALLED']) await sessions.transition(id, st as never);
  return id;
}

beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); doWritesCalls = 0; autonomyLevel = 0; autonomyActor = 'M'; });

test('the real action at L4: AWAITING_GATE_D moves to GATE_D_REQUESTED through the real requestReviewPr, while the red-line states AWAITING_HUMAN_MERGE and GATE_C_STALLED do not budge', async () => {
  autonomyLevel = 4;
  const dId = await mkAt('AWAITING_GATE_D');
  const mId = await mkAt('AWAITING_HUMAN_MERGE');
  const sId = await mkStalled();
  await worker.applyAutonomy();
  assert.equal((await sessions.get(dId))!.state, 'GATE_D_REQUESTED', 'the real requestReviewPr moved it, passing both the permission gate and the state machine');
  assert.equal((await sessions.get(mId))!.state, 'AWAITING_HUMAN_MERGE', 'red line #1: never merge automatically -- the state does not move');
  assert.equal((await sessions.get(sId))!.state, 'GATE_C_STALLED', 'red line #2: a deterministic gate -- the state does not move');
});

test('the real action inherits the permissions: an actor not on the list is refused by the real requestGateB, CONFIRMED does not move, and permission_denied is recorded', async () => {
  autonomyLevel = 1;
  autonomyActor = 'NOPE'; // not in gate_b_allowed
  const id = await mkAt('CONFIRMED');
  await worker.applyAutonomy();
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED', 'the permission did not pass, so the real action performed no transition');
  const evs = await sessions.events(id);
  assert.ok(evs.some((e) => e.kind === 'permission_denied'), 'the real action recorded permission_denied');
  const res = evs.find((e) => e.kind === 'autonomy_auto_result');
  assert.equal(JSON.parse(res!.detail ?? '{}').ok, false);
});

test('the real action inherits the assignment gate: an automatic go with no DRI assigned is blocked by the real go, AWAITING_GO does not move, go_blocked_no_assignee is recorded, and **doWrites is never called, so nothing is written outward**', async () => {
  autonomyLevel = 2;
  const id = await mkAt('AWAITING_GO'); // driven here by hand without running autoAssignOnGo, so assignee is empty
  await worker.applyAutonomy();
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO', 'the assignment gate did not pass, so the real go filed nothing and the state did not move');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'go_blocked_no_assignee'), 'the real go recorded the assignment-blocked event');
  assert.equal(doWritesCalls, 0, 'red line #3: a deterministic gate before the write did not pass, so doWrites was never called and nothing went outward');
});

test('the real action with the permission granted: actor=M (in go_approvers) at L4 from AWAITING_GATE_D moves forward through the real requestReviewPr', async () => {
  autonomyLevel = 4;
  const id = await mkAt('AWAITING_GATE_D');
  await worker.applyAutonomy();
  assert.equal((await sessions.get(id))!.state, 'GATE_D_REQUESTED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'autonomy_auto_triggered'));
});
