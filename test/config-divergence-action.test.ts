// 集成（配置分化收口）：真 action 的权限闸**按 session 所属项目**取名单与 login 映射，而非全局。
// mock config.ts（带 projects 注册表）但 resolveLogin/inAllowList 用**生产同款逻辑**（读 cfg.routing.reviewers，
// 即被合并后的项目级 reviewers），**不** mock projects.ts —— configForProject 的字段级/map 合并是被测真逻辑。
// 真：actions.ts、projects.ts、状态机、sessions。证明同一个人（短码或 login）在不同项目得到不同权限后果。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 全局 gate_b_allowed=[M]；项目 acme 覆盖名单为 [BD]（字段级替换），并加自己的 reviewers（map 合并 → 继承全局 + EO）。demo 无覆盖 → 全局。
const PERMISSIONS = { gate_b_allowed: ['M'], go_approvers: ['M'], gate_c_allowed: ['M'], pr_create_approvers: ['M'], merge_ack_allowed: ['M'] };
const ROUTING = { min_confidence: 0.7, sensitive_areas: [], reviewers: { M: 'ming', BD: 'jintao' }, lead: 'M' };
const REGISTRY = {
  default_project: 'demo',
  projects: {
    demo: {},
    acme: { root: '/tmp/acme-proj', permissions: { gate_b_allowed: ['BD'] }, routing: { reviewers: { EO: 'xw-login' } } },
  },
};
// 生产同款短码/login 解析（读传入 cfg 的 routing.reviewers —— actions 传的是 configForSession(s) 的合并结果）。
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

test('真 requestGateB：项目 acme 覆盖 gate_b_allowed=[BD] → 全局审批人 M 被拒、态不变 + permission_denied', async () => {
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'M'); // M 在**全局** gate_b_allowed，但不在 acme 的
  assert.equal(r.ok, false);
  assert.match(r.msg, /无闸B 权限/);
  assert.equal((await sessions.get('s-acme'))!.state, 'CONFIRMED'); // 未推进
  assert.ok((await sessions.events('s-acme')).some((e) => e.kind === 'permission_denied'));
});

test('真 requestGateB：acme 的 BD 在该项目名单内 → 推进 GATE_B_REQUESTED', async () => {
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'BD');
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s-acme'))!.state, 'GATE_B_REQUESTED');
});

test('真 requestGateB：默认项目 demo 无覆盖 → 沿用全局名单（M 可、BD 不可）', async () => {
  await mkConfirmed('s-demo', 'demo');
  assert.equal((await actions.requestGateB('s-demo', 'BD')).ok, false); // BD 不在全局 gate_b_allowed
  assert.equal((await sessions.get('s-demo'))!.state, 'CONFIRMED');
  const r = await actions.requestGateB('s-demo', 'M'); // M 在全局
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s-demo'))!.state, 'GATE_B_REQUESTED');
});

test('真 requestGateB·login 映射（SF2 reviewers map 合并）：acme 名单含继承短码 BD，用其 **login=jintao** 也能过', async () => {
  // acme 只覆盖 reviewers={EO:...} → map 合并保留全局 BD→jintao。gate_b_allowed=[BD] 是项目覆盖；
  // 用 login 'jintao'（非短码）→ inAllowList 经合并后的 reviewers 解析 BD→jintao 命中。证明继承短码的 login 映射不丢。
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'jintao');
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s-acme'))!.state, 'GATE_B_REQUESTED');
});

test('真 requestGateB·login 映射：acme 自己的 reviewers（EO→xw-login）不在 gate_b_allowed=[BD] → 仍被拒（名单是替换、身份映射才合并）', async () => {
  await mkConfirmed('s-acme', 'acme');
  const r = await actions.requestGateB('s-acme', 'xw-login'); // EO 解析得到，但 EO 不在 acme gate_b_allowed=[BD]
  assert.equal(r.ok, false);
  assert.equal((await sessions.get('s-acme'))!.state, 'CONFIRMED');
});
