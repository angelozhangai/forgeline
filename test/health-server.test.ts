// 健康服务路由：临时端口起服务，/healthz→200 ok、/health→JSON、/→HTML、未知→404。
// 隔离：FORGE_DB=:memory:、FORGE_HEARTBEAT 指到不存在的临时文件（守护未运行场景）。
process.env.FORGE_DB = ':memory:';
process.env.FORGE_HEARTBEAT = '/tmp/forge-test-hb-server-absent.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
// 动态 import：须等设好 FORGE_DB/FORGE_HEARTBEAT 再载入 root.ts（静态 import 会在 env 赋值前求值）。
const { startHealthServer } = await import('../src/health/server.ts');
const sessions = await import('../src/store/sessions.ts');

test('健康服务：/healthz /health / 与 404 路由', async () => {
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

// 查询隔离的 HTTP 路由防回归（收 Codex 建议补的一层网）：?project= 真经 server→board→store 过滤；未知回退全部；详情跨项目 404。
test('健康服务·查询隔离：/api/board /api/sessions /api/session 接 ?project=（未知回退全部、详情跨项目守门）', async () => {
  await sessions.create({ id: 'hs-c1', slug: 'hs-c1', title: 'T', branch: 'main', project_id: 'demo' } as never);
  await sessions.create({ id: 'hs-a1', slug: 'hs-a1', title: 'T', branch: 'main', project_id: 'acme' } as never);
  await sessions.create({ id: 'hs-a2', slug: 'hs-a2', title: 'T', branch: 'main', project_id: 'acme' } as never);
  const server = startHealthServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string) => (await fetch(`${base}${p}`)).json();
  try {
    assert.equal(((await j('/api/board?project=acme')) as { total: number }).total, 2); // 仅 acme
    assert.equal(((await j('/api/board?project=ghost')) as { total: number }).total, 3); // 未知 → 全部（不空）
    const sAcme = (await j('/api/sessions?project=acme')) as { sessions: { slug: string }[]; projects: string[] };
    assert.deepEqual(sAcme.sessions.map((r) => r.slug).sort(), ['hs-a1', 'hs-a2']);
    assert.ok(sAcme.projects.includes('demo') && sAcme.projects.includes('acme'), 'projects 列全库（喂下拉）');
    // 详情项目守门
    assert.equal((await fetch(`${base}/api/session?id=hs-a1&project=acme`)).status, 200); // 属 acme
    assert.equal((await fetch(`${base}/api/session?id=hs-a1&project=demo`)).status, 404); // 跨项目 → 404
    assert.equal((await fetch(`${base}/api/session?id=hs-a1&project=ghost`)).status, 200); // 未知项目 → 不约束
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
