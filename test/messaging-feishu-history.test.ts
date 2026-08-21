// 飞书 adapter 的**群历史**侧（Phase 0 新增 port 成员）：watchedChats / listHistorySince。
// 无网络——feishu/history.ts 的那一次 API 往返被替换掉，本用例只钉「原始条目 → provider 无关
// InboundMessage」这层映射。它是补拉链路上唯一还带飞书形状的地方，映射错了补拉会静默漏消息。
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
// 观察群走临时 config 覆盖目录（只放 forge.env，其余 yaml 按 root.ts 的逐文件回退取仓内 config/）；
// 同名 process.env 会盖过文件值，先删掉，免得开发机上真实凭据影响断言。
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
  sender?: { id?: string };
  body?: { content?: string };
  mentions?: { id?: { open_id?: string } }[];
}
let items: HistItem[] = [];
const calls: { chatId: string; startSec: number }[] = [];
mock.module('../src/feishu/history.ts', {
  namedExports: {
    listMessages: async (chatId: string, startSec: number) => {
      calls.push({ chatId, startSec });
      return items;
    },
  },
});
const { feishuPort } = await import('../src/messaging/feishu.ts');
const { __setBotOpenIdCacheForTest } = await import('../src/feishu/dm.ts');

test('id：adapter 自报 provider 名（核心只拿来做展示/日志）', () => {
  assert.equal(feishuPort.id, 'feishu');
});

test('watchedChats：逗号切分 + 去空白去空项（补拉遍历与探针取样同源）', () => {
  assert.deepEqual(feishuPort.watchedChats(), ['oc_a', 'oc_b']);
});

test('listHistorySince：毫秒水位 → 飞书秒级 start_time（向下取整）', async () => {
  calls.length = 0;
  items = [];
  await feishuPort.listHistorySince('oc_x', 1_700_000_001_999);
  assert.deepEqual(calls, [{ chatId: 'oc_x', startSec: 1_700_000_001 }]);
});

test('listHistorySince：秒级 create_time 归一成毫秒（水位比较全程用毫秒）', async () => {
  items = [{ create_time: '1700000000' }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.createTime, 1_700_000_000_000);
});

test('listHistorySince：已是毫秒的 create_time 原样保留（不重复 ×1000）', async () => {
  items = [{ create_time: '1700000000000' }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.createTime, 1_700_000_000_000);
});

test('listHistorySince：body.content 的 JSON 取 text；非 JSON 原样兜底', async () => {
  items = [{ body: { content: '{"text":"看下 PRD"}' } }, { body: { content: '裸文本' } }, {}];
  const got = await feishuPort.listHistorySince('oc_x', 0);
  assert.deepEqual(got.map((m) => m.text), ['看下 PRD', '裸文本', '']);
});

test('listHistorySince：整条序列化进 searchTexts——分享卡/富文本的链接不在正文里', async () => {
  items = [{ message_id: 'om_1', body: { content: '{"text":""}' } }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.deepEqual(m.searchTexts, [JSON.stringify(items[0])]);
});

test('listHistorySince：chat_id/sender/message_id 透传，缺 chat_id 时回落到入参群', async () => {
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

// D1（见 docs/pluggable-messaging-and-doc-sources.md）：补拉今天不走「必须 @机器人」那道闸。
// adapter 如实映射 mentions，好让「历史条目到底带不带这个字段」在真实租户上一验即知；
// 核心的补拉循环 Phase 0 不读它——统一与否是单独的 follow-up，不在纯重构里顺手改行为。
test('listHistorySince：mentions 命中 bot → true，未命中 → false', async () => {
  __setBotOpenIdCacheForTest('ou_bot');
  items = [{ mentions: [{ id: { open_id: 'ou_bot' } }] }, { mentions: [{ id: { open_id: 'ou_other' } }] }, { mentions: [] }];
  const got = await feishuPort.listHistorySince('oc_x', 0);
  assert.deepEqual(got.map((m) => m.mentionedBot), [true, false, false]);
});

test('listHistorySince：信封根本没有 mentions 字段 → null（「无法确认」≠「没人 @」）', async () => {
  __setBotOpenIdCacheForTest('ou_bot');
  items = [{ message_id: 'om_no_mentions' }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.mentionedBot, null);
});

test('listHistorySince：bot 身份未就绪 → null（不敢报 false）', async () => {
  __setBotOpenIdCacheForTest(null);
  items = [{ mentions: [{ id: { open_id: 'ou_bot' } }] }];
  const [m] = await feishuPort.listHistorySince('oc_x', 0);
  assert.equal(m.mentionedBot, null);
  __setBotOpenIdCacheForTest('ou_bot');
});
