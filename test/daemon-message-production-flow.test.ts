// 集成：群消息入口的真实业务链路。只 mock 外部 IM/闸执行边界；
// 链路本身走 listen → MessagingPort.parseMessage → claimDocs（文档源注册表）→ addPrd → 群反馈/cursor/tick。
// 禁止镜像测试：不检查 listen 内部字段读取，只验证 PM 在群里发消息后生产上会发生什么。
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel, InboundMessage } from '../src/messaging/model.ts';
import type { MessagingPort } from '../src/messaging/port.ts';
// cursors 故意**不在这里静态 import**：静态 import 会 hoist 到上面 FORGE_DB=:memory: 之前，
// 让 cursors→store→root.ts 在 env 设好前求值 DB_PATH → 落真库（污染 state/service.db 的 chat_cursor）。
// 与本套件其它涉库测试同范式：在 FORGE_DB 设好后**动态** import（见文件末 await import）。

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
  inboundConfigured: () => false, // 本测试直调 __handleMessageForTest，不走长连接
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
const cursors = await import('../src/store/cursors.ts'); // 动态：FORGE_DB=:memory: 设好后才加载 → root.ts 落内存库，不碰真库

function reset(): void {
  parsedMessage = null;
  addPrdCalls.length = 0;
  addPrdResult = {};
  tickCalls = 0;
  syncCalls = 0;
  groupReplies.length = 0;
  groupSends.length = 0;
}

test('PM 发文档分享/富文本消息：纯 text 无链接也能登记 PRD、回状态卡、推进水位并立即 tick', async () => {
  reset();
  const shareUrl = 'https://example.feishu.cn/docx/RichDocToken?from=share';
  parsedMessage = {
    type: 'message',
    chatId: 'oc_rich',
    senderId: 'ou_pm',
    messageId: 'om_rich',
    text: '需求文档见分享卡',
    searchTexts: [`{"href":"${shareUrl}","title":"充值退款需求"}`],
    createTime: 1_700_000_000_123,
    isGroup: true,
    mentionedBot: true, // 群里 @ 了机器人 → 入流程
  };
  addPrdResult = { ok: true, created: true, session: { id: 'rich-doc', slug: 'rich-doc' } };

  await __handleMessageForTest({ raw: { ignored: true } });

  assert.deepEqual(addPrdCalls, [
    { doc: { source: 'feishu', token: 'RichDocToken', url: 'https://example.feishu.cn/docx/RichDocToken' }, chatId: 'oc_rich', posterId: 'ou_pm', intakeMsgId: 'om_rich' },
  ]);
  assert.equal(syncCalls, 1, '新 PRD 应立即在群里回复/刷新状态卡，PM 看到入口已接住');
  assert.equal(tickCalls, 1, '收到有效 PRD 后应立即推进闸A，而不是等下一轮 poll');
  assert.equal(cursors.getCursor('oc_rich'), 1_700_000_000_123, '处理过的消息要推进水位，避免重连后重复补拉');
});

test('重复 PRD：不重建立项，但会在原消息下明确回复重复提交', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_dup',
    senderId: 'ou_pm',
    messageId: 'om_dup',
    text: '再发一次 https://example.feishu.cn/wiki/DupToken',
    createTime: 1_700_000_000_456,
    isGroup: true,
    mentionedBot: true,
  };
  addPrdResult = { ok: true, created: false, msg: '这份 PRD 已评审过，本次不再重复评审。', session: { id: 'old', slug: 'old-req', state: 'DONE' } };

  await __handleMessageForTest({});

  assert.equal(addPrdCalls.length, 1);
  assert.equal(syncCalls, 0, '重复 PRD 不应刷新成新需求状态卡');
  assert.equal(groupReplies.length, 1, '有原消息 id 时应回复到 PM 那条下面');
  assert.equal(groupReplies[0].replyToMessageId, 'om_dup');
  assert.match(JSON.stringify(groupReplies[0].card), /已评审过/);
  assert.equal(groupSends.length, 0);
  assert.equal(cursors.getCursor('oc_dup'), 1_700_000_000_456);
});

test('群消息未 @机器人：含飞书链接也不入流程（不建需求/不 tick/不发卡），但推进水位', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_nomention',
    senderId: 'ou_someone',
    messageId: 'om_nomention',
    text: '随手分享 https://example.feishu.cn/wiki/SomeShared',
    createTime: 1_700_000_001_000,
    isGroup: true,
    mentionedBot: false, // 群里没 @ 机器人 → 按规则忽略
  };
  addPrdResult = { ok: true, created: true, session: { id: 'should-not', slug: 'should-not' } };

  await __handleMessageForTest({ raw: {} });

  assert.equal(addPrdCalls.length, 0, '未 @机器人 的群消息绝不建需求（避免随手分享被误吃进闸A 白花钱）');
  assert.equal(tickCalls, 0, '不入流程就不该触发 tick');
  assert.equal(syncCalls, 0);
  assert.equal(cursors.getCursor('oc_nomention'), 1_700_000_001_000, '忽略也要推进水位，避免重连后反复重拉这条非 @ 消息');
});

test('群消息 bot 身份未就绪（mentionedBot=null）：保守忽略、不入流程，但推进水位', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_unknown',
    senderId: 'ou_someone',
    messageId: 'om_unknown',
    text: '看下 https://example.feishu.cn/wiki/Whatever',
    createTime: 1_700_000_002_000,
    isGroup: true,
    mentionedBot: null, // 无法确认是否 @ 了机器人 → 宁可漏不可误吃
  };
  addPrdResult = { ok: true, created: true, session: { id: 'should-not', slug: 'should-not' } };

  await __handleMessageForTest({ raw: {} });

  assert.equal(addPrdCalls.length, 0, '身份未确认时保守忽略，绝不入流程');
  assert.equal(tickCalls, 0);
  assert.equal(cursors.getCursor('oc_unknown'), 1_700_000_002_000);
});

test('p2p 私聊（isGroup=false）：天然定向，无需 @机器人 也照常入流程', async () => {
  reset();
  parsedMessage = {
    type: 'message',
    chatId: 'oc_p2p',
    senderId: 'ou_pm',
    messageId: 'om_p2p',
    text: '私聊发需求 https://example.feishu.cn/wiki/P2PToken',
    createTime: 1_700_000_003_000,
    isGroup: false,
    mentionedBot: false, // 私聊不要求 @，mentionedBot 不参与判定
  };
  addPrdResult = { ok: true, created: true, session: { id: 'p2p-doc', slug: 'p2p-doc' } };

  await __handleMessageForTest({ raw: {} });

  assert.equal(addPrdCalls.length, 1, '私聊定向消息照常入流程（不被群 @ 闸拦下）');
  assert.deepEqual(addPrdCalls[0].doc, { source: 'feishu', token: 'P2PToken', url: 'https://example.feishu.cn/wiki/P2PToken' });
  assert.equal(tickCalls, 1);
});
