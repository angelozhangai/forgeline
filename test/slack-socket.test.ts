// Socket Mode 长连接的**状态机**（src/slack/socket.ts）。依赖全注入 → 无网络、无 Slack 工作区也能跑全。
// 这正是「值得手写一个长连接」的前提：不可测的手写长连接是负债，可测的才是省下一个依赖。
//
// 四条必须对的事（全部来自本地 spike 实测的真实事件序列）：
//  ① 每条带 envelope_id 的信封立刻 ack —— 迟于 3s 会被 Slack 重投，同一次点击执行两遍；
//  ② type:'disconnect' 是**计划内**换连接，不是故障；
//  ③ 硬断时原生 WebSocket 先 error 再 close，两个都触发重连会开出两条连接 → 每条信封收两遍；
//  ④ 首连失败如实 reject（核心据此降级为仅周期 tick），重连失败则退避重试、不放弃。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createSocketChannel, type WsLike } from '../src/slack/socket.ts';

// 假 socket：把 addEventListener 收下来，测试自己触发事件。
class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, ((ev: { data?: unknown; code?: number }) => void)[]>();
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.fire('close', { code: 1000 });
  }
  fire(type: string, ev: { data?: unknown; code?: number } = {}): void {
    for (const cb of this.handlers.get(type) ?? []) cb(ev);
  }
  frame(obj: unknown): void {
    this.fire('message', { data: JSON.stringify(obj) });
  }
}

interface Harness {
  sockets: FakeWs[];
  envelopes: { type: string; payload: Record<string, unknown> }[];
  errors: string[];
  reconnects: number;
  sleeps: number[];
  channel: ReturnType<typeof createSocketChannel>;
}
function harness(o: { openUrl?: () => Promise<{ ok: boolean; url?: string; error?: string }> } = {}): Harness {
  const sockets: FakeWs[] = [];
  const envelopes: { type: string; payload: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];
  let reconnects = 0;
  const channel = createSocketChannel(
    {
      onEnvelope: (type, payload) => envelopes.push({ type, payload }),
      onError: (r) => errors.push(r),
      onReconnected: () => {
        reconnects++;
      },
    },
    {
      openUrl: o.openUrl ?? (async () => ({ ok: true, url: 'wss://fake' })),
      connect: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      // 退避 sleep 直接返回（测试里不真等）。但重连失败会立刻再排一次重连——零延迟下那是死循环，
      // 所以第 5 次之后把 sleep 挂住，让循环停在那儿（真实运行里这里是真的在等秒级退避）。
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length > 5) await new Promise<void>(() => {});
      },
    },
  );
  const h: Harness = { sockets, envelopes, errors, reconnects: 0, sleeps, channel };
  Object.defineProperty(h, 'reconnects', { get: () => reconnects });
  return h;
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('首连：拿到 wss URL → 连上 → connect() resolve', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  assert.equal(h.sockets.length, 1);
});

test('首连失败如实 reject（核心据此降级为「仅周期 tick」，绝不假装连上了）', async () => {
  const h = harness({ openUrl: async () => ({ ok: false, error: 'invalid_auth' }) });
  await assert.rejects(() => h.channel.connect(), /apps\.connections\.open 失败.*invalid_auth/);
});

test('① 带 envelope_id 的信封**先 ack 再分发**（迟 3s 会被重投 → 同一次点击执行两遍）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const ws = h.sockets[0];
  ws.fire('open');
  await p;
  ws.frame({ envelope_id: 'env-1', type: 'interactive', payload: { type: 'block_actions' } });
  assert.deepEqual(ws.sent, ['{"envelope_id":"env-1"}']);
  assert.deepEqual(h.envelopes, [{ type: 'interactive', payload: { type: 'block_actions' } }]);
});

test('hello 不当业务事件；坏 JSON 跳过不崩；无 payload 的信封只 ack 不分发', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const ws = h.sockets[0];
  ws.fire('open');
  await p;
  ws.frame({ type: 'hello', num_connections: 1 });
  ws.fire('message', { data: 'not json{' });
  ws.frame({ envelope_id: 'env-2', type: 'events_api' }); // 缺 payload
  assert.deepEqual(h.envelopes, []);
  assert.deepEqual(ws.sent, ['{"envelope_id":"env-2"}'], '缺 payload 也要 ack——不 ack 就会被无限重投');
});

// Slack 每半小时左右就来这么一次。做错了不会有任何报错，只会「偶尔一个按钮点了没反应」+
// 每半小时一条假故障日志——两种最难查的形态。故这条路径的三件事全部钉死。
test('② type:disconnect 是计划内换连接：先建新连接、连上之后才关旧的（中间不留空窗）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const old = h.sockets[0];
  old.fire('open');
  await p;
  old.frame({ type: 'disconnect', reason: 'refresh_requested' });
  await tick();
  assert.equal(h.sockets.length, 2, '收到 disconnect 就立刻建新连接，不等退避');
  assert.equal(old.closed, false, '新连接还没连上 → 旧的必须还活着：空窗里丢掉的按钮点击是补拉捞不回来的');
  h.sockets[1].fire('open');
  assert.equal(old.closed, true, '新连接 open 之后才关旧的');
  assert.equal(h.sockets.length, 2, '一次换连接只开一条新的');
});

test('② 计划内换连接不算故障：不报 onError（否则核心 markWs(false)+log.err，每半小时一次假警报），也不走退避', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const old = h.sockets[0];
  old.fire('open');
  await p;
  old.frame({ type: 'disconnect', reason: 'refresh_requested' });
  await tick();
  h.sockets[1].fire('open');
  assert.deepEqual(h.errors, [], '计划内的换连接不是错误');
  assert.deepEqual(h.sleeps, [], '不走退避 sleep——那 1s 就是空窗本身');
  assert.equal(h.reconnects, 1, '仍然通知核心「已重连」→ 顺手补拉一次，空窗即便为零也不吃亏');
});

test('② 同一条连接上重复收到 disconnect：不再多开一条（否则一次换连接开出两条，信封收两遍）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const old = h.sockets[0];
  old.fire('open');
  await p;
  old.frame({ type: 'disconnect' });
  old.frame({ type: 'disconnect' });
  await tick();
  assert.equal(h.sockets.length, 2);
});

test('② 换连接之后，新连接上的硬断照样报错并重连（「计划内」是每条连接的属性，不是全局开关）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  h.sockets[0].frame({ type: 'disconnect' });
  await tick();
  h.sockets[1].fire('open'); // 换连接完成
  h.sockets[1].fire('close', { code: 1006 }); // 这次是真断了
  await tick();
  await tick();
  assert.deepEqual(h.errors, ['WebSocket closed code=1006']);
  assert.equal(h.sockets.length, 3, '真断开要重连');
});

test('③ error 与 close 成对触发时只重连一次（否则每条信封会被收两遍）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const ws = h.sockets[0];
  ws.fire('open');
  await p;
  // 本地 spike 实测的真实序列：error 紧接着 close:1006
  ws.fire('error');
  ws.fire('close', { code: 1006 });
  await tick();
  await tick();
  assert.equal(h.errors.length, 1, '一次断开只报一次错');
  assert.equal(h.sockets.length, 2, '一次断开只开一条新连接');
});

test('④ 重连成功才通知核心 onReconnected（首连不算——核心拿它去补拉断连期间的消息）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  assert.equal(h.reconnects, 0, '首连不是重连');
  h.sockets[0].fire('close', { code: 1006 });
  await tick();
  await tick();
  h.sockets[1].fire('open');
  assert.equal(h.reconnects, 1);
});

test('重连退避：1s→2s→4s…封顶 60s；连上后清零', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(backoffMs), [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]);
  assert.equal(backoffMs(99), 60_000, '封顶，绝不指数到天荒地老');

  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  h.sockets[0].fire('close', { code: 1006 });
  await tick();
  await tick();
  h.sockets[1].fire('open'); // 第二条连上了 → 退避清零
  h.sockets[1].fire('close', { code: 1006 });
  await tick();
  await tick();
  assert.deepEqual(h.sleeps.slice(0, 2), [1000, 1000], '每次成功连上都把退避清零 → 又从 1s 起');
});

test('重连时 openUrl 失败：报错 + 继续退避重试，绝不放弃（首连才 reject）', async () => {
  let first = true;
  const h = harness({
    openUrl: async () => {
      if (first) {
        first = false;
        return { ok: true, url: 'wss://fake' };
      }
      return { ok: false, error: 'ratelimited' };
    },
  });
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  h.sockets[0].fire('close', { code: 1006 });
  await tick();
  await tick();
  await tick();
  assert.ok(h.errors.some((e) => e.includes('ratelimited')), '重连拿不到 URL 要如实报错');
  assert.ok(h.sleeps.length >= 2, '并且继续退避重试');
});

test('close() 之后不再重连（守护退出时不该留个循环在后台刷）', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  h.channel.close();
  await tick();
  await tick();
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.errors, []);
});
