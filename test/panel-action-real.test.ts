// 集成（收 Codex retry-Blocker）：面板写网关接的是**真** actions.retry（不 mock action），证明面板 retry 真的继承
// 生产 retry 的权限闸——web_actor 不在对应失败闸名单 → !ok 且**失败态纹丝不动**（绝不被无权点击重新点燃付费闸链/外向写）。
// 只 mock config（控 web_actor + 名单）与外部边界（projects/notify/writes/load）；真：actions.ts、action-gateway、状态机、sessions。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 面板署名 actor = runtime.web_actor（缺省 routing.lead）。控它来覆盖「无权 / 有权」两路。
let webActor = 'NOPE';
const PERMS = { gate_b_allowed: ['M'], go_approvers: ['M'], gate_c_allowed: ['M'], pr_create_approvers: ['M'], merge_ack_allowed: ['M'] };
// 复刻真 inAllowList 的判定（仅按短码大小写匹配；本测试不涉及 login 映射，故 resolveLogin 返 null）。
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
// 配置分化：panelActor 经 configForProject 取 web_actor；桩回退同一受控配置（与 loadConfig 一致）。
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

test('面板 retry·真 action：web_actor 不在 gate_c_allowed → !ok，GATE_C_FAILED 态不变 + permission_denied', async () => {
  await mkFailed('s1', 'GATE_C_FAILED', { error: 'boom', worktree_path: '/tmp/wt' });
  const r = await runPanelAction('retry', 's1');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get('s1'))!.state, 'GATE_C_FAILED'); // 失败闸未被无权 web_actor 重新点燃
  assert.ok((await sessions.events('s1')).some((e) => e.kind === 'permission_denied'));
});

test('面板 retry·真 action：web_actor 不在 pr_create_approvers → !ok，GATE_D_FAILED 态不变', async () => {
  await mkFailed('s1', 'GATE_D_FAILED', { error: 'boom', pr_url: 'https://x/pr/1' });
  const r = await runPanelAction('retry', 's1');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get('s1'))!.state, 'GATE_D_FAILED');
  assert.ok((await sessions.events('s1')).some((e) => e.kind === 'permission_denied'));
});

test('面板 retry·真 action：web_actor=M（在名单）→ 真重置 GATE_C_FAILED → GATE_C_LOOP', async () => {
  webActor = 'M';
  await mkFailed('s1', 'GATE_C_FAILED', { error: 'boom', worktree_path: '/tmp/wt' });
  const r = await runPanelAction('retry', 's1');
  assert.equal(r.ok, true);
  assert.equal((await sessions.get('s1'))!.state, 'GATE_C_LOOP'); // 有 worktree + 无 pending_input → 续跑实现循环
});
