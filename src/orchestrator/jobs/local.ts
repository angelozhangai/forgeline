// localJobSource - the adapter that claims from the local DB (in the same process as the daemon). It claims
// atomically through the SessionStore seam (`store`) rather than importing store/sessions.ts directly, and
// together with the JobSource seam it forms the control/runner data flow.
import { store } from '../../store/index.ts';
import { POLLER_DRIVEN } from '../../statemachine/states.ts';
import { RUNNER_ID, leaseTtlMs } from './runner.ts';
import type { JobSource } from './port.ts';

export const localJobSource: JobSource = {
  // Locally: atomically claim jobs in a POLLER_DRIVEN state (the lease stops several runners claiming the same
  // one), taking at most `limit` of them FIFO (that being this round's concurrency capacity).
  // With a single runner: each tick claims at most `limit`, runs them, and the next tick claims more - which is
  // throughput-equivalent to the old "listByStates for the whole batch + runLimited in waves" (the tick lock
  // already serialises ticks and runLimited already worked in waves). The only difference is writing the lease
  // columns, which does not bump updated_at.
  claimDueJobs: async (limit: number) => store.leaseClaim([...POLLER_DRIVEN], RUNNER_ID, leaseTtlMs(), limit),
};
