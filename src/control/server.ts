// 控制面 HTTP server——把 runner 拉 job(/jobs) 与读写状态(/store) 的 wire 端点对外服务。
// 这是「control plane / runner 分离」里**控制面进程**的最小可运行体：runner（设了 FORGE_CONTROL_URL）经它
// 拉到期 job + 读写中心 session 状态。**独立于** health/server.ts（那是 runner 本地 127.0.0.1 状态页/探针）。
//
//   GET  /healthz                  → 200 'ok'（**无鉴权**廉价探活，给 LB/runner 探）
//   GET  /jobs?runner=<id>&limit=N → 原子领取该 runner 的到期 job（lease；FIFO 至多 N 条）        【需鉴权】
//   POST /store                    → SessionStore RPC 信封（handleStoreCall(store, body)）         【需鉴权】
//
// **鉴权边界（shared secret）**：配了 token 则 /jobs+/store 要 `Authorization: Bearer <token>`
// （timingSafeEqual 定长比较，防时序侧信）→ 否则 401。/healthz 不鉴权（纯存活探针）。
// **fail-closed 两道**：
//   ① 绑**非回环**地址却**无 token** → 启动即抛（无鉴权把读写全部 session 状态对网络开放=灾难）。回环允许无 token（本机开发）。
//   ② 进程设了 **FORGE_CONTROL_URL**（=runner 标记）→ 启动即抛：控制面进程必须直连本地 sqlite，绝不把读写
//      代理到别处（否则 store/jobSource 选择点会变远端，控制面对着空气服务）。本守门保证 `store`/`jobSource` 恒为本地实现。
//
// **lease（多 runner 防重领，深水⑥）**：/jobs 经 `store.leaseClaim([...POLLER_DRIVEN], runner, ttl)` 原子领取——
// 把到期 job 占租给 `?runner=<id>` 标识的 runner，别的 runner 同刻拉只能拿到无主/过期的剩余 job，绝不重领同一个。
// runner 死亡 → 租约过期后另一 runner 可重领。缺 `?runner` → 用控制面自己的 RUNNER_ID（loopback/单 runner 兜底）。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../util/log.ts';
import { loadConfig } from '../config.ts';
import { store, handleStoreCall } from '../store/index.ts';
import { POLLER_DRIVEN } from '../statemachine/states.ts';
import { RUNNER_ID, leaseTtlMs } from '../orchestrator/jobs/index.ts';

const JSONT = 'application/json; charset=utf-8';
const MAX_BODY = 1_000_000; // /store 请求体上限：session patch 信封最多几 KB，1MB 极宽松（防内存炸）。
const MAX_CLAIM = 512; // 单次 /jobs 占租上限：防 buggy/恶意 runner 一把把整个 backlog 占租走。

// 请求方 runner 的本轮并发容量（?limit）。缺省/非法 → 控制面自身 max_parallel；一律钳到 [1, MAX_CLAIM]。
function claimLimit(raw: string | null): number {
  const n = Number(raw);
  const want = Number.isFinite(n) && n >= 1 ? Math.floor(n) : loadConfig().runtime.max_parallel;
  return Math.min(Math.max(1, want), MAX_CLAIM);
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// 鉴权：配了 token 才校验（无 token 仅回环放行，由 startControlServer fail-closed① 守门）。
// 定长 timingSafeEqual：长度不等先短路（长度本身非秘密），等长再常数时间比较，防按字节时序爆破 token。
function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

// 累积请求体，超上限即断（绝不无界缓冲）。
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!aborted) resolve(body);
    });
    req.on('error', reject);
  });
}

export interface ControlServerOpts {
  port: number;
  host?: string; // 默认 127.0.0.1（回环安全默认）
  token?: string; // shared secret；绑非回环必须给
}

// 返回 **Promise<Server>**：绑定就绪(listening)→resolve；**listening 前绑定出错(EADDRINUSE 等)→reject**——
// 控制面 HTTP 是「控制面进程」存在的理由，绑不上即半启动（tick/health 看着活、但额外 runner 的 /jobs+/store 不可用），
// 必须 fail-fast 让调用方（listen/control）拿不到 HTTP 面就退出，绝不静默以「无控制面」形态活着。listening 后的运行期
// 错误只 warn（不撤已起的服务）。两道 fail-closed 守门是**同步 throw**（在返回 Promise 前）：误配即刻炸，调用方
// `await` 同步抛、测试 `assert.throws` 可捕。
export function startControlServer(opts: ControlServerOpts): Promise<Server> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token || undefined;
  // fail-closed②：控制面进程不应是 runner——设了 FORGE_CONTROL_URL 则 store/jobSource 选择点会指向远端。
  if (process.env.FORGE_CONTROL_URL) {
    throw new Error('控制面进程不应设 FORGE_CONTROL_URL（那是 runner 标记）：会让 store/jobSource 代理到别处，控制面对着空气服务');
  }
  // fail-closed①：非回环 + 无 token = 拒绝启动（绝不无鉴权把读写全部状态暴露到网络）。
  if (!isLoopback(host) && !token) {
    throw new Error(`拒绝在非回环地址 ${host} 无鉴权启动控制面：/store 可读写全部 session 状态，必须配 FORGE_CONTROL_TOKEN`);
  }
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = url.pathname;
        if (req.method === 'GET' && path === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
        // 以下端点需鉴权。
        if (!authorized(req, token)) return send(res, 401, JSONT, JSON.stringify({ ok: false, error: '未授权（缺/错 Bearer token）' }));
        if (req.method === 'GET' && path === '/jobs') {
          const runner = url.searchParams.get('runner') || RUNNER_ID; // 缺省=控制面自身 id（loopback/单 runner 兜底）
          const limit = claimLimit(url.searchParams.get('limit')); // 本 runner 本轮容量（FIFO 至多 limit 条）
          const jobs = await store.leaseClaim([...POLLER_DRIVEN], runner, leaseTtlMs(), limit);
          return send(res, 200, JSONT, JSON.stringify(jobs));
        }
        if (req.method === 'POST' && path === '/store') return send(res, 200, JSONT, await handleStoreCall(store, await readBody(req)));
        return send(res, 404, JSONT, JSON.stringify({ ok: false, error: 'not found' }));
      } catch (e) {
        try {
          send(res, 500, JSONT, JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
        } catch {
          /* 响应已发出 */
        }
      }
    })();
  });
  return new Promise<Server>((resolve, reject) => {
    let listening = false;
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (listening) {
        log.warn(`控制面 server 运行期出错：${String(e).slice(0, 160)}`); // 已起后的错误不撤服务
        return;
      }
      const why = e.code === 'EADDRINUSE' ? `端口 ${opts.port} 被占用` : String(e).slice(0, 160);
      reject(new Error(`控制面 HTTP 绑定失败（${why}）→ 拒绝以「无控制面」形态启动`));
    });
    server.listen(opts.port, host, () => {
      listening = true;
      log.ok(`控制面已起：http://${host}:${opts.port}/（/jobs /store /healthz）· ${token ? '鉴权 on' : '回环·无鉴权'}`);
      resolve(server);
    });
  });
}
