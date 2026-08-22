// Slack provider 层——**Socket Mode 长连接**。零新依赖：apps.connections.open 换 wss URL，
// 再用 Node 原生 WebSocket（≥22 内置，本仓要求 ≥24）连上去。跟飞书那边用 lark SDK 是对等的一层。
//
// 手搓要正确处理的就四件事，全在下面：
//   ① 每条带 envelope_id 的信封**必须立刻 ack**，否则 Slack 3 秒后重投，业务动作会被执行两次；
//   ② Slack 会定期主动发 type:'disconnect'（refresh_requested）并随后断开——这是常态，不是故障；
//   ③ 硬断时原生 WebSocket 会**先 error 再 close**（本地 spike 实测：open→…→error→close:1006），
//      两个事件都触发重连的话会开出两条连接，于是每条信封收两遍。故一次连接只允许结算一次。
//   ④ 首连失败要如实 reject（交核心决定降级为仅周期 tick），重连失败则退避重试、绝不放弃。
//
// 依赖全部可注入（openUrl / connect / sleep），所以上面这套状态机能在**没有网络、没有 Slack 工作区**
// 的情况下被单测钉死。这正是它值得手写的前提：不可测的手写长连接才是负债。
//
// 只允许 messaging/slack.ts 使用（架构边界闸守着）。
import { log } from '../util/log.ts';
import { appToken } from './web.ts';
import { slackApi } from './web.ts';

// 我们只用到 WebSocket 的这几件事——收窄成最小接口，测试才能塞假的进来。
export interface WsLike {
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SocketHandlers {
  // 一条已 ack 的信封：type 是 Slack 的信封类型（events_api / interactive / slash_commands），payload 是原始载荷。
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

// 退避：1s → 2s → 4s … 封顶 60s。导出供单测直接断言（重连节奏错了会把工作区打成 429）。
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

export function createSocketChannel(handlers: SocketHandlers, overrides: Partial<SocketDeps> = {}): SocketChannel {
  const deps: SocketDeps = { ...defaultDeps, ...overrides };
  let ws: WsLike | null = null;
  let closed = false; // 调用方显式 close() 之后不再重连
  let attempt = 0;
  let everConnected = false;

  // 起一条连接。首连（first=true）把失败原样 reject 交给核心；重连则自行退避重试。
  function open(first: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        const got = await deps.openUrl();
        if (!got.ok || !got.url) {
          const reason = `apps.connections.open 失败：${got.error ?? '无 url'}`;
          if (first) return reject(new Error(reason));
          handlers.onError(reason);
          return void scheduleReconnect();
        }
        const sock = deps.connect(got.url);
        ws = sock;
        // ③ 一次连接只结算一次：error 与 close 常常成对出现，各触发一次重连就会开出两条连接。
        let settled = false;
        const settle = (reason: string): void => {
          if (settled) return;
          settled = true;
          if (closed) return;
          handlers.onError(reason);
          void scheduleReconnect();
        };
        sock.addEventListener('open', () => {
          attempt = 0; // 连上了就把退避清零，下次断开重新从 1s 起
          if (everConnected) handlers.onReconnected();
          everConnected = true;
          resolve();
        });
        sock.addEventListener('message', (ev) => onFrame(sock, ev?.data));
        sock.addEventListener('error', () => settle('WebSocket error'));
        sock.addEventListener('close', (ev) => settle(`WebSocket closed code=${ev?.code ?? '?'}`));
      })();
    });
  }

  function onFrame(sock: WsLike, data: unknown): void {
    if (typeof data !== 'string') return; // Slack 只发文本帧；二进制不是我们的东西
    let env: { envelope_id?: string; type?: string; payload?: unknown; reason?: string };
    try {
      env = JSON.parse(data) as typeof env;
    } catch {
      log.warn(`Slack 信封不是合法 JSON（已跳过）：${data.slice(0, 120)}`);
      return;
    }
    // ① 先 ack 再处理：ack 迟于 3s 就会被重投，那意味着同一个按钮点击被执行两次。
    if (env.envelope_id) {
      try {
        sock.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch (e) {
        log.warn(`Slack ack 发送失败（会被重投）：${String(e).slice(0, 120)}`);
      }
    }
    if (env.type === 'hello') return; // 建连问候，无载荷
    if (env.type === 'disconnect') {
      // ② 常态：Slack 定期要求换连接。这是**计划内**的，别当错误报警——但确实要重连。
      log.info(`Slack 要求换连接（${env.reason ?? 'disconnect'}）→ 重连`);
      try {
        sock.close();
      } catch {
        /* 已经断了 */
      }
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
      void open(false).catch(() => undefined); // 重连路径自己会继续退避，不再向上抛
    });
  }

  return {
    connect: () => open(true),
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* 已经断了 */
      }
    },
  };
}
