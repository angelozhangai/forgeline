// Integration: the production chain from pressing a button on the decision card through to the local
// re-review state and the record left on the PRD.
// Only the outbound send and the tick are mocked; parsing the form, the session state, assembling the answer
// and the PRD comment text all run for real.
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const comments: { token: string; text: string }[] = [];
let tickCalls = 0;

// Writing back to the document goes through the docs registry (Phase 1), so commentDoc is replaced here to
// assert what the core actually writes into the document.
mock.module('../src/docs/index.ts', {
  namedExports: {
    commentDoc: async (ref: string, text: string) => {
      comments.push({ token: ref, text });
    },
    readDoc: async () => ({ ok: true, text: '' }),
    formatRef: (r: { source: string; token: string }) => `${r.source}:${r.token}`,
    parseStoredRef: () => null,
    registeredIds: () => ['feishu'],
    parseAnyRef: () => null,
    claimDocs: () => [],
  },
});

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
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
    patchCard: async () => true, // listen.ts now imports the whole group module indirectly, through messaging/feishu (the port)
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
  await sessions.create({ id, slug: id, title: 'top-up rules', branch: 'main', doc_ref: `doc-${id}` });
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'AWAITING_PM_CONFIRM');
  await sessions.patch(id, { gate_a_output_path: gateAOutputPath, gate_a_round: 2 });
}

test('product uses only the per-question dropdowns: both the re-review input and the record on the PRD keep business decisions 6 through 8', async () => {
  comments.length = 0;
  tickCalls = 0;
  const id = 'pm-dropdown-only';
  await awaitingPmSession(
    id,
    gateAPath(
      Array.from({ length: 8 }, (_, i) => ({
        q: `business decision ${i + 1}?`,
        severity: i === 7 ? 'high' : 'med',
        options: [
          { label: `recommended answer ${i + 1}`, recommended: true, impact: `impact ${i + 1}` },
          { label: `alternative answer ${i + 1}`, recommended: false, impact: `cost ${i + 1}` },
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
            ask_H1: 'recommended answer 1',
            ask_H6: 'recommended answer 6',
            ask_H8: 'alternative answer 8',
          },
        },
      },
    },
  });

  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_REVISION_REQUESTED');
  assert.match(s.gate_a_pending_input ?? '', /H1 \(business decision 1\?\): recommended answer 1/);
  assert.match(s.gate_a_pending_input ?? '', /H6 \(business decision 6\?\): recommended answer 6/);
  assert.match(s.gate_a_pending_input ?? '', /H8 \(business decision 8\?\): alternative answer 8/);
  assert.match(s.confirmed_notes ?? '', /\[round 2 answers\]/);
  assert.match(s.confirmed_notes ?? '', /alternative answer 8/);
  assert.equal(tickCalls, 1);

  assert.equal(comments.length, 1);
  assert.equal(comments[0].token, `doc-${id}`);
  assert.match(comments[0].text, /\[Product confirmed · round 2\]/);
  assert.match(comments[0].text, /Choice: suggestions accepted, confirmed/);
  assert.match(comments[0].text, /Notes: H1 \(business decision 1\?\): recommended answer 1/);
  assert.match(comments[0].text, /H8 \(business decision 8\?\): alternative answer 8/);
  assert.doesNotMatch(comments[0].text, /Notes: \(none\)/);
});

test('product picks "other" without adding anything: no answer is invented, and the re-review is told plainly it was partially accepted', async () => {
  comments.length = 0;
  tickCalls = 0;
  const id = 'pm-other-no-notes';
  await awaitingPmSession(
    id,
    gateAPath([{ q: 'Where does the refund go?', severity: 'high', options: [{ label: 'the original method', recommended: true, impact: 'cleaner for compliance' }] }]),
  );

  await __handleCardActionForTest({
    action: { value: { action: 'confirm_submit', slug: id, round: 2 } },
    raw: { event: { action: { form_value: { verdict: 'partial', ask_H1: '__other__' } } } },
  });

  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_REVISION_REQUESTED');
  assert.equal(s.gate_a_pending_input, 'Partially accepted');
  assert.match(s.confirmed_notes ?? '', /Partially accepted/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /Choice: partially accepted/);
  assert.match(comments[0].text, /Notes: \(none\)/);
  assert.equal(tickCalls, 1);
});
