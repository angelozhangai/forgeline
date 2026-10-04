// Runs under the `prod` environment exactly as wrangler.jsonc defines it (vitest.config.ts, project `prod`).
//
// The acceptance criterion of #50: until P2's handshake exists, an unauthenticated connection is refused in
// prod by construction. "By construction" is tested here against the shipped prod configuration, at both
// places that could accept a socket -- the Worker route and the Durable Object itself -- and the same request
// is shown to succeed in dev (test/hub.test.ts), so a refusal here means prod, not a broken route.
import { env, exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { auditRows, connectRequest, hub, hubExists, job, newDeviceId } from './helpers.ts';

describe('prod', () => {
  test('this project really runs the prod configuration (otherwise every test below proves nothing)', () => {
    expect(env.FORGELINE_ENV).toBe('prod');
    expect(env.FORGELINE_JOBS_ENABLED).toBe('false');
  });

  test('healthz says prod', async () => {
    const res = await exports.default.fetch('https://cloud.test/healthz');
    expect(await res.json()).toEqual({ ok: true, service: 'forgeline-cloud', env: 'prod', wire: [1] });
  });

  test('the Worker refuses an unauthenticated connection, without waking the device Hub', async () => {
    const id = newDeviceId();
    const res = await exports.default.fetch(connectRequest(id));
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
    expect(await res.json()).toMatchObject({ error: 'auth_required' });
    expect(await hubExists(id)).toBe(false);
  });

  test('the DeviceHub refuses it too, when reached directly -- it does not rely on the route having checked', async () => {
    const id = newDeviceId();
    const res = await hub(id).fetch(connectRequest(id));
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
    expect(await res.json()).toMatchObject({ error: 'auth_required' });
    expect((await hub(id).presence()).online).toBe(false);
  });

  test('no job can be created: the deploy-time kill switch is off in prod, and the refusal is audited', async () => {
    const id = newDeviceId();
    const j = job();
    expect(await hub(id).enqueue(j)).toMatchObject({ ok: false, code: 'jobs_disabled', reason: 'FORGELINE_JOBS_ENABLED is not "true"' });
    expect(await hub(id).queued()).toEqual([]);
    expect((await auditRows(id))[0]).toMatchObject({ action: 'job.enqueue', outcome: 'rejected', ref: j.job_id });
  });
});
