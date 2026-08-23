// The **channel history** side of the Feishu adapter (the port members Phase 0 added): watchedChats and
// listHistorySince. No network: feishu/history.ts's single API round trip is replaced, and these tests pin
// only the mapping from a raw entry to a provider-neutral InboundMessage. That is the one place in the
// backfill chain still shaped like Feishu, and getting it wrong makes backfill drop messages silently.
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
// The watched chats come from a temporary config overlay holding only forge.env, with the other yaml files
// falling back per file to the repo's config/ as root.ts does. A process.env of the same name would beat the
// file, so it is deleted first -- otherwise real credentials on a developer's machine would sway the assertions.
delete process.env.FEISHU_WATCH_CHATS;
delete process.env.FEISHU_REVIEW_CHAT_ID;
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfgDir = mkdtempSync(join(tmpdir(), 'forge-hist-'));
writeFileSync(join(cfgDir, 'forge.env'), 'FEISHU_WATCH_CHATS=oc_a, oc_b ,\nFEISHU_REVIEW_CHAT_ID=oc_fallback\n');
process.env.FORGE_CONFIG_DIR = cfgDir;

interface HistItem {
  message_id?: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  sender?: { id?: string };
  body?: { content?: string };
  mentions?: { id?: { open_id?: string } }[];
}
let items: HistItem[] = [];
const calls: { chatId: string; startSec: number }[] = [];
// Looking up the chat kind: unanswerable (null) by default, with each test setting its own. The number of
// calls is recorded so the tests can assert that one chat is asked about exactly once.
let chatKind: boolean | null = null;
const kindCalls: string[] = [];
mock.module('../src/feishu/history.ts', {
  namedExports: {
    listMessages: async (chatId: string, startSec: number) => {
      calls.push({ chatId, startSec });
      return items;
    },
    chatIsGroup: async (chatId: string) => {
      kindCalls.push(chatId);
      return chatKind;
    },
  },
});
const { feishuPort } = await import('../src/messaging/feishu.ts');
const { __setBotOpenIdCacheForTest } = await import('../src/feishu/dm.ts');

test('id: the adapter reports its own provider name, which the core uses only for display and logging', () => {
  assert.equal(feishuPort.id, 'feishu');
});

test('watchedChats: split on commas, trimmed, with empty entries dropped (backfill and the probe sample from the same source)', () => {
  assert.deepEqual(feishuPort.watchedChats(), ['oc_a', 'oc_b']);
});

test('listHistorySince: a millisecond watermark becomes Feishu\'s second-level start_time, rounded down', async () => {
  calls.length = 0;
  items = [];
  await feishuPort.listHistorySince('oc_x', 1_700_000_001_999);
  assert.deepEqual(calls, [{ chatId: 'oc_x', startSec: 1_700_000_001 }]);
});

test('listHistorySince: a second-level create_time is normalised to milliseconds (watermarks are compared in milliseconds throughout)', async () => {
  items = [{ create_time: '1700000000' }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.createTime, 1_700_000_000_000);
});

test('listHistorySince: a create_time already in milliseconds is left alone, never multiplied by 1000 twice', async () => {
  items = [{ create_time: '1700000000000' }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.createTime, 1_700_000_000_000);
});

test('listHistorySince: body.content is parsed as JSON to take its text, falling back to the raw string when it is not JSON', async () => {
  items = [{ body: { content: '{"text":"have a look at the PRD"}' } }, { body: { content: 'bare text' } }, {}];
  const got = await feishuPort.listHistorySince('oc_x', 0);
  assert.deepEqual(got.map((m) => m.text), ['have a look at the PRD', 'bare text', '']);
});

test('listHistorySince: the whole entry is serialised into searchTexts -- a share card or rich text keeps its link outside the body', async () => {
  items = [{ message_id: 'om_1', body: { content: '{"text":""}' } }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.deepEqual(m.searchTexts, [JSON.stringify(items[0])]);
});

test('listHistorySince: chat_id, sender and message_id pass straight through, with a missing chat_id falling back to the chat that was asked for', async () => {
  items = [{ message_id: 'om_9', chat_id: 'oc_real', sender: { id: 'ou_pm' } }, { message_id: 'om_10' }];
  const got = await feishuPort.listHistorySince('oc_arg', 0);
  assert.deepEqual(
    got.map((m) => ({ c: m.chatId, s: m.senderId, i: m.messageId, g: m.isGroup })),
    [
      { c: 'oc_real', s: 'ou_pm', i: 'om_9', g: true },
      { c: 'oc_arg', s: undefined, i: 'om_10', g: true },
    ],
  );
});

// D1 (see docs/pluggable-messaging-and-doc-sources.md): backfill does not currently go through the
// must-mention-the-bot gate. The adapter maps mentions faithfully so that whether a history entry carries the
// field at all can be settled against a real tenant in one look; the core's backfill loop does not read it in
// Phase 0. Whether to unify the two is a separate follow-up, not a behaviour change slipped into a refactor.
test('listHistorySince: mentions containing the bot gives true, and not containing it gives false', async () => {
  __setBotOpenIdCacheForTest('ou_bot');
  items = [{ mentions: [{ id: { open_id: 'ou_bot' } }] }, { mentions: [{ id: { open_id: 'ou_other' } }] }, { mentions: [] }];
  const got = await feishuPort.listHistorySince('oc_x', 0);
  assert.deepEqual(got.map((m) => m.mentionedBot), [true, false, false]);
});

test('listHistorySince: an envelope with no mentions field at all gives null -- "cannot tell" is not "nobody mentioned it"', async () => {
  __setBotOpenIdCacheForTest('ou_bot');
  items = [{ message_id: 'om_no_mentions' }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.mentionedBot, null);
});

test('listHistorySince: the bot identity is not ready yet -> null, never a confident false', async () => {
  __setBotOpenIdCacheForTest(null);
  items = [{ mentions: [{ id: { open_id: 'ou_bot' } }] }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.mentionedBot, null);
  __setBotOpenIdCacheForTest('ou_bot');
});

// -- Is the chat a group or a direct message? Getting it wrong makes **requirements sent by DM while offline
// vanish silently.** Backfill walks the cursor table, every inbound message advances a cursor, and DMs are
// naturally among them. Treat DM history as channel messages and it hits the "nobody mentioned me in the
// channel" intake gate and is dropped -- which is the one thing backfill exists to prevent.

test('chat kind: an entry carrying chat_type=p2p gives isGroup=false (a DM is directed by nature and needs no mention)', async () => {
  kindCalls.length = 0;
  chatKind = null;
  items = [{ create_time: '1712345678', chat_type: 'p2p', body: { content: '{"text":"have a look at this one"}' } }];
  const got = await feishuPort.listHistorySince('oc_dm', 0);
  assert.equal(got[0].isGroup, false);
  assert.deepEqual(kindCalls, [], 'the entry already says so, and that should not cost another API round trip');
});

test('chat kind: an entry carrying chat_type=group gives isGroup=true', async () => {
  kindCalls.length = 0;
  items = [{ create_time: '1712345678', chat_type: 'group', body: { content: '{"text":"have a look at this"}' } }];
  assert.equal((await feishuPort.listHistorySince('oc_g', 0))[0].isGroup, true);
  assert.deepEqual(kindCalls, []);
});

test('chat kind: an entry with no chat_type triggers one lookup, and a DM answer is taken as a DM', async () => {
  kindCalls.length = 0;
  chatKind = false;
  items = [{ create_time: '1712345678', body: { content: '{"text":"have a look at this one"}' } }, { create_time: '1712345679', body: { content: '{"text":"and this one too"}' } }];
  const got = await feishuPort.listHistorySince('oc_dm', 0);
  assert.deepEqual(got.map((m) => m.isGroup), [false, false]);
  assert.deepEqual(kindCalls, ['oc_dm'], 'one listHistorySince asks once, not once per message');
});

test('chat kind: unanswerable (no permission, or the network is down) falls back to a group, keeping today\'s behaviour without spending more the other way', async () => {
  kindCalls.length = 0;
  chatKind = null; // chatIsGroup has already logged a warning internally, so this is not silent
  items = [{ create_time: '1712345678', body: { content: '{"text":"have a look at this"}' } }];
  assert.equal((await feishuPort.listHistorySince('oc_unknown', 0))[0].isGroup, true);
  assert.deepEqual(kindCalls, ['oc_unknown']);
});

test('chat kind: one entry carrying chat_type settles it, even when the history mixes entries that have it with entries that do not', async () => {
  kindCalls.length = 0;
  chatKind = true; // asking would answer "group", which is how this proves it never asked
  items = [{ create_time: '1712345678', body: { content: '{"text":"a"}' } }, { create_time: '1712345679', chat_type: 'p2p', body: { content: '{"text":"b"}' } }];
  const got = await feishuPort.listHistorySince('oc_dm', 0);
  assert.deepEqual(got.map((m) => m.isGroup), [false, false]);
  assert.deepEqual(kindCalls, []);
});
