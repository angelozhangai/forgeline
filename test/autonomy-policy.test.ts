// 单测：渐进自治阶梯纯函数（autonomyPolicy）。锁住「哪些状态可自动、各自最低 level」+ 红线「危险/主观态任何 level 都不自动」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoActionFor, AUTONOMY_GATES, AUTONOMY_MAX_LEVEL } from '../src/statemachine/autonomyPolicy.ts';

test('阶梯：4 个授权停泊点各在其最低 level 才触发，低于则不动', () => {
  // CONFIRMED → requestGateB（L1）
  assert.equal(autoActionFor('CONFIRMED', 0), null);
  assert.equal(autoActionFor('CONFIRMED', 1), 'requestGateB');
  // AWAITING_GO → go（L2）
  assert.equal(autoActionFor('AWAITING_GO', 1), null);
  assert.equal(autoActionFor('AWAITING_GO', 2), 'go');
  // DONE → requestGateC（L3）
  assert.equal(autoActionFor('DONE', 2), null);
  assert.equal(autoActionFor('DONE', 3), 'requestGateC');
  // AWAITING_GATE_D → requestReviewPr（L4）
  assert.equal(autoActionFor('AWAITING_GATE_D', 3), null);
  assert.equal(autoActionFor('AWAITING_GATE_D', 4), 'requestReviewPr');
});

test('单调：高 level 含低 level 的动作（L4 时 4 个授权点都触发各自动作）', () => {
  assert.equal(autoActionFor('CONFIRMED', 4), 'requestGateB');
  assert.equal(autoActionFor('AWAITING_GO', 4), 'go');
  assert.equal(autoActionFor('DONE', 4), 'requestGateC');
  assert.equal(autoActionFor('AWAITING_GATE_D', 4), 'requestReviewPr');
});

test('红线：危险/主观/失败态任何 level（含远超上限）都永不自动', () => {
  const huge = 99;
  // 红线#1 永不自动 merge
  assert.equal(autoActionFor('AWAITING_HUMAN_MERGE', huge), null);
  // 红线#2 确定性闸永不可跳（CI 没绿只能再修）
  assert.equal(autoActionFor('GATE_C_STALLED', huge), null);
  // 主观裁决态 —— 需人判断，不替人做
  for (const st of ['GATE_A_STALLED', 'GATE_B_STALLED', 'GATE_D_STALLED'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
  // 需人答复的升级态
  for (const st of ['AWAITING_PM_CONFIRM', 'AWAITING_GATE_B_INPUT', 'AWAITING_GATE_C_INPUT', 'AWAITING_GATE_D_INPUT'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
  // 失败/终态
  for (const st of ['GATE_A_FAILED', 'GATE_B_FAILED', 'GATE_C_FAILED', 'GATE_D_FAILED', 'GO_DENIED', 'WRITE_FAILED', 'SHIPPED'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
  // 运行中态（poller 在跑，无需自治）
  for (const st of ['GATE_A_RUNNING', 'GATE_C_LOOP', 'GATE_D_HARDENING'] as const) {
    assert.equal(autoActionFor(st, huge), null, st);
  }
});

test('AUTONOMY_GATES 恰是 4 个授权停泊点；上限 = 4', () => {
  assert.deepEqual([...AUTONOMY_GATES].sort(), ['AWAITING_GATE_D', 'AWAITING_GO', 'CONFIRMED', 'DONE']);
  assert.equal(AUTONOMY_MAX_LEVEL, 4);
});
