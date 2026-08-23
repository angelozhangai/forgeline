// 集成：从真实动作入口(forge go)验证多仓写入的生产后果。
// 只 mock GitHub/主仓脚本边界；状态机、actions.go、writes.doWrites、session 落库走真实代码。
process.env.FORGE_DB = ':memory:';

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

let epicCreates = 0;
let approveCalls = 0;
let labelCalls = 0;
let epicMissExampleChild = false;
let discoveredByRepo: Record<string, { number: number; url: string }[]> = {};
const notifications: { kind: string; state: string; issues?: unknown }[] = [];

function epicStdout(): string {
  const lines = [
    '═══ 建【多仓需求 Epic】epic:refund-flow：退款方案 ═══',
    '  ✓ Epic P#10  状态=status:1-待讨论',
    '  ── 子 issue ──',
    '    ✓ C#11  feat(api): 退款接口',
  ];
  if (!epicMissExampleChild) lines.push('    ✓ U#12  feat(web): 退款入口');
  lines.push('  → Epic: https://github.com/your-org/example-project/issues/10');
  return lines.join('\n');
}

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
    newReqSingle: async () => ({ ok: false, stdout: '', stderr: 'unexpected single path', issues: [] }),
    newReqEpic: async () => {
      epicCreates++;
      return {
        ok: true,
        stdout: epicStdout(),
        stderr: '',
        issues: [{ repo: 'example-project', number: 10, url: 'https://github.com/your-org/example-project/issues/10' }],
      };
    },
    listEpicChildren: async (repo: string) => ({
      ok: true,
      issues: (discoveredByRepo[repo] ?? []).map((i) => ({ repo, number: i.number, url: i.url })),
      stderr: '',
    }),
    addLabel: async () => {
      labelCalls++;
      return { ok: true, stderr: '' };
    },
    techDesignApprove: async () => {
      approveCalls++;
      return { ok: true, stdout: 'status:3', stderr: '' };
    },
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { state: string }, extra?: { issues?: unknown }) => {
      notifications.push({ kind, state: s.state, issues: extra?.issues });
    },
    syncGroupCard: async () => {},
  },
});

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');

const tmp = mkdtempSync(resolve(tmpdir(), 'forge-go-flow-'));
let seq = 0;

const multiRepoDraft = {
  summary: '退款方案',
  key_decisions: { rollout: 'backend first' },
  tech_design_markdown: '后端先行，前端随后接入。',
  multi_repo: true,
  epic_title: '[Epic] 退款能力',
  issue_specs: [
    { repo: 'C', title: 'feat(api): 退款接口', type: 'feat', prio: 'P1' },
    { repo: 'U', title: 'feat(web): 退款入口', type: 'feat', prio: 'P1' },
  ],
  acceptance: {
    contracts: [{ repo: '', surface: 'POST /api/v1/refunds {order_id, idem_key} -> 200 {refund_id}' }],
    scenarios: [{ id: 'AC1', repo: '', gherkin: 'Given 已支付订单\nWhen 以幂等键发起退款\nThen 返回退款编号且订单进入退款中' }],
  },
  confidence: 0.88,
};

function draftPath(env = multiRepoDraft): string {
  const p = resolve(tmp, `gate-b-${seq++}.json`);
  writeFileSync(p, JSON.stringify(env));
  return p;
}

async function sessionAwaitingGo(slug: string): Promise<string> {
  await sessions.create({ id: slug, slug, title: '退款方案', branch: 'dev' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO']) {
    await sessions.transition(slug, st as never);
  }
  await sessions.patch(slug, { gate_b_draft_path: draftPath(), size: 'M', assignee: 'M' }); // 立项需 DRI（指派层闸）
  return slug;
}

async function issueRepos(slug: string): Promise<string[]> {
  return JSON.parse((await sessions.get(slug))!.created_issues ?? '[]').map((i: { repo: string }) => i.repo).sort();
}

beforeEach(() => {
  epicCreates = 0;
  approveCalls = 0;
  labelCalls = 0;
  epicMissExampleChild = false;
  discoveredByRepo = {};
  notifications.length = 0;
});

test('go 生产流：多仓部分创建失败停在 WRITE_FAILED，人工补 child 后 retry 才 DONE 且不重复建 Epic', async () => {
  const slug = await sessionAwaitingGo('refund-flow');
  epicMissExampleChild = true;

  const first = await actions.go(slug, 'M');
  assert.equal(first.ok, false);
  assert.match(first.msg, /sub-issues are missing/);
  assert.equal((await sessions.get(slug))!.state, 'WRITE_FAILED');
  assert.deepEqual(await issueRepos(slug), ['demo', 'example-project']);
  assert.equal(epicCreates, 1);
  assert.equal(approveCalls, 0);
  assert.ok(notifications.some((n) => n.kind === 'failed' && n.state === 'WRITE_FAILED'));

  const stillMissing = await actions.go(slug, 'M');
  assert.equal(stillMissing.ok, false);
  assert.equal((await sessions.get(slug))!.state, 'WRITE_FAILED');
  assert.deepEqual(await issueRepos(slug), ['demo', 'example-project']);
  assert.equal(epicCreates, 1, 'retry must not create a second Epic');
  assert.equal(approveCalls, 0);

  discoveredByRepo = {
    'example-web': [{ number: 12, url: 'https://github.com/your-org/example-web/issues/12' }],
  };
  const repaired = await actions.go(slug, 'M');
  assert.equal(repaired.ok, true);
  assert.match(repaired.msg, /DONE|已建/);
  assert.equal((await sessions.get(slug))!.state, 'DONE');
  assert.deepEqual(await issueRepos(slug), ['demo', 'example-project', 'example-web']);
  assert.equal(epicCreates, 1, 'manual add-child repair must be discovered, not recreated');
  assert.equal(approveCalls, 1);
  assert.equal(labelCalls, 1, 'multi-repo size label is applied to the Epic demand row');
  assert.ok(notifications.some((n) => n.kind === 'done' && n.state === 'DONE'));
});

