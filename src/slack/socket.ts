// Slack provider 层——**Socket Mode 长连接**。零新依赖：apps.connections.open 换 wss URL，
// 再用 Node 原生 WebSocket（≥22 内置，本仓要求 ≥24）连上去。跟飞书那边用 lark SDK 是对等的一层。
//
// 手搓要正确处理的就四件事，全在下面：
//   ① 每条带 envelope_id 的信封**必须立刻 ack**，否则 Slack 3 秒后重投，业务动作会被执行两次；
//   ② Slack 会定期主动发 type:'disconnect'（refresh_requested）并随后断开——这是常态，不是故障。
//      两条推论：**不报错**（报了核心就 markWs(false)+log.err，每半小时一次假警报），
//      且**先建新连接再关旧的**——中间留空窗的话，落在窗口里的按钮点击就没了：
//      群消息还能靠重连后的补拉捞回来，interactive 载荷捞不回来；
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

// 一条连接的私有状态。superseded = 「它已经被一条新连接接住了」——那它之后的断开是**计划内**的：
// 不该报错，也不该再触发一次重连（否则一次换连接会开出两条，每条信封收两遍）。
interface Conn {
  sock: WsLike;
  superseded: boolean;
}

export function createSocketChannel(handlers: SocketHandlers, overrides: Partial<SocketDeps> = {}): SocketChannel {
  const deps: SocketDeps = { ...defaultDeps, ...overrides };
  let ws: WsLike | null = null;
  let closed = false; // 调用方显式 close() 之后不再重连
  let attempt = 0;
  let everConnected = false;

  function closeQuietly(sock: WsLike): void {
    try {
      sock.close();
    } catch {
      /* 已经断了 */
    }
  }

  // 起一条连接。首连（first=true）把失败原样 reject 交给核心；重连则自行退避重试。
  // onOpened：新连接**真的连上之后**才执行的收尾（换连接时用来关掉旧的那条）。
  function open(first: boolean, onOpened?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        const got = await deps.openUrl();
        if (closed) return; // 等 openUrl 期间调用方关了通道 → 不再往下建连接
        if (!got.ok || !got.url) {
          const reason = `apps.connections.open 失败：${got.error ?? '无 url'}`;
          if (first) return reject(new Error(reason));
          handlers.onError(reason);
          return void scheduleReconnect();
        }
        const sock = deps.connect(got.url);
        ws = sock;
        const conn: Conn = { sock, superseded: false };
        // ③ 一次连接只结算一次：error 与 close 常常成对出现，各触发一次重连就会开出两条连接。
        let settled = false;
        const settle = (reason: string): void => {
          if (settled) return;
          settled = true;
          if (closed || conn.superseded) return; // 计划内换连接：旧连接的断开既不报错也不再重连
          handlers.onError(reason);
          void scheduleReconnect();
        };
        sock.addEventListener('open', () => {
          if (closed) return void closeQuietly(sock); // 建连过程中被 close()：别留一条没人管的连接
          attempt = 0; // 连上了就把退避清零，下次断开重新从 1s 起
          if (everConnected) handlers.onReconnected();
          everConnected = true;
          onOpened?.(); // 新连接已就绪 → 这时才关旧连接，中间不留空窗
          resolve();
        });
        sock.addEventListener('message', (ev) => onFrame(conn, ev?.data));
        sock.addEventListener('error', () => settle('WebSocket error'));
        sock.addEventListener('close', (ev) => settle(`WebSocket closed code=${ev?.code ?? '?'}`));
      })();
    });
  }

  function onFrame(conn: Conn, data: unknown): void {
    const sock = conn.sock;
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
      // ② 常态：Slack 定期要求换连接，并在短暂宽限后断开这一条。这是**计划内**的：
      // 不走 onError（否则核心每半小时被报一次假故障），也不走退避——直接现在就建新连接，
      // 等新连接 open 了再关旧的。空窗期丢掉的按钮点击是补拉捞不回来的，所以宁可短暂两条并存
      //（Slack 把每条事件只投给其中一条，重叠不会重复投递）。
      if (conn.superseded) return; // 同一条连接上重复收到 disconnect：新连接已在建，别再开一条
      conn.superseded = true;
      log.info(`Slack 要求换连接（${env.reason ?? 'disconnect'}）→ 先建新连接，连上后再关旧的`);
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
      void open(false).catch(() => undefined); // 重连路径自己会继续退避，不再向上抛
    });
  }

  return {
    connect: () => open(true),
    close() {
      closed = true;
      if (ws) closeQuietly(ws);
    },
  };
}
