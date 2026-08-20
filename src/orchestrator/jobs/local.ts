// localJobSource——本地 DB 领取 adapter（与 daemon 同进程）。经 SessionStore 接缝（store）原子领取，不直连
// store/sessions.ts；与 JobSource 接缝组合成 control/runner 数据流。
import { store } from '../../store/index.ts';
import { POLLER_DRIVEN } from '../../statemachine/states.ts';
import { RUNNER_ID, leaseTtlMs } from './runner.ts';
import type { JobSource } from './port.ts';

export const localJobSource: JobSource = {
  // 本地：原子领取 POLLER_DRIVEN 态 job（lease 防多 runner 重领），FIFO 取至多 limit 条（=本轮并发容量）。
  // 单 runner 时：每 tick 领 ≤limit 条、本轮跑完，下个 tick 续领——与旧「整批 listByStates + runLimited 分波」吞吐等价
  // （tick 锁本就串行、runLimited 本就分波），仅多写 lease 列（不 bump updated_at）。
  claimDueJobs: async (limit: number) => store.leaseClaim([...POLLER_DRIVEN], RUNNER_ID, leaseTtlMs(), limit),
};
