// 飞书 raw 层——**会话是群还是私聊**（src/feishu/history.ts chatIsGroup）。
//
// 为什么值得单独钉：这里有一个同名字段的陷阱，只靠注释守不住。飞书两个接口里都叫 chat_type，
// 意思却不一样——
//   · 事件 message.chat_type：'group' / 'p2p'        ← 会话形态（补拉要的是这个）
//   · im/v1/chats 的 chat_type：'private' / 'public' ← 群的**可见性**
// 拿后者当前者用，所有公开群都会被判成私聊、入口闸整个失效，而症状只是"群里随手分享的文档全被立项了"。
// 所以判定必须走 chat_mode，且要有一条用例专门喂一个 chat_type='private' 的**群**。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let token: string | null = 'tk';
mock.module('../src/feishu/dm.ts', {
  namedExports: {
    FEISHU_BASE: 'https://open.feishu.cn/open-apis',
    botTenantToken: async () => token,
  },
});
const { chatIsGroup, __clearChatKindCacheForTest } = await import('../src/feishu/history.ts');

const urls: string[] = [];
let reply: unknown = { code: 0, data: { chat_mode: 'group' } };
let boom = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL) => {
  urls.push(String(url));
  if (boom) throw new Error('ECONNRESET');
  return { json: async () => reply } as unknown as Response;
}) as typeof fetch;
process.on('exit', () => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  __clearChatKindCacheForTest();
  urls.length = 0;
  token = 'tk';
  boom = false;
});

test('chat_mode=p2p → 私聊（false）', async () => {
  reply = { code: 0, data: { chat_mode: 'p2p' } };
  assert.equal(await chatIsGroup('oc_dm'), false);
  assert.match(urls[0], /\/im\/v1\/chats\/oc_dm$/);
});

test('chat_mode=group → 群（true）', async () => {
  reply = { code: 0, data: { chat_mode: 'group' } };
  assert.equal(await chatIsGroup('oc_g'), true);
});

test('陌生的 chat_mode（如 topic 话题群）也算群——只有 p2p 才是私聊', async () => {
  reply = { code: 0, data: { chat_mode: 'topic' } };
  assert.equal(await chatIsGroup('oc_t'), true);
});

test('⚠️ 响应里的 chat_type 是**可见性**，不是会话形态：private 的群仍然是群', async () => {
  reply = { code: 0, chat_type: 'private', data: { chat_mode: 'group', chat_type: 'private' } };
  assert.equal(await chatIsGroup('oc_private_group'), true, '看错字段的话这里会变成 false，入口闸就整个失效了');
});

test('接口报错（多半是没给 im:chat:readonly）→ null，让调用方自己决定兜底方向', async () => {
  reply = { code: 99991672, msg: 'no permission' };
  assert.equal(await chatIsGroup('oc_x'), null);
});

test('信封里没有 chat_mode → null（认不出就是认不出，绝不猜一个）', async () => {
  reply = { code: 0, data: {} };
  assert.equal(await chatIsGroup('oc_x'), null);
});

test('网络异常 → null，不抛（补拉是 best-effort，不该拖垮周期循环）', async () => {
  boom = true;
  assert.equal(await chatIsGroup('oc_x'), null);
});

test('取不到 token → null，且不打一发注定失败的请求', async () => {
  token = null;
  assert.equal(await chatIsGroup('oc_x'), null);
  assert.deepEqual(urls, []);
});

test('会话形态一辈子不变 → 记忆住，同一个会话只往返一次', async () => {
  reply = { code: 0, data: { chat_mode: 'p2p' } };
  assert.equal(await chatIsGroup('oc_dm'), false);
  assert.equal(await chatIsGroup('oc_dm'), false);
  assert.equal(urls.length, 1);
});

test('失败**不**记忆：这次没权限，下次拿到权限就该问得出来', async () => {
  reply = { code: 1, msg: 'nope' };
  assert.equal(await chatIsGroup('oc_x'), null);
  reply = { code: 0, data: { chat_mode: 'group' } };
  assert.equal(await chatIsGroup('oc_x'), true);
  assert.equal(urls.length, 2);
});
