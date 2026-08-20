// 控制面 / Runner 边界——**JobSource 选择点（唯一接线处）**。
// worker.tick 只 `import { jobSource }`，永不直接 DB 枚举到期 job。
//
// 后端按 FORGE_CONTROL_URL 切（与 root.ts 读 FORGE_* infra env 同风格，模块加载即定）：
//   · 设了 → 本进程是**纯 runner**：经 HTTP 从远端控制面拉 job（remotePull）。
//   · 未设 → **all-in-one**：本地 DB 枚举（现状，行为不变）。
import { localJobSource } from './local.ts';
import { makeRemoteJobSource } from './remote.ts';
import { RUNNER_ID } from './runner.ts';
import type { JobSource } from './port.ts';

const controlUrl = process.env.FORGE_CONTROL_URL;
// 纯 runner：带本机 RUNNER_ID 拉 job（控制面据此把租约记在本 runner 名下、与别的 runner 分开领）。
export const jobSource: JobSource = controlUrl ? makeRemoteJobSource(controlUrl, process.env.FORGE_CONTROL_TOKEN, RUNNER_ID) : localJobSource;
export { makeRemoteJobSource, dueJobsPayload } from './remote.ts';
export { RUNNER_ID, leaseTtlMs } from './runner.ts';
export type { JobSource } from './port.ts';
