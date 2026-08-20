// remoteApi——runner 经 HTTP 读写**控制面**状态（GitHub-runner 模式：状态在中心、runner 远程读写）。
// 与 localSqliteStore（store/sessions.ts）实现同一 `SessionStore` 接口；选择点（store/index.ts）按
// FORGE_CONTROL_URL 切（设了=纯 runner，经 HTTP；未设=all-in-one 现状）。照 jobs/remote.ts 的 client/server
// wire 共用范式。
//
// wire 契约：单一 RPC 信封 `POST <base>/store` body `{method, args}` → `{ok:true,result}` | `{ok:false,error}`。
//   · 选 RPC 信封而非逐资源 REST：SessionStore 是**内部 control/runner RPC 接口**（19 方法、非公开资源模型），
//     一个分发点保证 client/server 严格锁步、零路由漂移；新增/改方法只动接口一处，无需手摆一串 endpoint。
//   · 2xx 一律「server 处理过」(result 或业务错误都进信封)；非 2xx 才是真传输/server 崩。故业务错误（非法
//     转移 / UNIQUE 撞索引）走 `ok:false` + 原始 message，**不**用 HTTP 4xx——让 client 重建 Error 后纯谓词仍能分类。
//
// 失败不静默：网络/HTTP 非2xx/坏JSON/非法信封/server 报错 → **抛**（runner 据此知「读写控制面失败」，绝不
// 把失败静默当「无状态」继续）。**保留原始 error message**：故 isDuplicate*Error 这类纯谓词在 client 侧对
// rejected error 仍可分类（只看 message 正则、无 IO）——它们不过网，client 本地跑。
//
// ⚠️ 鉴权/网络暴露属**部署侧**（后续）：本切片是 client + 可挂载的 handler + 往返测试，默认路径（未设
// FORGE_CONTROL_URL）零变更。挂进生产控制面 server + 鉴权见 docs/architecture-control-plane-split.md Phase 2。
import type { Session } from '../types.ts';
import type { State } from '../statemachine/states.ts';
import type { SessionStore, NewSession, EventRow } from './port.ts';
import { isDuplicateTokenError, isDuplicateIssueRefError } from './sessions.ts';

const TIMEOUT_MS = 30_000;

// 可经网络分发的 IO 方法白名单（server 侧据此拒绝任意 method 注入；纯谓词 isDuplicate*Error 不过网 → 不在内）。
export const REMOTE_METHODS = [
  'create', 'findByIssueRef',
  'get', 'getBySlug', 'findByPrdUrl', 'findByDocToken', 'resolve',
  'listByStates', 'listAll', 'distinctProjects', 'countByState', 'countByStates',
  'patch', 'transition', 'appendEvent', 'events', 'lastEventTs',
  'leaseClaim',
] as const;

interface Envelope {
  ok?: boolean;
  result?: unknown;
  error?: string;
}

// runner 客户端：发一个 RPC 调用，回 result（或抛——失败不静默 + 保留原 message）。
async function call(base: string, headers: Record<string, string>, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${base}/store`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`控制面 /store HTTP ${res.status}`);
  let env: Envelope;
  try {
    env = JSON.parse(await res.text()) as Envelope;
  } catch {
    throw new Error('控制面 /store 返回非法 JSON');
  }
  if (!env || typeof env !== 'object') throw new Error('控制面 /store 返回非法信封');
  if (env.ok === false) throw new Error(env.error ?? '控制面 /store 未知错误');
  if (env.ok !== true) throw new Error('控制面 /store 返回非法信封（缺 ok）');
  return env.result;
}

// runner 客户端工厂：baseUrl 末尾斜杠归一（避免 `//store`）。token 给定则带 `Authorization: Bearer <token>`
// （控制面鉴权边界，shared secret）。
export function makeRemoteStore(baseUrl: string, token?: string): SessionStore {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const rpc = <T>(method: string, ...args: unknown[]): Promise<T> => call(base, headers, method, args) as Promise<T>;
  return {
    create: (s: NewSession) => rpc<Session>('create', s),
    findByIssueRef: (ref: string) => rpc<Session | null>('findByIssueRef', ref),
    isDuplicateTokenError, // 纯谓词：对 rejected error 跑 message 正则，client 本地（不过网）。
    isDuplicateIssueRefError,
    get: (id: string) => rpc<Session | null>('get', id),
    getBySlug: (slug: string) => rpc<Session | null>('getBySlug', slug),
    findByPrdUrl: (url: string) => rpc<Session | null>('findByPrdUrl', url),
    findByDocToken: (token: string) => rpc<Session | null>('findByDocToken', token),
    resolve: (idOrSlug: string) => rpc<Session | null>('resolve', idOrSlug),
    listByStates: (states: State[]) => rpc<Session[]>('listByStates', states),
    listAll: (projectId?: string) => rpc<Session[]>('listAll', projectId),
    distinctProjects: () => rpc<string[]>('distinctProjects'),
    countByState: () => rpc<Record<string, number>>('countByState'),
    countByStates: (states: State[]) => rpc<number>('countByStates', states),
    patch: (id: string, fields: Partial<Session>) => rpc<Session>('patch', id, fields),
    transition: (id: string, to: State, fields?: Partial<Session>) => rpc<Session>('transition', id, to, fields),
    appendEvent: (id: string, kind: string, detail?: unknown) => rpc<void>('appendEvent', id, kind, detail),
    events: (id: string) => rpc<EventRow[]>('events', id),
    lastEventTs: (id: string, kind: string) => rpc<number | null>('lastEventTs', id, kind),
    leaseClaim: (states: State[], runnerId: string, ttlMs: number, limit: number) => rpc<Session[]>('leaseClaim', states, runnerId, ttlMs, limit),
  };
}

// 控制面侧：把一个 store RPC 调用分发到本地实现 `impl`，出 wire 信封 JSON（始终 2xx——业务错误也进信封）。
// 绝不信任外部输入：JSON 必须可解析；method 必须在白名单（否则任意方法/原型链注入）；args 必须是数组。
export async function handleStoreCall(impl: SessionStore, body: string): Promise<string> {
  let req: { method?: unknown; args?: unknown };
  try {
    req = (JSON.parse(body) ?? {}) as { method?: unknown; args?: unknown };
  } catch {
    return JSON.stringify({ ok: false, error: '控制面 /store 收到非法 JSON' });
  }
  const { method, args } = req;
  if (typeof method !== 'string' || !(REMOTE_METHODS as readonly string[]).includes(method)) {
    return JSON.stringify({ ok: false, error: `控制面 /store 非法 method: ${String(method)}` });
  }
  if (!Array.isArray(args)) {
    return JSON.stringify({ ok: false, error: '控制面 /store args 非数组' });
  }
  try {
    const fn = impl[method as keyof SessionStore] as unknown as (...a: unknown[]) => unknown;
    const result = await fn(...args);
    return JSON.stringify({ ok: true, result });
  } catch (e) {
    // 业务错误（非法转移 / UNIQUE 撞索引）原样回传 message → client 重建 Error 后 isDuplicate*Error 仍可分类。
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
