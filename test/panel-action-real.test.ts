// Integration (closing the retry blocker Codex raised): the panel's write gateway is wired to the **real**
// actions.retry (the action is not mocked), proving the panel's retry really inherits production retry's
// permission gate — a web_actor not on the relevant failed gate's list gets !ok and the **failed state does
// not budge** (an unauthorised click must never re-ignite a chain of paid gates or an outward write).
// Only config (which controls web_actor and the lists) and the external boundaries (projects, notify, writes,
// load) are mocked; actions.ts, action-gateway, the state machine and sessions are all real.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The panel's signing actor is runtime.web_actor (defaulting to routing.lead). Controlling it covers both
// paths: unauthorised and authorised.
let webActor = 'NOPE';
const PERMS = { gate_b_allowed: ['M'], go_approvers: ['M'], gate_c_allowed: ['M'], pr_create_approvers: ['M'], merge_ack_allowed: ['M'] };
// Reproduces the real inAllowList's judgement (matching the short code case-insensitively; this test does not
// involve login mapping, so resolveLogin returns null).
function inAllowList(_cfg: unknown, list: string[], who: string): boolean {
  const up = who.toUpperCase();
  return list.some((c) => c.toUpperCase() === up);
}
function currentCfg() {
  return { runtime: { web_actor: webActor }, routing: { lead: 'M' }, permissions: PERMS };
}
mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: currentCfg,
    resolveLogin: () => null,
    inAllowList,
  },
});
// Configuration diverges per project: panelActor reads web_actor through configForProject, and the stub falls
// back to the same controlled config (matching loadConfig).
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => ({ autonomy: { level: 0, actor: 'M' } }), configForProject: currentCfg, configForSession: currentCfg } });
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', {
  namedExports: { doWrites: async () => ({ ok: true, stdout: '', issues: [] }), maybeCommitDeliveryDocs: async () => ({ ok: true, committed: false }) },
});
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db, prep } = await import('../src/store/db.ts');
const { runPanelAction } = await import('../src/health/action-gateway.ts');

async function mkFailed(id: string, state: string, fields: Record<string, unknown> = {}): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  prep('UPDATE session SET state = ? WHERE id = ?').run(state, id);
  if (Object.keys(fields).length) await sessions.patch(id, fields as never);
}

beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); webActor = 'NOPE'; });

test("the panel's retry against the real action: a web_actor not in gate_c_allowed -> !ok, GATE_C_FAILED unchanged, and a permission_denied event", async () => {
  await mkFailed('s1', 'GATE_C_FAILED', { error: 'boom', worktree_path: '/tmp/wt' });
  const r = await runPanelAction('retry', 's1');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get('s1'))!.state, 'GATE_C_FAILED'); // the failed gate was not re-ignited by an unauthorised web_actor
  assert.ok((await sessions.events('s1')).some((e) => e.kind === 'permission_denied'));
});

test("the panel's retry against the real action: a web_actor not in pr_create_approvers -> !ok, GATE_D_FAILED unchanged", async () => {
  await mkFailed('s1', 'GATE_D_FAILED', { error: 'boom', pr_url: 'https://x/pr/1' });
  const r = await runPanelAction('retry', 's1');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get('s1'))!.state, 'GATE_D_FAILED');
  assert.ok((await sessions.events('s1')).some((e) => e.kind === 'permission_denied'));
});

test("the panel's retry against the real action: web_actor=M (on the list) -> it really resets GATE_C_FAILED to GATE_C_LOOP", async () => {
  webActor = 'M';
  await mkFailed('s1', 'GATE_C_FAILED', { error: 'boom', worktree_path: '/tmp/wt' });
  const r = await runPanelAction('retry', 's1');
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s1'))!.state, 'GATE_C_LOOP'); // there is a worktree and no pending_input -> it carries on with the implementation loop
});
