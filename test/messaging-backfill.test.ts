// 单元：provider 无关的**离线补拉循环**（messaging/backfill.ts）。全程无网络——port 与 intake 都被替换。
//
// 这是 Phase 0 关缝的回归底座：补拉的正确性逻辑（水位只前进 / 边界那条再滤一次 / 抽链接兜底顺序 /
// 防重入 / 观察群种子化）从飞书层上移到核心后，必须还能被**单测钉死**，而不是只能靠连真租户才敢改。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage } from '../src/messaging/model.ts';

// ── 假 port：只实现补拉用到的两个方法，其余成员在本用例里永不被调用 ──
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

let addPrdCalls: { prdUrl: string; chatId?: string; posterId?: string; intakeMsgId?: string }[] = []; // prdUrl 取自 doc.url，断言更好读
let createdUrls = new Set<string>(); // 模拟 addPrd 的去重：同一 url 第二次 created=false

const warns: string[] = []; // 入口闸的「确认不了」是靠一条 warn 暴露的 → 必须能断言到

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
const cursors = await import('../src/store/cursors.ts'); // 动态：FORGE_DB=:memory: 生效后才加载

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

test('补拉：正文里的文档链接 → 登记，并把水位推到最后一条', async () => {
  reset();
  cursors.advanceCursor('oc_a', 1000);
  history.oc_a = [
    msg({ chatId: 'oc_a', text: `看下这个 ${DOC}`, createTime: 2000, senderId: 'ou_pm', messageId: 'om_1' }),
    msg({ chatId: 'oc_a', text: '收到', createTime: 3000 }),
  ];
  const n = await backfillChat('oc_a');
  assert.equal(n, 1);
  // 发起人与原消息 id 一并带上：补拉登记的需求与 live 登记的长得一样（状态卡回到 PM 那条下面、能 @ 到人）。
  assert.deepEqual(addPrdCalls, [{ prdUrl: DOC, chatId: 'oc_a', posterId: 'ou_pm', intakeMsgId: 'om_1' }]);
  assert.equal(cursors.getCursor('oc_a'), 3000); // 无链接的那条也推水位——否则每轮都重扫
});

test('补拉：拉历史时按当前水位起（秒级精度的边界重复由核心再滤一次，不重复登记）', async () => {
  reset();
  cursors.advanceCursor('oc_b', 5000);
  // adapter 因 start_time 取整把水位那条一并带回：createTime === cursor → 必须跳过。
  history.oc_b = [msg({ chatId: 'oc_b', text: DOC, createTime: 5000 }), msg({ chatId: 'oc_b', text: DOC2, createTime: 6000 })];
  const n = await backfillChat('oc_b');
  assert.deepEqual(historyCalls, [{ chatId: 'oc_b', sinceMs: 5000 }]);
  assert.equal(n, 1);
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC2]); // 水位那条没被重登记
});

test('补拉：历史条目缺发起人/原消息 id 时照常登记（只是回不到那条下面）', async () => {
  reset();
  cursors.advanceCursor('oc_a2', 0);
  // 历史接口本就可能不带这两项（老消息 / provider 差异）——缺了不能成为「不登记」的理由，
  // 那等于离线期间的需求被静默丢掉；后果只是状态卡直接发到群里（notify 侧已有该降级）。
  history.oc_a2 = [msg({ chatId: 'oc_a2', text: DOC, createTime: 100 })];
  const n = await backfillChat('oc_a2');
  assert.equal(n, 1);
  assert.deepEqual(addPrdCalls, [{ prdUrl: DOC, chatId: 'oc_a2', posterId: undefined, intakeMsgId: undefined }]);
});

// ── 群入口闸（与 live 消息入口共用 messaging/gate.ts 的判据）────────────────────
// 上面那些用例的消息都没设 isGroup → 按非群放行，闸不介入；下面三条专门走群路径。

test('补拉：群历史里没 @ 机器人的消息不登记（同一道防花钱闸），但水位照推', async () => {
  reset();
  cursors.advanceCursor('oc_gate1', 0);
  history.oc_gate1 = [msg({ chatId: 'oc_gate1', text: `随手分享 ${DOC}`, createTime: 100, isGroup: true, mentionedBot: false })];
  const n = await backfillChat('oc_gate1');
  assert.equal(n, 0);
  assert.deepEqual(addPrdCalls, [], '群里随手分享的文档不该白跑一次闸A');
  assert.equal(cursors.getCursor('oc_gate1'), 100, '挡下的也要推水位，否则每轮重扫同一批');
});

test('补拉：群历史里 @ 了机器人 → 照常登记', async () => {
  reset();
  cursors.advanceCursor('oc_gate2', 0);
  history.oc_gate2 = [msg({ chatId: 'oc_gate2', text: `@bot 看下 ${DOC}`, createTime: 100, isGroup: true, mentionedBot: true })];
  assert.equal(await backfillChat('oc_gate2'), 1);
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]);
});

test('补拉：无法确认是否 @（历史信封不带 mentions）→ 仍照常登记，并把这个事实 warn 出来', async () => {
  reset();
  cursors.advanceCursor('oc_gate3', 0);
  history.oc_gate3 = [
    msg({ chatId: 'oc_gate3', text: DOC, createTime: 100, isGroup: true, mentionedBot: null }),
    msg({ chatId: 'oc_gate3', text: '闲聊', createTime: 200, isGroup: true, mentionedBot: null }),
  ];
  // live 侧对这一态取忽略，补拉侧**故意取反**：消息已经过去了，忽略等于离线期间的需求被静默吞掉，
  // 而那正是补拉唯一的存在理由。宁可白跑一次闸A，不可漏需求。
  assert.equal(await backfillChat('oc_gate3'), 1);
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]);
  // 这条 warn 就是「该 provider 的历史信封到底带不带 mentions」的观察口——跑一轮即知，不用手捞 payload。
  const hit = warns.filter((w) => w.includes('无法确认是否 @ 了机器人'));
  assert.equal(hit.length, 1, '每轮只报一次汇总，不逐条刷屏');
  assert.match(hit[0], /2 条/);
  assert.match(hit[0], /fake/); // 点名是哪个 provider 的信封缺字段
});

test('补拉：正文无链接时退到 adapter 给的兜底文本块（文档分享卡 / 富文本 post）', async () => {
  reset();
  cursors.advanceCursor('oc_c', 0);
  history.oc_c = [msg({ chatId: 'oc_c', text: '[分享文档]', searchTexts: [`{"url":"${DOC}"}`], createTime: 100 })];
  await backfillChat('oc_c');
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]);
});

test('补拉：searchTexts 逐个尝试，命中即停（与 live 消息入口同序）', async () => {
  reset();
  cursors.advanceCursor('oc_c2', 0);
  history.oc_c2 = [msg({ chatId: 'oc_c2', text: '', searchTexts: ['无链接', `x ${DOC}`, `y ${DOC2}`], createTime: 100 })];
  await backfillChat('oc_c2');
  assert.deepEqual(addPrdCalls.map((c) => c.prdUrl), [DOC]); // 第二块命中后不再看第三块
});

test('补拉：水位只前进——历史里的乱序旧消息不会把水位拖回去', async () => {
  reset();
  cursors.advanceCursor('oc_d', 9000);
  history.oc_d = [msg({ chatId: 'oc_d', text: '旧', createTime: 100 }), msg({ chatId: 'oc_d', text: DOC, createTime: 9500 })];
  await backfillChat('oc_d');
  assert.equal(cursors.getCursor('oc_d'), 9500);
});

test('补拉：重复文档 addPrd 报 created=false → 不计入新登记数（去重无害）', async () => {
  reset();
  cursors.advanceCursor('oc_e', 0);
  history.oc_e = [msg({ chatId: 'oc_e', text: DOC, createTime: 10 }), msg({ chatId: 'oc_e', text: DOC, createTime: 20 })];
  const n = await backfillChat('oc_e');
  assert.equal(addPrdCalls.length, 2);
  assert.equal(n, 1);
});

test('补拉：首见的群从 now 起，不回捞古早历史（sinceMs≈now，水位随即落库）', async () => {
  reset();
  const before = Date.now();
  history.oc_f = [];
  await backfillChat('oc_f');
  assert.ok(historyCalls[0].sinceMs >= before, '未知群应从 now 起拉，而非从 0 起把全部历史吃进来');
  assert.ok((cursors.getCursor('oc_f') ?? 0) >= before);
});

test('backfillAll：观察群先种子化再遍历所有已登记群', async () => {
  reset();
  watched = ['oc_w1', 'oc_w2'];
  cursors.advanceCursor('oc_learned', 1); // live 消息自学习到的群也要补
  history.oc_w1 = [msg({ chatId: 'oc_w1', text: DOC, createTime: Date.now() + 1000 })];
  const n = await backfillAll();
  const visited = historyCalls.map((c) => c.chatId);
  for (const c of ['oc_w1', 'oc_w2', 'oc_learned']) assert.ok(visited.includes(c), `漏了 ${c}`);
  assert.equal(n, 1);
});

test('backfillAll：种子化不覆盖已有水位（否则每次开机 now 会冲掉真实水位 → 漏消息）', async () => {
  reset();
  cursors.advanceCursor('oc_seed', 1234);
  watched = ['oc_seed'];
  await backfillAll();
  assert.equal(historyCalls.find((c) => c.chatId === 'oc_seed')?.sinceMs, 1234);
});

test('backfillAll：防重入——开机/重连/周期三处并发触发时只跑一轮', async () => {
  reset();
  watched = ['oc_g'];
  const [a, b] = await Promise.all([backfillAll(), backfillAll()]);
  const rounds = historyCalls.filter((c) => c.chatId === 'oc_g').length;
  assert.equal(rounds, 1, '并发触发应有一轮被防重入挡掉');
  assert.equal(a + b, 0);
});
