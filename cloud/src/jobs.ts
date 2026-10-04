// Jobs as the Hub queues them: validation, limits and the kill switch (docs/cloud-agent.md sections 5.7, 5.8,
// 5.11, 6 and 10.3). Delivery is not here yet: a job goes to a device as a signed `job` frame after `welcome`,
// and P1 has neither the handshake nor a signing key. Until P2 the queue only fills, expires, and is audited.
import { log } from './log.ts';
import type { Env } from './env.ts';
import { ULID_RE } from './ids.ts';
import * as b64 from './wire/base64url.ts';
import { CanonicalError, canonicalize } from './wire/canonical.ts';
import { MAX_FRAME_BYTES } from './wire/frame.ts';

// The catalogue of section 6.1. A kind outside it is refused at the door, never queued "for later".
export const JOB_KINDS = ['session.reply', 'session.start', 'permission.answer', 'device.pause', 'keys.update'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// Pending jobs per device in the Hub (section 5.11). Past this the Hub refuses new ones rather than evicting
// old ones: an evicted job would be a silently dropped instruction.
export const MAX_PENDING_JOBS = 100;
// `params.text` / `params.prompt` (section 5.11), counted in Unicode code points so the Rust agent, which
// counts `chars()`, reaches the same number.
export const MAX_TEXT_CHARS = 4_000;
// The longest a job may live. The device deduplicates by job_id against a journal it keeps for 24 hours
// (section 5.7); a job delivered later than that could run twice, because the device no longer remembers it.
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
// Room left in a frame for the envelope around the job body (type, ids, kid, signature: about 300 bytes).
const ENVELOPE_OVERHEAD_BYTES = 1_024;

export interface JobInput {
  job_id: string;
  owner_id: string;
  kind: JobKind;
  issued_at: number;
  expires_at: number;
  origin: { provider: string; ref: string };
  params: Record<string, unknown>;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isShortString = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

// Shape and limits only. Whether a kind's params make sense (an agent the device has, a session it reported) is
// the device's call (section 6.1) -- the cloud cannot see enough to decide it, and must not pretend to.
export function checkJob(input: unknown, now: number): Checked<JobInput> {
  if (!isObject(input)) return { ok: false, reason: 'not an object' };
  const { job_id, owner_id, kind, issued_at, expires_at, origin, params } = input;
  if (typeof job_id !== 'string' || !ULID_RE.test(job_id)) return { ok: false, reason: 'job_id is not a ULID' };
  if (!isShortString(owner_id, 64)) return { ok: false, reason: 'owner_id' };
  if (typeof kind !== 'string' || !(JOB_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `unknown kind ${String(kind)}` };
  if (!isTime(issued_at) || !isTime(expires_at)) return { ok: false, reason: 'issued_at / expires_at are not integer milliseconds' };
  if (expires_at <= issued_at) return { ok: false, reason: 'expires_at is not after issued_at' };
  if (expires_at - issued_at > MAX_TTL_MS) return { ok: false, reason: 'lives longer than the device remembers job ids (24 h)' };
  if (expires_at <= now) return { ok: false, reason: 'already expired' };
  if (!isObject(origin) || !isShortString(origin.provider, 32) || !isShortString(origin.ref, 256)) return { ok: false, reason: 'origin' };
  if (Object.keys(origin).length !== 2) return { ok: false, reason: 'origin has extra fields' };
  if (!isObject(params)) return { ok: false, reason: 'params is not an object' };
  for (const field of ['text', 'prompt'] as const) {
    const v = params[field];
    if (v !== undefined && (typeof v !== 'string' || [...v].length > MAX_TEXT_CHARS)) return { ok: false, reason: `params.${field} is not a string of at most ${MAX_TEXT_CHARS} characters` };
  }
  const job: JobInput = { job_id, owner_id, kind: kind as JobKind, issued_at, expires_at, origin: { provider: origin.provider, ref: origin.ref }, params };
  // A job that cannot be canonicalised, or would not fit in a frame, can never be delivered. Refuse it now,
  // while the caller can still tell the owner, instead of letting it sit in the queue until it expires.
  let size: number;
  try {
    size = new TextEncoder().encode(canonicalize(job)).length;
  } catch (err) {
    if (err instanceof CanonicalError) return { ok: false, reason: `not canonicalisable: ${err.message}` };
    throw err;
  }
  if (size + ENVELOPE_OVERHEAD_BYTES > MAX_FRAME_BYTES) return { ok: false, reason: `too large for one frame (${size} bytes)` };
  return { ok: true, value: job };
}

// D1 stores a hash of the params, never the params (threat 11): enough to tell two jobs apart, or to check a
// device's log against the cloud's, without the cloud keeping reply text or prompts.
export async function paramsSha256(params: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(params)));
  return b64.toHex(new Uint8Array(digest));
}

export type JobsSwitch = { enabled: true } | { enabled: false; reason: string };

// The two kill switches of section 10.3 that the cloud owns (the third, a device's local pause, is the
// device's). Both fail closed: the deploy-time variable must be exactly "true", and the runtime row, when it
// exists, must be exactly "true" -- and a D1 error reading it counts as "off", because "could not check
// whether the owner paused everything" must never mean "go ahead".
export async function jobsSwitch(env: Pick<Env, 'FORGELINE_JOBS_ENABLED' | 'DB'>): Promise<JobsSwitch> {
  if (env.FORGELINE_JOBS_ENABLED !== 'true') return { enabled: false, reason: 'FORGELINE_JOBS_ENABLED is not "true"' };
  let row: { value: string } | null;
  try {
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'jobs_enabled'").first<{ value: string }>();
  } catch (err) {
    log('error', 'jobs.switch_unreadable', { error: err instanceof Error ? err.message : String(err) });
    return { enabled: false, reason: 'the runtime switch (settings.jobs_enabled) could not be read' };
  }
  // No row: nobody has paused anything. That is the state of a fresh deployment, not a failure.
  if (row && row.value !== 'true') return { enabled: false, reason: 'paused at runtime (settings.jobs_enabled)' };
  return { enabled: true };
}
