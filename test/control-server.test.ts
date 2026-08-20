// 集成：控制面 server——真 HTTP 回环验证「control plane / runner 分离」的控制面进程：
// runner（makeRemoteJobSource/makeRemoteStore）经它拉 job + 读写中心状态；鉴权边界 + 两道 fail-closed。
// 必须在导入前设 FORGE_DB（真 node:sqlite，:memory:）。**不设** FORGE_CONTROL_URL（否则 store/jobSource 变远端 +
// 触发 fail-closed②）——本进程当「控制面」。
process.env.FORGE_DB = ':memory:';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const { startControlServer } = await import('../src/control/server.ts');
const { store } = await import('../src/store/index.ts');
const { makeRemoteStore } = await import('../src/store/remote.ts');
const { makeRemoteJobSource } = await import('../src/orchestrator/jobs/remote.ts');

async function start(opts: { port: number; host?: string; token?: string }): Promise<{ server: Server; base: string }> {
  const server = await startControlServer(opts); // resolve = 已 listening（绑定就绪）
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function mk(id: string, state: string): Promise<unknown> {
  return store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

const TOKEN = 'sekret-123';
const { server: authed, base } = await start({ port: 0, token: TOKEN });
after(() => authed.close());

test('control：/healthz 无鉴权 → 200 ok（纯存活探针）', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('control：/jobs 带 token → 拉到 POLLER_DRIVEN 到期 job（人等态不拉）', async () => {
  await mk('c-intake', 'INTAKE'); // 到期
  await mk('c-go', 'AWAITING_GO'); // 人等态——不该被拉
  const jobs = await makeRemoteJobSource(base, TOKEN).claimDueJobs(100);
  const ids = jobs.map((s) => s.id);
  assert.ok(ids.includes('c-intake'), 'INTAKE 应被拉');
  assert.ok(!ids.includes('c-go'), 'AWAITING_GO 不该被拉');
});

test('control：/jobs lease——两 runner 不重领同一 job（A 领走，B 同刻拿空）', async () => {
  await mk('c-lease', 'GATE_B_REQUESTED'); // POLLER_DRIVEN，到期
  const A = makeRemoteJobSource(base, TOKEN, 'runnerA');
  const B = makeRemoteJobSource(base, TOKEN, 'runnerB');
  const a = await A.claimDueJobs(100);
  assert.ok(a.some((s) => s.id === 'c-lease'), 'runnerA 应领到 c-lease');
  const b = await B.claimDueJobs(100);
  assert.ok(!b.some((s) => s.id === 'c-lease'), 'runnerB 不该重领 c-lease（A 已占租）');
  // 落库 owner = A（控制面据 ?runner 记租约）。
  assert.equal((await store.get('c-lease'))!.lease_owner, 'runnerA');
});

test('control：/store 带 token → runner 读写中心状态（同库）', async () => {
  const remote = makeRemoteStore(base, TOKEN);
  await remote.create({ id: 'c-store', slug: 'c-store', title: 'T', branch: 'dev' });
  await remote.transition('c-store', 'GATE_A_RUNNING' as never);
  assert.equal((await remote.get('c-store'))!.state, 'GATE_A_RUNNING');
  // 经控制面 HTTP 写的，控制面后端直读得到（证明真打到中心库、非两套状态）。
  assert.equal((await store.get('c-store'))!.state, 'GATE_A_RUNNING');
});

test('control：/jobs 无 token → 401（鉴权边界设防读路径）', async () => {
  await assert.rejects(() => makeRemoteJobSource(base).claimDueJobs(100), /HTTP 401/);
});

test('control：/store 无 token → 401（写路径也设防）', async () => {
  await assert.rejects(() => makeRemoteStore(base).get('whatever'), /HTTP 401/);
});

test('control：错 token → 401（shared secret 不匹配，timingSafeEqual）', async () => {
  await assert.rejects(() => makeRemoteStore(base, 'wrong-token').get('x'), /HTTP 401/);
});

test('control：未知路径 → 404', async () => {
  const res = await fetch(`${base}/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
});

test('control：回环 + 无 token → 放行（本机开发，无鉴权但只绑 127.0.0.1）', async () => {
  const { server, base: b } = await start({ port: 0 }); // 无 token，回环默认
  try {
    const jobs = await makeRemoteJobSource(b).claimDueJobs(100); // 无 Authorization 也通
    assert.ok(Array.isArray(jobs));
  } finally {
    server.close();
  }
});

test('control：非回环 + 无 token → fail-closed① 拒绝启动（同步抛，绝不无鉴权暴露读写）', () => {
  assert.throws(() => startControlServer({ port: 0, host: '0.0.0.0' }), /拒绝在非回环/);
});

test('control：配了端口却绑定失败(EADDRINUSE) → reject（fail-fast，不半启动以「无控制面」形态活着）', async () => {
  const a = authed.address(); // authed 已占着这个端口
  const occupied = typeof a === 'object' && a ? a.port : 0;
  await assert.rejects(() => startControlServer({ port: occupied, token: TOKEN }), /绑定失败|被占用/);
});

test('control：进程设了 FORGE_CONTROL_URL → fail-closed② 拒绝启动（控制面不应是 runner）', () => {
  process.env.FORGE_CONTROL_URL = 'http://somewhere';
  try {
    assert.throws(() => startControlServer({ port: 0, token: TOKEN }), /不应设 FORGE_CONTROL_URL/);
  } finally {
    delete process.env.FORGE_CONTROL_URL;
  }
});
