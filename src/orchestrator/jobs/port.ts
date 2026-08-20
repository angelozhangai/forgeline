// 控制面 / Runner 边界薄缝——**JobSource**：runner 从「哪里」取一批到期 job 来执行。
// 照 MessagingPort / SessionStore 范式：接口（本文件）+ 单一选择点（jobs/index.ts `jobSource`）+ adapter（local=DB 枚举）。
// 核心（worker.tick）只 `import { jobSource }`，永不直接 DB 枚举到期 job；换 remotePull 在选择点一处换。
//
// 一个 **job** = 「一条到期、需推进下一步 gate 的 session」。runner 对每个 job 跑 worker.step(s)，结果经
// **SessionStore 接缝（store）写回**——故 JobSource(拉 job) + SessionStore(回报) 两个接缝合成完整的 control/runner
// 数据流（控制面出 job、runner 执行、状态回中心）。
//
// 实现：`localJobSource`（本地 DB 枚举，与 daemon 同进程）/ `remotePull`（runner 经 HTTP 从控制面拉 job）。
//
// **异步契约（Phase 2 深水）**：`claimDueJobs` 返回 Promise——job-pull 是 runner 远端循环的**第一个动作**
// （GitHub-runner 模式：runner 先向控制面要 job），故率先 async 化（仅 1 个消费方 worker.tick、本就 async，
// 零行为变更）。本地实现 `await store.listByStates(...)` 同步底层无副作用。SessionStore（回报侧）的 async 化是
// 更大迁移（277 调用点），随后跟进——见 docs/architecture-control-plane-split.md Phase 2。
import type { Session } from '../../types.ts';

export interface JobSource {
  // 认领本轮到期 job（POLLER_DRIVEN 态的 session）：**原子 lease 占租**（防多 runner 重领）。本地=直连 DB leaseClaim；
  // 远端=控制面 HTTP `/jobs?runner=&limit=`（控制面侧 leaseClaim）。
  // limit = 本 runner 本轮并发容量（worker 传 max_parallel）：只认领这一轮就会开跑的量，绝不一次占租整个 backlog
  // （否则排队未开跑的 job 也倒 TTL → 被另一 runner 当过期重领 → 同 worktree 双跑；且 backlog 不分摊）。见 store leaseClaim。
  claimDueJobs(limit: number): Promise<Session[]>;
}
