// End-to-end unit tests for the layer-1 contract-drift guard: util/proc.ts's run is mocked and fed a
// constructed stdout, the real runClaude and runCodex run over it, and the assertion is that a collapsed
// envelope comes back as ok:false with a ..._CONTRACT_DRIFT error -- rather than the old ok:true that fell
// back to the raw text -- while the legitimate paths (a result event, scanning back to a result object, and
// ordinary JSONL) do not regress.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The mocked run: module-level variables control the stdout, the exit code, and the lines replayed to
// onStdoutLine for each call.
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

test('runClaude: no result event and no result object to scan back to -> CLAUDE_CONTRACT_DRIFT, and the session parks', async () => {
  streamLines = []; // no result event is replayed
  runCode = 0;
  runStdout = '{"type":"system","x":1}\n{"type":"telemetry","foo":"bar"}'; // an unfamiliar post-upgrade schema, carrying no result
  const r = await runClaude('hi');
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').startsWith('CLAUDE_CONTRACT_DRIFT'), `this should be judged contract drift, but got: ${r.error}`);
});

test('runClaude: an ordinary result event gives ok:true (no regression)', async () => {
  const line = '{"type":"result","result":"hello","session_id":"s1","total_cost_usd":0.02}';
  streamLines = [line];
  runCode = 0;
  runStdout = line;
  const r = await runClaude('hi');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'hello');
  assert.equal(r.sessionId, 's1');
});

test('runClaude: no result event but a result-shaped object found by scanning back gives ok:true -- a legitimate framework change is not misjudged as drift', async () => {
  streamLines = []; // the result event was never streamed back
  runCode = 0;
  runStdout = '{"type":"noise"}\n{"result":"recovered","session_id":"s2","total_cost_usd":0.01}';
  const r = await runClaude('hi');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'recovered');
});

test('runClaude: a non-zero exit plus an is_error result (an API network error packed into the stream-json) carries the real cause into error, so it can be judged transient', async () => {
  // The claude CLI puts "socket connection closed" into result(is_error:true), leaves stderr empty, and exits 1.
  const line = '{"type":"result","is_error":true,"result":"API Error: The socket connection was closed unexpectedly.","session_id":"s3"}';
  streamLines = [line];
  runCode = 1;
  runStdout = line;
  const r = await runClaude('hi');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /socket connection was closed/); // the real cause is folded into error, rather than leaving only "exit code 1"
});

test('runCodex: a collapsed envelope, with every event renamed -> CODEX_CONTRACT_DRIFT, and the session parks', async () => {
  streamLines = [];
  runCode = 0;
  runStdout = ['{"type":"session.created","session_id":"x"}', '{"type":"item.done","item":{"type":"assistant_message","text":"OK"}}', '{"type":"turn.done"}'].join('\n');
  const r = await runCodex('hi');
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').startsWith('CODEX_CONTRACT_DRIFT'), `this should be judged contract drift, but got: ${r.error}`);
});

test('runCodex: ordinary JSONL gives ok:true with the agent_message in hand (no regression)', async () => {
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
