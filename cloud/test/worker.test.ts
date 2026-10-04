// The Worker's routes (src/index.ts), under the dev environment of wrangler.jsonc.
import { env, exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { connectRequest, hubExists, newDeviceId } from './helpers.ts';

const fetchSelf = (input: string | Request, init?: RequestInit) => exports.default.fetch(input, init);
// The handler called directly, with an env that differs from the configured one.
const fetchWith = (request: Request, overrides: Partial<Env>) => worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ...overrides });

describe('GET /healthz', () => {
  test('reports the environment it was deployed as', async () => {
    const res = await fetchSelf('https://cloud.test/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, service: 'forgeline-cloud', env: 'dev', wire: [1] });
  });

  test('fails when FORGELINE_ENV is missing or unknown: a deployment that does not know what it is must look unhealthy', async () => {
    for (const value of [undefined, '', 'Dev', 'production', 'staging']) {
      const res = await fetchWith(new Request('https://cloud.test/healthz'), { FORGELINE_ENV: value });
      expect(res.status, String(value)).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('misconfigured');
    }
  });
});

describe('everything else is 404', () => {
  const id = 'dev_01M3ZGYZ00MZDA2E2C003XDNC6';
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/healthz/'],
    ['POST', '/healthz'],
    ['GET', '/v1/devices'],
    ['GET', `/v1/devices/${id}`],
    ['GET', `/v1/devices/${id}/connect/`],
    ['GET', `/v1/devices/${id}/connect/extra`],
    ['POST', `/v1/devices/${id}/connect`],
    ['PUT', `/v1/devices/${id}/connect`],
    ['GET', `/v2/devices/${id}/connect`],
  ] as const) {
    test(`${method} ${path}`, async () => {
      // No upgrade header: workerd's fetch() turns any request carrying one into a GET, which would test
      // the runtime instead of the router.
      const res = await fetchSelf(`https://cloud.test${path}`, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });
  }
});

describe('GET /v1/devices/:device_id/connect', () => {
  test('an id that is not dev_ + ULID is refused before any Durable Object is addressed', async () => {
    for (const bad of ['dev_short', 'DEV_01M3ZGYZ00MZDA2E2C003XDNC6', 'dev_01M3ZGYZ00MZDA2E2C003XDNCI', 'dev_01m3zgyz00mzda2e2c003xdnc6', 'cloud', 'dev_01M3ZGYZ00MZDA2E2C003XDNC6%00']) {
      const res = await fetchSelf(connectRequest(bad));
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_device_id');
      expect(await hubExists(bad), bad).toBe(false);
    }
  });

  test('a plain GET without a WebSocket upgrade is 426, and wakes no Durable Object', async () => {
    const id = newDeviceId();
    const res = await fetchSelf(connectRequest(id, {}));
    expect(res.status).toBe(426);
    expect(res.headers.get('upgrade')).toBe('websocket');
    expect(await hubExists(id)).toBe(false);
  });

  test('in dev, a well-formed id with an upgrade reaches its own DeviceHub and gets a socket', async () => {
    const id = newDeviceId();
    const res = await fetchSelf(connectRequest(id));
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket!.accept();
    res.webSocket!.close(1000, 'done');
    expect(await hubExists(id)).toBe(true);
  });

  test('outside dev the Worker refuses before waking the Hub -- for any value that is not exactly "dev", missing included', async () => {
    for (const value of [undefined, '', 'prod', 'Dev', 'DEV', ' dev', 'development', 'staging']) {
      const id = newDeviceId();
      const res = await fetchWith(connectRequest(id), { FORGELINE_ENV: value });
      expect(res.status, String(value)).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('auth_required');
      expect(await hubExists(id), String(value)).toBe(false);
    }
  });
});
