// Who may hold a device's WebSocket -- the P1 seam that P2 (#51) replaces.
//
// P1 has no device authentication yet. So that the skeleton can be exercised end to end, an unauthenticated
// connection is admitted in exactly one case: FORGELINE_ENV is the exact string "dev". Everything else --
// "prod", a typo, a different case, an empty or missing value -- is refused. That is the "refused in prod by
// construction" of docs/cloud-agent.md section 12: there is no code path that accepts an unauthenticated
// socket in prod, rather than a path that a prod flag switches off.
//
// Both the Worker (before it wakes a Durable Object) and DeviceHub (before it accepts) call this. The Hub's
// check is not redundant: it is the code that actually accepts, so it must not depend on every future route
// having remembered to check first.
//
// P2 deletes `unauthenticatedDev` and puts the challenge-response handshake (section 3.1, 5.5) here. Until
// then, grep for `admit(` to find every place that decides.
import { type Env, environmentOf } from './env.ts';

export type Admission = { ok: true; mode: 'unauthenticated-dev' } | { ok: false; reason: string };

export function admit(env: Pick<Env, 'FORGELINE_ENV'>): Admission {
  if (environmentOf(env) === 'dev') return { ok: true, mode: 'unauthenticated-dev' };
  return { ok: false, reason: 'device authentication is not implemented yet, and unauthenticated connections are accepted only in the dev environment' };
}
