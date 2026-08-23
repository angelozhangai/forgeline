// remotePull - a runner pulls due jobs from the **control plane** over HTTP (the GitHub-runner model: the
// runner asks the control plane for work first).
// It implements the same JobSource interface as localJobSource (which enumerates the DB in-process); the
// selection point (jobs/index.ts) switches on FORGE_CONTROL_URL.
//
// The wire contract: the control plane's `GET /jobs` returns a JSON array of due sessions (those in a
// POLLER_DRIVEN state). The client (runner) and the server (control plane) share this file's serialisation and
// parsing, which keeps both ends aligned. The control-plane side produces its payload with
// `dueJobsPayload(localJobSource)`.
//
// No silent failures: a network error, a non-2xx, broken JSON or a malformed job all **throw**. That is how the
// runner knows "no jobs could be pulled" and never silently treats a failed pull as "there is no work" and
// sleeps through it (which would stall every requirement without a symptom).
import type { Session } from '../../types.ts';
import type { JobSource } from './port.ts';

const TIMEOUT_MS = 30_000;

// The control-plane side: serialise the local due jobs into the wire payload (a JSON array). limit is the
// requesting runner's capacity for this round.
export async function dueJobsPayload(src: JobSource, limit: number): Promise<string> {
  return JSON.stringify(await src.claimDueJobs(limit));
}

// Parse and lightly validate the wire payload (external input is never trusted: anything that is not an array,
// or a job missing id or state, throws rather than letting bad data through silently).
function parseJobs(text: string): Session[] {
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('control plane /jobs returned invalid JSON');
  }
  if (!Array.isArray(arr)) throw new Error('control plane /jobs did not return an array');
  for (const j of arr) {
    if (!j || typeof (j as Session).id !== 'string' || typeof (j as Session).state !== 'string') {
      throw new Error('control plane /jobs returned an invalid job (id or state is missing)');
    }
  }
  return arr as Session[];
}

// The runner client: pull due jobs from baseUrl. Trailing slashes on baseUrl are normalised away (so it never
// requests `//jobs`). When a token is given it sends `Authorization: Bearer <token>` (the control plane's
// authentication boundary, a shared secret). When a runnerId is given it appends `?runner=<id>`, so the control
// plane records the lease under this runner; without one the control plane uses its own RUNNER_ID (the
// loopback / single-runner fallback).
export function makeRemoteJobSource(baseUrl: string, token?: string, runnerId?: string): JobSource {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const runnerQs = runnerId ? `runner=${encodeURIComponent(runnerId)}` : '';
  return {
    claimDueJobs: async (limit: number) => {
      // This round's concurrency capacity travels with the request, so the control plane leases at most `limit`
      // jobs FIFO to this runner (which is what spreads the backlog across runners).
      const qs = [runnerQs, `limit=${encodeURIComponent(String(limit))}`].filter(Boolean).join('&');
      const res = await fetch(`${base}/jobs?${qs}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`control plane /jobs returned HTTP ${res.status}`);
      return parseJobs(await res.text());
    },
  };
}
