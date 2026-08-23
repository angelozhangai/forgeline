// Parsing codex's JSONL: capturing the thread_id, taking the last agent_message, reading the token usage, and
// spotting the failure marker.
// Pure-function unit tests -- no codex process is ever started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexJsonl } from '../src/llm/runCodex.ts';
import { codexEnvelopeCollapsed, assertCodexEnvelope } from '../src/llm/contract.ts';

test('parseCodexJsonl: captures the thread_id, the last agent_message, the token usage and the envelope markers', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"019ec253-aaaa-bbbb"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"```json\\n{\\"verdict\\":\\"clean\\",\\"findings\\":[]}\\n```"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":300,"output_tokens":80}}',
  ].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.threadId, '019ec253-aaaa-bbbb');
  assert.match(p.result ?? '', /"verdict":"clean"/);
  assert.deepEqual(p.tokens, { input: 1200, cachedInput: 300, output: 80 });
  assert.equal(p.isError, false);
  // The envelope markers: having seen thread.started and turn.completed, nothing collapsed and nothing drifted.
  assert.equal(p.sawThreadStarted, true);
  assert.equal(p.sawTurnCompleted, true);
  assert.equal(codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }), false);
});

test('contract drift: a codex upgrade renames every event (thread.started becomes session.created) -> the envelope collapses', () => {
  // Simulating a codex CLI upgrade that renames the whole event set: it exits 0 and emits JSON, but not one
  // envelope event we recognise.
  const drifted = [
    '{"type":"session.created","session_id":"new-shape"}',
    '{"type":"item.done","item":{"type":"assistant_message","text":"OK"}}',
    '{"type":"turn.done","usage":{"in":10,"out":5}}',
  ].join('\n');
  const p = parseCodexJsonl(drifted);
  assert.equal(p.sawThreadStarted, false);
  assert.equal(p.sawTurnCompleted, false);
  assert.equal(p.result, null); // the agent_message we know did not match either
  // The layer-1 hot path: a total collapse is judged drift and parks, rather than silently passing the whole
  // blob of JSONL off as the result.
  assert.equal(codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }), true);
  assert.equal(assertCodexEnvelope({ threadStarted: false, turnCompleted: false }).drifted, true);
});

test('contract drift: a partial rename (only turn.completed becoming turn.done) does not park the hot path, while the probe judges it drift under its stricter rule', () => {
  const partial = ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.done","usage":{}}'].join('\n');
  const p = parseCodexJsonl(partial);
  assert.equal(p.sawThreadStarted, true);
  assert.equal(p.sawTurnCompleted, false);
  // The hot path saw thread.started, so nothing collapsed and it does not wrongly park -- a result may still
  // come back.
  assert.equal(codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }), false);
  // The probe's stricter rule: a missing turn.completed is drift, and it raises the alarm itself.
  assert.equal(assertCodexEnvelope({ threadStarted: true, turnCompleted: false }).drifted, true);
});

test('parseCodexJsonl: with several agent_messages it takes the last one', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
  ].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.result, 'final');
});

test('parseCodexJsonl: turn.failed sets isError', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t2"}',
    '{"type":"turn.failed","error":{"message":"boom"}}',
  ].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.isError, true);
  assert.equal(p.threadId, 't2');
});

test('parseCodexJsonl: lines that are not JSON are ignored rather than crashing', () => {
  const jsonl = ['noise line', '{"type":"thread.started","thread_id":"t3"}', '', '   '].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.threadId, 't3');
  assert.equal(p.result, null);
});
