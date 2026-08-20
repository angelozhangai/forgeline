// contract.ts 信封断言纯函数单测：完好→不漂移；改名/缺失→漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCodexEnvelope, codexEnvelopeCollapsed, assertClaudeEnvelope } from '../src/llm/contract.ts';

test('assertCodexEnvelope：两信封事件都在 → 不漂移', () => {
  const d = assertCodexEnvelope({ threadStarted: true, turnCompleted: true });
  assert.equal(d.drifted, false);
  assert.deepEqual(d.missing, []);
});

test('assertCodexEnvelope：缺任一信封事件 → 漂移且列出缺失', () => {
  assert.deepEqual(assertCodexEnvelope({ threadStarted: false, turnCompleted: true }).missing, ['thread.started']);
  assert.deepEqual(assertCodexEnvelope({ threadStarted: true, turnCompleted: false }).missing, ['turn.completed']);
  const both = assertCodexEnvelope({ threadStarted: false, turnCompleted: false });
  assert.equal(both.drifted, true);
  assert.deepEqual(both.missing, ['thread.started', 'turn.completed']);
});

test('codexEnvelopeCollapsed：仅全部信封事件缺失才算坍塌（热路径阈值）', () => {
  assert.equal(codexEnvelopeCollapsed({ threadStarted: false, turnCompleted: false }), true);
  assert.equal(codexEnvelopeCollapsed({ threadStarted: true, turnCompleted: false }), false);
  assert.equal(codexEnvelopeCollapsed({ threadStarted: false, turnCompleted: true }), false);
});

test('assertClaudeEnvelope：有 result 信封→不漂移；无→漂移', () => {
  assert.equal(assertClaudeEnvelope({ resultEvent: true }).drifted, false);
  const d = assertClaudeEnvelope({ resultEvent: false });
  assert.equal(d.drifted, true);
  assert.deepEqual(d.missing, ['result 事件']);
});
