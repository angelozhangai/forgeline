// The Socket Mode connection's **state machine** (src/slack/socket.ts). Every dependency is injected ->
// the whole thing runs with no network and no Slack workspace.
// That is exactly what makes hand-writing a connection defensible: an untestable hand-written connection
// is a liability, while a testable one saves a dependency.
//
// Four things that must be right (all taken from the real event sequences measured in a local spike):
//  1. Every envelope carrying an envelope_id is acked immediately — later than 3s and Slack redelivers,
//     so the same click executes twice;
//  2. type:'disconnect' is a **planned** connection swap, not a fault;
//  3. On a hard drop the native WebSocket fires error before close, and reconnecting on both opens two
//     connections -> every envelope arrives twice;
//  4. A failed first connect rejects faithfully (the core degrades to periodic ticks only on that), while
//     a failed reconnect backs off, retries and never gives up.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createSocketChannel, type WsLike } from '../src/slack/socket.ts';

// Fake socket: it captures addEventListener, and the test fires the events itself.
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
      // The backoff sleep returns immediately (tests do not really wait). But a failed reconnect schedules
      // another one straight away, and with zero delay that is an infinite loop — so after the fifth call
      // the sleep hangs, parking the loop there (in a real run this is genuinely waiting out a
      // seconds-long backoff).
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

test('first connect: obtain the wss URL -> connect -> connect() resolves', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  assert.equal(h.sockets.length, 1);
});

test('a failed first connect rejects faithfully (the core degrades to "periodic ticks only" on that, never pretending it connected)', async () => {
  const h = harness({ openUrl: async () => ({ ok: false, error: 'invalid_auth' }) });
  await assert.rejects(() => h.channel.connect(), /apps\.connections\.open failed.*invalid_auth/);
});

test('(1) an envelope with an envelope_id is **acked before it is dispatched** (3s late means redelivery -> the same click executes twice)', async () => {
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

test('hello is not a business event; bad JSON is skipped without crashing; an envelope with no payload is acked but not dispatched', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const ws = h.sockets[0];
  ws.fire('open');
  await p;
  ws.frame({ type: 'hello', num_connections: 1 });
  ws.fire('message', { data: 'not json{' });
  ws.frame({ envelope_id: 'env-2', type: 'events_api' }); // no payload
  assert.deepEqual(h.envelopes, []);
  assert.deepEqual(ws.sent, ['{"envelope_id":"env-2"}'], 'a missing payload must still be acked — without an ack it is redelivered forever');
});

// Slack does this roughly every half hour. Getting it wrong produces no error at all, only "occasionally
// a button does nothing" plus a bogus fault log every half hour — the two hardest shapes to diagnose. So
// all three aspects of this path are pinned.
test('(2) type:disconnect is a planned swap: build the new connection first and close the old one only once it is up (leaving no gap)', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const old = h.sockets[0];
  old.fire('open');
  await p;
  old.frame({ type: 'disconnect', reason: 'refresh_requested' });
  await tick();
  assert.equal(h.sockets.length, 2, 'a disconnect builds the new connection immediately, without waiting out a backoff');
  assert.equal(old.closed, false, 'the new connection is not up yet -> the old one must still be alive: a button click lost in the gap cannot be recovered by backfill');
  h.sockets[1].fire('open');
  assert.equal(old.closed, true, 'the old one is closed only after the new one is open');
  assert.equal(h.sockets.length, 2, 'one swap opens exactly one new connection');
});

test('(2) a planned swap is not a fault: no onError (which would make the core call markWs(false) + log.err, a bogus alarm every half hour) and no backoff', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const old = h.sockets[0];
  old.fire('open');
  await p;
  old.frame({ type: 'disconnect', reason: 'refresh_requested' });
  await tick();
  h.sockets[1].fire('open');
  assert.deepEqual(h.errors, [], 'a planned swap is not an error');
  assert.deepEqual(h.sleeps, [], 'no backoff sleep — that 1s *is* the gap');
  assert.equal(h.reconnects, 1, 'the core is still told "reconnected" -> it runs a backfill, so even a zero-length gap costs nothing');
});

test('(2) a repeated disconnect on the same connection does not open another (otherwise one swap opens two and every envelope arrives twice)', async () => {
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

test('(2) after a swap, a hard drop on the new connection still reports and reconnects ("planned" is a per-connection property, not a global flag)', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  h.sockets[0].frame({ type: 'disconnect' });
  await tick();
  h.sockets[1].fire('open'); // the swap completes
  h.sockets[1].fire('close', { code: 1006 }); // this one really did drop
  await tick();
  await tick();
  assert.deepEqual(h.errors, ['WebSocket closed code=1006']);
  assert.equal(h.sockets.length, 3, 'a genuine drop must reconnect');
});

test('(3) when error and close fire as a pair, reconnect only once (otherwise every envelope arrives twice)', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const ws = h.sockets[0];
  ws.fire('open');
  await p;
  // The real sequence measured in a local spike: error immediately followed by close:1006
  ws.fire('error');
  ws.fire('close', { code: 1006 });
  await tick();
  await tick();
  assert.equal(h.errors.length, 1, 'one drop reports one error');
  assert.equal(h.sockets.length, 2, 'one drop opens one new connection');
});

test('(4) onReconnected is only reported after a successful reconnect (the first connect does not count — the core uses it to backfill messages from the outage)', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  assert.equal(h.reconnects, 0, 'a first connect is not a reconnect');
  h.sockets[0].fire('close', { code: 1006 });
  await tick();
  await tick();
  h.sockets[1].fire('open');
  assert.equal(h.reconnects, 1);
});

test('reconnect backoff: 1s -> 2s -> 4s … capped at 60s; reset once connected', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(backoffMs), [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]);
  assert.equal(backoffMs(99), 60_000, 'capped, never exponentiating forever');

  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.sockets[0].fire('open');
  await p;
  h.sockets[0].fire('close', { code: 1006 });
  await tick();
  await tick();
  h.sockets[1].fire('open'); // the second one connected -> the backoff resets
  h.sockets[1].fire('close', { code: 1006 });
  await tick();
  await tick();
  assert.deepEqual(h.sleeps.slice(0, 2), [1000, 1000], 'every successful connect resets the backoff -> it starts from 1s again');
});

test('openUrl failing during a reconnect: report it and keep backing off and retrying, never give up (only the first connect rejects)', async () => {
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
  assert.ok(h.errors.some((e) => e.includes('ratelimited')), 'failing to get a URL on reconnect must be reported faithfully');
  assert.ok(h.sleeps.length >= 2, 'and it must keep backing off and retrying');
});

test('no reconnect after close() (a daemon shutting down should not leave a loop spinning in the background)', async () => {
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

// The overlap window of a swap holds two live connections — if close() only closes "the current one",
// the other is left unowned: it will not reconnect (superseded) and nobody will ever close it, so the
// process cannot exit while holding a live handle.
// This is exactly the shape this repo most needs to avoid: no error, the daemon just will not stop.
test('close() landing inside a swap\'s overlap window: both connections must be closed, and not one may be missed', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  const old = h.sockets[0];
  old.fire('open');
  await p;
  old.frame({ type: 'disconnect' });
  await tick();
  assert.equal(h.sockets.length, 2, 'precondition: the new connection is being built and the old one is still alive');
  assert.equal(old.closed, false);
  h.channel.close();
  assert.equal(old.closed, true, 'the old connection must not be left behind (it is already superseded, so nobody else will touch it)');
  assert.equal(h.sockets[1].closed, true);
});

test('close() racing the first connect\'s openUrl: connect() must settle, and no connection is built (otherwise the startup path hangs)', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h = harness({
    openUrl: async () => {
      await gate;
      return { ok: true, url: 'wss://fake' };
    },
  });
  const p = h.channel.connect();
  h.channel.close(); // closed while still inside openUrl
  release();
  await p; // if it hangs, this test times out — which is exactly what "the daemon will not start" looks like in production
  assert.equal(h.sockets.length, 0, 'once closed, do not build another unowned connection');
});

test('a late open after close(): the connection is closed, and connect() still settles', async () => {
  const h = harness();
  const p = h.channel.connect();
  await tick();
  h.channel.close(); // the socket exists but has not opened yet
  h.sockets[0].fire('open'); // the late open
  await p;
  assert.equal(h.sockets[0].closed, true);
  assert.deepEqual(h.errors, [], 'we closed it ourselves, so it is not a fault');
});
