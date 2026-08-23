// Unit tests for contract.ts's pure envelope assertions: intact -> no drift; renamed or missing -> drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCodexEnvelope, codexEnvelopeCollapsed, assertClaudeEnvelope } from '../src/llm/contract.ts';

test('assertCodexEnvelope: both envelope events present -> no drift', () => {
  const d = assertCodexEnvelope({ threadStarted: true, turnCompleted: true });
  assert.equal(d.drifted, false);
  assert.deepEqual(d.missing, []);
});

test('assertCodexEnvelope: either envelope event missing -> drift, listing what is missing', () => {
  assert.deepEqual(assertCodexEnvelope({ threadStarted: false, turnCompleted: true }).missing, ['thread.started']);
  assert.deepEqual(assertCodexEnvelope({ threadStarted: true, turnCompleted: false }).missing, ['turn.completed']);
  const both = assertCodexEnvelope({ threadStarted: false, turnCompleted: false });
  assert.equal(both.drifted, true);
  assert.deepEqual(both.missing, ['thread.started', 'turn.completed']);
});

test('codexEnvelopeCollapsed: only losing every envelope event counts as collapsed (the hot path threshold)', () => {
  assert.equal(codexEnvelopeCollapsed({ threadStarted: false, turnCompleted: false }), true);
  assert.equal(codexEnvelopeCollapsed({ threadStarted: true, turnCompleted: false }), false);
  assert.equal(codexEnvelopeCollapsed({ threadStarted: false, turnCompleted: true }), false);
});

test('assertClaudeEnvelope: a result envelope present -> no drift; absent -> drift', () => {
  assert.equal(assertClaudeEnvelope({ resultEvent: true }).drifted, false);
  const d = assertClaudeEnvelope({ resultEvent: false });
  assert.equal(d.drifted, true);
  assert.deepEqual(d.missing, ['the result event']);
});
