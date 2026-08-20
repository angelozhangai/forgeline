// remotePull——runner 经 HTTP 从**控制面**拉到期 job（GitHub-runner 模式：runner 先向控制面要 job）。
// 与 localJobSource（同进程 DB 枚举）实现同一 JobSource 接口；选择点（jobs/index.ts）按 FORGE_CONTROL_URL 切。
//
// wire 契约：控制面 `GET /jobs` → 到期 session 的 JSON 数组（POLLER_DRIVEN 态）。client（runner）与 server
// （控制面）共用本文件的序列化/解析，保证两端对齐。控制面侧用 `dueJobsPayload(localJobSource)` 出 payload
// （待挂进控制面 HTTP server，本切片先备好 + 往返测试验证；生产挂载是后续）。
//
// 失败不静默：网络/HTTP 非 2xx/坏 JSON/非法 job → **抛**。runner 据此知道「拉不到 job」，绝不把拉取失败
// 静默当成「无活」而空转睡过去（那会让所有需求静默卡死）。
import type { Session } from '../../types.ts';
import type { JobSource } from './port.ts';

const TIMEOUT_MS = 30_000;

// 控制面侧：把本地到期 job 序列化成 wire payload（JSON 数组）。limit = 请求方 runner 的本轮容量。
export async function dueJobsPayload(src: JobSource, limit: number): Promise<string> {
  return JSON.stringify(await src.claimDueJobs(limit));
}

// 解析 + 轻校验 wire payload（绝不信任外部输入：非数组 / job 缺 id|state → 抛，不静默放过坏数据）。
function parseJobs(text: string): Session[] {
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('控制面 /jobs 返回非法 JSON');
  }
  if (!Array.isArray(arr)) throw new Error('控制面 /jobs 返回非数组');
  for (const j of arr) {
    if (!j || typeof (j as Session).id !== 'string' || typeof (j as Session).state !== 'string') {
      throw new Error('控制面 /jobs 含非法 job（缺 id/state）');
    }
  }
  return arr as Session[];
}

// runner 客户端：从 baseUrl 拉到期 job。baseUrl 末尾斜杠归一（避免 `//jobs`）。token 给定则带
// `Authorization: Bearer <token>`（控制面鉴权边界，shared secret）。runnerId 给定则 `?runner=<id>`——控制面据此
// 把租约记在本 runner 名下（多 runner 防重领）；缺省则控制面用自己的 RUNNER_ID（loopback/单 runner 兜底）。
export function makeRemoteJobSource(baseUrl: string, token?: string, runnerId?: string): JobSource {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const runnerQs = runnerId ? `runner=${encodeURIComponent(runnerId)}` : '';
  return {
    claimDueJobs: async (limit: number) => {
      // limit 本轮并发容量随请求带上 → 控制面据此 FIFO 占租至多 limit 条给本 runner（多 runner 分摊 backlog）。
      const qs = [runnerQs, `limit=${encodeURIComponent(String(limit))}`].filter(Boolean).join('&');
      const res = await fetch(`${base}/jobs?${qs}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`控制面 /jobs HTTP ${res.status}`);
      return parseJobs(await res.text());
    },
  };
}
