// forgeline Cloud: the Worker entry (docs/cloud-agent.md section 2).
//
// Routes, and nothing else:
//   GET /healthz                          liveness, and whether the deployment knows which environment it is
//   GET /v1/devices/<device_id>/connect   WebSocket upgrade, handed to that device's DeviceHub
// Every other method and path is 404. The IM ingress (P4) and enrolment (P2) arrive as routes here later.
import { admit } from './admission.ts';
import { type Env, environmentOf } from './env.ts';
import { json } from './http.ts';
import { isDeviceId } from './ids.ts';
import { errorFields, log } from './log.ts';

export { DeviceHub } from './hub.ts';

const CONNECT = /^\/v1\/devices\/([^/]+)\/connect$/;

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      // A bug, not a client error. Logged with what can be logged; the client learns only that it failed.
      log('error', 'worker.unhandled', { path: new URL(request.url).pathname, ...errorFields(err) });
      return json(500, { error: 'internal' });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/healthz') return healthz(env);
  const connect = request.method === 'GET' ? CONNECT.exec(url.pathname) : null;
  if (connect) return connectDevice(request, env, connect[1]);
  return json(404, { error: 'not_found' });
}

// Cheap on purpose: no D1, no Durable Object. Anyone can call it, so it must not cost a database read. It
// does fail when the deployment is misconfigured, because "up, but refusing everything for a reason nobody can
// see" is the failure a health check exists to surface.
function healthz(env: Env): Response {
  const environment = environmentOf(env);
  if (!environment) return json(503, { ok: false, error: 'misconfigured', message: 'FORGELINE_ENV is neither "dev" nor "prod"' });
  return json(200, { ok: true, service: 'forgeline-cloud', env: environment, wire: [1] });
}

async function connectDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  // Validated before any Durable Object is addressed: idFromName() would happily create an object for any
  // string, and every distinct string is a distinct object.
  if (!isDeviceId(deviceId)) return json(400, { error: 'invalid_device_id', message: 'a device id is dev_ followed by a ULID' });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'upgrade_required' }, { upgrade: 'websocket' });
  const admission = admit(env);
  if (!admission.ok) {
    // Refused here without waking the device's Hub. Logged rather than audited, for the reason given in
    // DeviceHub.fetch: before P2, a refusal says nothing about any real device.
    log('warn', 'ws.refuse', { device_id: deviceId, reason: admission.reason, at: 'worker' });
    return json(403, { error: 'auth_required', message: admission.reason });
  }
  return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(deviceId)).fetch(request);
}
