// 单元：群状态卡的**投递路径**（notify.ts syncGroupCard）。全程无网络——port 与 store 都被替换。
//
// 这里钉死的是一条只在真实群里才会暴露的规则：**卡片绝不能因为「回不到原消息下面」就消失**。
// 状态卡是需求在群里的唯一反馈面，intake 那条消息却随时可能回不上去（被删、太久、或补拉登记时
// 记下的 id 本就跨了一次重启）。回复失败若不退回「直接发到群」，这条需求全程无声，而且
// status_msg_id 永远是空 → 之后每次同步都重走同一条失败路径，自己好不了。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel } from '../src/messaging/model.ts';
import type { Session } from '../src/types.ts';

// ── 假 port：只实现群卡三个出口，其余成员在本用例里永不被调用 ──
let replyResult: string | null = 'reply-card-id';
let sendResult: string | null = 'group-card-id';
const replies: { messageId: string; card: CardModel }[] = [];
const sends: { chatId: string; card: CardModel }[] = [];
const edits: { messageId: string; card: CardModel }[] = [];
const fakePort = {
  id: 'fake',
  async replyGroupCard(messageId: string, card: CardModel) {
    replies.push({ messageId, card });
    return replyResult;
  },
  async sendGroupCard(chatId: string, card: CardModel) {
    sends.push({ chatId, card });
    return sendResult;
  },
  async editGroupCard(messageId: string, card: CardModel) {
    edits.push({ messageId, card });
    return true;
  },
};

// ── 假 store：get 回读最新态（syncGroupCard 靠它避免陈旧重复发），patch 记录写回 ──
let current: Session | null = null;
const patches: { id: string; fields: Partial<Session> }[] = [];
const fakeStore = {
  get: async () => current,
  patch: async (id: string, fields: Partial<Session>) => {
    patches.push({ id, fields });
    return { ...(current as Session), ...fields };
  },
};

mock.module('../src/messaging/index.ts', { namedExports: { port: fakePort } });
mock.module('../src/store/index.ts', { namedExports: { store: fakeStore } });

const { syncGroupCard } = await import('../src/notify.ts');

function sess(p: Partial<Session>): Session {
  return {
    id: 'id1', slug: 'finance-report', title: 't', state: 'AWAITING_GO', branch: 'dev',
    gate_a_output_path: null, routing: null, adversarial_residual: null,
    gate_a_cost_usd: 0, gate_b_cost_usd: 0, confirmed_by: null, confirmed_notes: null,
    error: null, prd_url: null, chat_id: 'oc_1', poster_id: null, intake_msg_id: null, status_msg_id: null,
    ...p,
  } as unknown as Session;
}

function reset(): void {
  replyResult = 'reply-card-id';
  sendResult = 'group-card-id';
  replies.length = 0;
  sends.length = 0;
  edits.length = 0;
  patches.length = 0;
}

test('群状态卡：有 intake 消息 id → 回复到 PM 那条下面，卡 id 落 status_msg_id', async () => {
  reset();
  current = sess({ intake_msg_id: 'om_pm' });
  await syncGroupCard(current);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].messageId, 'om_pm');
  assert.equal(sends.length, 0, '回复成功时不该另发一张到群里');
  assert.deepEqual(patches, [{ id: 'id1', fields: { status_msg_id: 'reply-card-id' } }]);
});

test('群状态卡：无 intake 消息 id（手动 add / 补拉没拿到）→ 直接发到群', async () => {
  reset();
  current = sess({ intake_msg_id: null });
  await syncGroupCard(current);
  assert.equal(replies.length, 0);
  assert.deepEqual(sends.map((s) => s.chatId), ['oc_1']);
  assert.deepEqual(patches, [{ id: 'id1', fields: { status_msg_id: 'group-card-id' } }]);
});

test('群状态卡：intake 消息回不上去（被删/过期）→ 退回直接发到群，卡不丢', async () => {
  reset();
  replyResult = null; // adapter 报回复失败
  current = sess({ intake_msg_id: 'om_gone' });
  await syncGroupCard(current);
  assert.equal(replies.length, 1, '先试回复');
  assert.deepEqual(sends.map((s) => s.chatId), ['oc_1'], '回复失败必须退到群里发，而不是把卡丢掉');
  // 落的是群卡的 id：下一轮同步走原地编辑，不会再撞一次失败的回复路径。
  assert.deepEqual(patches, [{ id: 'id1', fields: { status_msg_id: 'group-card-id' } }]);
});

test('群状态卡：回复与群发都失败 → 不写 status_msg_id，也不抛（流程不受影响）', async () => {
  reset();
  replyResult = null;
  sendResult = null;
  current = sess({ intake_msg_id: 'om_gone' });
  await syncGroupCard(current);
  assert.equal(patches.length, 0, '没发出去就不能记 status_msg_id——否则之后的原地编辑全打在空 id 上');
});

test('群状态卡：已有 status_msg_id → 原地编辑同一张卡，不新发', async () => {
  reset();
  current = sess({ intake_msg_id: 'om_pm', status_msg_id: 'card_1' });
  await syncGroupCard(current);
  assert.deepEqual(edits.map((e) => e.messageId), ['card_1']);
  assert.equal(replies.length + sends.length, 0);
  assert.equal(patches.length, 0);
});

test('群状态卡：非群来源（无 chat_id）→ 一张都不发', async () => {
  reset();
  current = sess({ chat_id: null });
  await syncGroupCard(current);
  assert.equal(replies.length + sends.length + edits.length, 0);
});
