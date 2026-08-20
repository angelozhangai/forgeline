// 单元：对外展示层（编号 + 状态人话）。守住「卡片绝不泄漏 闸A/闸B/GATE_ 黑话」这条要求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reqRef, stateLabel, refTitle } from '../src/util/display.ts';
import { STATES } from '../src/statemachine/states.ts';

test('reqRef：有 ref_num → REQ-n；无 → 回退 slug', () => {
  assert.equal(reqRef({ ref_num: 7, slug: 'x' }), 'REQ-7');
  assert.equal(reqRef({ ref_num: null, slug: 'finance-report' }), 'finance-report');
});

test('stateLabel：每个内部状态都有人话标签，且不泄漏黑话(闸A/闸B/GATE_)', () => {
  for (const s of STATES) {
    const label = stateLabel(s as never);
    assert.ok(label && label !== s, `状态 ${s} 缺人话标签`);
    assert.doesNotMatch(label, /闸A|闸B|GATE_|ADVERSARIAL|INTAKE/, `状态 ${s} 标签泄漏黑话：${label}`);
  }
});

test('refTitle：编号 · 标题（长标题截断），可带前缀 emoji', () => {
  assert.equal(refTitle({ ref_num: 3, slug: 'x', title: '财务积分报表' }, '🔴 '), '🔴 REQ-3 · 财务积分报表');
  const long = refTitle({ ref_num: 1, slug: 'x', title: 'a'.repeat(100) });
  assert.ok(long.length < 60, `长标题应截断，实际：${long.length}`);
});
