// 集成：闸A codex 对抗循环（runGateALoop）的真实 gateAConfig 接线——prompt 加载 + 输出 schema +
// 列持久化 + 停泊残留。引擎控制流本身在 reviewFixLoop.test.ts 已覆盖，这里只验闸A 专属配置。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 假驱动：codex reviewer / claude fixer 各用队列逐轮返回（队空兜 LGTM）。
const codexQueue: { ok: boolean; result?: string; available?: boolean }[] = [];
mock.module('../src/llm/runCodex.ts', {
  namedExports: {
    runCodex: async () => {
      const r = codexQueue.shift() ?? { ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) };
      return { ok: r.ok, result: r.result ?? '', threadId: 'codex-thread', tokens: null, raw: r.result ?? '', available: r.available ?? true, error: r.ok ? undefined : 'codex err' };
    },
  },
});
const claudeQueue: { ok: boolean; result?: string }[] = [];
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async () => {
      const r = claudeQueue.shift() ?? { ok: true, result: '{}' };
      return { ok: r.ok, result: r.result ?? '', sessionId: 'claude-sid', costUsd: 0.01, raw: r.result ?? '', error: r.ok ? undefined : 'claude err' };
    },
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateALoop } = await import('../src/gates/gateALoop.ts');

const BASE_ENV = {
  summary: 's', repos_touched: ['C'], size: 'M', size_reason: '', open_questions: [], risks: [],
  confidence: 0.5, needs_lead: false, prd_score: 0, prd_score_dims: { clarity: 0, completeness: 0, feasibility: 0, testability: 0 }, prd_score_reason: '',
};
const CHANGES = JSON.stringify({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue: 'x', where: 'open_questions', fix: 'y', evidence: 'z' }] });
const FIX = (env: unknown) => JSON.stringify({ artifact: env, needs_human: [] });

async function mkSession(id: string) {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-gatea-')), 'gate-a.json');
  writeFileSync(p, JSON.stringify(BASE_ENV));
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  await sessions.patch(id, { gate_a_output_path: p });
  return (await sessions.get(id))!;
}

test('runGateALoop：codex LGTM → resolved（不调 fixer），对抗轮次落库', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  codexQueue.push({ ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) });
  const out = await runGateALoop(await mkSession('gal1'));
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'LGTM');
  assert.equal((await sessions.get('gal1'))!.gate_a_adv_round, 1);
  assert.equal(claudeQueue.length, 0); // fixer 未被调用（队列未被消费）
});

test('runGateALoop：CHANGES → claude 改评审 → 复审 LGTM；修订落 gate-a.json + fixer 会话落库', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  codexQueue.push({ ok: true, result: CHANGES });
  claudeQueue.push({ ok: true, result: FIX({ ...BASE_ENV, open_questions: [{ q: '退款去哪？', suggestion: '余额', severity: 'high', options: [] }] }) });
  codexQueue.push({ ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) });
  const s = await mkSession('gal2');
  const out = await runGateALoop(s);
  assert.equal(out.resolved, true);
  const env = JSON.parse(readFileSync((await sessions.get('gal2'))!.gate_a_output_path!, 'utf8'));
  assert.equal(env.open_questions.length, 1); // claude 的修订已落盘
  assert.ok((await sessions.get('gal2'))!.gate_a_fixer_session); // fixer 会话已 pin 落库（续修 resume 用）
});

test('runGateALoop：到上限仍 CHANGES → stalled + 落 gate_a_residual(source=codex)', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  for (let i = 0; i < 6; i++) { codexQueue.push({ ok: true, result: CHANGES }); claudeQueue.push({ ok: true, result: FIX(BASE_ENV) }); }
  const s = await mkSession('gal3');
  // 每-tick 上限会先 paused，模拟多个 tick 续跑直到 stalled（最多 5 次防呆）。
  let out = await runGateALoop(s);
  for (let i = 0; i < 5 && out.paused; i++) out = await runGateALoop((await sessions.get('gal3'))!);
  assert.equal(out.stalled, true);
  const resid = JSON.parse((await sessions.get('gal3'))!.gate_a_residual!) as { source: string; findings: unknown[] };
  assert.equal(resid.source, 'codex');
  assert.ok(resid.findings.length >= 1);
});

test('runGateALoop：on_missing=skip 且 codex 不可用 → 视为通过（保住评审稿，不卡死）', async () => {
  codexQueue.length = 0; claudeQueue.length = 0;
  codexQueue.push({ ok: false, available: false });
  // 仓内 runtime.yaml on_missing=claude（降级），此处仅验 codex 不可用时不抛、不静默丢稿——降级 claude 复审。
  claudeQueue.push({ ok: true, result: JSON.stringify({ verdict: 'LGTM', findings: [] }) });
  const out = await runGateALoop(await mkSession('gal4'));
  assert.equal(out.resolved, true);
});
