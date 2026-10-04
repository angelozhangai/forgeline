// Shared test helpers. Every test uses its own device id, so tests never depend on each other's Durable
// Objects or audit rows, whatever order (or isolation) the pool runs them in.
import { env, exports } from 'cloudflare:workers';
import { ulid } from '../src/ids.ts';
import type { JobInput } from '../src/jobs.ts';

export function newDeviceId(): string {
  return `dev_${ulid()}`;
}

export function hub(deviceId: string) {
  return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(deviceId));
}

export async function hubExists(deviceId: string): Promise<boolean> {
  const { listDurableObjectIds } = await import('cloudflare:test');
  const target = env.DEVICE_HUB.idFromName(deviceId);
  return (await listDurableObjectIds(env.DEVICE_HUB)).some((id) => id.equals(target));
}

export function connectRequest(deviceId: string, headers: Record<string, string> = { upgrade: 'websocket' }): Request {
  return new Request(`https://cloud.test/v1/devices/${deviceId}/connect`, { headers });
}

// A client socket with its incoming messages and its close event captured from the start, so nothing that
// arrives between two awaits is missed.
export interface Client {
  ws: WebSocket;
  messages: string[];
  next(): Promise<string>;
  closed: Promise<{ code: number; reason: string }>;
}

export async function connect(deviceId: string): Promise<{ res: Response; client: Client }> {
  const res = await exports.default.fetch(connectRequest(deviceId));
  if (!res.webSocket) throw new Error(`no WebSocket: ${res.status} ${await res.text()}`);
  return { res, client: wrap(res.webSocket) };
}

function wrap(ws: WebSocket): Client {
  const messages: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  let resolveClosed!: (c: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    resolveClosed = r;
  });
  ws.addEventListener('message', (e) => {
    const data = typeof e.data === 'string' ? e.data : '<binary>';
    const w = waiters.shift();
    if (w) w(data);
    else messages.push(data);
  });
  ws.addEventListener('close', (e) => resolveClosed({ code: e.code, reason: e.reason }));
  ws.accept();
  return {
    ws,
    messages,
    next: () => {
      const m = messages.shift();
      return m !== undefined ? Promise.resolve(m) : new Promise((r) => waiters.push(r));
    },
    closed,
  };
}

// Resolves with `value` if `p` has not settled within `ms` -- for asserting that something does NOT happen.
export function within<T, U>(p: Promise<T>, ms: number, value: U): Promise<T | U> {
  return Promise.race([p, new Promise<U>((r) => setTimeout(() => r(value), ms))]);
}

export interface AuditRow {
  seq: number;
  at: number;
  owner_id: string | null;
  device_id: string | null;
  actor: string;
  action: string;
  outcome: string;
  reason: string | null;
  ref: string | null;
  meta: string | null;
}

export async function auditRows(deviceId: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM audit WHERE device_id = ? ORDER BY seq').bind(deviceId).all<AuditRow>();
  return results;
}

// Audit rows written after the fact (a peer's close) are not awaited by anyone; poll until they land.
export async function waitForAudit(deviceId: string, action: string, timeoutMs = 2_000): Promise<AuditRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (await auditRows(deviceId)).find((r) => r.action === action);
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`no ${action} audit row for ${deviceId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function job(overrides: Partial<JobInput> & Record<string, unknown> = {}): JobInput {
  const now = Date.now();
  return {
    job_id: ulid(now),
    owner_id: 'own_test',
    kind: 'session.reply',
    issued_at: now,
    expires_at: now + 15 * 60 * 1000,
    origin: { provider: 'slack', ref: 'slack:T00000000:D00000000:1791071980.000100' },
    params: { agent: 'claude', session: '6f1c2a9e-4b7d-4e2a-9c31-0d5e8f7a1b24', text: 'run the full suite' },
    ...overrides,
  } as JobInput;
}
