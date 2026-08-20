// Runner 身份 + 租约 TTL——多 runner 防重领（lease）的两个参数。中立小模块（只 node:os + process.env，
// 不引任何 hub 模块，避免 mock 脆裂）。localJobSource / control server 共用。
import { hostname } from 'node:os';

// 本 runner 的稳定 id（lease owner）。每进程一个：FORGE_RUNNER_ID 显式覆盖，否则 host:pid。
// 多 runner 各自 id 不同 → 控制面据此把到期 job 分给不同 runner、互不重领。
export const RUNNER_ID = process.env.FORGE_RUNNER_ID || `${hostname()}:${process.pid}`;

// 租约 TTL：一个 runner 持有某 job 不被别 runner 抢走的时长。**必须 ≥ 单 tick 处理一个 job 的最长时间**——
// 否则长 step 跑到一半租约过期、另一 runner 重领 → 同 worktree 双跑（烧钱 + 互踩 git）。
// 默认 7200s（2h，覆盖上游所有 step + 绝大多数下游 step）；重下游（闸C/D 单 step 可能更久）的部署调大
// FORGE_LEASE_TTL_SEC。注：每个 tick 经 leaseClaim 的「自持续租」分支给在跑的 loop session 续租，故**跨 tick
// 不会过期**；唯一未覆盖窗 = 单个超长 step 内（无 tick 边界续租）——故 TTL 取够大即可，rare 边界已文档。
const DEFAULT_LEASE_TTL_SEC = 7200;
export function leaseTtlMs(): number {
  const v = Number(process.env.FORGE_LEASE_TTL_SEC);
  return (Number.isFinite(v) && v > 0 ? v : DEFAULT_LEASE_TTL_SEC) * 1000;
}
