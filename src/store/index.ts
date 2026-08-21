// 状态层薄缝——**存储后端选择点（唯一接线处）**。
// 核心（gates/worker/actions/daemon…）只 `import { store } from './store/index.ts'`，永不直接依赖 store/sessions.ts。
//
// 后端按 FORGE_CONTROL_URL 切（与 jobs/index.ts 同风格，模块加载即定）：
//   · 设了 → 本进程是**纯 runner**：经 HTTP 读写远端控制面状态（remoteApi）。
//   · 未设 → **all-in-one**：本地 sqlite（现状，行为不变）。
//
// 选好的后端再包一层**扩展钩子装饰器**（withTransitionHook）：全仓 40 处 `.transition(` 调用点本就
// 全部收敛在这一个方法上，所以生命周期钩子在这里装一次就覆盖全部，调用点一行都不用改。
import { localSqliteStore } from './sessions.ts';
import { makeRemoteStore } from './remote.ts';
import { hooks, fireTransition } from '../ext/index.ts';
import type { SessionStore } from './port.ts';

/**
 * 给 transition 挂上扩展钩子。**未装扩展时是零开销直通**——连查旧态的那次读都不发生，
 * 所以纯 OSS 路径与引入本装饰器之前逐字节一致（远端后端下那会是一次多余的 HTTP 往返，不能白付）。
 *
 * 钩子在 transition **成功之后**才发：失败的转移（状态机守门抛错）不产生事件，
 * 否则下游会收到一个从未发生过的流转。查旧态失败按 from=null 处理，绝不因此挡住转移本身。
 *
 * 导出是为了能拿假 store 直接测这三条语义（发在成功之后 / 未装钩子零开销 / 旧态查不到不挡路）。
 * 走真 sqlite 测会把这些语义和建表迁移、状态机守门混在一起，失败时分不清是谁的锅。
 */
export function withTransitionHook(inner: SessionStore): SessionStore {
  return {
    ...inner,
    async transition(id, to, fields) {
      if (!hooks()?.onTransition) return inner.transition(id, to, fields);
      const before = await inner.get(id).catch(() => null);
      const s = await inner.transition(id, to, fields);
      await fireTransition({ id, from: before?.state ?? null, to, at: Date.now() });
      return s;
    },
  };
}

const controlUrl = process.env.FORGE_CONTROL_URL;
export const store: SessionStore = withTransitionHook(
  controlUrl ? makeRemoteStore(controlUrl, process.env.FORGE_CONTROL_TOKEN) : localSqliteStore,
);
export { makeRemoteStore, handleStoreCall, REMOTE_METHODS } from './remote.ts';
export type { SessionStore, NewSession, EventRow } from './port.ts';
