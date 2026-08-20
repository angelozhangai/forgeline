// 集成：remotePull 垂直切片——runner 经**真 HTTP 回环**从控制面 /jobs 拉到期 job（GitHub-runner 模式）。
// 证明 client(runner) ↔ server(控制面，dueJobsPayload(localJobSource)) 的 wire 契约对齐：序列化 + HTTP + 解析。
// 必须在导入前设 FORGE_DB（真 node:sqlite，:memory:）。
process.env.FORGE_DB = ':memory:';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const { store } = await import('../src/store/index.ts');
const { localJobSource } = await import('../src/orchestrator/jobs/local.ts');
const { makeRemoteJobSource, dueJobsPayload } = await import('../src/orchestrator/jobs/remote.ts');

// 控制面：以 localJobSource 为后端的 /jobs HTTP 端点（=未来挂进控制面 server 的那段）。
const server: Server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/jobs') {
    const limit = Number(u.searchParams.get('limit')) || 100; // runner 带的本轮容量（缺省宽松）
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(await dueJobsPayload(localJobSource, limit));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const baseUrl = `http://127.0.0.1:${port}`;
after(() => server.close());

function mk(id: string, state: string): void {
  store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

test('remotePull：经 HTTP 从控制面 /jobs 拉到期 job（只 POLLER_DRIVEN，跨进程序列化往返一致）', async () => {
  mk('r-intake', 'INTAKE'); // 到期
  mk('r-dloop', 'GATE_D_LOOP'); // 到期
  mk('r-go', 'AWAITING_GO'); // 人等态——不该被拉到
  const remote = makeRemoteJobSource(baseUrl);
  const jobs = await remote.claimDueJobs(100);
  assert.deepEqual(jobs.map((s) => s.id).sort(), ['r-dloop', 'r-intake']);
  // 字段经 JSON 往返完整（非只 id/state）：slug/branch 等也回得来。
  const intake = jobs.find((s) => s.id === 'r-intake');
  assert.equal(intake?.slug, 'r-intake');
  assert.equal(intake?.branch, 'dev');
});

test('remotePull：baseUrl 末尾斜杠归一（不打成 //jobs）', async () => {
  const remote = makeRemoteJobSource(`${baseUrl}/`);
  const jobs = await remote.claimDueJobs(100); // 命中 /jobs（404 会抛）
  assert.ok(Array.isArray(jobs));
});

test('remotePull：控制面不可达 → 抛（失败不静默，runner 不把拉不到当无活）', async () => {
  const dead = makeRemoteJobSource('http://127.0.0.1:1'); // 1 端口不可达
  await assert.rejects(() => dead.claimDueJobs(100));
});

test('remotePull：坏 payload（非数组）→ 抛（绝不信任外部输入）', async () => {
  const bad = createServer((_q, s) => {
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end('{"not":"an array"}');
  });
  await new Promise<void>((r) => bad.listen(0, '127.0.0.1', () => r()));
  const a = bad.address();
  const p = typeof a === 'object' && a ? a.port : 0;
  try {
    await assert.rejects(() => makeRemoteJobSource(`http://127.0.0.1:${p}`).claimDueJobs(100), /非数组/);
  } finally {
    bad.close();
  }
});

test('remotePull：HTTP 非 2xx → 抛', async () => {
  const remote = makeRemoteJobSource(baseUrl);
  // /jobs 之外的路径 server 回 404 —— 但 remotePull 固定打 /jobs，这里用一个总是 500 的 server 验非 2xx。
  const err = createServer((_q, s) => { s.writeHead(500); s.end('boom'); });
  await new Promise<void>((r) => err.listen(0, '127.0.0.1', () => r()));
  const a = err.address();
  const p = typeof a === 'object' && a ? a.port : 0;
  try {
    await assert.rejects(() => makeRemoteJobSource(`http://127.0.0.1:${p}`).claimDueJobs(100), /HTTP 500/);
  } finally {
    err.close();
  }
  void remote;
});
