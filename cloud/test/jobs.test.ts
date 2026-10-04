// The job queue (src/jobs.ts, DeviceHub.enqueue / alarm) under the dev environment: validation, the kill
// switches, idempotency, the bound of 100, and expiry that is marked and audited -- never a silent drop.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { canonicalize } from '../src/wire/canonical.ts';
import { checkJob, jobsSwitch, MAX_PENDING_JOBS, MAX_TEXT_CHARS, MAX_TTL_MS, paramsSha256 } from '../src/jobs.ts';
import { auditRows, hub, job, newDeviceId } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function d1Job(id: string) {
  return env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<Record<string, unknown>>();
}

// Makes every audit insert for one device fail, as a D1 outage would, without touching any other test's rows.
async function breakAuditFor(deviceId: string): Promise<() => Promise<void>> {
  const name = `fail_audit_${deviceId.toLowerCase()}`;
  await env.DB.prepare(`CREATE TRIGGER ${name} BEFORE INSERT ON audit WHEN NEW.device_id = '${deviceId}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
}

describe('checkJob', () => {
  const now = Date.now();

  test('accepts a well-formed job', () => {
    expect(checkJob(job(), now).ok).toBe(true);
  });

  for (const [what, input, reason] of [
    ['not an object', 'job', /not an object/],
    ['a job_id that is not a ULID', job({ job_id: 'job-1' }), /job_id/],
    ['an empty owner', job({ owner_id: '' }), /owner_id/],
    ['a kind outside the catalogue', job({ kind: 'shell.exec' as never }), /unknown kind shell.exec/],
    ['fractional times', job({ issued_at: now + 0.5 }), /integer milliseconds/],
    ['expires_at not after issued_at', job({ issued_at: now + 1_000, expires_at: now + 1_000 }), /not after issued_at/],
    ['a lifetime past the device journal (24 h)', job({ issued_at: now, expires_at: now + MAX_TTL_MS + 1 }), /24 h/],
    ['an already expired job', job({ issued_at: now - 20_000, expires_at: now - 1 }), /already expired/],
    ['an origin without a ref', job({ origin: { provider: 'slack' } as never }), /origin/],
    ['an origin with extra fields', job({ origin: { provider: 'slack', ref: 'r', path: '/etc' } as never }), /extra fields/],
    ['params that are not an object', job({ params: [] as never }), /params is not an object/],
    ['a text longer than 4000 characters', job({ params: { text: 'a'.repeat(MAX_TEXT_CHARS + 1) } }), /params.text/],
    ['a prompt that is not a string', job({ params: { prompt: 42 } }), /params.prompt/],
    ['a fraction inside params (cannot be canonicalised)', job({ params: { n: 1.5 } }), /not canonicalisable/],
    ['a non-ASCII key inside params', job({ params: { 'caf\u00e9': 1 } }), /not canonicalisable/],
    ['a body too large for one frame', job({ params: { blob: 'x'.repeat(64 * 1024) } }), /too large/],
  ] as const) {
    test(`refuses ${what}`, () => {
      const r = checkJob(input, now);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    });
  }

  test('counts text in code points, as the Rust agent does: 4000 emoji are 8000 UTF-16 units and still fit', () => {
    expect(checkJob(job({ params: { text: '\u{1F680}'.repeat(MAX_TEXT_CHARS) } }), now).ok).toBe(true);
    expect(checkJob(job({ params: { text: '\u{1F680}'.repeat(MAX_TEXT_CHARS + 1) } }), now).ok).toBe(false);
  });
});

describe('jobsSwitch (the kill switches of section 10.3)', () => {
  const db = (row: { value: string } | null | 'throw') =>
    ({
      prepare: () => ({
        first: async () => {
          if (row === 'throw') throw new Error('D1 is down');
          return row;
        },
      }),
    }) as unknown as D1Database;

  test('the deploy-time variable must be exactly "true"', async () => {
    for (const value of ['false', 'TRUE', '1', 'yes', '', undefined]) {
      expect(await jobsSwitch({ FORGELINE_JOBS_ENABLED: value, DB: db(null) }), String(value)).toEqual({ enabled: false, reason: 'FORGELINE_JOBS_ENABLED is not "true"' });
    }
  });

  test('with the variable on: no runtime row means not paused; a row must say exactly "true"', async () => {
    expect(await jobsSwitch({ FORGELINE_JOBS_ENABLED: 'true', DB: db(null) })).toEqual({ enabled: true });
    expect(await jobsSwitch({ FORGELINE_JOBS_ENABLED: 'true', DB: db({ value: 'true' }) })).toEqual({ enabled: true });
    for (const value of ['false', 'paused', 'TRUE', '']) expect((await jobsSwitch({ FORGELINE_JOBS_ENABLED: 'true', DB: db({ value }) })).enabled, value).toBe(false);
  });

  test('a runtime switch that cannot be read counts as off', async () => {
    expect(await jobsSwitch({ FORGELINE_JOBS_ENABLED: 'true', DB: db('throw') })).toEqual({ enabled: false, reason: 'the runtime switch (settings.jobs_enabled) could not be read' });
  });
});

describe('DeviceHub.enqueue', () => {
  test('queues the job: the body stays in the Hub, D1 gets metadata and a hash, and it is audited', async () => {
    const id = newDeviceId();
    const j = job();
    expect(await hub(id).enqueue(j)).toEqual({ ok: true, job_id: j.job_id, duplicate: false });
    expect(await hub(id).queued()).toEqual([{ job_id: j.job_id, kind: j.kind, issued_at: j.issued_at, expires_at: j.expires_at, attempts: 0 }]);
    const row = await d1Job(j.job_id);
    expect(row).toMatchObject({ owner_id: 'own_test', device_id: id, kind: 'session.reply', status: 'queued', issued_at: j.issued_at, expires_at: j.expires_at, attempts: 0 });
    expect(row!.params_sha256).toBe(await paramsSha256(j.params));
    expect(JSON.parse(row!.origin as string)).toEqual(j.origin);
    // Threat 11: no reply text in D1.
    expect(JSON.stringify(row)).not.toContain(j.params.text as string);
    const audit = await auditRows(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'cloud', action: 'job.enqueue', outcome: 'ok', owner_id: 'own_test', ref: j.job_id });
    expect(JSON.stringify(audit)).not.toContain(j.params.text as string);
    // The alarm is armed for the job's expiry.
    expect(await runInDurableObject(hub(id), (_, state) => state.storage.getAlarm())).toBe(j.expires_at);
  });

  test('the hash is over the canonical params, so key order does not change it', async () => {
    expect(await paramsSha256({ b: 1, a: 'x' })).toBe(await paramsSha256({ a: 'x', b: 1 }));
    expect(canonicalize({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
  });

  test('is idempotent by job_id: a second enqueue of the same job queues nothing and audits nothing', async () => {
    const id = newDeviceId();
    const j = job();
    await hub(id).enqueue(j);
    expect(await hub(id).enqueue(j)).toEqual({ ok: true, job_id: j.job_id, duplicate: true });
    expect(await hub(id).queued()).toHaveLength(1);
    expect(await auditRows(id)).toHaveLength(1);
  });

  test('an invalid job is refused with a code, audited, and leaves no trace in the queue or in jobs', async () => {
    const id = newDeviceId();
    const j = job({ kind: 'shell.exec' as never });
    const r = await hub(id).enqueue(j);
    expect(r).toMatchObject({ ok: false, job_id: j.job_id, code: 'invalid_job' });
    expect(await hub(id).queued()).toEqual([]);
    expect(await d1Job(j.job_id)).toBeNull();
    const [row] = await auditRows(id);
    expect(row).toMatchObject({ action: 'job.enqueue', outcome: 'rejected', ref: j.job_id });
    expect(row.reason).toMatch(/^invalid_job: unknown kind/);
  });

  test('the runtime pause (settings.jobs_enabled) refuses new jobs, audited', async () => {
    const id = newDeviceId();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('jobs_enabled', 'false')").run();
    try {
      const r = await hub(id).enqueue(job());
      expect(r).toMatchObject({ ok: false, code: 'jobs_disabled', reason: 'paused at runtime (settings.jobs_enabled)' });
      expect(await hub(id).queued()).toEqual([]);
      expect((await auditRows(id))[0]).toMatchObject({ action: 'job.enqueue', outcome: 'rejected' });
    } finally {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'jobs_enabled'").run();
    }
  });

  test(`holds at most ${MAX_PENDING_JOBS} pending jobs, and refuses the next instead of evicting an old one`, async () => {
    const id = newDeviceId();
    const jobs = Array.from({ length: MAX_PENDING_JOBS }, () => job());
    for (const j of jobs) expect((await hub(id).enqueue(j)).ok).toBe(true);
    const extra = job();
    expect(await hub(id).enqueue(extra)).toMatchObject({ ok: false, code: 'queue_full', job_id: extra.job_id });
    const queued = await hub(id).queued();
    expect(queued).toHaveLength(MAX_PENDING_JOBS);
    expect(queued.map((q) => q.job_id).sort()).toEqual(jobs.map((j) => j.job_id).sort());
    const refusals = (await auditRows(id)).filter((r) => r.outcome === 'rejected');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toMatch(/^queue_full/);
  });

  test('when D1 cannot record the job, the Hub takes it back out: it is queued in both places or in neither', async () => {
    const id = newDeviceId();
    const j = job();
    const restore = await breakAuditFor(id);
    try {
      expect(await hub(id).enqueue(j)).toMatchObject({ ok: false, code: 'internal', job_id: j.job_id });
      expect(await hub(id).queued()).toEqual([]);
      expect(await d1Job(j.job_id)).toBeNull();
    } finally {
      await restore();
    }
    // And the caller can simply retry.
    expect(await hub(id).enqueue(j)).toEqual({ ok: true, job_id: j.job_id, duplicate: false });
  });
});

describe('DeviceHub.alarm: expiry (section 5.8)', () => {
  test('an undelivered job is marked expired in D1, audited, and only then removed; the alarm moves to the next job', async () => {
    const id = newDeviceId();
    const now = Date.now();
    const soon = job({ issued_at: now, expires_at: now + 150 });
    const later = job({ issued_at: now, expires_at: now + 60 * 60 * 1000 });
    await hub(id).enqueue(soon);
    await hub(id).enqueue(later);
    await sleep(200);
    // The runtime may already have fired it on time; either way, by now it has run.
    await runDurableObjectAlarm(hub(id));
    expect((await hub(id).queued()).map((q) => q.job_id)).toEqual([later.job_id]);
    expect(await d1Job(soon.job_id)).toMatchObject({ status: 'expired' });
    expect(await d1Job(later.job_id)).toMatchObject({ status: 'queued' });
    const expiry = (await auditRows(id)).filter((r) => r.action === 'job.expire');
    expect(expiry).toHaveLength(1);
    expect(expiry[0]).toMatchObject({ actor: 'hub', outcome: 'ok', ref: soon.job_id, reason: 'expired before it was delivered' });
    expect(await runInDurableObject(hub(id), (_, state) => state.storage.getAlarm())).toBe(later.expires_at);
  });

  test('if the expiry cannot be recorded, the job stays queued and the alarm fails (so the runtime retries) -- never a silent drop', async () => {
    const id = newDeviceId();
    const now = Date.now();
    const j = job({ issued_at: now, expires_at: now + 150 });
    await hub(id).enqueue(j);
    // Driven by hand: the runtime's own alarm would fire into the injected failure too, and retry on its own
    // schedule. That is the behaviour being relied on, but it makes the test's timing the runtime's.
    await runInDurableObject(hub(id), (_, state) => state.storage.deleteAlarm());
    const restore = await breakAuditFor(id);
    try {
      await sleep(200);
      await expect(runInDurableObject(hub(id), (instance) => instance.alarm())).rejects.toThrow(/injected failure/);
      expect((await hub(id).queued()).map((q) => q.job_id)).toEqual([j.job_id]);
      expect(await d1Job(j.job_id)).toMatchObject({ status: 'queued' });
    } finally {
      await restore();
    }
    await runInDurableObject(hub(id), (instance) => instance.alarm());
    expect(await hub(id).queued()).toEqual([]);
    expect(await d1Job(j.job_id)).toMatchObject({ status: 'expired' });
    // Nothing left to expire: no alarm.
    expect(await runInDurableObject(hub(id), (_, state) => state.storage.getAlarm())).toBeNull();
  });

  test('a job whose D1 row was lost is still marked expired (the expiry upserts)', async () => {
    const id = newDeviceId();
    const now = Date.now();
    const j = job({ issued_at: now, expires_at: now + 150 });
    await hub(id).enqueue(j);
    await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(j.job_id).run();
    await sleep(200);
    await runInDurableObject(hub(id), (instance) => instance.alarm());
    expect(await d1Job(j.job_id)).toMatchObject({ status: 'expired', device_id: id, kind: j.kind, params_sha256: await paramsSha256(j.params) });
  });
});
