// Layer-1 契约漂移守卫的端到端单测：mock util/proc.ts 的 run，喂构造的 stdout，
// 走真实 runClaude/runCodex，断言信封坍塌时返回 ok:false …_CONTRACT_DRIFT（而非旧的 ok:true 原文兜底），
// 且合法路径（result 事件 / 反扫到 result 对象 / 正常 JSONL）不回归。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// mock run：由模块级变量控制本次返回的 stdout / 退出码 / 要回放给 onStdoutLine 的行。
let runStdout = '';
let runCode: number | null = 0;
let streamLines: string[] = [];

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (_bin: string, _args: string[], opts: { onStdoutLine?: (l: string) => void } = {}) => {
      if (opts.onStdoutLine) for (const l of streamLines) if (l.trim()) opts.onStdoutLine(l);
      return { code: runCode, stdout: runStdout, stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const { runClaude } = await import('../src/llm/runClaude.ts');
const { runCodex } = await import('../src/llm/runCodex.ts');

test('runClaude：无 result 事件、反扫不到 result 对象 → CLAUDE_CONTRACT_DRIFT（停泊）', async () => {
  streamLines = []; // 不回放任何 result 事件
  runCode = 0;
  runStdout = '{"type":"system","x":1}\n{"type":"telemetry","foo":"bar"}'; // 升级后的陌生 schema，无 result
  const r = await runClaude('hi');
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').startsWith('CLAUDE_CONTRACT_DRIFT'), `应判契约漂移，实际：${r.error}`);
});

test('runClaude：正常 result 事件 → ok:true（不回归）', async () => {
  const line = '{"type":"result","result":"hello","session_id":"s1","total_cost_usd":0.02}';
  streamLines = [line];
  runCode = 0;
  runStdout = line;
  const r = await runClaude('hi');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'hello');
  assert.equal(r.sessionId, 's1');
});

test('runClaude：无 result 事件但反扫到 result 形状对象 → ok:true（合法框架变更，不误判漂移）', async () => {
  streamLines = []; // result 事件没流式回放
  runCode = 0;
  runStdout = '{"type":"noise"}\n{"result":"recovered","session_id":"s2","total_cost_usd":0.01}';
  const r = await runClaude('hi');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'recovered');
});

test('runClaude：退码非零 + is_error result（API 网络错塞进 stream-json）→ error 带上真实原因，可被判瞬时', async () => {
  // claude CLI 把 "socket connection closed" 放进 result(is_error:true)、stderr 空、退码 1。
  const line = '{"type":"result","is_error":true,"result":"API Error: The socket connection was closed unexpectedly.","session_id":"s3"}';
  streamLines = [line];
  runCode = 1;
  runStdout = line;
  const r = await runClaude('hi');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /socket connection was closed/); // 真实原因被并进 error（而非只剩「退出码 1」）
});

test('runCodex：信封坍塌（事件全改名）→ CODEX_CONTRACT_DRIFT（停泊）', async () => {
  streamLines = [];
  runCode = 0;
  runStdout = ['{"type":"session.created","session_id":"x"}', '{"type":"item.done","item":{"type":"assistant_message","text":"OK"}}', '{"type":"turn.done"}'].join('\n');
  const r = await runCodex('hi');
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').startsWith('CODEX_CONTRACT_DRIFT'), `应判契约漂移，实际：${r.error}`);
});

test('runCodex：正常 JSONL → ok:true 且拿到 agent_message（不回归）', async () => {
  streamLines = [];
  runCode = 0;
  runStdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"verdict\\":\\"clean\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}',
  ].join('\n');
  const r = await runCodex('hi');
  assert.equal(r.ok, true);
  assert.match(r.result, /verdict/);
  assert.equal(r.threadId, 't1');
});
