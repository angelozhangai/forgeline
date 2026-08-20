// 集成：remoteApi 垂直切片——runner 经**真 HTTP 回环**读写控制面 SessionStore（状态在中心、runner 远程读写）。
// 证明 client(runner, makeRemoteStore) ↔ server(控制面, handleStoreCall(localSqliteStore)) 的 wire 契约对齐：
// RPC 信封序列化 + HTTP + 解析 + 业务错误/纯谓词跨网保真。必须在导入前设 FORGE_DB（真 node:sqlite，:memory:）。
// 不设 FORGE_CONTROL_URL——本测试自起 server + 手造 remote client，不污染别处 `store` 选择点。
process.env.FORGE_DB = ':memory:';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';

const { localSqliteStore } = await import('../src/store/sessions.ts');
const { makeRemoteStore, handleStoreCall } = await import('../src/store/remote.ts');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// 控制面：以 localSqliteStore 为后端的 /store RPC 端点（=未来挂进控制面 server 的那段）。
const server: Server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/store') {
    const out = await handleStoreCall(localSqliteStore, await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out);
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

const remote = makeRemoteStore(baseUrl);

test('remoteApi：create → get/patch/transition/event 全链（经 HTTP，与控制面同库）', async () => {
  const s = await remote.create({ id: 'rm1', slug: 'rm1', title: 'T', branch: 'dev', prd_url: 'https://x.feishu.cn/wiki/rm1' });
  assert.equal(s.state, 'INTAKE');
  assert.equal((await remote.get('rm1'))!.slug, 'rm1');
  // 经 HTTP 写的，控制面后端直读得到（证明真打到同一后端、非两套状态）。
  assert.equal((await localSqliteStore.get('rm1'))!.slug, 'rm1');

  await remote.patch('rm1', { title: 'T2' });
  assert.equal((await remote.get('rm1'))!.title, 'T2');

  await remote.transition('rm1', 'GATE_A_RUNNING' as never);
  assert.equal((await remote.get('rm1'))!.state, 'GATE_A_RUNNING');

  await remote.appendEvent('rm1', 'note', { k: 1 });
  const kinds = (await remote.events('rm1')).map((e) => e.kind);
  assert.ok(kinds.includes('intake') && kinds.includes('transition') && kinds.includes('note'));
});

test('remoteApi：非法转移 → 抛（业务错误经信封回传原 message，非 HTTP 4xx）', async () => {
  await remote.create({ id: 'rm2', slug: 'rm2', title: 'T', branch: 'dev' });
  await assert.rejects(() => remote.transition('rm2', 'DONE' as never), /illegal transition/);
});

test('remoteApi：撞 doc_token 唯一索引 → reject，isDuplicateTokenError 跨网仍可分类（原 message 保真）', async () => {
  await remote.create({ id: 'rm3a', slug: 'rm3a', title: 'T', branch: 'dev', feishu_doc_token: 'tok-dup' });
  let err: unknown;
  try {
    await remote.create({ id: 'rm3b', slug: 'rm3b', title: 'T', branch: 'dev', feishu_doc_token: 'tok-dup' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '第二次撞唯一索引应抛');
  // 纯谓词在 client 本地对 rejected error 跑 message 正则——证明 server→client message 保真。
  assert.equal(remote.isDuplicateTokenError(err), true);
  assert.equal(remote.isDuplicateIssueRefError(err), false);
});

test('remoteApi：listByStates 过滤（经 HTTP，Session 字段往返完整非只 id/state）', async () => {
  await remote.create({ id: 'rm4', slug: 'rm4', title: 'T', branch: 'dev', state: 'AWAITING_GO' as never });
  const go = await remote.listByStates(['AWAITING_GO'] as never);
  const hit = go.find((s) => s.id === 'rm4');
  assert.ok(hit, 'AWAITING_GO 应被列出');
  assert.equal(hit.branch, 'dev'); // 字段经 JSON 往返完整
});

test('remoteApi：每个读/查找/聚合方法都经 HTTP 往返且方法名对齐（防 wrapper method 字符串拼错静默失效）', async () => {
  // 造一条带去重键/PRD/项目的 session，覆盖各查找路径。
  await remote.create({
    id: 'rm6', slug: 'rm6-slug', title: 'T', branch: 'dev',
    prd_url: 'https://x.feishu.cn/wiki/rm6', feishu_doc_token: 'tok-rm6',
    source_kind: 'issue', issue_ref: 'owner/repo#6', project_id: 'projX',
  });
  await remote.appendEvent('rm6', 'note', { n: 1 });

  // 每个方法经 remote 取到 → 证明 wrapper 的 method 字符串拼对（拼错则后端无此分发、取不到 rm6 立刻暴雷）。
  assert.equal((await remote.findByIssueRef('owner/repo#6'))?.id, 'rm6');
  assert.equal((await remote.getBySlug('rm6-slug'))?.id, 'rm6');
  assert.equal((await remote.findByPrdUrl('https://x.feishu.cn/wiki/rm6'))?.id, 'rm6');
  assert.equal((await remote.findByDocToken('tok-rm6'))?.id, 'rm6');
  assert.equal((await remote.resolve('rm6-slug'))?.id, 'rm6');
  assert.ok((await remote.listAll('projX')).some((s) => s.id === 'rm6'));
  assert.ok((await remote.distinctProjects()).includes('projX'));
  assert.equal(typeof (await remote.countByState()), 'object');
  assert.ok((await remote.countByStates(['INTAKE'] as never)) >= 1);
  assert.equal(typeof (await remote.lastEventTs('rm6', 'note')), 'number');
});

test('remoteApi：控制面不可达 → 抛（失败不静默，runner 不把读写失败当无状态）', async () => {
  const dead = makeRemoteStore('http://127.0.0.1:1'); // 1 端口不可达
  await assert.rejects(() => dead.get('whatever'));
});

test('remoteApi：HTTP 非 2xx → 抛（传输失败 vs 业务错误两分）', async () => {
  const err = createServer((_q, s) => { s.writeHead(500); s.end('boom'); });
  await new Promise<void>((r) => err.listen(0, '127.0.0.1', () => r()));
  const a = err.address();
  const p = typeof a === 'object' && a ? a.port : 0;
  try {
    await assert.rejects(() => makeRemoteStore(`http://127.0.0.1:${p}`).get('x'), /HTTP 500/);
  } finally {
    err.close();
  }
});

test('remoteApi：baseUrl 末尾斜杠归一（不打成 //store）', async () => {
  const r = makeRemoteStore(`${baseUrl}/`);
  await r.create({ id: 'rm5', slug: 'rm5', title: 'T', branch: 'dev' }); // 命中 /store（404 会抛）
  assert.equal((await r.get('rm5'))!.id, 'rm5');
});

test('handleStoreCall：非白名单 method 拒绝（防任意方法 / 原型链注入）', async () => {
  const out = JSON.parse(await handleStoreCall(localSqliteStore, JSON.stringify({ method: 'constructor', args: [] })));
  assert.equal(out.ok, false);
  assert.match(out.error, /非法 method/);
});

test('handleStoreCall：args 非数组 / 坏 JSON → 信封 ok:false（不信任外部输入）', async () => {
  const bad1 = JSON.parse(await handleStoreCall(localSqliteStore, JSON.stringify({ method: 'get', args: 'nope' })));
  assert.equal(bad1.ok, false);
  assert.match(bad1.error, /args 非数组/);
  const bad2 = JSON.parse(await handleStoreCall(localSqliteStore, '{bad json'));
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /非法 JSON/);
});
