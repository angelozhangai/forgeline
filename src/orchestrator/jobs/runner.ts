// The runner's identity and the lease TTL - the two parameters behind the lease that stops several runners
// claiming the same job. A deliberately neutral little module (only node:os and process.env, importing no hub
// module, so mocking it stays robust). Shared by localJobSource and the control server.
import { hostname } from 'node:os';

// This runner's stable id (the lease owner). One per process: FORGE_RUNNER_ID overrides it explicitly,
// otherwise it is host:pid.
// Several runners have different ids, so the control plane hands due jobs to different runners and none of them
// claim the same job.
export const RUNNER_ID = process.env.FORGE_RUNNER_ID || `${hostname()}:${process.pid}`;

// The lease TTL: how long a runner holds a job before another runner may take it. It **must be at least as
// long as the longest a single job takes in one tick** - otherwise a long step's lease expires halfway through,
// another runner re-claims it, and the same worktree runs twice (burning money and both sides fighting over
// git).
// The default is 7200s (2 hours, which covers every upstream step and nearly every downstream one); a
// deployment with heavy downstream work (a single Gate C or D step can run longer) should raise
// FORGE_LEASE_TTL_SEC. Note that every tick renews the lease for a running loop session through leaseClaim's
// self-held branch, so a lease **never expires across ticks**; the only uncovered window is inside one
// exceptionally long step (where no tick boundary renews it) - hence a generously large TTL, with that rare
// edge documented here.
const DEFAULT_LEASE_TTL_SEC = 7200;
export function leaseTtlMs(): number {
  const v = Number(process.env.FORGE_LEASE_TTL_SEC);
  return (Number.isFinite(v) && v > 0 ? v : DEFAULT_LEASE_TTL_SEC) * 1000;
}
