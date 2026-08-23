// The Feishu raw layer: **is this chat a group or a direct message** (chatIsGroup in src/feishu/history.ts).
//
// Why this deserves its own file: there is a same-name field trap here that a comment alone cannot guard.
// Two Feishu APIs both call a field chat_type, and they mean different things:
//   * the message event's chat_type: 'group' / 'p2p'   <- the kind of chat, which is what backfill needs
//   * im/v1/chats' chat_type:       'private' / 'public' <- a group's **visibility**
// Use the second where the first is meant and every public group is judged a direct message, the intake gate
// stops working entirely, and the only symptom is "every document casually shared in a channel got filed".
// So the decision has to go through chat_mode, and one test has to feed it a **group** whose chat_type is
// 'private'.
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

test('chat_mode=p2p means a direct message (false)', async () => {
  reply = { code: 0, data: { chat_mode: 'p2p' } };
  assert.equal(await chatIsGroup('oc_dm'), false);
  assert.match(urls[0], /\/im\/v1\/chats\/oc_dm$/);
});

test('chat_mode=group means a group (true)', async () => {
  reply = { code: 0, data: { chat_mode: 'group' } };
  assert.equal(await chatIsGroup('oc_g'), true);
});

test('an unfamiliar chat_mode, such as a topic thread, still counts as a group -- only p2p is a direct message', async () => {
  reply = { code: 0, data: { chat_mode: 'topic' } };
  assert.equal(await chatIsGroup('oc_t'), true);
});

test('the chat_type in the response is **visibility**, not the kind of chat: a private group is still a group', async () => {
  reply = { code: 0, chat_type: 'private', data: { chat_mode: 'group', chat_type: 'private' } };
  assert.equal(await chatIsGroup('oc_private_group'), true, 'reading the wrong field turns this into false, and the intake gate stops working entirely');
});

test('the API returns an error, most often because im:chat:readonly was not granted -> null, leaving the caller to choose its own fallback', async () => {
  reply = { code: 99991672, msg: 'no permission' };
  assert.equal(await chatIsGroup('oc_x'), null);
});

test('the envelope carries no chat_mode -> null (unrecognised means unrecognised, never a guess)', async () => {
  reply = { code: 0, data: {} };
  assert.equal(await chatIsGroup('oc_x'), null);
});

test('a network error gives null rather than throwing (backfill is best effort and must not take the periodic loop down)', async () => {
  boom = true;
  assert.equal(await chatIsGroup('oc_x'), null);
});

test('no token available -> null, without firing a request that is bound to fail', async () => {
  token = null;
  assert.equal(await chatIsGroup('oc_x'), null);
  assert.deepEqual(urls, []);
});

test('the kind of a chat never changes, so it is remembered and one chat costs a single round trip', async () => {
  reply = { code: 0, data: { chat_mode: 'p2p' } };
  assert.equal(await chatIsGroup('oc_dm'), false);
  assert.equal(await chatIsGroup('oc_dm'), false);
  assert.equal(urls.length, 1);
});

test('a failure is **not** remembered: no permission this time should still mean an answer once the permission is granted', async () => {
  reply = { code: 1, msg: 'nope' };
  assert.equal(await chatIsGroup('oc_x'), null);
  reply = { code: 0, data: { chat_mode: 'group' } };
  assert.equal(await chatIsGroup('oc_x'), true);
  assert.equal(urls.length, 2);
});
