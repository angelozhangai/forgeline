// The audit trail (docs/cloud-agent.md section 10.1, `audit` table): every state change in the cloud writes one
// row here, and the same entry goes to the structured log.
//
// Why both: the log is what an operator searches while something is happening; the D1 row is what the owner
// reconstructs from afterwards ("what ran, why, and on whose instruction" -- asset A7). Logs age out on
// Cloudflare's schedule; the audit table does not.
//
// Rules for callers:
//  * Audit *before* the change becomes visible, or in the same D1 batch as it (auditStatement), so a change
//    that could not be audited does not happen. The one exception is an event that already happened -- a socket
//    the peer closed -- where the row is best effort and a failure is logged loudly instead.
//  * `reason` and `meta` carry codes, ids and counts, never message bodies (threat 11).
import { log } from './log.ts';

export type Outcome = 'ok' | 'rejected' | 'error';

export interface AuditEntry {
  // Who caused it: 'device' (the device's connection did it), 'hub' (the Hub decided on its own, e.g. expiry
  // or replacement), 'cloud' (another part of the cloud asked the Hub to), later 'owner'.
  actor: string;
  // Dotted noun.verb, e.g. ws.connect, job.enqueue, job.expire.
  action: string;
  outcome: Outcome;
  owner_id?: string | null;
  device_id?: string | null;
  reason?: string | null;
  // What the action was about: a job id, a connection id.
  ref?: string | null;
  meta?: Record<string, unknown> | null;
  at?: number;
}

// The INSERT as a prepared statement, for callers that must commit the audit row atomically with the change it
// records (D1 `batch()` runs its statements in one transaction).
export function auditStatement(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit (at, owner_id, device_id, actor, action, outcome, reason, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(e.at ?? Date.now(), e.owner_id ?? null, e.device_id ?? null, e.actor, e.action, e.outcome, e.reason ?? null, e.ref ?? null, e.meta ? JSON.stringify(e.meta) : null);
}

// The log line that mirrors an audit row. Called by audit(), and by callers that use auditStatement() once
// their batch has committed.
export function logAudit(e: AuditEntry): void {
  log(e.outcome === 'error' ? 'error' : e.outcome === 'rejected' ? 'warn' : 'info', e.action, {
    audit: true,
    actor: e.actor,
    outcome: e.outcome,
    owner_id: e.owner_id ?? undefined,
    device_id: e.device_id ?? undefined,
    reason: e.reason ?? undefined,
    ref: e.ref ?? undefined,
    ...(e.meta ? { meta: e.meta } : {}),
  });
}

// Write one audit row and its log line. Throws if the row cannot be written: the caller decides whether the
// change may still go ahead (almost always: it may not).
export async function audit(db: D1Database, e: AuditEntry): Promise<void> {
  await auditStatement(db, e).run();
  logAudit(e);
}
