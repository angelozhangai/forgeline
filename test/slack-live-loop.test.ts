// **The local acceptance loop** -- everything from the "needs a real workspace" half of issue #14 that can
// in fact be run locally is run here.
//
// How this differs from messaging-slack.test.ts is worth stating: that file replaces slack/web.ts and pins
// down *how we assemble the payload*. This one **replaces nothing** -- the real slack/web.ts (native fetch
// plus form encoding) and the real slack/socket.ts (Node's native WebSocket) talk to a fake Slack we stand
// up ourselves: a node:http Web API plus a WebSocket server with a hand-written handshake. So the loop it
// actually walks is:
//
//   apps.connections.open -> the wss handshake -> an events_api envelope -> ack -> post a card
//   (chat.postMessage) -> press a button (block_actions/interactive) -> views.open -> submit
//   (view_submission) -> the core receives {action, slug, round, formValues}
//
// What it catches and a unit test cannot is exactly the three things that only blow up against the real
// thing:
//   * **Encoding**: read methods like conversations.history accept form encoding only; send JSON and the
//     arguments may as well not have been sent at all;
//   * **Framing**: whether the ack really goes back in Slack's envelope format (not merely "we called send");
//   * **The round trip**: whether the context in private_metadata comes back unchanged, and whether the
//     flattened state.values keys still line up.
//
// What genuinely still needs a Slack workspace is only "Slack's own behaviour": the cadence of a real
// disconnect, the 3-second ack window under real latency, and views.open's final verdict on this view of
// ours. The list lives in docs/ and in issue #14.
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { CardModel } from '../src/messaging/model.ts';
import type { InboundChannel } from '../src/messaging/port.ts';

// env goes through a mock: the real loadConfig caches for the whole process and cannot be switched, and
// here the API base has to point at the fake Slack.
let env: Record<string, string | undefined> = {};
mock.module('../src/config.ts', { namedExports: { loadConfig: () => ({ env }) } });
const { slackPort, OPEN_MODAL_ACTION } = await import('../src/messaging/slack.ts');
const { validateAttachments } = await import('../src/slack/blockkit.ts');

// -- A hand-written WebSocket server (no dependencies) ----------------------------
// It implements only what we use: the handshake, sending and receiving text frames, and close. Frames from
// client to server are always masked; the other direction never is.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455's handshake magic (SHA-1 over Sec-WebSocket-Key)

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
  readonly received: Record<string, unknown>[] = []; // the frames the client sent back (i.e. the acks)
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

// -- The fake Slack Web API ------------------------------------------
interface ApiCall {
  method: string;
  body: Record<string, string>;
  auth: string;
  contentType: string;
}

const calls: ApiCall[] = [];
let server: Server;
// **More than one** connection is alive at a time: a planned reconnect opens the new one first and only
// closes the old one once it is up. The fake server records every one of them faithfully.
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
    // **Form encoding only**: a JSON body parses to an empty object here, so the arguments may as well not
    // have been sent -- which is exactly what real Slack does with conversations.history, and exactly the
    // trap a local test can otherwise never surface.
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
  channel?.close?.(); // the **only** reason the port exposes close(): without it the reconnect backoff hangs the test process -- the same shape as a daemon that will not exit
  for (const c of conns) c.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const tickWait = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await tickWait();
  }
}

let envelopeSeq = 0;
async function envelope(type: string, payload: Record<string, unknown>): Promise<string> {
  const id = `env-${++envelopeSeq}`;
  const on = live();
  on?.send({ envelope_id: id, type, payload });
  await until(() => (on?.received ?? []).some((r) => r.envelope_id === id), `the ack for envelope ${id}`);
  return id;
}

// -- The loop --------------------------------------------------------

test('1. connect: apps.connections.open (the app token, not the bot token) -> the native WebSocket really does complete the handshake', async () => {
  channel = slackPort.startInbound({
    onMessage: (raw) => void inbound.messages.push(raw),
    onCardAction: (raw) => void inbound.actions.push(raw),
    onError: (r) => void inbound.errors.push(r),
    onReconnected: () => {
      inbound.reconnects++;
    },
  });
  await channel.connect();
  await until(() => conns.length === 1, 'the WebSocket handshake to complete');
  const open = last('apps.connections.open');
  assert.equal(open?.auth, 'Bearer xapp-acceptance'); // Socket Mode accepts the app token only
  assert.match(open?.contentType ?? '', /application\/x-www-form-urlencoded/);
});

test('2. envelopes: a channel message is acked first (later than 3s and Slack redelivers it, registering the same requirement twice) and only then handed to the core, parsed with everything the intake gate needs', async () => {
  await envelope('events_api', {
    type: 'event_callback',
    event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UPM', ts: '1712345678.000100', text: '<@UBOT> take a look at this https://example.com/prd' },
  });
  assert.equal(inbound.messages.length, 1);
  const m = slackPort.parseMessage(inbound.messages[0]);
  assert.equal(m?.chatId, 'C1');
  assert.equal(m?.senderId, 'UPM');
  assert.equal(m?.messageId, 'C1:1712345678.000100');
  assert.equal(m?.isGroup, true);
  assert.equal(m?.mentionedBot, true); // this is what the intake gate lets through on
});

// A real gate A review card (a decision form, which on Slack can only be a modal).
const decisionCard: CardModel = {
  color: 'orange',
  title: '📋 Requirement review - the monthly finance report',
  subtitle: 'finance-report - round 2',
  blocks: [
    { kind: 'text', md: '**Summary**: automate the manual reporting process.' },
    { kind: 'stats', fields: ['**Complexity**\nM', '**Confidence**\n0.78'] },
    {
      kind: 'decisionForm',
      slug: 'finance-report',
      action: 'confirm_submit',
      round: 2,
      verdict: true,
      submitText: 'Submit answers',
      notesLabel: 'Anything to add',
      notesPlaceholder: 'Anything else worth saying goes here',
      items: [
        { prompt: 'Should the report follow calendar months or fiscal months?', severity: 'high', options: [{ label: 'calendar months', recommended: true }, { label: 'fiscal months' }] },
        { prompt: 'How far back should the history go?', severity: 'med', options: [{ label: '12 months', recommended: true }, { label: '24 months' }] },
      ],
    } as never,
  ],
};

test('3. post a card: chat.postMessage uses form encoding with blocks/attachments as JSON strings, and the payload that goes out is structurally valid', async () => {
  const id = await slackPort.sendGroupCard('C1', decisionCard);
  assert.equal(id, 'C1:1712345678.000200'); // a composite id: chat.update needs both channel and ts
  const c = last('chat.postMessage');
  assert.equal(c?.body.channel, 'C1');
  assert.equal(c?.auth, 'Bearer xoxb-acceptance'); // posting a card uses the bot token
  assert.ok(c?.body.text, 'the notification preview must not be empty');
  const attachments = JSON.parse(c?.body.attachments ?? '[]') as Record<string, unknown>[];
  assert.deepEqual(validateAttachments(attachments), []);
});

// Read the form back out of **the card the server actually received** — the questions took no shortcut on
// their way into the message.
function cardBlocks(): Record<string, unknown>[] {
  const attachments = JSON.parse(last('chat.postMessage')?.body.attachments ?? '[]') as { blocks: Record<string, unknown>[] }[];
  return attachments[0].blocks;
}
// The state Slack sends with any interaction on that message: one entry per input block, keyed
// [block_id][action_id], exactly as a real workspace returned it.
const STATE = {
  values: {
    ask_H1: { ask_H1: { type: 'radio_buttons', selected_option: { value: 'calendar months' } } },
    ask_H2: { ask_H2: { type: 'radio_buttons', selected_option: null } }, // unanswered: must not appear in formValues
    verdict: { verdict: { type: 'static_select', selected_option: { value: 'partial' } } },
    notes: { notes: { type: 'plain_text_input', value: 'let me double-check the second one' } },
  },
};

test('4. the form is in the card: one input block per open question, keyed the way the answers are reassembled', () => {
  const ids = cardBlocks()
    .filter((b) => b.type === 'input')
    .map((b) => (b as { block_id?: string }).block_id);
  // answerableDecisions numbers the question ids by severity (H = high, ...), in the same order the core
  // reassembles the answers in
  assert.deepEqual(ids, ['ask_H1', 'ask_H2', 'verdict', 'notes']);
});

test('4b. touching an option is not an answer: an input dispatches its own callback, and the core must not see a half-filled form', async () => {
  const before = inbound.actions.length;
  await envelope('interactive', { type: 'block_actions', user: { id: 'UPM' }, state: STATE, actions: [{ type: 'radio_buttons', action_id: 'ask_H1' }] });
  await until(() => inbound.actions.length > before, 'the callback to reach the core side of the seam');
  assert.equal(slackPort.parseCardAction(inbound.actions.at(-1) as Record<string, unknown>), null, 'only the submit button counts as an answer');
});

test('5. submit: one click carries the context and every field back, with no modal in between', async () => {
  const submit = cardBlocks()
    .flatMap((b) => ((b as { elements?: Record<string, unknown>[] }).elements ?? []))
    .find((e) => (e as { type?: string }).type === 'button') as { action_id: string; value: string } | undefined;
  assert.ok(submit, 'the card should carry a submit button');
  assert.notEqual(submit.action_id, OPEN_MODAL_ACTION, 'and it should not be opening a modal');

  const before = inbound.actions.length;
  await envelope('interactive', {
    type: 'block_actions',
    user: { id: 'UPM' },
    state: STATE,
    actions: [{ type: 'button', action_id: submit.action_id, value: submit.value }],
  });
  await until(() => inbound.actions.length > before, 'the submission to reach the core side of the seam');
  const action = slackPort.parseCardAction(inbound.actions.at(-1) as Record<string, unknown>);
  assert.equal(action?.action, 'confirm_submit');
  assert.equal(action?.slug, 'finance-report');
  assert.equal(action?.value.round, 2); // this is what deduplicates the in-place edits of the channel card
  assert.equal(action?.operatorId, 'UPM');
  assert.deepEqual(action?.formValues, { ask_H1: 'calendar months', verdict: 'partial', notes: 'let me double-check the second one' });
});

test('6. edit the card: chat.update splits out channel+ts and edits in place (there is only ever one channel status card)', async () => {
  assert.equal(await slackPort.editGroupCard('C1:1712345678.000200', decisionCard), true);
  const c = last('chat.update');
  assert.equal(c?.body.channel, 'C1');
  assert.equal(c?.body.ts, '1712345678.000200');
});

test('7. backfill: conversations.history is a **read method** and takes form encoding only; it returns newest first, so the order is flipped before the core sees it', async () => {
  history = [
    { type: 'message', user: 'UPM', ts: '1712345680.000100', text: '<@UBOT> the second one https://example.com/b' },
    { type: 'message', user: 'UPM', ts: '1712345679.000100', text: 'just pasting this https://example.com/a' },
  ];
  const got = await slackPort.listHistorySince('C1', 1712345678000);
  const c = last('conversations.history');
  assert.equal(c?.body.channel, 'C1'); // the argument really did reach the body (sent as JSON this would be undefined)
  assert.equal(c?.body.oldest, '1712345678.000000');
  assert.deepEqual(got.map((m) => m.createTime), [1712345679000, 1712345680000]);
  assert.deepEqual(got.map((m) => m.mentionedBot), [false, true]); // the intake gate can still decide on backfilled entries
});

test('7. backfill: direct-message history must not be treated as channel messages -- otherwise a requirement sent by DM while offline is silently dropped by the intake gate', async () => {
  history = [{ type: 'message', user: 'UPM', ts: '1712345681.000100', text: 'have a look at this https://example.com/dm' }];
  const dm = await slackPort.listHistorySince('D9PRIVATE', 1712345678000);
  assert.equal(dm[0]?.isGroup, false); // a DM is directed by nature and needs no @-mention
  const group = await slackPort.listHistorySince('C1', 1712345678000);
  assert.equal(group[0]?.isGroup, true);
});

test('8. the probe: backfill depends on the conversations.history pagination envelope (messages + has_more), and that is exactly what the probe verifies', async () => {
  history = [];
  const p = await slackPort.probe();
  assert.equal(p.ok, true);
  assert.equal(p.available, true);
});

// -- The long-connection lifecycle: these two run over a **real** WebSocket, not an injected fake --------
// socket.ts's state machine is already pinned down by slack-socket.test.ts through injected dependencies;
// what these add is the other half -- that the native WebSocket really does follow that sequence under a
// real handshake and a real disconnect. This is what "leave it up for an hour and watch it reconnect" on
// the #14 list was verifying.

test('9. a planned reconnect (the disconnect Slack sends every half hour): open the new connection first and close the old one only once it is up, leaving no gap in between', async () => {
  const before = conns.length;
  const errs = inbound.errors.length;
  live()?.send({ type: 'disconnect', reason: 'refresh_requested' });
  await until(() => conns.length === before + 1, 'the new connection to be established');
  await until(() => conns[before - 1].closed, 'the old connection to be closed');
  assert.equal(inbound.errors.length, errs, 'a planned reconnect is not a fault: report it and the core calls markWs(false) -- a false alarm every half hour');
  // The new connection sends and receives as usual: an interactive payload dropped during a reconnect is
  // not something backfill can recover.
  await envelope('events_api', { type: 'event_callback', event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UPM', ts: '1712345690.000100', text: '<@UBOT> still received after the reconnect https://example.com/c' } });
  assert.equal(slackPort.parseMessage(inbound.messages.at(-1) as Record<string, unknown>)?.createTime, 1712345690000);
});

test('10. a hard drop: the native WebSocket fires error then close, and reconnects exactly once; the core is told only once the reconnect succeeds (that is what it backfills the gap from)', async () => {
  const before = conns.length;
  const reconnects0 = inbound.reconnects;
  conns[before - 1].destroy(); // the server drops the connection = a network blip
  await until(() => conns.length === before + 1, 'the reconnect after the backoff', 8000);
  assert.equal(conns.length, before + 1, 'one hard drop should produce exactly one new connection (error and close fire as a pair)');
  await until(() => inbound.reconnects === reconnects0 + 1, 'onReconnected to reach the core');
});
