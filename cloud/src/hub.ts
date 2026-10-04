// DeviceHub: one Durable Object per device (docs/cloud-agent.md sections 3.1, 5.1, 5.7, 5.8, 10.2).
//
// It holds the device's WebSocket, knows whether the device is present, and keeps the device's job queue.
// The socket is hibernatable (ctx.acceptWebSocket): an idle device costs nothing while connected, and the
// liveness `ping` is answered by the runtime itself (setWebSocketAutoResponse) without waking the object --
// which is why `ping` / `pong` are the one unsigned exception in the protocol (section 5.1).
//
// What P1 does NOT do yet, on purpose:
//  * authenticate the device. Connections are admitted by src/admission.ts: unauthenticated in `dev` only,
//    refused everywhere else. P2 (#51) replaces that with the handshake.
//  * deliver jobs. A job reaches a device as a signed `job` frame after `welcome`; there is no welcome and
//    no signing key yet. So the queue fills, expires and is audited, and nothing is ever sent from it.
//  * tell the owner a job expired. Expiry is marked in D1 and audited now; the chat message is P4 (#53).
import { DurableObject } from 'cloudflare:workers';
import { admit } from './admission.ts';
import { type AuditEntry, audit, auditStatement, logAudit } from './audit.ts';
import type { Env } from './env.ts';
import { json } from './http.ts';
import { isDeviceId, ulid } from './ids.ts';
import { checkJob, jobsSwitch, MAX_PENDING_JOBS, paramsSha256 } from './jobs.ts';
import { errorFields, log } from './log.ts';
import { MAX_FRAME_BYTES } from './wire/frame.ts';

// Close codes (section 5.9).
export const CLOSE = { protocol: 4000, authFailed: 4001, revoked: 4003, unknownDevice: 4004, replaced: 4005, unsupportedVersion: 4009 } as const;

// WebSocket.readyState OPEN. A socket the Hub has already closed (replaced, protocol error) can still be listed
// by getWebSockets() until the peer answers the close; it is not "present".
const OPEN = 1;

interface Attachment {
  conn: string;
  connected_at: number;
  mode: 'unauthenticated-dev';
}

export interface Presence {
  online: boolean;
  conn: string | null;
  connected_at: number | null;
  // The last sign of life: the runtime's timestamp of the last auto-answered `ping` on the open socket, or, when
  // none is open, what was recorded when the last one closed (section 10.2).
  last_seen_at: number | null;
}

export interface QueuedJob {
  job_id: string;
  kind: string;
  issued_at: number;
  expires_at: number;
  attempts: number;
}

export type EnqueueResult =
  | { ok: true; job_id: string; duplicate: boolean }
  | { ok: false; job_id: string | null; code: 'jobs_disabled' | 'invalid_job' | 'queue_full' | 'internal'; reason: string };

// The Hub's own storage (SQLite-backed Durable Object). Job bodies live here, and only here, until they are
// delivered or expire; D1 has a hash of the params and the metadata (threat 11).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS queue (
     job_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     issued_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     origin TEXT NOT NULL,
     params TEXT NOT NULL,
     params_sha256 TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS queue_by_expiry ON queue (expires_at)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

export class DeviceHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
    // Persisted by the runtime across hibernation; re-setting it on every construction is idempotent.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // The device this object belongs to: the name the Worker addressed it by (idFromName). It is also written to
  // the object's own storage the first time, because the runtime only promises the name on calls that came
  // through a named stub -- an alarm waking a hibernated object must still know whose jobs it is expiring.
  // Anything else -- an object reached by a raw id, a name that is not a device id, a name that disagrees with
  // the stored one -- is a bug, and nothing is done for it.
  private device(): string {
    const name = this.ctx.id.name;
    const stored = this.meta('device_id');
    if (name !== undefined && stored !== null && name !== stored) throw new Error(`DeviceHub for ${stored} was addressed as ${name}`);
    const id = name ?? stored;
    if (!id || !isDeviceId(id)) throw new Error('DeviceHub must be addressed with idFromName(<device id>)');
    if (stored === null) this.setMeta('device_id', id);
    return id;
  }

  // -- Connection ---------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const device = this.device();
    // The only request a Hub serves is its own device's connect. A request for another path, or for another
    // device's, is a routing bug upstream; answering it would attach that socket to the wrong device.
    if (new URL(request.url).pathname !== `/v1/devices/${device}/connect`) return json(404, { error: 'not_found' });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'upgrade_required' }, { upgrade: 'websocket' });
    // The Worker has already checked this. Checked again here because this is the code that accepts.
    const admission = admit(this.env);
    if (!admission.ok) {
      // Logged, not audited: until P2 there is no way to tell a real device from anyone on the internet who
      // knows the URL, and an audit row per refusal would let them write to D1 at will.
      log('warn', 'ws.refuse', { device_id: device, reason: admission.reason, at: 'hub' });
      return json(403, { error: 'auth_required', message: admission.reason });
    }
    const conn = ulid();
    const now = Date.now();
    // Audited before the socket exists: a connection that cannot be recorded is not accepted.
    try {
      await audit(this.env.DB, { actor: 'device', action: 'ws.connect', outcome: 'ok', device_id: device, ref: conn, meta: { mode: admission.mode } });
    } catch (err) {
      log('error', 'ws.connect_unaudited', { device_id: device, ...errorFields(err) });
      return json(503, { error: 'unavailable', message: 'the connection could not be recorded; try again' });
    }
    // The newest connection wins (section 5.1). Collected after the await above, so a connection that was
    // accepted while this one was being audited is replaced too.
    for (const old of this.ctx.getWebSockets()) {
      const previous = old.deserializeAttachment() as Attachment | null;
      try {
        old.close(CLOSE.replaced, 'replaced by a newer connection');
      } catch {
        // Already closing: nothing left to replace.
      }
      await this.auditAfterTheFact({ actor: 'hub', action: 'ws.replace', outcome: 'ok', device_id: device, ref: previous?.conn ?? null, meta: { by: conn } });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [conn]);
    server.serializeAttachment({ conn, connected_at: now, mode: admission.mode } satisfies Attachment);
    // A job whose alarm was lost (the alarm ran out of retries while D1 was down) is expired at the latest
    // here, the next time the device shows up.
    await this.armAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // `ping` never arrives here: the runtime answers it. Anything else is, in P1, a frame before `welcome`,
    // and until `welcome` the only acceptable frames are the next handshake frame and `error` (section 5.5) --
    // of which P1 has none. So every other frame is a protocol error, closed with 4000 and audited.
    const device = this.device();
    const att = ws.deserializeAttachment() as Attachment | null;
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
    const reason = typeof message !== 'string' ? 'binary frame (text frames only)' : bytes > MAX_FRAME_BYTES ? 'frame larger than 64 KiB' : 'no handshake in this build: only ping is accepted';
    try {
      ws.close(CLOSE.protocol, 'protocol error');
    } catch {
      // Already closing.
    }
    await this.auditAfterTheFact({ actor: 'device', action: 'ws.protocol_error', outcome: 'rejected', device_id: device, ref: att?.conn ?? null, reason, meta: { bytes } });
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    // No ws.close() here: with this compatibility date the runtime answers the peer's close frame itself
    // (web_socket_auto_reply_to_close), and a second close would throw.
    const device = this.device();
    const att = ws.deserializeAttachment() as Attachment | null;
    this.recordLastSeen(ws, att);
    await this.auditAfterTheFact({ actor: 'device', action: 'ws.close', outcome: 'ok', device_id: device, ref: att?.conn ?? null, meta: { code, clean: wasClean } });
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    this.recordLastSeen(ws, att);
    log('warn', 'ws.error', { device_id: this.device(), conn: att?.conn, ...errorFields(error) });
  }

  // -- Presence ------------------------------------------------------------------------------------

  async presence(): Promise<Presence> {
    const open = this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN);
    const ws = open.at(-1);
    const stored = this.meta('last_seen_at');
    const recorded = stored === null ? null : Number(stored);
    if (!ws) return { online: false, conn: null, connected_at: null, last_seen_at: recorded };
    const att = ws.deserializeAttachment() as Attachment | null;
    const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
    return { online: true, conn: att?.conn ?? null, connected_at: att?.connected_at ?? null, last_seen_at: max(ping, att?.connected_at ?? null, recorded) };
  }

  // -- Job queue -----------------------------------------------------------------------------------

  // Queue a job for this device. Idempotent by job_id (section 5.7): queueing the same job twice is a no-op
  // that reports `duplicate: true`. Every refusal is audited and returned with a code -- never swallowed.
  async enqueue(input: unknown): Promise<EnqueueResult> {
    const device = this.device();
    const jobId = typeof (input as { job_id?: unknown } | null)?.job_id === 'string' ? (input as { job_id: string }).job_id : null;
    const refuse = async (code: 'jobs_disabled' | 'invalid_job' | 'queue_full', reason: string): Promise<EnqueueResult> => {
      await audit(this.env.DB, { actor: 'cloud', action: 'job.enqueue', outcome: 'rejected', device_id: device, ref: jobId, reason: `${code}: ${reason}` });
      return { ok: false, job_id: jobId, code, reason };
    };
    const now = Date.now();
    const sw = await jobsSwitch(this.env);
    if (!sw.enabled) return refuse('jobs_disabled', sw.reason);
    const checked = checkJob(input, now);
    if (!checked.ok) return refuse('invalid_job', checked.reason);
    const job = checked.value;
    const hash = await paramsSha256(job.params);
    // Already known to D1 -- queued before, or already expired or run. Either way, not a new job.
    const known = await this.env.DB.prepare('SELECT 1 AS known FROM jobs WHERE id = ?').bind(job.job_id).first();
    if (known) return { ok: true, job_id: job.job_id, duplicate: true };

    // From here to the INSERT there is no await, so the duplicate check, the bound and the insert see one
    // consistent queue even with enqueues interleaving at the awaits above.
    if (this.sql.exec('SELECT 1 FROM queue WHERE job_id = ?', job.job_id).toArray().length) return { ok: true, job_id: job.job_id, duplicate: true };
    const pending = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM queue').one().n;
    if (pending >= MAX_PENDING_JOBS) return refuse('queue_full', `${pending} jobs are already pending for this device`);
    this.sql.exec(
      'INSERT INTO queue (job_id, owner_id, kind, issued_at, expires_at, origin, params, params_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      job.job_id,
      job.owner_id,
      job.kind,
      job.issued_at,
      job.expires_at,
      JSON.stringify(job.origin),
      JSON.stringify(job.params),
      hash,
    );

    // The Hub row first, then D1 (job row + audit row in one transaction). If D1 fails, the Hub row is taken
    // back out, so the job exists in both places or in neither and the caller can simply retry.
    const entry: AuditEntry = { actor: 'cloud', action: 'job.enqueue', outcome: 'ok', owner_id: job.owner_id, device_id: device, ref: job.job_id, meta: { kind: job.kind, expires_at: job.expires_at } };
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "INSERT INTO jobs (id, owner_id, device_id, kind, params_sha256, origin, issued_at, expires_at, attempts, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?)",
        ).bind(job.job_id, job.owner_id, device, job.kind, hash, JSON.stringify(job.origin), job.issued_at, job.expires_at, now),
        auditStatement(this.env.DB, { ...entry, at: now }),
      ]);
    } catch (err) {
      this.sql.exec('DELETE FROM queue WHERE job_id = ?', job.job_id);
      log('error', 'job.enqueue_unrecorded', { device_id: device, job_id: job.job_id, ...errorFields(err) });
      return { ok: false, job_id: job.job_id, code: 'internal', reason: 'the job could not be recorded; nothing was queued' };
    }
    logAudit(entry);
    await this.armAlarm();
    return { ok: true, job_id: job.job_id, duplicate: false };
  }

  // What is queued, without the bodies: those leave the Hub only inside a signed frame to the device.
  async queued(): Promise<QueuedJob[]> {
    return this.sql.exec<QueuedJob & Record<string, SqlStorageValue>>('SELECT job_id, kind, issued_at, expires_at, attempts FROM queue ORDER BY expires_at, job_id').toArray();
  }

  // Expire every job whose expires_at has passed (section 5.8). A job leaves the queue only after D1 says
  // `expired` and the audit row exists, in one D1 transaction. If that fails the alarm throws, the runtime
  // retries it, and the job stays queued meanwhile -- an expired job is late to be marked, never lost.
  override async alarm(): Promise<void> {
    const device = this.device();
    const now = Date.now();
    const due = this.sql
      .exec<{ job_id: string; owner_id: string; kind: string; issued_at: number; expires_at: number; attempts: number; origin: string; params_sha256: string }>(
        'SELECT job_id, owner_id, kind, issued_at, expires_at, attempts, origin, params_sha256 FROM queue WHERE expires_at <= ? ORDER BY expires_at',
        now,
      )
      .toArray();
    if (due.length) {
      const entries: AuditEntry[] = due.map((j) => ({
        actor: 'hub',
        action: 'job.expire',
        outcome: 'ok',
        owner_id: j.owner_id,
        device_id: device,
        ref: j.job_id,
        // P1 never delivers, so every expiry is "the device never got it". From P2 on, an acknowledged job
        // without a result becomes `unknown` instead (section 5.8), and this reason starts to vary.
        reason: 'expired before it was delivered',
        meta: { kind: j.kind, expires_at: j.expires_at, attempts: j.attempts },
        at: now,
      }));
      await this.env.DB.batch([
        ...due.map((j) =>
          // An upsert, not an UPDATE: if the enqueue's D1 write was lost between the Hub insert and the batch
          // (a crash in between), the row is created here instead of the expiry matching nothing.
          this.env.DB.prepare(
            `INSERT INTO jobs (id, owner_id, device_id, kind, params_sha256, origin, issued_at, expires_at, attempts, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'expired', ?)
             ON CONFLICT (id) DO UPDATE SET status = 'expired', attempts = excluded.attempts, updated_at = excluded.updated_at`,
          ).bind(j.job_id, j.owner_id, device, j.kind, j.params_sha256, j.origin, j.issued_at, j.expires_at, j.attempts, now),
        ),
        ...entries.map((e) => auditStatement(this.env.DB, e)),
      ]);
      // Only now does the body go: marked and audited first, then forgotten (threat 11).
      for (const j of due) this.sql.exec('DELETE FROM queue WHERE job_id = ?', j.job_id);
      for (const e of entries) logAudit(e);
    }
    await this.armAlarm();
  }

  // -- Internals -----------------------------------------------------------------------------------

  // One alarm, at the earliest expiry in the queue. setAlarm replaces any earlier one, so this is safe to call
  // after every change.
  private async armAlarm(): Promise<void> {
    const next = this.sql.exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM queue').one().next;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private meta(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray();
    return rows[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  private recordLastSeen(ws: WebSocket, att: Attachment | null): void {
    const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
    const prev = this.meta('last_seen_at');
    const seen = max(ping, att?.connected_at ?? null, prev === null ? null : Number(prev));
    if (seen !== null) this.setMeta('last_seen_at', String(seen));
  }

  // For events that have already happened (the peer closed, a frame was refused): the row cannot gate anything,
  // so a failure to write it is logged as an error instead of thrown into the runtime.
  private async auditAfterTheFact(e: AuditEntry): Promise<void> {
    try {
      await audit(this.env.DB, e);
    } catch (err) {
      log('error', 'audit.write_failed', { action: e.action, device_id: e.device_id ?? undefined, ref: e.ref ?? undefined, ...errorFields(err) });
    }
  }
}

function max(...xs: (number | null)[]): number | null {
  const present = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return present.length ? Math.max(...present) : null;
}
