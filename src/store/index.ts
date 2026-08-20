// 状态层薄缝——**存储后端选择点（唯一接线处）**。
// 核心（gates/worker/actions/daemon…）只 `import { store } from './store/index.ts'`，永不直接依赖 store/sessions.ts。
//
// 后端按 FORGE_CONTROL_URL 切（与 jobs/index.ts 同风格，模块加载即定）：
//   · 设了 → 本进程是**纯 runner**：经 HTTP 读写远端控制面状态（remoteApi）。
//   · 未设 → **all-in-one**：本地 sqlite（现状，行为不变）。
import { localSqliteStore } from './sessions.ts';
import { makeRemoteStore } from './remote.ts';
import type { SessionStore } from './port.ts';

const controlUrl = process.env.FORGE_CONTROL_URL;
export const store: SessionStore = controlUrl ? makeRemoteStore(controlUrl, process.env.FORGE_CONTROL_TOKEN) : localSqliteStore;
export { makeRemoteStore, handleStoreCall, REMOTE_METHODS } from './remote.ts';
export type { SessionStore, NewSession, EventRow } from './port.ts';
