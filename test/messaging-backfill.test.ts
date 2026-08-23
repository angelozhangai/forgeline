// Unit: the provider-neutral **offline backfill loop** (messaging/backfill.ts). No network at any point —
// both the port and intake are replaced.
//
// This is the regression base for the Phase 0 seam closure: once backfill's correctness logic (the cursor
// only moves forward / the boundary entry is filtered again / the link-extraction fallback order / the
// re-entrancy guard / seeding watched chats) moved up out of the Feishu layer into the core, it had to
// remain **pinnable by unit tests** rather than only being safe to change against a real tenant.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage } from '../src/messaging/model.ts';

// -- Fake port: implements only the two methods backfill uses; no other member is ever called here --
let watched: string[] = [];
let history: Record<string, InboundMessage[]> = {};
const historyCalls: { chatId: string; sinceMs: number }[] = [];
const fakePort = {
  id: 'fake',
  watchedChats: () => watched,
  listHistorySince: async (chatId: string, sinceMs: number) => {
    historyCalls.push({ chatId, sinceMs });
    return history[chatId] ?? [];
  },
};

let addPrdCalls: { prdUrl: string; chatId?: string; posterId?: string; intakeMsgId?: string }[] = []; // prdUrl comes from doc.url, which reads better in assertions
let createdUrls = new Set<string>(); // simulate addPrd's dedup: the same url a second time gives created=false

const warns: string[] = []; // the intake gate's "unconfirmable" is only exposed through a warning -> it must be assertable

mock.module('../src/util/log.ts', {
  namedExports: {
    log: { info: () => {}, ok: () => {}, warn: (m: string) => void warns.push(m), err: () => {} },
    out: () => {},
  },
});
mock.module('../src/messaging/index.ts', { namedExports: { port: fakePort } });
mock.module('../src/intake.ts', {
  namedExports: {
    addPrd: async (o: { doc: { url?: string; token: string }; chatId?: string; posterId?: string; intakeMsgId?: string }) => {
      const url = o.doc.url ?? o.doc.token;
      addPrdCalls.push({ prdUrl: url, chatId: o.chatId, posterId: o.posterId, intakeMsgId: o.intakeMsgId });
      const created = !createdUrls.has(url);
      createdUrls.add(url);
      return { ok: true, created, msg: '', session: { slug: `s-${addPrdCalls.length}` } };
    },
  },
});

const { backfillChat, backfillAll } = await import('../src/messaging/backfill.ts');
const cursors = await import('../src/store/cursors.ts'); // dynamic: load only after FORGE_DB=:memory: takes effect

function msg(o: Partial<InboundMessage> & { createTime: number }): InboundMessage {
  return { type: 'message', chatId: 'oc_1', text: '', createTime: o.createTime, ...o };
}
const DOC = 'https://xx.feishu.cn/docx/AAAAbbbb1111';
const DOC2 = 'https://xx.feishu.cn/wiki/CCCCdddd2222';

function reset(): void {
  watched = [];
  history = {};
  historyCalls.length = 0;
  addPrdCalls = [];
  createdUrls = new Set();
  warns.length = 0;
}

test('backfill: a document link in the body -> registered, and the cursor advances to the last entry', async () => {
  reset();
  cursors.advanceCursor('oc_a', 1000);
  history.oc_a = [
    msg({ chatId: 'oc_a', text: `take a look at this ${DOC}`, createTime: 2000, senderId: 'ou_pm', messageId: 'om_1' }),
    msg({ chatId: 'oc_a', text: 'got it', createTime: 3000 }),
  ];
  const n = await backfillChat('oc_a');
  assert.equal(n, 1);
  // The poster and originating message id are carried through: a backfilled requirement looks the same as
  // a live one (the status card replies under the PM's message and can @-mention them).
  assert.deepEqual(addPrdCalls, [{ prdUrl: DOC, chatId: 'oc_a', posterId: 'ou_pm', intakeMsgId: 'om_1' }]);
  assert.equal(cursors.getCursor('oc_a'), 3000); // the link-free entry advances the cursor too, or every round rescans
});

test('backfill: history is fetched from the current watermark (the second-precision boundary duplicate is filtered again by the core, so nothing is registered twice)', async () => {
  reset();
  cursors.advanceCursor('oc_b', 5000);
  // The adapter's rounding of start_time brings the watermark entry back with it: createTime === cursor
  // -> it must be skipped.
  history.oc_b = [msg({ chatId: 'oc_b', text: DOC, createTime: 5000 }), msg({ chatId: 'oc_b', text: DOC2, createTime: 6000 })];
  const n = await backfillChat('oc_b');
  assert.deepEqual(historyCalls, [{ chatId: 'oc_b', sinceMs: 5000 }]);
  assert.equal(n, 1);
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC2]); // the watermark entry was not re-registered
});

test('backfill: a history entry missing the poster / originating message id is still registered (it just cannot reply underneath it)', async () => {
  reset();
  cursors.advanceCursor('oc_a2', 0);
  // History APIs may legitimately omit these two (older messages, provider differences) — a missing field
  // cannot be a reason not to register, because that silently drops requirements filed while offline; the
  // only consequence is the status card posting straight to the channel (notify already has that
  // degradation).
  history.oc_a2 = [msg({ chatId: 'oc_a2', text: DOC, createTime: 100 })];
  const n = await backfillChat('oc_a2');
  assert.equal(n, 1);
  assert.deepEqual(addPrdCalls, [{ prdUrl: DOC, chatId: 'oc_a2', posterId: undefined, intakeMsgId: undefined }]);
});

// -- The channel intake gate (sharing messaging/gate.ts's predicate with the live entry point) --------
// None of the messages above set isGroup -> they are treated as non-channel and the gate stays out of it;
// the three cases below deliberately take the channel path.

test('backfill: a channel history message that did not @-mention the bot is not registered (the same cost guard), but the cursor still advances', async () => {
  reset();
  cursors.advanceCursor('oc_gate1', 0);
  history.oc_gate1 = [msg({ chatId: 'oc_gate1', text: `just sharing ${DOC}`, createTime: 100, isGroup: true, mentionedBot: false })];
  const n = await backfillChat('oc_gate1');
  assert.equal(n, 0);
  assert.deepEqual(addPrdCalls, [], 'a document casually shared in a channel should not cost a Gate A run');
  assert.equal(cursors.getCursor('oc_gate1'), 100, 'gated-out entries must advance the cursor, or every round rescans the same batch');
});

test('backfill: a channel history message that did @-mention the bot -> registered as usual', async () => {
  reset();
  cursors.advanceCursor('oc_gate2', 0);
  history.oc_gate2 = [msg({ chatId: 'oc_gate2', text: `@bot take a look ${DOC}`, createTime: 100, isGroup: true, mentionedBot: true })];
  assert.equal(await backfillChat('oc_gate2'), 1);
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]);
});

test('backfill: the mention cannot be confirmed (the history envelope carries no mentions) -> still registered, and that fact is warned about', async () => {
  reset();
  cursors.advanceCursor('oc_gate3', 0);
  history.oc_gate3 = [
    msg({ chatId: 'oc_gate3', text: DOC, createTime: 100, isGroup: true, mentionedBot: null }),
    msg({ chatId: 'oc_gate3', text: 'small talk', createTime: 200, isGroup: true, mentionedBot: null }),
  ];
  // The live side ignores this state; backfill **deliberately does the opposite**: the message is already
  // in the past, so ignoring it silently swallows a requirement filed while offline — which is backfill's
  // only reason to exist. Better a wasted Gate A run than a lost requirement.
  assert.equal(await backfillChat('oc_gate3'), 1);
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]);
  // This warning is the observation point for "does this provider's history envelope carry mentions" — one
  // run answers it, with no fishing out payloads by hand.
  const hit = warns.filter((w) => w.includes('could not be confirmed as mentioning the bot'));
  assert.equal(hit.length, 1, 'one aggregated report per round, not one line per message');
  assert.match(hit[0], /2 channel history messages/);
  assert.match(hit[0], /fake/); // names which provider's envelope is missing the field
});

test('backfill: with no link in the body, fall back to the text blocks the adapter supplied (a document share card / a rich-text post)', async () => {
  reset();
  cursors.advanceCursor('oc_c', 0);
  history.oc_c = [msg({ chatId: 'oc_c', text: '[shared document]', searchTexts: [`{"url":"${DOC}"}`], createTime: 100 })];
  await backfillChat('oc_c');
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]);
});

test('backfill: searchTexts are tried one by one and stop at the first hit (the same order as the live entry point)', async () => {
  reset();
  cursors.advanceCursor('oc_c2', 0);
  history.oc_c2 = [msg({ chatId: 'oc_c2', text: '', searchTexts: ['no link', `x ${DOC}`, `y ${DOC2}`], createTime: 100 })];
  await backfillChat('oc_c2');
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]); // once the second block hits, the third is not examined
});

test('backfill: the cursor only moves forward — out-of-order old messages in history cannot drag it back', async () => {
  reset();
  cursors.advanceCursor('oc_d', 9000);
  history.oc_d = [msg({ chatId: 'oc_d', text: 'old', createTime: 100 }), msg({ chatId: 'oc_d', text: DOC, createTime: 9500 })];
  await backfillChat('oc_d');
  assert.equal(cursors.getCursor('oc_d'), 9500);
});

test('backfill: a duplicate document makes addPrd report created=false -> it does not count as newly registered (dedup is harmless)', async () => {
  reset();
  cursors.advanceCursor('oc_e', 0);
  history.oc_e = [msg({ chatId: 'oc_e', text: DOC, createTime: 10 }), msg({ chatId: 'oc_e', text: DOC, createTime: 20 })];
  const n = await backfillChat('oc_e');
  assert.equal(addPrdCalls.length, 2);
  assert.equal(n, 1);
});

test('backfill: a chat seen for the first time starts from now and does not dredge up ancient history (sinceMs is approximately now, and the cursor is persisted immediately)', async () => {
  reset();
  const before = Date.now();
  history.oc_f = [];
  await backfillChat('oc_f');
  assert.ok(historyCalls[0].sinceMs >= before, 'an unknown chat should be fetched from now, not from 0 pulling in all of history');
  assert.ok((cursors.getCursor('oc_f') ?? 0) >= before);
});

test('backfillAll: watched chats are seeded first, then every registered chat is visited', async () => {
  reset();
  watched = ['oc_w1', 'oc_w2'];
  cursors.advanceCursor('oc_learned', 1); // chats learned from live messages must be backfilled too
  history.oc_w1 = [msg({ chatId: 'oc_w1', text: DOC, createTime: Date.now() + 1000 })];
  const n = await backfillAll();
  const visited = historyCalls.map((c) => c.chatId);
  for (const c of ['oc_w1', 'oc_w2', 'oc_learned']) assert.ok(visited.includes(c), `missed ${c}`);
  assert.equal(n, 1);
});

test('backfillAll: seeding does not overwrite an existing watermark (otherwise every startup would let now clobber the real watermark and lose messages)', async () => {
  reset();
  cursors.advanceCursor('oc_seed', 1234);
  watched = ['oc_seed'];
  await backfillAll();
  assert.equal(historyCalls.find((c) => c.chatId === 'oc_seed')?.sinceMs, 1234);
});

test('backfillAll: re-entrancy guard — concurrent triggers from startup, reconnect and the periodic tick run only one round', async () => {
  reset();
  watched = ['oc_g'];
  const [a, b] = await Promise.all([backfillAll(), backfillAll()]);
  const rounds = historyCalls.filter((c) => c.chatId === 'oc_g').length;
  assert.equal(rounds, 1, 'one of the concurrent triggers should be blocked by the re-entrancy guard');
  assert.equal(a + b, 0);
});
