// The thin seam at the control-plane / runner boundary - **JobSource**: *where* a runner gets its next batch of
// due jobs from.
// It follows the MessagingPort / SessionStore pattern: the interface (this file) + a single selection point
// (`jobSource` in jobs/index.ts) + an adapter (local = enumerating the DB).
// The core (worker.tick) only does `import { jobSource }` and never enumerates due jobs from the DB itself;
// switching to remotePull is a one-line change at the selection point.
//
// A **job** is "one due session that needs its next gate step run". The runner runs worker.step(s) for each
// job, and the result is **written back through the SessionStore seam (store)** - so JobSource (pulling jobs)
// and SessionStore (reporting back) together form the complete control/runner data flow: the control plane
// hands out jobs, the runner executes them, and the state returns to the centre.
//
// Implementations: `localJobSource` (enumerating the local DB, in the same process as the daemon) and
// `remotePull` (a runner pulling jobs from the control plane over HTTP).
//
// **The async contract**: `claimDueJobs` returns a Promise - pulling a job is the **first action** in a remote
// runner's loop (the GitHub-runner model: the runner asks the control plane for work first), so it was made
// async first (it has a single consumer, worker.tick, which was already async, so behaviour was unchanged).
// The local implementation wraps a synchronous store call with no side effects. Making SessionStore (the
// reporting side) async was the larger migration that followed - see
// docs/architecture-control-plane-split.md.
import type { Session } from '../../types.ts';

export interface JobSource {
  // Claim this round's due jobs (sessions in a POLLER_DRIVEN state) with an **atomic lease**, so several
  // runners cannot claim the same one. Locally this is a direct DB leaseClaim; remotely it is the control
  // plane's HTTP `GET /jobs?runner=&limit=` (which calls leaseClaim on the control-plane side).
  // limit = this runner's concurrency capacity for the round (the worker passes max_parallel): it claims only
  // what will actually start running this round, and never leases the whole backlog at once (otherwise queued
  // jobs would count down their TTL, be treated as expired by another runner and re-claimed -> the same
  // worktree runs twice; and the backlog would not spread across runners). See store leaseClaim.
  claimDueJobs(limit: number): Promise<Session[]>;
}
