// 集成：闸B 的 PRD 真源生产链路。
// 只 mock LLM / git fetch / 目标项目脚本边界；真实覆盖 runGateB/loadPrdTruth/session/worker 的上线行为。
process.env.FORGE_DB = ':memory:';

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const projectRoot = mkdtempSync(resolve(tmpdir(), 'forge-gateb-prdtruth-project-'));
process.env.FORGE_PROJECT_ROOT = projectRoot;

let claudeCalls = 0;
let lastPrompt = '';
let scaffoldCalls = 0;
const notifications: { kind: string; state: string; error?: string | null }[] = [];

const gateBResult = JSON.stringify({
  summary: '按冻结 PRD 真源出方案',
  key_decisions: { source: 'prd-truth' },
  tech_design_markdown: '实现只应基于冻结真源与代码真源。',
  acceptance: {
    contracts: [{ repo: 'C', surface: 'POST /refund {order_id} -> 200 {refund_id}' }],
    scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 已支付订单\nWhen 发起退款\nThen 返回退款单号' }],
  },
  issue_specs: [{ repo: 'C', title: 'feat(refund): 支持退款', type: 'feat', prio: 'P1' }],
  confidence: 0.91,
});

mock.module('../src/gates/repoFreshness.ts', {
  namedExports: {
    refresh: (branch: string) => ({
      branch,
      fetchedAt: '2026-06-17T08:00:00.000Z',
      shas: { demo: 'abc123456789' },
      refsText: '- demo: `origin/dev` @ `abc123456789`',
    }),
    assertFresh: () => {},
  },
});
// checkout 锚定校验隔离成「已对齐」——本测不验证 git，只走 runGateB 上线行为。
mock.module('../src/gates/repoAnchor.ts', {
  namedExports: { anchorCheck: () => ({ off: [], disclosure: '' }), reposOffRef: () => [] },
});

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string) => {
      claudeCalls++;
      lastPrompt = prompt;
      return { ok: true, result: gateBResult, raw: gateBResult, costUsd: 0.12, sessionId: 'claude-gateb' };
    },
  },
});

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    reviewReqScaffold: async () => ({ ok: true, stdout: '', stderr: '' }),
    techDesignScaffold: async () => {
      scaffoldCalls++;
      return { ok: true, stdout: '', stderr: '' };
    },
    techDesignApprove: async () => ({ ok: true, stdout: '', stderr: '' }),
    newReqSingle: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    newReqEpic: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    listEpicChildren: async () => ({ ok: true, issues: [], stderr: '' }),
    issueStates: async () => [],
    addLabel: async () => ({ ok: true, stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { state: string; error?: string | null }) => {
      notifications.push({ kind, state: s.state, error: s.error ?? null });
    },
    syncGroupCard: async () => {},
  },
});

// worker 导入 autoAssignOnGo；避免成功路径意外触真实负载探针。失败停泊用例不会走到这里。
mock.module('../src/util/load.ts', {
  namedExports: { probeLoad: async () => [] },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateB } = await import('../src/gates/gateB.ts');
const worker = await import('../src/orchestrator/worker.ts');

function deliveryDir(slug: string): string {
  return resolve(projectRoot, 'docs', 'delivery', slug);
}

async function createSession(id: string): ReturnType<typeof sessions.get> {
  await sessions.create({ id, slug: id, title: '退款需求', branch: 'dev', prd_url: 'https://feishu/prd' });
  return sessions.get(id);
}

async function moveToGateBRequested(id: string): Promise<void> {
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED']) {
    await sessions.transition(id, st as never);
  }
}

beforeEach(() => {
  claudeCalls = 0;
  lastPrompt = '';
  scaffoldCalls = 0;
  notifications.length = 0;
});

test('生产链路：封口 prd-truth 已存在时，闸B 只读冻结单源；后续 gate-a.json 损坏也不污染 prompt', async () => {
  const id = 'prdtruth-frozen-source';
  await createSession(id);
  mkdirSync(deliveryDir(id), { recursive: true });
  writeFileSync(
    resolve(deliveryDir(id), 'prd-truth.md'),
    [
      '# PRD 真源（已多轮评审）',
      '冻结事实：本期只做余额退款。',
      'PM 最终裁决：不做原路退款。',
    ].join('\n'),
  );
  const badGateA = resolve(mkdtempSync(resolve(tmpdir(), 'forge-bad-gatea-')), 'gate-a.json');
  writeFileSync(badGateA, '{"summary": "旧的三源不该再被读", "repos_');
  await sessions.patch(id, {
    gate_a_output_path: badGateA,
    confirmed_notes: '旧 confirmed_notes 不该作为独立输入拼进闸B',
  });

  await runGateB((await sessions.get(id))!);

  assert.equal(claudeCalls, 1);
  assert.equal(scaffoldCalls, 1);
  assert.match(lastPrompt, /冻结事实：本期只做余额退款/);
  assert.match(lastPrompt, /PM 最终裁决：不做原路退款/);
  assert.doesNotMatch(lastPrompt, /旧的三源不该再被读/);
  assert.doesNotMatch(lastPrompt, /旧 confirmed_notes 不该作为独立输入拼进闸B/);
  assert.doesNotMatch(lastPrompt, /\{\{PRD_TEXT\}\}|\{\{GATE_A_OUTPUT\}\}|\{\{CONFIRMED_NOTES\}\}/);
  assert.ok(readFileSync(resolve('logs', id, 'gate-b.prompt.txt'), 'utf8').includes('冻结事实：本期只做余额退款'));
});

test('生产链路：封口文档缺且 gate-a.json 损坏时，worker 停泊 GATE_B_FAILED，不调用 Claude 生成空壳方案', async () => {
  const id = 'prdtruth-bad-gatea-parks';
  await createSession(id);
  await moveToGateBRequested(id);
  const badGateA = resolve(mkdtempSync(resolve(tmpdir(), 'forge-bad-gatea-')), 'gate-a.json');
  writeFileSync(badGateA, '{"summary": "截断的评审稿"');
  await sessions.patch(id, { gate_a_output_path: badGateA, confirmed_notes: 'PM：已确认' });

  await worker.step((await sessions.get(id))!);

  const parked = (await sessions.get(id))!;
  assert.equal(parked.state, 'GATE_B_FAILED');
  assert.match(parked.error ?? '', /PRD 真源：闸A 信封 JSON 解析失败/);
  assert.equal(claudeCalls, 0);
  assert.equal(scaffoldCalls, 0);
  assert.ok(notifications.some((n) => n.kind === 'failed' && n.state === 'GATE_B_FAILED'));
});
