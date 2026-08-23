// Slack provider layer — **the Socket Mode connection**. Zero new dependencies:
// apps.connections.open returns a wss URL, and Node's native WebSocket (built in since 22; this repo
// requires 24) connects to it. This is the peer of the lark SDK layer on the Feishu side.
//
// Writing it by hand means getting exactly five things right, and all five are below:
//   1. Every envelope carrying an envelope_id **must be acked immediately**, or Slack redelivers after
//      3 seconds and the business action runs twice;
//   2. Slack periodically sends type:'disconnect' (refresh_requested) and then closes the connection —
//      this is normal, not a fault. Two consequences: **do not report an error** (reporting it makes the
//      core call markWs(false) + log.err, a bogus alarm every half hour), and **establish the new
//      connection before closing the old one** — leaving a gap in between loses any button click that
//      lands in it: channel messages can still be recovered by the backfill after reconnect, but
//      interactive payloads cannot;
//   3. On a hard drop the native WebSocket fires **error before close** (measured in a local spike:
//      open -> … -> error -> close:1006), and reconnecting on both events opens two connections, so
//      every envelope arrives twice. Hence one connection may settle only once.
//   4. A failed first connect must reject faithfully (leaving the core to decide whether to degrade to
//      periodic ticks only), while a failed reconnect backs off and retries and never gives up;
//   5. close() must close **every** connection still alive, and no path may leave an unsettled promise.
//      The overlap window from (2) holds two connections, and missing one means the daemon cannot exit;
//      missing one resolve() means startup hangs on the await. Neither reports an error — they just
//      manifest as "it won't stop" or "it won't start".
//
// Every dependency is injectable (openUrl / connect / sleep), so the state machine above can be pinned
// by unit tests **with no network and no Slack workspace**. That is precisely what makes hand-writing it
// defensible: an untestable hand-written connection is the thing that would be a liability.
//
// Only messaging/slack.ts may use this (the architecture boundary gate enforces it).
import { log } from '../util/log.ts';
import { appToken } from './web.ts';
import { slackApi } from './web.ts';

// We use only these few things from WebSocket — narrowed to the smallest interface so tests can inject a
// fake.
export interface WsLike {
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SocketHandlers {
  // One acked envelope: `type` is Slack's envelope type (events_api / interactive / slash_commands) and
  // `payload` is the raw payload.
  onEnvelope(type: string, payload: Record<string, unknown>): void;
  onError(reason: string): void;
  onReconnected(): void;
}

export interface SocketDeps {
  openUrl(): Promise<{ ok: boolean; url?: string; error?: string }>;
  connect(url: string): WsLike;
  sleep(ms: number): Promise<void>;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

// Backoff: 1s -> 2s -> 4s … capped at 60s. Exported so unit tests can assert on it directly (getting the
// reconnect cadence wrong would hammer the workspace into 429s).
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

const defaultDeps: SocketDeps = {
  async openUrl() {
    const r = await slackApi('apps.connections.open', {}, { token: appToken() });
    return { ok: r.ok === true, url: typeof r.url === 'string' ? r.url : undefined, error: r.error };
  },
  connect: (url) => new WebSocket(url) as unknown as WsLike,
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

export interface SocketChannel {
  connect(): Promise<void>;
  close(): void;
}

// One connection's private state. superseded = "a new connection has already taken over from it", which
// makes its subsequent disconnect **planned**: it should not report an error and should not trigger
// another reconnect (otherwise one connection swap opens two, and every envelope arrives twice).
interface Conn {
  sock: WsLike;
  superseded: boolean;
}

export function createSocketChannel(handlers: SocketHandlers, overrides: Partial<SocketDeps> = {}): SocketChannel {
  const deps: SocketDeps = { ...defaultDeps, ...overrides };
  // **More than one** connection can be alive at a time: a planned swap briefly holds two (build the new
  // one, then close the old once it is up).
  // So tracking only "the current one" is not enough — if close() lands inside the overlap window, the
  // other connection is left unowned: it will not reconnect (superseded) and will never be closed, so the
  // process cannot exit while holding a live handle.
  const live = new Set<WsLike>();
  let closed = false; // once the caller has explicitly called close(), never reconnect again
  let attempt = 0;
  let everConnected = false;

  function closeQuietly(sock: WsLike): void {
    live.delete(sock);
    try {
      sock.close();
    } catch {
      /* already disconnected */
    }
  }

  // Open one connection. The first connect (first=true) rejects faithfully so the core can decide;
  // a reconnect backs off and retries on its own.
  // onOpened: cleanup that runs only **after the new connection is genuinely up** (used during a swap to
  // close the old one).
  function open(first: boolean, onOpened?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        const got = await deps.openUrl();
        // The caller closed the channel while openUrl was in flight -> do not go on to build a connection.
        // But the promise **must settle**: connect() is awaited on the first connect, and leaving a
        // never-settling promise would hang the startup path outright.
        if (closed) return void resolve();
        if (!got.ok || !got.url) {
          const reason = `apps.connections.open failed: ${got.error ?? 'no url'}`;
          if (first) return reject(new Error(reason));
          handlers.onError(reason);
          return void scheduleReconnect();
        }
        const sock = deps.connect(got.url);
        live.add(sock);
        const conn: Conn = { sock, superseded: false };
        // (3) One connection settles once: error and close usually arrive as a pair, and reconnecting on
        // each of them would open two connections.
        let settled = false;
        const settle = (reason: string): void => {
          if (settled) return;
          settled = true;
          if (closed || conn.superseded) return; // a planned swap: the old connection's close neither reports nor reconnects
          handlers.onError(reason);
          void scheduleReconnect();
        };
        sock.addEventListener('open', () => {
          if (closed) {
            closeQuietly(sock); // close() arrived while connecting: do not leave an unowned connection
            return void resolve(); // as above: the caller no longer wants this channel, but the promise must not dangle
          }
          attempt = 0; // connected, so reset the backoff; the next disconnect starts from 1s again
          if (everConnected) handlers.onReconnected();
          everConnected = true;
          onOpened?.(); // the new connection is ready -> only now close the old one, leaving no gap
          resolve();
        });
        sock.addEventListener('message', (ev) => onFrame(conn, ev?.data));
        sock.addEventListener('error', () => settle('WebSocket error'));
        sock.addEventListener('close', (ev) => {
          live.delete(sock); // already disconnected, no need to close it (and do not let `live` grow with every reconnect)
          settle(`WebSocket closed code=${ev?.code ?? '?'}`);
        });
      })();
    });
  }

  function onFrame(conn: Conn, data: unknown): void {
    const sock = conn.sock;
    if (typeof data !== 'string') return; // Slack sends text frames only; binary is not ours
    let env: { envelope_id?: string; type?: string; payload?: unknown; reason?: string };
    try {
      env = JSON.parse(data) as typeof env;
    } catch {
      log.warn(`Slack envelope is not valid JSON (skipped): ${data.slice(0, 120)}`);
      return;
    }
    // (1) Ack before handling: an ack later than 3s means redelivery, which means the same button click
    // executes twice.
    if (env.envelope_id) {
      try {
        sock.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch (e) {
        log.warn(`Failed to send the Slack ack (it will be redelivered): ${String(e).slice(0, 120)}`);
      }
    }
    if (env.type === 'hello') return; // the connection greeting, no payload
    if (env.type === 'disconnect') {
      // (2) Normal operation: Slack periodically asks for a connection swap and closes this one after a
      // short grace period. This is **planned**: it does not go through onError (which would report a
      // bogus fault to the core every half hour) and does not go through backoff — build the new
      // connection right now and close the old one once the new one is open. Button clicks lost in a gap
      // cannot be recovered by backfill, so two briefly coexisting connections is the better trade (Slack
      // delivers each event to only one of them, so an overlap does not double-deliver).
      if (conn.superseded) return; // a repeated disconnect on the same connection: a new one is already being built, do not open another
      conn.superseded = true;
      log.info(`Slack requested a connection swap (${env.reason ?? 'disconnect'}) -> building the new connection first, closing the old one once it is up`);
      void open(false, () => closeQuietly(sock)).catch(() => undefined);
      return;
    }
    if (!env.type || typeof env.payload !== 'object' || env.payload === null) return;
    handlers.onEnvelope(env.type, env.payload as Record<string, unknown>);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const wait = backoffMs(attempt++);
    void deps.sleep(wait).then(() => {
      if (closed) return;
      void open(false).catch(() => undefined); // the reconnect path keeps backing off on its own and does not rethrow
    });
  }

  return {
    connect: () => open(true),
    close() {
      closed = true;
      for (const s of [...live]) closeQuietly(s); // the overlap window may hold two; not one may be missed
    },
  };
}
