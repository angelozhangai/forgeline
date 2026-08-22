// Slack adapter 的契约级单测（对齐 messaging-feishu.test.ts 的规格）：每个 CardBlock → 精确的 Block Kit，
// 加上入站解析、复合消息 id、模态往返、历史补拉。全程无网络：slack/web.ts 的那一次 fetch 被替掉。
//
// ⚠️ 这里钉的是**我们对 Slack 载荷形状的处理**，不是 Slack 的真实行为。载荷形状取自 Slack 官方文档；
// 「真工作区上模态确实这样往返、Socket Mode 确实这样重连」需要一次真实联调（见 PR 说明的未验清单）。
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardBlock, CardModel } from '../src/messaging/model.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';

// env 也要能按用例切：真 loadConfig 是全进程缓存的，切不动；而本文件的模块图里只有 slack.ts 用它
// （slack/web.ts 已被替掉，slack/socket、slack/modal、gates/envelopes 都不碰 config）。
let slackEnv: Record<string, string | undefined> = {};
mock.module('../src/config.ts', { namedExports: { loadConfig: () => ({ env: slackEnv }) } });

interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}
const calls: ApiCall[] = [];
let respond: (method: string) => Record<string, unknown> = () => ({ ok: true, ts: '1712345678.000200', channel: 'C1' });
mock.module('../src/slack/web.ts', {
  namedExports: {
    SLACK_BASE: 'https://slack.com/api',
    botToken: () => 'xoxb-test',
    appToken: () => 'xapp-test',
    slackApi: async (method: string, body: Record<string, unknown> = {}) => {
      calls.push({ method, body });
      return respond(method);
    },
  },
});
// 捕获 adapter 交给 Socket Mode 的那套 handlers：入站路由（事件/交互/模态拦截）全靠它。
let captured: { onEnvelope: (t: string, p: Record<string, unknown>) => void; onError: (r: string) => void; onReconnected: () => void } | null = null;
mock.module('../src/slack/socket.ts', {
  namedExports: {
    createSocketChannel: (h: typeof captured) => {
      captured = h;
      return { connect: async () => {}, close: () => {} };
    },
    backoffMs: (n: number) => 1000 * 2 ** n,
  },
});
const slack = await import('../src/messaging/slack.ts');
const { slackPort, renderSlackMessage, toMrkdwn, packMsgId, unpackMsgId, OPEN_MODAL_ACTION } = slack;

function reset(env: Record<string, string | undefined> = {}): void {
  calls.length = 0;
  respond = () => ({ ok: true, ts: '1712345678.000200', channel: 'C1' });
  slack.__clearModalSpecsForTest();
  slackEnv = env;
}
// 把单个块塞进最小卡片，取 attachment.blocks（前两块固定是 header + 可选 subtitle）。
function blocksOf(block: CardBlock): Record<string, unknown>[] {
  const card: CardModel = { color: 'grey', title: 't', blocks: [block] };
  return (renderSlackMessage(card).attachments[0].blocks as Record<string, unknown>[]).slice(1);
}
const one = (block: CardBlock): Record<string, unknown> => blocksOf(block)[0];

// ── 信封 ───────────────────────────────────────────────────────────
test('信封：Block Kit 没有卡片主色 → 语义色落在 attachment 的色条上；text 兜通知栏预览', () => {
  const m = renderSlackMessage({ color: 'red', title: '需求待确认', subtitle: 'REQ-7', blocks: [] });
  assert.equal(m.text, '需求待确认', '不给 text 的话通知栏和不支持 blocks 的客户端就是一片空白');
  assert.equal(m.attachments.length, 1);
  assert.equal((m.attachments[0] as { color: string }).color, '#e01e5a');
  const blocks = (m.attachments[0] as { blocks: Record<string, unknown>[] }).blocks;
  assert.deepEqual(blocks[0], { type: 'header', text: { type: 'plain_text', text: '需求待确认', emoji: true } });
  assert.equal(blocks[1].type, 'context', '副标题走 context（小灰字）');
});

test('信封：无副标题就不出那一块', () => {
  const blocks = (renderSlackMessage({ color: 'blue', title: 'T', blocks: [] }).attachments[0] as { blocks: unknown[] }).blocks;
  assert.equal(blocks.length, 1);
});

// ── mrkdwn 方言 ────────────────────────────────────────────────────
test('toMrkdwn：**粗体**→*粗体*、[文字](链接)→<链接|文字>、## 标题→粗体行', () => {
  assert.equal(toMrkdwn('**要点**在这'), '*要点*在这');
  assert.equal(toMrkdwn('见 [PRD](https://x.example/p)'), '见 <https://x.example/p|PRD>');
  assert.equal(toMrkdwn('## 小标题'), '*小标题*');
});

test('toMrkdwn：飞书时代残留的内联标记也要落地——<font> 摘掉、<at id=X> → <@X>', () => {
  assert.equal(toMrkdwn("<font color='grey'>次要</font>说明"), '次要说明');
  assert.equal(toMrkdwn('<at id=U123></at> 看下'), '<@U123> 看下');
});

// ── 各 CardBlock → Block Kit ───────────────────────────────────────
test('text / note / footnote / quote：正文走 section，次要信息走 context', () => {
  assert.deepEqual(one({ kind: 'text', md: 'hello' }), { type: 'section', text: { type: 'mrkdwn', text: 'hello' } });
  assert.equal(one({ kind: 'note', md: '灰字' }).type, 'context');
  assert.equal(one({ kind: 'footnote', md: '脚注' }).type, 'context');
  assert.deepEqual(one({ kind: 'quote', text: '一段\n  概述  ' }), { type: 'section', text: { type: 'mrkdwn', text: '> 一段 概述' } });
});

test('callout：Block Kit 正文不能内联着色 → 用 emoji 前缀承载语义色调', () => {
  const danger = one({ kind: 'callout', tone: 'danger', md: '危险' }) as { text: { text: string } };
  assert.equal(danger.text.text, '🔴 *危险*');
  assert.match((one({ kind: 'callout', tone: 'warning', md: 'w' }) as { text: { text: string } }).text.text, /^🟠/);
  assert.match((one({ kind: 'callout', tone: 'info', md: 'i' }) as { text: { text: string } }).text.text, /^🔵/);
});

test('divider / stats：stats 落 section.fields（Slack 自动两列排布）', () => {
  assert.deepEqual(one({ kind: 'divider' }), { type: 'divider' });
  assert.deepEqual(one({ kind: 'stats', fields: ['*复杂度* M', '*置信* 0.8'] }), {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: '*复杂度* M' },
      { type: 'mrkdwn', text: '*置信* 0.8' },
    ],
  });
});

test('button：核心那套 {action,slug,value} 原样进按钮 value，点回来直接能用', () => {
  const el = one({ kind: 'button', button: { text: '出方案', style: 'primary', action: 'gateb', slug: 'refund', value: { round: 2 } } });
  const actions = el as { type: string; elements: { type: string; style?: string; value: string; text: unknown }[] };
  assert.equal(actions.type, 'actions');
  assert.equal(actions.elements[0].style, 'primary');
  assert.deepEqual(JSON.parse(actions.elements[0].value), { action: 'gateb', slug: 'refund', round: 2 });
});

test('button：default 样式**不出** style 字段（Slack 只认 primary/danger，给别的会整块报错）', () => {
  const el = one({ kind: 'button', button: { text: 'x', style: 'default', action: 'retry', slug: 's' } }) as { elements: Record<string, unknown>[] };
  assert.equal('style' in el.elements[0], false);
});

test('buttonRow：并排按钮进同一个 actions 块', () => {
  const el = one({
    kind: 'buttonRow',
    buttons: [
      { text: 'A', style: 'primary', action: 'gateb_force_go', slug: 's' },
      { text: 'B', style: 'default', action: 'gateb_send_back', slug: 's' },
    ],
  }) as { type: string; elements: unknown[] };
  assert.equal(el.type, 'actions');
  assert.equal(el.elements.length, 2);
});

const ITEM: DecisionItem = { id: 'H1', prompt: '要不要限额？', severity: 'high', options: [{ label: '要', recommended: true, impact: '风控更稳' }, { label: '不要' }], hint: '按风控口径' };

test('decisionList / findingList：逐条一块，带严重度前缀与 ★推荐', () => {
  const list = blocksOf({ kind: 'decisionList', items: [ITEM] });
  const text = (list[0] as { text: { text: string } }).text.text;
  assert.match(text, /^\*1\.\* 🔴 \[high\] 要不要限额？/);
  assert.match(text, /★ 要（影响：风控更稳）/);
  assert.match(text, /_建议：按风控口径_/);
  const f = blocksOf({ kind: 'findingList', findings: [{ severity: 'med', lead: '缺回滚方案', notes: [{ label: '位置', text: '§3' }] }] });
  assert.match((f[0] as { text: { text: string } }).text.text, /🟠 \[med\] 缺回滚方案[\s\S]*_位置：§3_/);
});

// ── 表单 → 模态（与飞书唯一的真实交互差异）──────────────────────────
test('decisionForm：卡上只留一个按钮（Slack 的 input 块在消息里非法），上下文随按钮 value 走', () => {
  reset();
  const blocks = blocksOf({
    kind: 'decisionForm',
    slug: 'refund',
    items: [ITEM],
    action: 'confirm_submit',
    round: 3,
    verdict: true,
    submitText: '提交答复',
    notesLabel: '补充说明',
    notesPlaceholder: '写点什么',
  });
  assert.equal(blocks[0].type, 'context', '先给一句「共 N 项待决」的说明');
  const btn = (blocks[1] as { elements: { action_id: string; value: string }[] }).elements[0];
  assert.equal(btn.action_id, OPEN_MODAL_ACTION);
  assert.deepEqual(JSON.parse(btn.value), { action: 'confirm_submit', slug: 'refund', round: 3, kind: 'decision' });
});

test('goForm：同样进模态，动作是 go', () => {
  reset();
  const blocks = blocksOf({ kind: 'goForm', slug: 'refund', pool: ['M', 'CC'], picked: 'CC' });
  const btn = (blocks[0] as { elements: { action_id: string; value: string }[] }).elements[0];
  assert.equal(btn.action_id, OPEN_MODAL_ACTION);
  assert.deepEqual(JSON.parse(btn.value), { action: 'go', slug: 'refund', kind: 'go' });
});

test('petRow：宠物台词进 context；有 mentionId 就 @ 上（Slack 的 <@U…>）', () => {
  const el = one({ kind: 'petRow', asset: 'cat', voice: '喵', mentionId: 'U9' }) as { type: string; elements: { text: string }[] };
  assert.equal(el.type, 'context');
  assert.equal(el.elements[0].text, '<@U9> 喵');
});

// ── 复合消息 id ────────────────────────────────────────────────────
test('复合消息 id："channel:ts" —— chat.update 要两个值，而 port 只传一个不透明字符串', () => {
  assert.equal(packMsgId('C1', '1712345678.000200'), 'C1:1712345678.000200');
  assert.deepEqual(unpackMsgId('C1:1712345678.000200'), { channel: 'C1', ts: '1712345678.000200' });
  assert.equal(unpackMsgId('没有冒号'), null);
  assert.equal(unpackMsgId(':x'), null);
  assert.equal(unpackMsgId('C1:'), null);
});

// ── 出站 ───────────────────────────────────────────────────────────
test('replyGroupCard：回复=发到同一 channel 的 thread；返回新卡的复合 id', async () => {
  reset();
  const id = await slackPort.replyGroupCard('C7:111.222', { color: 'blue', title: 'T', blocks: [] });
  assert.equal(calls[0].method, 'chat.postMessage');
  assert.equal(calls[0].body.channel, 'C7');
  assert.equal(calls[0].body.thread_ts, '111.222');
  assert.equal(id, 'C1:1712345678.000200');
});

test('editGroupCard：拆出 channel+ts 走 chat.update；id 拆不开就如实报 false，不静默', async () => {
  reset();
  assert.equal(await slackPort.editGroupCard('C7:111.222', { color: 'grey', title: 'T', blocks: [] }), true);
  assert.equal(calls[0].method, 'chat.update');
  assert.deepEqual([calls[0].body.channel, calls[0].body.ts], ['C7', '111.222']);
  reset();
  assert.equal(await slackPort.editGroupCard('坏id', { color: 'grey', title: 'T', blocks: [] }), false);
  assert.equal(calls.length, 0);
});

test('出站失败不抛：Slack 报 ok:false → 返回 null/false，由调用方降级', async () => {
  reset();
  respond = () => ({ ok: false, error: 'channel_not_found' });
  assert.equal(await slackPort.sendGroupCard('C9', { color: 'grey', title: 'T', blocks: [] }), null);
  assert.equal(await slackPort.editGroupCard('C9:1.2', { color: 'grey', title: 'T', blocks: [] }), false);
});

// ── 入站 ───────────────────────────────────────────────────────────
test('parseCardAction：普通按钮 → {action,slug,value}；operator 取点击人', () => {
  const parsed = slackPort.parseCardAction({
    type: 'block_actions',
    user: { id: 'U42' },
    actions: [{ action_id: 'forge_gateb_refund', value: JSON.stringify({ action: 'gateb', slug: 'refund', round: 1 }) }],
  });
  assert.deepEqual(parsed, {
    type: 'card_action',
    action: 'gateb',
    slug: 'refund',
    value: { action: 'gateb', slug: 'refund', round: 1 },
    formValues: {},
    operatorId: 'U42',
  });
});

test('parseCardAction：「打开模态」是 adapter 内部动作 → 核心永远看不到（返回 null）', () => {
  const parsed = slackPort.parseCardAction({
    type: 'block_actions',
    actions: [{ action_id: OPEN_MODAL_ACTION, value: '{"action":"go","slug":"s","kind":"go"}' }],
  });
  assert.equal(parsed, null);
});

test('parseCardAction：view_submission → 上下文从 private_metadata 回来，字段从 state.values 拍平', () => {
  const parsed = slackPort.parseCardAction({
    type: 'view_submission',
    user: { id: 'U42' },
    view: {
      private_metadata: JSON.stringify({ action: 'confirm_submit', slug: 'refund', round: 2 }),
      state: {
        values: {
          ask_H1: { ask_H1: { type: 'static_select', selected_option: { value: '要' } } },
          verdict: { verdict: { type: 'static_select', selected_option: { value: 'accept' } } },
          notes: { notes: { type: 'plain_text_input', value: '按风控口径来' } },
        },
      },
    },
  });
  assert.equal(parsed?.action, 'confirm_submit');
  assert.equal(parsed?.slug, 'refund');
  assert.deepEqual(parsed?.formValues, { ask_H1: '要', verdict: 'accept', notes: '按风控口径来' });
  assert.equal(parsed?.value.round, 2);
});

test('parseCardAction：认不出的一律 null（坏 JSON / 缺 slug / 没 private_metadata）——绝不猜', () => {
  assert.equal(slackPort.parseCardAction({ type: 'block_actions', actions: [{ action_id: 'x', value: '坏json{' }] }), null);
  assert.equal(slackPort.parseCardAction({ type: 'block_actions', actions: [{ action_id: 'x', value: '{"action":"go"}' }] }), null);
  assert.equal(slackPort.parseCardAction({ type: 'view_submission', view: { private_metadata: '' } }), null);
  assert.equal(slackPort.parseCardAction({ type: 'url_verification' }), null);
});

test('parseMessage：ts（秒.微秒）→ 毫秒；messageId 是复合 id；channel_type=im 算私聊', () => {
  const m = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', user: 'U7', ts: '1712345678.000200', text: '看下需求', channel_type: 'im' } });
  assert.equal(m?.createTime, 1_712_345_678_000);
  assert.equal(m?.messageId, 'C1:1712345678.000200');
  assert.equal(m?.isGroup, false);
  assert.equal(m?.senderId, 'U7');
});

test('parseMessage：缺/坏 ts 兜 now()，绝不兜 0（水位插到 epoch 会让补拉重扫古早历史）', () => {
  const before = Date.now();
  const m = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', text: 'x' } });
  assert.ok((m?.createTime ?? 0) >= before);
});

test('parseMessage：bot 自己发的 / 带 subtype 的一律不入流程（否则状态卡会把自己当需求吃进去）', () => {
  assert.equal(slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: 'x', bot_id: 'B1' } }), null);
  assert.equal(slackPort.parseMessage({ event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1.2' } }), null);
  assert.equal(slackPort.parseMessage({ event: { type: 'reaction_added' } }), null);
});

test('parseMessage：群消息按 <@BOTID> / <@BOTID|name> 判 @；未配 bot user id → null（核心保守忽略，绝不当没 @）', () => {
  reset({ SLACK_BOT_USER_ID: 'UBOT' });
  const hit = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOT> 看下', channel_type: 'channel' } });
  assert.equal(hit?.mentionedBot, true);
  // 带显示名的老写法 <@U123|name>：历史条目/老客户端里仍会出现。只认 <@U123> 的话，
  // 群入口会「明明 @ 了却没反应」，而这条闸的失败是静默的（核心保守忽略），没有症状指向原因。
  const legacy = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOT|forge> 看下', channel_type: 'channel' } });
  assert.equal(legacy?.mentionedBot, true);
  const miss = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '随手一说', channel_type: 'channel' } });
  assert.equal(miss?.mentionedBot, false);
  // 别把「@ 了另一个 id 前缀相同的人」算成 @ 了自己。
  const other = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOTX> 看下', channel_type: 'channel' } });
  assert.equal(other?.mentionedBot, false);
  reset({});
  const noId = slackPort.parseMessage({ event: { type: 'message', channel: 'C1', ts: '1.2', text: '<@UBOT> 看下', channel_type: 'channel' } });
  assert.equal(noId?.mentionedBot, null, '「无法确认」不等于「没人 @」');
  assert.equal(noId?.isGroup, true);
});

test('parseMessage：整条事件序列化进 searchTexts——链接可能藏在 blocks/attachments 里', () => {
  const ev = { type: 'message', channel: 'C1', ts: '1.2', text: '', attachments: [{ title_link: 'https://x.feishu.cn/docx/AAA' }] };
  const m = slackPort.parseMessage({ event: ev });
  assert.deepEqual(m?.searchTexts, [JSON.stringify(ev)]);
});

// ── 历史补拉 / 探针 ────────────────────────────────────────────────
test('listHistorySince：oldest 用秒（带小数）；Slack 倒序返回 → 翻成升序给核心的补拉循环', async () => {
  reset();
  respond = () => ({
    ok: true,
    has_more: false,
    messages: [
      { type: 'message', user: 'U1', ts: '1712345680.000000', text: '第二条' },
      { type: 'message', user: 'U1', ts: '1712345670.000000', text: '第一条' },
    ],
  });
  const got = await slackPort.listHistorySince('C5', 1_712_345_600_000);
  assert.equal(calls[0].method, 'conversations.history');
  assert.equal(calls[0].body.oldest, '1712345600.000000');
  assert.deepEqual(got.map((m) => m.text), ['第一条', '第二条']);
  assert.deepEqual(got.map((m) => m.chatId), ['C5', 'C5']);
});

test('listHistorySince：失败不抛，返回已拿到的部分（补拉是 best-effort，不该拖垮周期循环）', async () => {
  reset();
  respond = () => ({ ok: false, error: 'not_in_channel' });
  assert.deepEqual(await slackPort.listHistorySince('C5', 0), []);
});

test('probe：信封缺字段 → drift；调用失败 → auth；都好 → ok', async () => {
  const configured = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_WATCH_CHANNELS: 'C5' };
  reset(configured);
  respond = () => ({ ok: true, messages: [], has_more: false });
  assert.equal((await slackPort.probe()).ok, true);
  reset(configured);
  respond = () => ({ ok: true, messages: [] }); // 缺 has_more
  const drift = await slackPort.probe();
  assert.equal(drift.ok, false);
  assert.equal(drift.kind, 'drift');
  reset(configured);
  respond = () => ({ ok: false, error: 'not_in_channel' });
  const auth = await slackPort.probe();
  assert.equal(auth.kind, 'auth');
  // 没配齐就直接说"跳过"，绝不去打一发注定失败的请求然后报成 auth 故障
  reset({});
  assert.deepEqual(await slackPort.probe(), { available: false, ok: false, detail: 'Slack bot/观察频道未配齐（跳过）' });
});

test('inboundConfigured：bot token 与 app token 都齐才算配好（少一个就连不上 Socket Mode）', () => {
  reset({ SLACK_BOT_TOKEN: 'xoxb-test' });
  assert.equal(slackPort.inboundConfigured(), false, '缺 app token → 建不了长连接');
  reset({ SLACK_APP_TOKEN: 'xapp-test' });
  assert.equal(slackPort.inboundConfigured(), false, '缺 bot token → 发不出卡');
  reset({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' });
  assert.equal(slackPort.inboundConfigured(), true);
});

test('watchedChats：逗号切分去空白（补拉遍历与探针取样同源）', () => {
  reset({ SLACK_WATCH_CHANNELS: 'C1, C2 ,' });
  assert.deepEqual(slackPort.watchedChats(), ['C1', 'C2']);
});

test('sendDmCard：未配 SLACK_DM_USER_ID → 不发、不抛，返回 false（调用方据此降级）', async () => {
  reset({});
  assert.equal(await slackPort.sendDmCard({ color: 'grey', title: 'T', blocks: [] }), false);
  assert.equal(calls.length, 0, '没有目标就别打请求');
});

// ── 入站路由（startInbound 里那层分发）────────────────────────────────
function inbound(): { msgs: Record<string, unknown>[]; actions: Record<string, unknown>[]; errors: string[]; reconnects: number } {
  const msgs: Record<string, unknown>[] = [];
  const actions: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let reconnects = 0;
  slackPort.startInbound({
    onMessage: (raw) => msgs.push(raw),
    onCardAction: (raw) => actions.push(raw),
    onError: (r) => errors.push(r),
    onReconnected: () => {
      reconnects++;
    },
  });
  const box = { msgs, actions, errors, reconnects: 0 };
  Object.defineProperty(box, 'reconnects', { get: () => reconnects });
  return box;
}

test('入站路由：events_api → onMessage，interactive → onCardAction，其它信封丢弃', () => {
  reset();
  const box = inbound();
  captured?.onEnvelope('events_api', { event: { type: 'message' } });
  captured?.onEnvelope('interactive', { type: 'block_actions', actions: [{ action_id: 'x', value: '{}' }] });
  captured?.onEnvelope('slash_commands', { command: '/forge' }); // 没订阅斜杠命令 → 不该外泄给核心
  assert.equal(box.msgs.length, 1);
  assert.equal(box.actions.length, 1);
});

test('入站路由：长连接的 error / reconnected 原样透给核心（markWs 判活 + 重连补拉都靠它）', () => {
  reset();
  const box = inbound();
  captured?.onError('WebSocket closed code=1006');
  captured?.onReconnected();
  assert.deepEqual(box.errors, ['WebSocket closed code=1006']);
  assert.equal(box.reconnects, 1);
});

test('入站路由：「打开模态」被 adapter 截住——核心一条都收不到，同时真的去 views.open 了', async () => {
  reset();
  // 先渲染一张带表单的卡，把模态内容备进内存
  blocksOf({ kind: 'goForm', slug: 'refund', pool: ['M', 'CC'], picked: 'CC' });
  const box = inbound();
  captured?.onEnvelope('interactive', {
    type: 'block_actions',
    trigger_id: 'T123',
    actions: [{ action_id: OPEN_MODAL_ACTION, value: JSON.stringify({ action: 'go', slug: 'refund', kind: 'go' }) }],
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(box.actions, [], '开模态是 adapter 内部动作，核心永远看不到');
  assert.equal(calls[0]?.method, 'views.open');
  assert.equal(calls[0]?.body.trigger_id, 'T123');
  const view = calls[0]?.body.view as { private_metadata: string; blocks: { element: { type: string } }[] };
  assert.deepEqual(JSON.parse(view.private_metadata), { action: 'go', slug: 'refund', round: 0 });
  assert.equal(view.blocks[0].element.type, 'static_select', '渲染时备好的 DRI 池要真的用上');
});

test('开模态：守护重启过（内存里没有表单内容）→ 降级成纯文本模态，绝不让按钮点了没反应', async () => {
  reset(); // 清空模态暂存 = 模拟重启
  const box = inbound();
  captured?.onEnvelope('interactive', {
    type: 'block_actions',
    trigger_id: 'T9',
    actions: [{ action_id: OPEN_MODAL_ACTION, value: JSON.stringify({ action: 'confirm_submit', slug: 'gone', round: 2, kind: 'decision' }) }],
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(box.actions.length, 0);
  assert.equal(calls[0]?.method, 'views.open');
  const view = calls[0]?.body.view as { private_metadata: string; blocks: { block_id?: string }[] };
  // 上下文照样带全了 —— 人在降级模态里写的答复仍然回到正确的需求上
  assert.deepEqual(JSON.parse(view.private_metadata), { action: 'confirm_submit', slug: 'gone', round: 2 });
  assert.deepEqual(view.blocks.map((b) => b.block_id), ['verdict', 'notes']);
});

test('开模态：缺 trigger_id / value 不是 JSON → 不打请求，也不崩', async () => {
  reset();
  inbound();
  captured?.onEnvelope('interactive', { type: 'block_actions', actions: [{ action_id: OPEN_MODAL_ACTION, value: '{}' }] }); // 缺 trigger_id
  captured?.onEnvelope('interactive', { type: 'block_actions', trigger_id: 'T', actions: [{ action_id: OPEN_MODAL_ACTION, value: '坏json{' }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
});

// ── 群 webhook 兜底 ────────────────────────────────────────────────
test('postWebhook：未配 URL → false 且不发请求；配了就 POST 同一份渲染结果', async () => {
  reset({});
  assert.equal(await slackPort.postWebhook('标题', ['一行'], 'blue'), false);

  reset({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' });
  const origFetch = globalThis.fetch;
  let hit: { url: string; body: unknown } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    hit = { url: String(url), body: JSON.parse(init.body as string) };
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    assert.equal(await slackPort.postWebhook('标题', ['一行'], 'blue'), true);
    assert.equal(hit?.url, 'https://hooks.slack.com/services/T/B/X');
    assert.equal((hit?.body as { text: string }).text, '标题');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('postWebhook：网络异常吞掉返回 false（兜底通道失败不该掀翻调用方）', async () => {
  reset({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  try {
    assert.equal(await slackPort.postWebhook('t', [], 'red'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sendDmText：简单文本卡复用同一条渲染路径（不搞两套外观）', async () => {
  reset({ SLACK_DM_USER_ID: 'U1' });
  assert.equal(await slackPort.sendDmText('漂移告警', ['a', 'b'], 'orange'), true);
  const att = (calls[0].body.attachments as { color: string; blocks: { type: string }[] }[])[0];
  assert.equal(att.color, '#e8912d');
  assert.deepEqual(att.blocks.map((b) => b.type), ['header', 'section', 'section']);
});
