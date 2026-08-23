// Integration: the real business chain behind a channel message. Only the external IM and gate-execution
// boundaries are mocked; the chain itself runs listen -> MessagingPort.parseMessage -> claimDocs (the
// document-source registry) -> addPrd -> the channel reply, the cursor and the tick.
// No mirror testing: this does not inspect which fields listen reads, only what production actually does
// once product posts a message in the channel.
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel, InboundMessage } from '../src/messaging/model.ts';
import type { MessagingPort } from '../src/messaging/port.ts';
// cursors is deliberately **not** imported statically here: a static import hoists above the
// FORGE_DB=':memory:' above, so cursors -> store -> root.ts would evaluate DB_PATH before the env is set and
// land on the real database, polluting chat_cursor in state/service.db.
// Same pattern as the other database-touching tests in this suite: import **dynamically** once FORGE_DB is
// set (see the await import at the end of the file).

type IntakeCall = { doc: { source: string; token: string; url?: string }; chatId?: string; posterId?: string; intakeMsgId?: string };

let parsedMessage: InboundMessage | null = null;
const addPrdCalls: IntakeCall[] = [];
let addPrdResult: Record<string, unknown> = {};
let tickCalls = 0;
let syncCalls = 0;
const groupReplies: { replyToMessageId: string; card: CardModel }[] = [];
const groupSends: { chatId: string; card: CardModel }[] = [];

const port: MessagingPort = {
  sendDmCard: async () => true,
  sendDmText: async () => true,
  replyGroupCard: async (replyToMessageId, card) => {
    groupReplies.push({ replyToMessageId, card });
    return 'reply-card';
  },
  sendGroupCard: async (chatId, card) => {
    groupSends.push({ chatId, card });
    return 'group-card';
  },
  editGroupCard: async () => true,
  postWebhook: async () => true,
  parseCardAction: () => null,
  parseMessage: () => parsedMessage,
  inboundConfigured: () => false, // this test calls __handleMessageForTest directly and never opens a connection
  startInbound: () => ({ connect: async () => {} }),
  probe: async () => ({ available: false, ok: false, detail: 'stub' }),
};

mock.module('../src/messaging/index.ts', {
  namedExports: { port },
});
mock.module('../src/intake.ts', {
  namedExports: {
    addPrd: async (call: IntakeCall) => {
      addPrdCalls.push(call);
      return addPrdResult;
    },
  },
});
mock.module('../src/notify.ts', {
  namedExports: {
    notify: async () => {},
    syncGroupCard: async () => {
      syncCalls++;
    },
  },
});
mock.module('../src/orchestrator/worker.ts', {
  namedExports: {
    tick: async () => {
      tickCalls++;
    },
  },
});
mock.module('../src/messaging/backfill.ts', { namedExports: { backfillAll: async () => {} } });
mock.module('../src/health/alert.ts', { namedExports: { sendHealthAlert: async () => {} } });

const { __handleMessageForTest } = await import('../src/daemon/listen.ts');
const cursors = await import('../src/store/cursors.ts'); // dynamic: loaded only once FORGE_DB=':memory:' is set, so root.ts lands on the in-memory database and never touches the real one

function reset(): void {
  parsedMessage = null;
  addPrdCalls.length = 0;
  addPrdResult = {};
  tickCalls = 0;
  syncCalls = 0;
  groupReplies.length = 0;
  groupSends.length = 0;
}

test('product posts a share card or rich text: even with no link in the plain text it registers the PRD, replies with a status card, advances the watermark and ticks straight away', async () => {
  reset();
  const shareUrl = 'https://example.feishu.cn/docx/RichDocToken?from=share';
  parsedMessage = {
    type: 'message',
    chatId: 'oc_rich',
    senderId: 'ou_pm',
    messageId: 'om_rich',
    text: 'the requirement document is in the share card',
    searchTexts: [`{"href":"${shareUrl}","title":"top-up and refund requirement"}`],
    createTime: 1_700_000_000_123,
    isGroup: true,
    mentionedBot: true, // the bot was mentioned in the channel -> it enters the flow
  };
  addPrdResult = { ok: true, created: true, session: { id: 'rich-doc', slug: 'rich-doc' } };

  await __handleMessageForTest({ raw: { ignored: true } });

  assert.deepEqual(addPrdCalls, [
    { doc: { source: 'feishu', token: 'RichDocToken', url: 'https://example.feishu.cn/docx/RichDocToken' }, chatId: 'oc_rich', posterId: 'ou_pm', intakeMsgId: 'om_rich' },
  ]);
  assert.equal(syncCalls, 1, 'a new PRD should reply or refresh the status card in the channel at once, so product can see it was picked up');
  assert.equal(tickCalls, 1, 'a valid PRD should push gate A forward immediately rather than waiting for the next poll');
  assert.equal(cursors.getCursor('oc_rich'), 1_700_000_000_123, 'a handled message has to advance the watermark, so a reconnect does not backfill it again');
});

test('a duplicate PRD: nothing is filed again, but the original message gets an explicit reply saying it was a repeat', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_dup',
    senderId: 'ou_pm',
    messageId: 'om_dup',
    text: 'posting it again https://example.feishu.cn/wiki/DupToken',
    createTime: 1_700_000_000_456,
    isGroup: true,
    mentionedBot: true,
  };
  addPrdResult = { ok: true, created: false, msg: 'this PRD has already been reviewed, so it will not start another review.', session: { id: 'old', slug: 'old-req', state: 'DONE' } };

  await __handleMessageForTest({});

  assert.equal(addPrdCalls.length, 1);
  assert.equal(syncCalls, 0, 'a duplicate PRD should not refresh into a status card for a new requirement');
  assert.equal(groupReplies.length, 1, 'with the original message id available, the reply belongs under product\'s message');
  assert.equal(groupReplies[0].replyToMessageId, 'om_dup');
  assert.match(JSON.stringify(groupReplies[0].card), /already been reviewed/);
  assert.equal(groupSends.length, 0);
  assert.equal(cursors.getCursor('oc_dup'), 1_700_000_000_456);
});

test('a channel message that does not mention the bot stays out of the flow even carrying a Feishu link -- nothing filed, no tick, no card -- but the watermark still advances', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_nomention',
    senderId: 'ou_someone',
    messageId: 'om_nomention',
    text: 'just sharing this https://example.feishu.cn/wiki/SomeShared',
    createTime: 1_700_000_001_000,
    isGroup: true,
    mentionedBot: false, // the bot was not mentioned in the channel -> ignored by the rule
  };
  addPrdResult = { ok: true, created: true, session: { id: 'should-not', slug: 'should-not' } };

  await __handleMessageForTest({ raw: {} });

  assert.equal(addPrdCalls.length, 0, 'a channel message without a mention must never file a requirement -- a casual share should not be swallowed into a gate A run and billed for');
  assert.equal(tickCalls, 0, 'what does not enter the flow should not trigger a tick');
  assert.equal(syncCalls, 0);
  assert.equal(cursors.getCursor('oc_nomention'), 1_700_000_001_000, 'even an ignored message advances the watermark, so a reconnect does not keep re-fetching this un-mentioned message');
});

test('a channel message while the bot identity is not ready (mentionedBot=null): ignored conservatively and kept out of the flow, but the watermark still advances', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_unknown',
    senderId: 'ou_someone',
    messageId: 'om_unknown',
    text: 'have a look at https://example.feishu.cn/wiki/Whatever',
    createTime: 1_700_000_002_000,
    isGroup: true,
    mentionedBot: null, // cannot tell whether the bot was mentioned -> better to miss one than to swallow one
  };
  addPrdResult = { ok: true, created: true, session: { id: 'should-not', slug: 'should-not' } };

  await __handleMessageForTest({ raw: {} });

  assert.equal(addPrdCalls.length, 0, 'with the identity unconfirmed it is ignored conservatively and never enters the flow');
  assert.equal(tickCalls, 0);
  assert.equal(cursors.getCursor('oc_unknown'), 1_700_000_002_000);
});

test('a direct message (isGroup=false): directed by nature, so it enters the flow without any mention', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_p2p',
    senderId: 'ou_pm',
    messageId: 'om_p2p',
    text: 'sending a requirement by DM https://example.feishu.cn/wiki/P2PToken',
    createTime: 1_700_000_003_000,
    isGroup: false,
    mentionedBot: false, // a DM needs no mention, so mentionedBot plays no part in the decision
  };
  addPrdResult = { ok: true, created: true, session: { id: 'p2p-doc', slug: 'p2p-doc' } };

  await __handleMessageForTest({ raw: {} });

  assert.equal(addPrdCalls.length, 1, 'a directed DM enters the flow as usual, and is not stopped by the channel mention gate');
  assert.deepEqual(addPrdCalls[0].doc, { source: 'feishu', token: 'P2PToken', url: 'https://example.feishu.cn/wiki/P2PToken' });
  assert.equal(tickCalls, 1);
});
