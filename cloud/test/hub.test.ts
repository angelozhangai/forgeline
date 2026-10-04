// DeviceHub's connection side (src/hub.ts) under the dev environment: hibernatable sockets, the ping/pong
// auto-response, presence, replacement by a newer connection, and the audit trail of each.
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { CLOSE } from '../src/hub.ts';
import { auditRows, connect, connectRequest, hub, job, newDeviceId, waitForAudit, within } from './helpers.ts';

describe('connecting', () => {
  test('a dev connection is accepted, audited before it exists, and makes the device present', async () => {
    const id = newDeviceId();
    const before = Date.now();
    const { res, client } = await connect(id);
    expect(res.status).toBe(101);
    const [row] = await auditRows(id);
    expect(row).toMatchObject({ actor: 'device', action: 'ws.connect', outcome: 'ok', device_id: id });
    expect(JSON.parse(row.meta!)).toEqual({ mode: 'unauthenticated-dev' });
    const p = await hub(id).presence();
    expect(p.online).toBe(true);
    expect(p.conn).toBe(row.ref);
    expect(p.connected_at).toBeGreaterThanOrEqual(before);
    client.ws.close(1000, 'done');
  });

  test('the literal ping is answered with pong by the runtime -- it never reaches the Hub as a frame', async () => {
    const id = newDeviceId();
    const { client } = await connect(id);
    const connected = (await hub(id).presence()).last_seen_at!;
    await new Promise((r) => setTimeout(r, 5));
    client.ws.send('ping');
    expect(await client.next()).toBe('pong');
    client.ws.send('ping');
    expect(await client.next()).toBe('pong');
    // Had either ping reached webSocketMessage, the Hub would have closed the socket as a protocol error.
    expect(await within(client.closed, 100, 'still open')).toBe('still open');
    expect((await auditRows(id)).map((r) => r.action)).toEqual(['ws.connect']);
    // Presence's last-seen is the auto-response timestamp of the last ping (docs/cloud-agent.md section 10.2).
    expect((await hub(id).presence()).last_seen_at!).toBeGreaterThan(connected);
    client.ws.close(1000, 'done');
  });

  test('the socket survives the Hub being evicted (hibernation): ping is still answered and the device is still present', async () => {
    const id = newDeviceId();
    const { client } = await connect(id);
    const { conn } = await hub(id).presence();
    await evictDurableObject(hub(id));
    client.ws.send('ping');
    expect(await client.next()).toBe('pong');
    const p = await hub(id).presence();
    expect(p).toMatchObject({ online: true, conn });
    client.ws.close(1000, 'done');
  });

  test('one device does not disturb another', async () => {
    const a = newDeviceId();
    const b = newDeviceId();
    const ca = await connect(a);
    const cb = await connect(b);
    ca.client.ws.send('ping');
    expect(await ca.client.next()).toBe('pong');
    expect(await within(ca.client.closed, 50, 'still open')).toBe('still open');
    expect((await hub(a).presence()).online).toBe(true);
    expect((await hub(b).presence()).online).toBe(true);
    ca.client.ws.close(1000, 'done');
    cb.client.ws.close(1000, 'done');
  });
});

describe('the Hub knows which device it is', () => {
  test('it serves only its own device\'s connect path; a request routed to the wrong Hub is refused', async () => {
    const id = newDeviceId();
    const other = newDeviceId();
    const res = await hub(id).fetch(connectRequest(other));
    expect(res.status).toBe(404);
    expect((await hub(id).presence()).online).toBe(false);
  });

  test('an alarm that wakes an evicted Hub still knows its device (the id is kept in its own storage)', async () => {
    const id = newDeviceId();
    const now = Date.now();
    await hub(id).enqueue(job({ issued_at: now, expires_at: now + 100 }));
    await evictDurableObject(hub(id));
    await new Promise((r) => setTimeout(r, 150));
    await runDurableObjectAlarm(hub(id));
    expect(await waitForAudit(id, 'job.expire')).toMatchObject({ device_id: id });
  });
});

describe('a newer connection replaces the older one (section 5.1)', () => {
  test('the old socket is closed with 4005, the new one is the one present, and the replacement is audited', async () => {
    const id = newDeviceId();
    const first = await connect(id);
    const firstConn = (await hub(id).presence()).conn;
    const second = await connect(id);
    expect(await first.client.closed).toEqual({ code: CLOSE.replaced, reason: 'replaced by a newer connection' });
    second.client.ws.send('ping');
    expect(await second.client.next()).toBe('pong');
    const p = await hub(id).presence();
    expect(p.online).toBe(true);
    expect(p.conn).not.toBe(firstConn);
    const replace = await waitForAudit(id, 'ws.replace');
    expect(replace).toMatchObject({ actor: 'hub', outcome: 'ok', ref: firstConn });
    expect(JSON.parse(replace.meta!)).toEqual({ by: p.conn });
    second.client.ws.close(1000, 'done');
  });
});

describe('frames other than ping', () => {
  // P1 has no handshake, and before `welcome` nothing but the next handshake frame is acceptable (section 5.5).
  for (const [what, frame, reason] of [
    ['a text frame', '{"v":1}', 'no handshake in this build: only ping is accepted'],
    ['a near-miss of ping', 'ping ', 'no handshake in this build: only ping is accepted'],
    ['a binary frame', new Uint8Array([1, 2, 3]), 'binary frame (text frames only)'],
    ['a frame over 64 KiB', 'x'.repeat(64 * 1024 + 1), 'frame larger than 64 KiB'],
  ] as const) {
    test(`${what} closes the socket with 4000 and is audited`, async () => {
      const id = newDeviceId();
      const { client } = await connect(id);
      client.ws.send(frame);
      expect((await client.closed).code).toBe(CLOSE.protocol);
      const row = await waitForAudit(id, 'ws.protocol_error');
      expect(row).toMatchObject({ actor: 'device', outcome: 'rejected', reason });
    });
  }
});

describe('disconnecting', () => {
  test('a closed socket leaves the device absent, with its last-seen time kept, and the close audited', async () => {
    const id = newDeviceId();
    const { client } = await connect(id);
    client.ws.send('ping');
    await client.next();
    const seen = (await hub(id).presence()).last_seen_at;
    client.ws.close(1000, 'bye');
    const row = await waitForAudit(id, 'ws.close');
    expect(row).toMatchObject({ actor: 'device', outcome: 'ok' });
    expect(JSON.parse(row.meta!)).toMatchObject({ code: 1000 });
    const p = await hub(id).presence();
    expect(p).toEqual({ online: false, conn: null, connected_at: null, last_seen_at: seen });
  });
});
