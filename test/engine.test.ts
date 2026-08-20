import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from '../src/statemachine/engine.ts';

// 闸生命周期 FSM 是核心业务：合法跃迁放行、非法跃迁拒绝、停泊态可重跑。
test('正常推进链路合法', () => {
  for (const [a, b] of [
    ['INTAKE', 'GATE_A_RUNNING'],
    ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM'],
    ['AWAITING_PM_CONFIRM', 'CONFIRMED'],
    ['CONFIRMED', 'GATE_B_REQUESTED'],
    ['GATE_B_REQUESTED', 'GATE_B_RUNNING'],
    ['GATE_B_RUNNING', 'ADVERSARIAL_LOOP'],
    ['ADVERSARIAL_LOOP', 'AWAITING_GO'],
    ['AWAITING_GO', 'WRITING'],
    ['WRITING', 'DONE'],
  ] as const) {
    assert.ok(canTransition(a, b), `${a}→${b} 应合法`);
  }
});

test('闸A PM 多轮循环跃迁合法', () => {
  for (const [a, b] of [
    ['AWAITING_PM_CONFIRM', 'GATE_A_REVISION_REQUESTED'], // PM 答复→复评
    ['GATE_A_REVISION_REQUESTED', 'GATE_A_RUNNING'], // worker 起复评
    ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM'], // 还有问题→下一轮
    ['GATE_A_RUNNING', 'CONFIRMED'], // 无剩余→评审完毕
    ['GATE_A_RUNNING', 'GATE_A_STALLED'], // 到上限→停泊
    ['GATE_A_STALLED', 'CONFIRMED'], // M 强制结束
    ['GATE_A_STALLED', 'GATE_A_REVISION_REQUESTED'], // M 补输入再跑一轮
    ['GATE_A_REVISION_REQUESTED', 'GATE_A_FAILED'], // 复评失败停泊
    ['GATE_A_FAILED', 'GATE_A_REVISION_REQUESTED'], // retry 回复评点不丢轮次
  ] as const) {
    assert.ok(canTransition(a, b), `${a}→${b} 应合法`);
  }
});

test('闸A codex 对抗复审跃迁合法（claude 复评无开放问题→对抗→确认）', () => {
  for (const [a, b] of [
    ['GATE_A_RUNNING', 'GATE_A_ADVERSARIAL'], // 无剩余开放问题→进对抗（不再直接 CONFIRMED）
    ['GATE_A_ADVERSARIAL', 'GATE_A_ADVERSARIAL'], // 每-tick 上限→自转移续跑
    ['GATE_A_ADVERSARIAL', 'CONFIRMED'], // codex LGTM→确认进闸B
    ['GATE_A_ADVERSARIAL', 'GATE_A_STALLED'], // 到上限→停泊交 M 裁决
    ['GATE_A_ADVERSARIAL', 'GATE_A_FAILED'], // 调用失败→停泊
    ['GATE_A_FAILED', 'GATE_A_ADVERSARIAL'], // 孤儿复位→原地续跑对抗
    ['GATE_A_ADVERSARIAL', 'AWAITING_PM_CONFIRM'], // 对抗补出 PM 未答漏问→弹回 PM 答复（不自动确认）
  ] as const) {
    assert.ok(canTransition(a, b), `${a}→${b} 应合法`);
  }
  // 闸A 对抗不升级人在环（PRD 拿不准走 PM loop），故无 →AWAITING_GATE_B_INPUT 边（漏问走 →AWAITING_PM_CONFIRM）。
  assert.equal(canTransition('GATE_A_ADVERSARIAL', 'AWAITING_GATE_B_INPUT'), false);
  assert.equal(canTransition('GATE_A_ADVERSARIAL', 'GATE_B_REQUESTED'), false); // 必须经 CONFIRMED
});

test('闸B codex审⇄claude改 多轮人在环循环跃迁合法', () => {
  for (const [a, b] of [
    ['ADVERSARIAL_LOOP', 'ADVERSARIAL_LOOP'], // 每-tick 上限→自转移续跑
    ['ADVERSARIAL_LOOP', 'AWAITING_GO'], // codex clean→放行
    ['ADVERSARIAL_LOOP', 'AWAITING_GATE_B_INPUT'], // claude 升级→等 M 答复
    ['ADVERSARIAL_LOOP', 'GATE_B_STALLED'], // 到上限→停泊裁决
    ['AWAITING_GATE_B_INPUT', 'GATE_B_REVISION_REQUESTED'], // M 答复→续修
    ['GATE_B_REVISION_REQUESTED', 'ADVERSARIAL_LOOP'], // resume 续修→回循环
    ['GATE_B_REVISION_REQUESTED', 'GATE_B_FAILED'], // 续修失败停泊
    ['GATE_B_STALLED', 'AWAITING_GO'], // M 强制立项
    ['GATE_B_STALLED', 'GATE_B_REVISION_REQUESTED'], // M 再修一轮
  ] as const) {
    assert.ok(canTransition(a, b), `${a}→${b} 应合法`);
  }
});

test('闸B 孤儿复位两跳合法：FAILED→原地复位点', () => {
  assert.ok(canTransition('GATE_B_FAILED', 'ADVERSARIAL_LOOP')); // 有初稿→原地续跑
  assert.ok(canTransition('GATE_B_FAILED', 'GATE_B_REVISION_REQUESTED')); // 有 pending_input→续修点
});

test('闸B 人在环停顿点不能跳步', () => {
  assert.equal(canTransition('AWAITING_GATE_B_INPUT', 'AWAITING_GO'), false); // 必须经续修
  assert.equal(canTransition('ADVERSARIAL_LOOP', 'DONE'), false);
  assert.equal(canTransition('GATE_B_STALLED', 'DONE'), false);
});

test('PM 无权直接定案：AWAITING_PM_CONFIRM→CONFIRMED 仅 M 走（FSM 允许，权限在 actions 层）', () => {
  // FSM 层 AWAITING_PM_CONFIRM→CONFIRMED 合法（M 强制结束用）；但 PM 群卡走的是 →GATE_A_REVISION_REQUESTED。
  assert.ok(canTransition('AWAITING_PM_CONFIRM', 'CONFIRMED'));
  assert.equal(canTransition('GATE_A_STALLED', 'GATE_B_REQUESTED'), false); // 停泊态不能跳过确认
});

test('跳步/乱跳非法', () => {
  assert.equal(canTransition('INTAKE', 'DONE'), false);
  assert.equal(canTransition('INTAKE', 'AWAITING_GO'), false);
  assert.equal(canTransition('AWAITING_PM_CONFIRM', 'WRITING'), false);
  assert.equal(canTransition('DONE', 'WRITING'), false); // 终态不可出
});

test('孤儿自愈用的合法两跳：RUNNING→FAILED→重跑点', () => {
  assert.ok(canTransition('GATE_A_RUNNING', 'GATE_A_FAILED'));
  assert.ok(canTransition('GATE_A_FAILED', 'INTAKE'));
  assert.ok(canTransition('GATE_B_RUNNING', 'GATE_B_FAILED'));
  assert.ok(canTransition('ADVERSARIAL_LOOP', 'GATE_B_FAILED'));
  assert.ok(canTransition('GATE_B_FAILED', 'GATE_B_REQUESTED'));
});

test('停泊态重跑边 + GO 拒绝回路', () => {
  assert.ok(canTransition('GO_DENIED', 'AWAITING_GO'));
  assert.ok(canTransition('WRITE_FAILED', 'WRITING'));
  assert.ok(canTransition('AWAITING_GO', 'GO_DENIED'));
});

test('自转移放行（幂等 patch / 对抗循环自转）', () => {
  assert.ok(canTransition('ADVERSARIAL_LOOP', 'ADVERSARIAL_LOOP'));
  assert.ok(canTransition('INTAKE', 'INTAKE'));
});

// ── 下游闸C：实现⇄CI 循环 ──
test('闸C 实现⇄CI 循环跃迁合法', () => {
  for (const [a, b] of [
    ['DONE', 'GATE_C_REQUESTED'], // 链式入口（standalone 裸 issue 直接置 GATE_C_REQUESTED）
    ['GATE_C_REQUESTED', 'GATE_C_RUNNING'],
    ['GATE_C_RUNNING', 'GATE_C_LOOP'],
    ['GATE_C_LOOP', 'GATE_C_LOOP'], // 每-tick 上限→自转续跑
    ['GATE_C_LOOP', 'AWAITING_GATE_D'], // CI 绿→等开 PR
    ['GATE_C_LOOP', 'AWAITING_GATE_C_INPUT'], // claude 升级 needs_human
    ['GATE_C_LOOP', 'GATE_C_STALLED'], // 到上限仍未绿→裁决
    ['AWAITING_GATE_C_INPUT', 'GATE_C_REVISION_REQUESTED'], // M 答复→续做
    ['GATE_C_STALLED', 'GATE_C_REVISION_REQUESTED'], // M 给输入再修一轮（唯一出路）
    ['GATE_C_REVISION_REQUESTED', 'GATE_C_LOOP'],
    ['GATE_C_FAILED', 'GATE_C_LOOP'], // 孤儿/退避复位（有 worktree 续跑）
    ['GATE_C_FAILED', 'GATE_C_REQUESTED'], // 干净重 setup
  ] as const) {
    assert.ok(canTransition(a, b), `${a}→${b} 应合法`);
  }
});

test('红线#3：闸C STALLED（确定性 CI 未绿）绝不能人工跳去开 PR / 跳过闸D', () => {
  // 闸C stall = CI/验收未绿 = 确定性闸失败。只能回再修一轮，绝不许强推进开 PR（区别于闸D stall）。
  assert.equal(canTransition('GATE_C_STALLED', 'AWAITING_GATE_D'), false);
  assert.equal(canTransition('GATE_C_STALLED', 'GATE_D_REQUESTED'), false);
  assert.equal(canTransition('GATE_C_LOOP', 'AWAITING_HUMAN_MERGE'), false); // 不能跳过闸D 直奔合并
  assert.ok(canTransition('GATE_C_STALLED', 'GATE_C_REVISION_REQUESTED')); // 唯一合法出路
});

// ── 下游闸D：PR 对抗 review + 测试补强 + 人工合并 ──
test('闸D PR 对抗 review + harden + 人工合并 跃迁合法', () => {
  for (const [a, b] of [
    ['AWAITING_GATE_D', 'GATE_D_REQUESTED'], // 权限人触发开 PR
    ['GATE_D_REQUESTED', 'GATE_D_LOOP'],
    ['GATE_D_LOOP', 'GATE_D_LOOP'],
    ['GATE_D_LOOP', 'GATE_D_HARDENING'], // codex LGTM→补内环测试
    ['GATE_D_LOOP', 'AWAITING_GATE_D_INPUT'],
    ['GATE_D_LOOP', 'GATE_D_STALLED'],
    ['AWAITING_GATE_D_INPUT', 'GATE_D_REVISION_REQUESTED'],
    ['GATE_D_REVISION_REQUESTED', 'GATE_D_LOOP'],
    ['GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE'],
    ['AWAITING_HUMAN_MERGE', 'SHIPPED'], // forge merged（人工确认已合并）
    ['AWAITING_HUMAN_MERGE', 'GATE_D_REVISION_REQUESTED'], // 合并前发现要改→回续修
  ] as const) {
    assert.ok(canTransition(a, b), `${a}→${b} 应合法`);
  }
  // 闸D 的 stall 是 codex 主观分歧、且闸C 已确保 CI 绿 → M 可强制前进到人工合并（与闸C 的确定性 stall 不同）。
  assert.ok(canTransition('GATE_D_STALLED', 'AWAITING_HUMAN_MERGE'));
  assert.ok(canTransition('GATE_D_STALLED', 'GATE_D_REVISION_REQUESTED'));
});

test('红线#2：绝不自动 merge / 跳过 harden；SHIPPED 终态不可出', () => {
  assert.equal(canTransition('GATE_D_LOOP', 'AWAITING_HUMAN_MERGE'), false); // 必须经 harden
  assert.equal(canTransition('GATE_D_LOOP', 'SHIPPED'), false); // 绝不自动合并
  assert.equal(canTransition('GATE_D_HARDENING', 'SHIPPED'), false); // harden 后仍须人工合并
  for (const t of ['GATE_C_REQUESTED', 'GATE_D_REQUESTED', 'DONE', 'AWAITING_HUMAN_MERGE'] as const) {
    assert.equal(canTransition('SHIPPED', t), false, `SHIPPED→${t} 应非法（终态）`);
  }
});
