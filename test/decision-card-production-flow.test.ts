// 集成：决策卡从飞书按钮提交到本地复评状态与 PRD 留痕的生产链路。
// 只 mock 外部发送/tick；表单解析、session 状态、答复拼装、PRD 评论文本走真实代码。
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const comments: { token: string; text: string }[] = [];
let tickCalls = 0;

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
    feishuCommentAdd: async (token: string, text: string) => {
      comments.push({ token, text });
      return { ok: true };
    },
    reviewReqScaffold: async () => {},
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    newReqSingle: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    newReqEpic: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    listEpicChildren: async () => ({ ok: true, issues: [], stderr: '' }),
    addLabel: async () => ({ ok: true, stderr: '' }),
    techDesignApprove: async () => ({ ok: true, stdout: '', stderr: '' }),
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async () => {},
    syncGroupCard: async () => {},
  },
});

mock.module('../src/orchestrator/worker.ts', {
  namedExports: {
    tick: async () => {
      tickCalls++;
    },
  },
});

mock.module('../src/intake.ts', {
  namedExports: {
    addPrd: async () => ({ ok: true, msg: 'mocked intake' }),
  },
});

mock.module('../src/feishu/dm.ts', {
  namedExports: {
    FEISHU_BASE: 'https://example.invalid',
    botTenantToken: async () => 'token',
    botOpenId: async () => null,
    botOpenIdCached: () => null,
    sendBotCard: async () => {},
    sendBotCardObject: async () => {},
  },
});

mock.module('../src/feishu/group.ts', {
  namedExports: {
    replyCard: async () => 'msg',
    patchCard: async () => true, // listen.ts 现经 messaging/feishu(port) 间接 import 全套 group 函数
    sendCardToChat: async () => 'msg',
  },
});

mock.module('../src/messaging/backfill.ts', {
  namedExports: {
    backfillAll: async () => {},
  },
});

const sessions = await import('../src/store/sessions.ts');
const { __handleCardActionForTest } = await import('../src/daemon/listen.ts');

const tmp = mkdtempSync(resolve(tmpdir(), 'forge-decision-flow-'));
let seq = 0;

function gateAPath(openQuestions: unknown[]): string {
  const p = resolve(tmp, `gate-a-${seq++}.json`);
  writeFileSync(p, JSON.stringify({ summary: 's', open_questions: openQuestions, risks: [] }));
  return p;
}

async function awaitingPmSession(id: string, gateAOutputPath: string): Promise<void> {
  await sessions.create({ id, slug: id, title: '充值规则', branch: 'main', feishu_doc_token: `doc-${id}` });
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'AWAITING_PM_CONFIRM');
  await sessions.patch(id, { gate_a_output_path: gateAOutputPath, gate_a_round: 2 });
}

test('PM 只点逐条下拉：复评输入和 PRD 留痕都保留第 6-8 条业务决定', async () => {
  comments.length = 0;
  tickCalls = 0;
  const id = 'pm-dropdown-only';
  await awaitingPmSession(
    id,
    gateAPath(
      Array.from({ length: 8 }, (_, i) => ({
        q: `第${i + 1}个业务决定？`,
        severity: i === 7 ? 'high' : 'med',
        options: [
          { label: `推荐答案${i + 1}`, recommended: true, impact: `影响${i + 1}` },
          { label: `备选答案${i + 1}`, recommended: false, impact: `代价${i + 1}` },
        ],
      })),
    ),
  );

  await __handleCardActionForTest({
    action: { value: { action: 'confirm_submit', slug: id, round: 2 } },
    raw: {
      event: {
        action: {
          form_value: {
            verdict: 'accept',
            ask_H1: '推荐答案1',
            ask_H6: '推荐答案6',
            ask_H8: '备选答案8',
          },
        },
      },
    },
  });

  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_REVISION_REQUESTED');
  assert.match(s.gate_a_pending_input ?? '', /H1（第1个业务决定？）：推荐答案1/);
  assert.match(s.gate_a_pending_input ?? '', /H6（第6个业务决定？）：推荐答案6/);
  assert.match(s.gate_a_pending_input ?? '', /H8（第8个业务决定？）：备选答案8/);
  assert.match(s.confirmed_notes ?? '', /第2轮答复/);
  assert.match(s.confirmed_notes ?? '', /备选答案8/);
  assert.equal(tickCalls, 1);

  assert.equal(comments.length, 1);
  assert.equal(comments[0].token, `doc-${id}`);
  assert.match(comments[0].text, /【PM确认 · 第2轮】/);
  assert.match(comments[0].text, /选择：采纳建议，确认通过/);
  assert.match(comments[0].text, /批注：H1（第1个业务决定？）：推荐答案1/);
  assert.match(comments[0].text, /H8（第8个业务决定？）：备选答案8/);
  assert.doesNotMatch(comments[0].text, /批注：（无）/);
});

test('PM 选其他但未补充：不会伪造选项答案，复评明确收到部分采纳', async () => {
  comments.length = 0;
  tickCalls = 0;
  const id = 'pm-other-no-notes';
  await awaitingPmSession(
    id,
    gateAPath([{ q: '退款退到哪里？', severity: 'high', options: [{ label: '原路', recommended: true, impact: '合规清晰' }] }]),
  );

  await __handleCardActionForTest({
    action: { value: { action: 'confirm_submit', slug: id, round: 2 } },
    raw: { event: { action: { form_value: { verdict: 'partial', ask_H1: '__other__' } } } },
  });

  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_REVISION_REQUESTED');
  assert.equal(s.gate_a_pending_input, '部分采纳');
  assert.match(s.confirmed_notes ?? '', /部分采纳/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /选择：部分采纳/);
  assert.match(comments[0].text, /批注：（无）/);
  assert.equal(tickCalls, 1);
});
