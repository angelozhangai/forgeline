// **本地验收回路**——issue #14 里"需要真工作区"的那半张清单，能在本地跑到的部分全在这里跑完。
//
// 和 messaging-slack.test.ts 的分工要说清楚：那边替掉了 slack/web.ts，钉的是"我们怎么拼载荷"；
// 这里**一个都不替**——真的 slack/web.ts（原生 fetch + form 编码）、真的 slack/socket.ts
// （Node 原生 WebSocket），对面是一个自己起的假 Slack：node:http 的 Web API + 手写握手的 WebSocket 服务端。
// 于是这条回路真正走过的是：
//
//   apps.connections.open → wss 握手 → events_api 信封 → ack → 发卡（chat.postMessage）
//   → 点按钮（block_actions/interactive）→ views.open → 提交（view_submission）→ 核心拿到 {action,slug,round,formValues}
//
// 它照得到、而单测照不到的东西，恰恰是那三件只在真环境才炸的：
//   · **编码**：conversations.history 这类读方法只认 form 编码，JSON 发过去参数等于没传；
//   · **帧**：ack 是不是真的按 Slack 的信封格式发回去了（不是"我们调用了 send"）；
//   · **往返**：private_metadata 里的上下文是不是原样回得来，且 state.values 拍平后键名对得上。
//
// 剩下真正需要一个 Slack 工作区的，只有"Slack 自己的行为"：真实 disconnect 的节奏、真实延迟下的
// 3 秒 ack 窗口、以及 views.open 对我们这份 view 的最终裁定。清单见 docs/ 与 issue #14。
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { CardModel } from '../src/messaging/model.ts';
import type { InboundChannel } from '../src/messaging/port.ts';

// env 走 mock：真 loadConfig 全进程缓存，切不动；这里要把 API 根地址指到假 Slack 上。
let env: Record<string, string | undefined> = {};
mock.module('../src/config.ts', { namedExports: { loadConfig: () => ({ env }) } });
const { slackPort, OPEN_MODAL_ACTION } = await import('../src/messaging/slack.ts');
const { validateAttachments, validateView } = await import('../src/slack/blockkit.ts');

// ── 手写 WebSocket 服务端（零依赖）──────────────────────────────────
// 只实现我们用得到的那点：握手、文本帧收发、close。客户端→服务端的帧一律带掩码，反向不带。
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 的握手魔数（对 Sec-WebSocket-Key 求 SHA-1）

function encodeFrame(text: string): Buffer {
  const p = Buffer.from(text, 'utf8');
  if (p.length < 126) return Buffer.concat([Buffer.from([0x81, p.length]), p]);
  const h = Buffer.alloc(4);
  h[0] = 0x81;
  h[1] = 126;
  h.writeUInt16BE(p.length, 2);
  return Buffer.concat([h, p]);
}

function decodeFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    len = Number(buf.readBigUInt64BE(off));
    off += 8;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, rest: buf.subarray(off + len) };
}

class FakeSocketMode {
  private buf = Buffer.alloc(0);
  private readonly sock: Duplex;
  readonly received: Record<string, unknown>[] = []; // 客户端发回来的帧（= ack）
  closed = false;
  constructor(sock: Duplex) {
    this.sock = sock;
    sock.on('close', () => {
      this.closed = true;
    });
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const f = decodeFrame(this.buf);
        if (!f) return;
        this.buf = f.rest;
        if (f.opcode === 0x8) return void sock.end();
        if (f.opcode === 0x1) this.received.push(JSON.parse(f.payload.toString('utf8')) as Record<string, unknown>);
      }
    });
    sock.on('error', () => undefined);
  }
  send(obj: unknown): void {
    this.sock.write(encodeFrame(JSON.stringify(obj)));
  }
  destroy(): void {
    this.sock.destroy();
  }
}

// ── 假 Slack Web API ────────────────────────────────────────────────
interface ApiCall {
  method: string;
  body: Record<string, string>;
  auth: string;
  contentType: string;
}

const calls: ApiCall[] = [];
let server: Server;
// 同时活着的连接**不止一条**：计划内换连接会先建新的、连上之后再关旧的。假服务端如实记下每一条。
const conns: FakeSocketMode[] = [];
const live = (): FakeSocketMode | undefined => conns.at(-1);
let history: Record<string, unknown>[] = [];

const last = (method: string): ApiCall | undefined => [...calls].reverse().find((c) => c.method === method);

function reply(method: string, body: Record<string, string>, base: string): Record<string, unknown> {
  switch (method) {
    case 'apps.connections.open':
      return { ok: true, url: `${base.replace('http://', 'ws://')}/link` };
    case 'chat.postMessage':
      return { ok: true, ts: '1712345678.000200', channel: body.channel };
    case 'chat.update':
      return { ok: true };
    case 'views.open':
      return { ok: true, view: JSON.parse(body.view ?? '{}') };
    case 'conversations.history':
      return { ok: true, has_more: false, messages: history };
    default:
      return { ok: false, error: 'unknown_method' };
  }
}

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const contentType = String(req.headers['content-type'] ?? '');
    const body: Record<string, string> = {};
    // **只吃 form 编码**：JSON body 在这里会解析成空对象，参数等于压根没传——
    // 那正是真 Slack 对 conversations.history 的行为，也正是本地永远照不出来的那个坑。
    if (contentType.includes('application/x-www-form-urlencoded')) {
      for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) body[k] = v;
    }
    const method = (req.url ?? '').replace(/^\/api\//, '');
    calls.push({ method, body, auth: String(req.headers.authorization ?? ''), contentType });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply(method, body, base())));
  });
  server.on('upgrade', (req, sock) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    conns.push(new FakeSocketMode(sock as Duplex));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  env = {
    SLACK_BOT_TOKEN: 'xoxb-acceptance',
    SLACK_APP_TOKEN: 'xapp-acceptance',
    SLACK_BOT_USER_ID: 'UBOT',
    SLACK_WATCH_CHANNELS: 'C1',
    SLACK_DM_USER_ID: 'UME',
    SLACK_API_BASE: `${base()}/api`,
  };
});

function base(): string {
  const a = server.address();
  return typeof a === 'object' && a ? `http://127.0.0.1:${a.port}` : '';
}

let channel: InboundChannel | null = null;
const inbound: { messages: Record<string, unknown>[]; actions: Record<string, unknown>[]; errors: string[]; reconnects: number } = { messages: [], actions: [], errors: [], reconnects: 0 };

after(async () => {
  channel?.close?.(); // 端口暴露 close() 的**唯一**理由：不关，重连退避会把测试进程吊住（也正是守护退不出去的那个形态）
  for (const c of conns) c.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const tickWait = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await tickWait();
  }
}

let envelopeSeq = 0;
async function envelope(type: string, payload: Record<string, unknown>): Promise<string> {
  const id = `env-${++envelopeSeq}`;
  const on = live();
  on?.send({ envelope_id: id, type, payload });
  await until(() => (on?.received ?? []).some((r) => r.envelope_id === id), `信封 ${id} 的 ack`);
  return id;
}

// ── 回路 ────────────────────────────────────────────────────────────

test('①建连：apps.connections.open（app token，不是 bot token）→ 原生 WebSocket 真的握上手', async () => {
  channel = slackPort.startInbound({
    onMessage: (raw) => void inbound.messages.push(raw),
    onCardAction: (raw) => void inbound.actions.push(raw),
    onError: (r) => void inbound.errors.push(r),
    onReconnected: () => {
      inbound.reconnects++;
    },
  });
  await channel.connect();
  await until(() => conns.length === 1, 'WebSocket 握手完成');
  const open = last('apps.connections.open');
  assert.equal(open?.auth, 'Bearer xapp-acceptance'); // Socket Mode 只认 app token
  assert.match(open?.contentType ?? '', /application\/x-www-form-urlencoded/);
});

test('②信封：群消息事件先 ack（迟 3s 会被重投 = 同一条需求登记两遍）再交核心，解析出的入站消息带齐入口闸判据', async () => {
  await envelope('events_api', {
    type: 'event_callback',
    event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UPM', ts: '1712345678.000100', text: '<@UBOT> 看下这份 https://example.com/prd' },
  });
  assert.equal(inbound.messages.length, 1);
  const m = slackPort.parseMessage(inbound.messages[0]);
  assert.equal(m?.chatId, 'C1');
  assert.equal(m?.senderId, 'UPM');
  assert.equal(m?.messageId, 'C1:1712345678.000100');
  assert.equal(m?.isGroup, true);
  assert.equal(m?.mentionedBot, true); // 入口闸靠它放行
});

// 一张真正的闸A 评审卡（决策表单 → Slack 侧只能进模态）。
const decisionCard: CardModel = {
  color: 'orange',
  title: '📋 需求评审 · 月度财务报表',
  subtitle: 'finance-report · 第 2 轮',
  blocks: [
    { kind: 'text', md: '**摘要**：把手工报表流程自动化。' },
    { kind: 'stats', fields: ['**复杂度**\nM', '**置信**\n0.78'] },
    {
      kind: 'decisionForm',
      slug: 'finance-report',
      action: 'confirm_submit',
      round: 2,
      verdict: true,
      submitText: '提交答复',
      notesLabel: '补充说明',
      notesPlaceholder: '还有别的要交代的写这里',
      items: [
        { prompt: '报表口径按自然月还是财月？', severity: 'high', options: [{ label: '自然月', recommended: true }, { label: '财月' }] },
        { prompt: '历史数据回溯多久？', severity: 'med', options: [{ label: '12 个月', recommended: true }, { label: '24 个月' }] },
      ],
    } as never,
  ],
};

test('③发卡：chat.postMessage 走 form 编码，blocks/attachments 是 JSON 串；发出去的载荷结构合法', async () => {
  const id = await slackPort.sendGroupCard('C1', decisionCard);
  assert.equal(id, 'C1:1712345678.000200'); // 复合 id：chat.update 要 channel+ts 两个值
  const c = last('chat.postMessage');
  assert.equal(c?.body.channel, 'C1');
  assert.equal(c?.auth, 'Bearer xoxb-acceptance'); // 发卡用 bot token
  assert.ok(c?.body.text, '通知栏预览不能为空');
  const attachments = JSON.parse(c?.body.attachments ?? '[]') as Record<string, unknown>[];
  assert.deepEqual(validateAttachments(attachments), []);
});

// 从**服务端真正收到的那张卡**里取出开模态按钮，模拟人点它——上下文全程没有走捷径。
function openModalPayload(): Record<string, unknown> {
  const attachments = JSON.parse(last('chat.postMessage')?.body.attachments ?? '[]') as { blocks: Record<string, unknown>[] }[];
  const el = attachments[0].blocks
    .flatMap((b) => ((b as { elements?: Record<string, unknown>[] }).elements ?? []))
    .find((e) => (e as { action_id?: string }).action_id === OPEN_MODAL_ACTION) as { value: string } | undefined;
  assert.ok(el, '卡上应该有一个开模态的按钮');
  return { type: 'block_actions', trigger_id: 'trg-1', user: { id: 'UPM' }, actions: [{ action_id: OPEN_MODAL_ACTION, value: el.value }] };
}

test('④点按钮：adapter 自己截住并 views.open——核心一条都收不到；开出来的 view 结构合法且带回上下文', async () => {
  const before = inbound.actions.length;
  await envelope('interactive', openModalPayload());
  await until(() => last('views.open') !== undefined, 'views.open 请求到达');
  assert.equal(inbound.actions.length, before, '「打开模态」是 adapter 内部动作，核心不该看到');
  const call = last('views.open');
  assert.equal(call?.body.trigger_id, 'trg-1');
  const view = JSON.parse(call?.body.view ?? '{}') as Record<string, unknown>;
  assert.deepEqual(validateView(view), []);
  assert.deepEqual(JSON.parse(String(view.private_metadata)), { action: 'confirm_submit', slug: 'finance-report', round: 2 });
  // 两条待决项各一个 input 块，键名与回拼同序对齐
  const ids = (view.blocks as { block_id?: string }[]).map((b) => b.block_id);
  // 待决项 id 由 answerableDecisions 按严重度编号（H=high…），与核心回拼答复时同序对齐
  assert.deepEqual(ids, ['ask_H1', 'ask_H2', 'verdict', 'notes']);
});

test('⑤提交：一条 view_submission 带回全部字段——这就是本阶段唯一赌在文档上的那件事', async () => {
  const view = JSON.parse(last('views.open')?.body.view ?? '{}') as Record<string, unknown>;
  await envelope('interactive', {
    type: 'view_submission',
    user: { id: 'UPM' },
    view: {
      private_metadata: view.private_metadata,
      state: {
        values: {
          ask_H1: { ask_H1: { type: 'static_select', selected_option: { value: '自然月' } } },
          ask_H2: { ask_H2: { type: 'static_select', selected_option: null } }, // 没答的项：不该出现在 formValues 里
          verdict: { verdict: { type: 'static_select', selected_option: { value: 'partial' } } },
          notes: { notes: { type: 'plain_text_input', value: '第 2 条我再确认下' } },
        },
      },
    },
  });
  const action = slackPort.parseCardAction(inbound.actions.at(-1) as Record<string, unknown>);
  assert.equal(action?.action, 'confirm_submit');
  assert.equal(action?.slug, 'finance-report');
  assert.equal(action?.value.round, 2); // 群卡原地编辑的去重靠它
  assert.equal(action?.operatorId, 'UPM');
  assert.deepEqual(action?.formValues, { ask_H1: '自然月', verdict: 'partial', notes: '第 2 条我再确认下' });
});

test('⑥改卡：chat.update 拆出 channel+ts 原地编辑（群状态卡全程只有一张）', async () => {
  assert.equal(await slackPort.editGroupCard('C1:1712345678.000200', decisionCard), true);
  const c = last('chat.update');
  assert.equal(c?.body.channel, 'C1');
  assert.equal(c?.body.ts, '1712345678.000200');
});

test('⑦补拉：conversations.history 是**读方法**，只认 form 编码；倒序返回 → 翻成升序交核心', async () => {
  history = [
    { type: 'message', user: 'UPM', ts: '1712345680.000100', text: '<@UBOT> 第二条 https://example.com/b' },
    { type: 'message', user: 'UPM', ts: '1712345679.000100', text: '随手贴的 https://example.com/a' },
  ];
  const got = await slackPort.listHistorySince('C1', 1712345678000);
  const c = last('conversations.history');
  assert.equal(c?.body.channel, 'C1'); // 参数真的到了 body 里（JSON 发过去这里会是 undefined）
  assert.equal(c?.body.oldest, '1712345678.000000');
  assert.deepEqual(got.map((m) => m.createTime), [1712345679000, 1712345680000]);
  assert.deepEqual(got.map((m) => m.mentionedBot), [false, true]); // 入口闸对历史条目同样判得出来
});

test('⑦补拉：私聊历史不能被当成群消息——否则离线期间私聊来的需求会被入口闸静默丢掉', async () => {
  history = [{ type: 'message', user: 'UPM', ts: '1712345681.000100', text: '这份你看下 https://example.com/dm' }];
  const dm = await slackPort.listHistorySince('D9PRIVATE', 1712345678000);
  assert.equal(dm[0]?.isGroup, false); // 私聊 → 天然定向，不要求 @
  const group = await slackPort.listHistorySince('C1', 1712345678000);
  assert.equal(group[0]?.isGroup, true);
});

test('⑧探针：conversations.history 的分页信封（messages + has_more）是补拉的依赖，探针验的正是它', async () => {
  history = [];
  const p = await slackPort.probe();
  assert.equal(p.ok, true);
  assert.equal(p.available, true);
});

// ── 长连接生命周期：这两条走的是**真** WebSocket，不是注入的假 socket ──────────
// socket.ts 的状态机已经被 slack-socket.test.ts 用注入依赖钉死了；这里补的是另一半：
// 原生 WebSocket 在真实握手/真实断开下**确实**按那套时序走。#14 清单里"挂一小时看换连接"验的就是它。

test('⑨计划内换连接（Slack 每半小时一次的 disconnect）：先建新连接、连上之后才关旧的，中间不留空窗', async () => {
  const before = conns.length;
  const errs = inbound.errors.length;
  live()?.send({ type: 'disconnect', reason: 'refresh_requested' });
  await until(() => conns.length === before + 1, '新连接建立');
  await until(() => conns[before - 1].closed, '旧连接被关掉');
  assert.equal(inbound.errors.length, errs, '计划内换连接不是故障：报了核心就会 markWs(false)，每半小时一次假警报');
  // 新连接照常收发：换连接期间掉一条 interactive 载荷是补拉捞不回来的
  await envelope('events_api', { type: 'event_callback', event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UPM', ts: '1712345690.000100', text: '<@UBOT> 换完连接照样收 https://example.com/c' } });
  assert.equal(slackPort.parseMessage(inbound.messages.at(-1) as Record<string, unknown>)?.createTime, 1712345690000);
});

test('⑩硬断：原生 WebSocket 先 error 再 close，只重连一次；重连成功才通知核心（核心据此补拉断连期间的消息）', async () => {
  const before = conns.length;
  const reconnects0 = inbound.reconnects;
  conns[before - 1].destroy(); // 服务端把连接掐掉 = 网络抖动
  await until(() => conns.length === before + 1, '退避后重连', 8000);
  assert.equal(conns.length, before + 1, '一次硬断只该重连出一条连接（error 与 close 会成对触发）');
  await until(() => inbound.reconnects === reconnects0 + 1, 'onReconnected 通知核心');
});
