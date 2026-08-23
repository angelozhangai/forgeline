// Integration, closing out config divergence: a real action's permission gate takes its allow list and login
// mapping **from the project the session belongs to**, not from the global config.
// config.ts is mocked (carrying a projects registry) while resolveLogin and inAllowList use **exactly the
// production logic**, reading cfg.routing.reviewers -- that is, the project-level reviewers after merging.
// projects.ts is **not** mocked: configForProject's field-level and map merging is the real logic under test.
// Real: actions.ts, projects.ts, the state machine and sessions. This proves the same person, by short code
// or by login, gets different permission outcomes in different projects.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Globally gate_b_allowed=[M]; the acme project replaces the list with [BD] (a field-level replacement) and
// adds its own reviewers (a map merge, so the global entries plus EO). demo overrides nothing, so it is global.
const PERMISSIONS = { gate_b_allowed: ['M'], go_approvers: ['M'], gate_c_allowed: ['M'], pr_create_approvers: ['M'], merge_ack_allowed: ['M'] };
const ROUTING = { min_confidence: 0.7, sensitive_areas: [], reviewers: { M: 'ming', BD: 'jintao' }, lead: 'M' };
const REGISTRY = {
  default_project: 'demo',
  projects: {
    demo: {},
    acme: { root: '/tmp/acme-proj', permissions: { gate_b_allowed: ['BD'] }, routing: { reviewers: { EO: 'xw-login' } } },
  },
};
// The same short-code and login resolution production uses, reading routing.reviewers off the cfg passed in --
// and what actions passes is the merged result of configForSession(s).
function resolveLogin(cfg: { routing: { reviewers: Record<string, string> } }, code: string): string | null {
  const up = code.toUpperCase();
  for (const [k, v] of Object.entries(cfg.routing.reviewers)) if (k.toUpperCase() === up) return v;
  return null;
}
function inAllowList(cfg: { routing: { reviewers: Record<string, string> } }, list: string[], who: string): boolean {
  const up = who.toUpperCase();
  for (const c of list) {
    if (c.toUpperCase() === up) return true;
    const login = resolveLogin(cfg, c);
    if (login && login.toLowerCase() === who.toLowerCase()) return true;
  }
  return false;
}
mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: () => ({ runtime: { repos: ['demo'], scripts: {} }, routing: ROUTING, permissions: PERMISSIONS, assignment: { pool: ['M'], wip_limit: { default: 2 }, in_progress_statuses: [3] }, projects: REGISTRY }),
    resolveLogin,
    inAllowList,
  },
});
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', { namedExports: { doWrites: async () => ({ ok: true, stdout: '', issues: [] }), maybeCommitDeliveryDocs: async () => ({ ok: true, committed: false }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db, prep } = await import('../src/store/db.ts');
const actions = await import('../src/actions.ts');

async function mkConfirmed(id: string, project: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main', project_id: project } as never);
  prep('UPDATE session SET state = ? WHERE id = ?').run('CONFIRMED', id);
}

beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); });

test('the real requestGateB: acme overrides gate_b_allowed to [BD], so the global approver M is refused, the state does not change, and permission_denied is recorded', async () => {
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'M'); // M is in the **global** gate_b_allowed, but not in acme's
  assert.equal(r.ok, false);
  assert.match(r.msg, /may not run Gate B/);
  assert.equal((await sessions.get('s-acme'))!.state, 'CONFIRMED'); // it did not move
  assert.ok((await sessions.events('s-acme')).some((e) => e.kind === 'permission_denied'));
});

test('the real requestGateB: BD is on acme\'s own list, so it moves to GATE_B_REQUESTED', async () => {
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'BD');
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s-acme'))!.state, 'GATE_B_REQUESTED');
});

test('the real requestGateB: the default project demo overrides nothing and keeps the global list, so M may and BD may not', async () => {
  await mkConfirmed('s-demo', 'demo');
  assert.equal((await actions.requestGateB('s-demo', 'BD')).ok, false); // BD is not in the global gate_b_allowed
  assert.equal((await sessions.get('s-demo'))!.state, 'CONFIRMED');
  const r = await actions.requestGateB('s-demo', 'M'); // M is in the global list
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s-demo'))!.state, 'GATE_B_REQUESTED');
});

test('the real requestGateB and the login mapping (SF2, reviewers merged as a map): acme\'s list carries the inherited short code BD, and its **login jintao** passes too', async () => {
  // acme overrides only reviewers={EO: ...}, so the map merge keeps the global BD -> jintao, while
  // gate_b_allowed=[BD] is the project's own override. Passing the login 'jintao' rather than the short code
  // makes inAllowList resolve BD -> jintao through the merged reviewers and match -- proving the login mapping
  // of an inherited short code is not lost.
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'jintao');
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s-acme'))!.state, 'GATE_B_REQUESTED');
});

test('the real requestGateB and the login mapping: acme\'s own reviewers entry (EO -> xw-login) is not in gate_b_allowed=[BD], so it is still refused -- the allow list is replaced, only the identity map is merged', async () => {
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'xw-login'); // it resolves to EO, but EO is not in acme's gate_b_allowed=[BD]
  assert.equal(r.ok, false);
  assert.equal((await sessions.get('s-acme'))!.state, 'CONFIRMED');
});
