// 单测：节点失败重试基础设施的纯函数（分类 / 退避 / 重试目标态规划）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, backoffMs, planRetry } from '../src/orchestrator/retry.ts';
import type { Session } from '../src/types.ts';

test('classifyError：瞬时信号(超时/限流/网络/fetch)判 transient', () => {
  for (const m of [
    'claude 超时',
    'codex 超时',
    '闸A claude 失败：claude 超时',
    '代码真源 git fetch 失败：demo（已重试仍失败）',
    'claude 退出码 1: Error: server overloaded (529)',
    'fetch failed: ECONNRESET',
    'request failed with status 429',
    'upstream returned 503',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'socket hang up',
    // claude CLI 把 API 层网络错误塞进 stream-json result、退码 1 → 须识别为瞬时自动重试（曾误判 permanent）
    'claude 退出码 1: API Error: The socket connection was closed unexpectedly.',
    '闸A claude 失败：claude 退出码 1: API Error: Connection error.',
    'fetch failed',
  ]) {
    assert.equal(classifyError(new Error(m)), 'transient', m);
  }
});

test('classifyError：语义/权限/配置失败判 permanent（默认安全）', () => {
  for (const m of [
    '闸A 解析失败',
    '闸B 初稿失败',
    '对抗失败',
    '输出不符合契约：open_questions: Required',
    'codex 退出码 2: invalid credentials',
    'issue_specs 为空，无可建 issue',
    '闸B 改方输出解析失败',
  ]) {
    assert.equal(classifyError(new Error(m)), 'permanent', m);
  }
});

test('backoffMs：指数递增 + 封顶 + jitter 在 ±20% 内', () => {
  // rand=0.5 → 无 jitter，取基准值
  assert.equal(backoffMs(1, 0.5), 30_000);
  assert.equal(backoffMs(2, 0.5), 120_000);
  assert.equal(backoffMs(3, 0.5), 300_000);
  assert.equal(backoffMs(4, 0.5), 300_000); // 超出 → 封顶
  assert.equal(backoffMs(0, 0.5), 30_000); // attempt<1 兜到第一档
  // jitter 边界
  assert.equal(backoffMs(1, 0), 24_000); // -20%
  assert.equal(backoffMs(1, 1), 36_000); // +20%
});

function mk(overrides: Partial<Session>): Session {
  return { state: 'GATE_A_FAILED', ...overrides } as Session;
}

test('planRetry：GATE_A_FAILED 有 pending_input → 回复评点；否则回 INTAKE', () => {
  assert.deepEqual(planRetry(mk({ state: 'GATE_A_FAILED' })), { to: 'INTAKE', fields: { error: null } });
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_pending_input: 'PM 答复' })),
    { to: 'GATE_A_REVISION_REQUESTED', fields: { error: null } },
  );
});

test('planRetry：闸A 对抗失败 → 原地续跑对抗（含首轮 codex 调用就失败：adv_round=0 标记，尚未起 codex 线）', () => {
  // 已起对抗轮/codex 线：续跑对抗（不退回 INTAKE）
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_adv_round: 1 })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_reviewer_session: 'codex-x' })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
  // 关键回归：首轮 codex 调用就失败（worker 进对抗时落的 adv_round=0 标记，还没计轮/起 codex 线）→ 仍回对抗，
  // 不因 `>0` 漏判而退回 INTAKE 重跑整闸 A、重新打扰 PM。即便误带 pending_input 也优先续对抗。
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_adv_round: 0 })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_A_FAILED', gate_a_adv_round: 0, gate_a_pending_input: 'PM 旧答复' })),
    { to: 'GATE_A_ADVERSARIAL', fields: { error: null } },
  );
});

test('planRetry：GATE_B_FAILED 有初稿+已起轮 → 续跑对抗（pending 则续修点）', () => {
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_B_FAILED', gate_b_draft_path: '/tmp/d.json', gate_b_round: 2 })),
    { to: 'ADVERSARIAL_LOOP', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_B_FAILED', gate_b_draft_path: '/tmp/d.json', gate_b_round: 2, gate_b_pending_input: 'M 决定' })),
    { to: 'GATE_B_REVISION_REQUESTED', fields: { error: null } },
  );
});

test('planRetry：GATE_B_FAILED 无初稿/未起轮 → 干净重跑并清旧对抗状态', () => {
  const p = planRetry(mk({ state: 'GATE_B_FAILED', gate_b_round: 0 }));
  assert.equal(p?.to, 'GATE_B_REQUESTED');
  assert.equal(p?.fields.gate_b_reviewer_session, null);
  assert.equal(p?.fields.gate_b_fixer_session, null);
  assert.equal(p?.fields.adversarial_residual, null);
});

test('planRetry：GATE_C_FAILED 有 worktree → 续跑实现循环（pending 则续修点）；无 worktree → 干净重 setup', () => {
  // 有 worktree：原地续跑实现⇄CI（绝不重 setup 撞已存在的 worktree）。
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_C_FAILED', worktree_path: '/wt/x' })),
    { to: 'GATE_C_LOOP', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_C_FAILED', worktree_path: '/wt/x', gate_c_pending_input: 'M 决定' })),
    { to: 'GATE_C_REVISION_REQUESTED', fields: { error: null } },
  );
  // 无 worktree（setup 失败）：干净重 setup，清半残会话/轮次/残留。
  const clean = planRetry(mk({ state: 'GATE_C_FAILED' }));
  assert.equal(clean?.to, 'GATE_C_REQUESTED');
  assert.equal(clean?.fields.gate_c_fixer_session, null);
  assert.equal(clean?.fields.gate_c_round, null);
  assert.equal(clean?.fields.gate_c_residual, null);
});

test('planRetry：GATE_D_FAILED 有 pr_url → 续跑 PR 对抗（pending 则续修点）；无 pr_url → 回重开 PR', () => {
  // PR 已开：原地续跑 codex 审 diff⇄claude 修（不丢轮次/双侧会话）。
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1' })),
    { to: 'GATE_D_LOOP', fields: { error: null } },
  );
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_pending_input: 'M 决定' })),
    { to: 'GATE_D_REVISION_REQUESTED', fields: { error: null } },
  );
  // 开 PR 失败/未开：回 GATE_D_REQUESTED 重开（forge-create-pr.sh 幂等）。
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED' })),
    { to: 'GATE_D_REQUESTED', fields: { error: null } },
  );
  // 回滚失败毒丸（gate_d_rollback_to）必须随重试存活：planRetry 只复位 error，绝不清毒丸——
  // 否则送回 GATE_D_LOOP 后 recoverPendingRollback 守不住，红/脏 HEAD 会进 review-first（Codex 三审 Blocker）。
  const r = planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_rollback_to: 'GREENSHA' }));
  assert.equal(r!.to, 'GATE_D_LOOP');
  assert.equal('gate_d_rollback_to' in r!.fields, false); // 不在复位字段里 → 毒丸保留
  // 已进测试补强（harden_round>0）→ 回 GATE_D_HARDENING 续补，绝不回 LOOP 白烧一轮 codex（优先级高于 pr_url→LOOP）。
  assert.deepEqual(
    planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_harden_round: 1 })),
    { to: 'GATE_D_HARDENING', fields: { error: null } },
  );
  // 回滚毒丸优先级最高：即便 harden_round 也在（异常并存），也必须先回 LOOP 过 recoverPendingRollback 强制复位确认，
  // 绝不绕到 HARDENING（那里不跑 rollback recovery）。毒丸保留（不在复位字段里）。
  const rb = planRetry(mk({ state: 'GATE_D_FAILED', pr_url: 'https://github.com/x/y/pull/1', gate_d_rollback_to: 'G', gate_d_harden_round: 1 }));
  assert.equal(rb!.to, 'GATE_D_LOOP');
  assert.equal('gate_d_rollback_to' in rb!.fields, false);
});

test('planRetry：无重试路径(如 WRITE_FAILED / 运行态) → null', () => {
  assert.equal(planRetry(mk({ state: 'WRITE_FAILED' })), null);
  assert.equal(planRetry(mk({ state: 'AWAITING_GO' })), null);
});
