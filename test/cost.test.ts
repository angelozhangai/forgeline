// 成本看板聚合：costRows/costSummary 的口径（闸A+闸B+闸C+闸D 合计、按状态分桶、withCost 计数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costRows, costSummary, formatCost } from '../src/cost.ts';
import type { Session } from '../src/types.ts';

const s = (p: Partial<Session>): Session =>
  ({
    id: 'x', ref_num: null, slug: 'sl', state: 'DONE', size: null,
    gate_a_cost_usd: null, gate_b_cost_usd: null, gate_c_cost_usd: null, gate_d_cost_usd: null,
    assignee: null, updated_at: 0, ...p,
  } as unknown as Session);

test('costRows：合计=闸A+闸B+闸C+闸D；缺成本算 0；ref 用 REQ-N 或 id 前缀', () => {
  const rows = costRows([
    s({ id: 'a', ref_num: 7, gate_a_cost_usd: 1.5, gate_b_cost_usd: 2.0, gate_c_cost_usd: 4.0, gate_d_cost_usd: 0.5 }),
    s({ id: 'bbbbbbbbbb', ref_num: null }),
  ]);
  assert.equal(rows[0].ref, 'REQ-7');
  assert.equal(rows[0].gateC, 4.0);
  assert.equal(rows[0].gateD, 0.5);
  assert.equal(rows[0].total, 8.0); // 1.5 + 2.0 + 4.0 + 0.5
  assert.equal(rows[1].ref, 'bbbbbbbb'); // id 前 8
  assert.equal(rows[1].total, 0);
});

test('costSummary：总计/分项（含闸C/闸D）/按状态分桶/withCost', () => {
  const rows = costRows([
    s({ ref_num: 1, state: 'DONE', gate_a_cost_usd: 1, gate_b_cost_usd: 3, gate_c_cost_usd: 5, gate_d_cost_usd: 2 }),
    s({ ref_num: 2, state: 'DONE', gate_a_cost_usd: 0.5 }),
    s({ ref_num: 3, state: 'AWAITING_GO' }),
  ]);
  const sum = costSummary(rows);
  assert.equal(sum.total, 11.5);
  assert.equal(sum.gateA, 1.5);
  assert.equal(sum.gateB, 3);
  assert.equal(sum.gateC, 5);
  assert.equal(sum.gateD, 2);
  assert.equal(sum.count, 3);
  assert.equal(sum.withCost, 2); // 第三条 0 成本不计
  assert.equal(sum.byState[0].state, 'DONE'); // 花费最高的桶在前
  assert.equal(sum.byState[0].usd, 11.5);
});

test('formatCost：空 → 占位；非空含合计行（4 闸分项）+ 管理面声明', () => {
  assert.equal(formatCost([], costSummary([])), '(no sessions)');
  const rows = costRows([s({ ref_num: 1, gate_a_cost_usd: 1, gate_b_cost_usd: 0, gate_c_cost_usd: 2, gate_d_cost_usd: 0 })]);
  const txt = formatCost(rows, costSummary(rows));
  assert.match(txt, /Total \$3\.0000/);
  assert.match(txt, /\$2\.0000/); // 下游分项可见
  assert.match(txt, /Gate D \$0\.0000/);
  assert.match(txt, /private, management-facing/);
});
