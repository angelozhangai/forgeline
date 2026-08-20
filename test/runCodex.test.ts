// codex JSONL 解析（thread_id 捕获 / 最后一条 agent_message / token 用量 / 失败标记）。
// 纯函数单测，不起真 codex 进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexJsonl } from '../src/llm/runCodex.ts';
import { codexEnvelopeCollapsed, assertCodexEnvelope } from '../src/llm/contract.ts';

test('parseCodexJsonl：捕获 thread_id + 最后一条 agent_message + token + 信封标记', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"019ec253-aaaa-bbbb"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"思考中"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"```json\\n{\\"verdict\\":\\"clean\\",\\"findings\\":[]}\\n```"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":300,"output_tokens":80}}',
  ].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.threadId, '019ec253-aaaa-bbbb');
  assert.match(p.result ?? '', /"verdict":"clean"/);
  assert.deepEqual(p.tokens, { input: 1200, cachedInput: 300, output: 80 });
  assert.equal(p.isError, false);
  // 信封标记：见过 thread.started + turn.completed → 未坍塌、未漂移。
  assert.equal(p.sawThreadStarted, true);
  assert.equal(p.sawTurnCompleted, true);
  assert.equal(codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }), false);
});

test('契约漂移：codex 升级改了所有事件名（thread.started→session.created）→ 信封坍塌', () => {
  // 模拟 codex CLI 升级把整套事件重命名：退出 0、有 JSON，但一个我们认识的信封事件都没有。
  const drifted = [
    '{"type":"session.created","session_id":"new-shape"}',
    '{"type":"item.done","item":{"type":"assistant_message","text":"OK"}}',
    '{"type":"turn.done","usage":{"in":10,"out":5}}',
  ].join('\n');
  const p = parseCodexJsonl(drifted);
  assert.equal(p.sawThreadStarted, false);
  assert.equal(p.sawTurnCompleted, false);
  assert.equal(p.result, null); // 我们认识的 agent_message 也没匹配上
  // Layer 1 热路径：整体坍塌 → 判漂移停泊（而非把整坨 JSONL 当结果静默放过）。
  assert.equal(codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }), true);
  assert.equal(assertCodexEnvelope({ threadStarted: false, turnCompleted: false }).drifted, true);
});

test('契约漂移：部分改名（仅 turn.completed→turn.done）→ 热路径不误停，探针严格判漂移', () => {
  const partial = ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.done","usage":{}}'].join('\n');
  const p = parseCodexJsonl(partial);
  assert.equal(p.sawThreadStarted, true);
  assert.equal(p.sawTurnCompleted, false);
  // 热路径：见到 thread.started → 未坍塌，不误判停泊（仍可能拿到结果）。
  assert.equal(codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }), false);
  // 探针严格口径：turn.completed 缺失即漂移 → 主动告警。
  assert.equal(assertCodexEnvelope({ threadStarted: true, turnCompleted: false }).drifted, true);
});

test('parseCodexJsonl：多条 agent_message 取最后一条', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
  ].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.result, 'final');
});

test('parseCodexJsonl：turn.failed → isError', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t2"}',
    '{"type":"turn.failed","error":{"message":"boom"}}',
  ].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.isError, true);
  assert.equal(p.threadId, 't2');
});

test('parseCodexJsonl：非 JSON 行忽略，不崩', () => {
  const jsonl = ['noise line', '{"type":"thread.started","thread_id":"t3"}', '', '   '].join('\n');
  const p = parseCodexJsonl(jsonl);
  assert.equal(p.threadId, 't3');
  assert.equal(p.result, null);
});
