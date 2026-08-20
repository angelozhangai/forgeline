// 集成：Web 面板写网关（action-gateway + server POST /api/action）。起真 http server、mock actions 捕获派发。
// 验：状态→动作映射；合法动作派到真 action（as web_actor=lead）+ panel_action 审计；未知动作/找不到需求 → !ok；
// 安全闸——跨源 Origin → 403、非 application/json → 415；GET /api/session 详情带该态可用 actions。
process.env.FORGE_DB = ':memory:';
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

const calls: { name: string; id: string; by?: string }[] = [];
const sync = (name: string) => (id: string, by: string) => { calls.push({ name, id, by }); return { ok: true, msg: `ok·${name}` }; };
const asyncFn = (name: string) => async (id: string, by: string) => { calls.push({ name, id, by }); return { ok: true, msg: `ok·${name}` }; };
mock.module('../src/actions.ts', {
  namedExports: {
    confirm: sync('confirm'),
    requestGateB: asyncFn('requestGateB'),
    forceGateBGo: asyncFn('forceGateBGo'),
    go: asyncFn('go'),
    deny: sync('deny'),
    requestGateC: sync('requestGateC'),
    requestReviewPr: sync('requestReviewPr'),
    ackMerged: asyncFn('ackMerged'),
    retry: (id: string, by: string) => { calls.push({ name: 'retry', id, by }); return { ok: true, msg: 'ok·retry' }; },
  },
});
mock.module('../src/projects.ts', { namedExports: { projectForSession: () => ({ autonomy: { level: 0, actor: 'M' } }), configForProject: () => loadConfig(), configForSession: () => loadConfig() } });

const sessions = await import('../src/store/sessions.ts');
const { db, prep } = await import('../src/store/db.ts');
const { startHealthServer } = await import('../src/health/server.ts');
const { panelActionsFor } = await import('../src/health/action-gateway.ts');

const PORT = 4398;
let server: ReturnType<typeof startHealthServer>;
before(() => { server = startHealthServer(PORT); });
after(() => server?.close());
beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); calls.length = 0; });

async function mk(id: string, state: string): Promise<void> {
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  prep('UPDATE session SET state = ? WHERE id = ?').run(state, id);
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('panelActionsFor：关键态映射；确定性闸/运行态不给按钮（红线：面板不提供跳过）', () => {
  assert.deepEqual(panelActionsFor('AWAITING_GO' as never), ['go', 'deny']);
  assert.deepEqual(panelActionsFor('CONFIRMED' as never), ['gateb']);
  assert.deepEqual(panelActionsFor('AWAITING_HUMAN_MERGE' as never), ['merged']);
  assert.deepEqual(panelActionsFor('WRITE_FAILED' as never), ['go']); // planRetry 对 WRITE_FAILED 返 null → 须重跑 go，不是 retry
  assert.deepEqual(panelActionsFor('GATE_C_STALLED' as never), []); // CI 没绿，面板也不给「跳过」
  assert.deepEqual(panelActionsFor('GATE_C_LOOP' as never), []); // 运行态无按钮
});

test('POST /api/action：合法动作 → 派到真 action（as web_actor=routing.lead=M）+ panel_action 审计 + 200', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await post({ action: 'gateb', slug: 's1' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ name: 'requestGateB', id: 's1', by: 'M' }]); // 真 action 被调、署名 lead
  assert.ok((await sessions.events('s1')).some((e) => e.kind === 'panel_action'));
});

test('POST /api/action：动作不属当前态 BY_STATE → !ok 400，绝不派发（SF1：服务端兜底，不只前端展示）', async () => {
  await mk('s1', 'CONFIRMED'); // CONFIRMED 的面板按钮只有 gateb；go 虽在 DISPATCH 且真 go 可能放行，但面板策略不提供 → 服务端拦
  const r = await post({ action: 'go', slug: 's1' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
  assert.equal(calls.length, 0); // 绝不派到真 action
});

test('POST /api/action：未知动作 → !ok 400，绝不派发', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await post({ action: 'nuke', slug: 's1' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
  assert.equal(calls.length, 0);
});

test('POST /api/action：找不到需求 → !ok 400', async () => {
  const r = await post({ action: 'gateb', slug: 'ghost' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('POST /api/action：跨源 Origin → 403（CSRF 闸：防恶意网页 drive-by POST 到 localhost）', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await post({ action: 'gateb', slug: 's1' }, { Origin: 'http://evil.example.com' });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test('POST /api/action：非 application/json → 415（表单 POST 设不了该 content-type，挡 CSRF）', async () => {
  await mk('s1', 'CONFIRMED');
  const r = await fetch(`http://127.0.0.1:${PORT}/api/action`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  assert.equal(calls.length, 0);
});

test('GET /api/session：详情带该状态可用 actions（喂前端画按钮）', async () => {
  await mk('s1', 'AWAITING_GO');
  const j = await (await fetch(`http://127.0.0.1:${PORT}/api/session?id=s1`)).json();
  assert.deepEqual(j.actions, ['go', 'deny']);
});
