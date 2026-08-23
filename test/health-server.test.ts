// The health service's routing: start it on a temporary port, then /healthz -> 200 ok, /health -> JSON,
// / -> HTML, and anything unknown -> 404.
// Isolation: FORGE_DB=:memory:, and FORGE_HEARTBEAT pointing at a temporary file that does not exist (the
// case where the daemon is not running).
process.env.FORGE_DB = ':memory:';
process.env.FORGE_HEARTBEAT = '/tmp/forge-test-hb-server-absent.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
// A dynamic import: root.ts must not load until FORGE_DB and FORGE_HEARTBEAT are set (a static import would
// evaluate before the env assignments).
const { startHealthServer } = await import('../src/health/server.ts');
const sessions = await import('../src/store/sessions.ts');

test('the health service: the /healthz, /health, / and 404 routes', async () => {
  rmSync('/tmp/forge-test-hb-server-absent.json', { force: true });
  const server = startHealthServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
    assert.equal((await hz.text()).trim(), 'ok');

    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    const body = (await h.json()) as { status: string; checks: unknown[] };
    assert.ok(['healthy', 'degraded', 'down'].includes(body.status));
    assert.ok(Array.isArray(body.checks));

    const board = await fetch(`${base}/api/board`);
    assert.equal(board.status, 200);
    const bj = (await board.json()) as { byState: Record<string, number>; total: number };
    assert.equal(typeof bj.total, 'number');

    const hist = await fetch(`${base}/api/history?hours=24`);
    assert.equal(hist.status, 200);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Forge/);

    const nf = await fetch(`${base}/nope`);
    assert.equal(nf.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// A regression net on query isolation at the HTTP layer (the extra layer Codex suggested): ?project= really
// filters through server -> board -> store; an unknown project falls back to everything; and a detail read
// across projects gives a 404.
test('the health service, query isolation: /api/board, /api/sessions and /api/session honour ?project= (an unknown one falls back to everything, and the detail view is gated across projects)', async () => {
  await sessions.create({ id: 'hs-c1', slug: 'hs-c1', title: 'T', branch: 'main', project_id: 'demo' } as never);
  await sessions.create({ id: 'hs-a1', slug: 'hs-a1', title: 'T', branch: 'main', project_id: 'acme' } as never);
  await sessions.create({ id: 'hs-a2', slug: 'hs-a2', title: 'T', branch: 'main', project_id: 'acme' } as never);
  const server = startHealthServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string) => (await fetch(`${base}${p}`)).json();
  try {
    assert.equal(((await j('/api/board?project=acme')) as { total: number }).total, 2); // acme only
    assert.equal(((await j('/api/board?project=ghost')) as { total: number }).total, 3); // unknown -> everything (never empty)
    const sAcme = (await j('/api/sessions?project=acme')) as { sessions: { slug: string }[]; projects: string[] };
    assert.deepEqual(sAcme.sessions.map((r) => r.slug).sort(), ['hs-a1', 'hs-a2']);
    assert.ok(sAcme.projects.includes('demo') && sAcme.projects.includes('acme'), 'projects lists every project in the database (it feeds the dropdown)');
    // The detail view's project gate
    assert.equal((await fetch(`${base}/api/session?id=hs-a1&project=acme`)).status, 200); // it belongs to acme
    assert.equal((await fetch(`${base}/api/session?id=hs-a1&project=demo`)).status, 404); // across projects -> 404
    assert.equal((await fetch(`${base}/api/session?id=hs-a1&project=ghost`)).status, 200); // an unknown project -> no constraint
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
