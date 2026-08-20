// 单测：状态页只读 payload 构造（src/health/board.ts）——看板分组/需关注、全量列表+状态过滤、单条详情+事件流。
// 安全断言：payload **绝不含成本/分数**字段（管理面私有，红线）。mock projects 控自治等级、raw SQL 设状态（只测读模型）。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // 动态导入（绝不静态！静态会 hoist 到 FORGE_DB=:memory: 之前 → root.ts 落真库 → 并发串库）。桩回退真配置。

mock.module('../src/projects.ts', {
  namedExports: { projectForSession: (s: { project_id?: string }) => ({ autonomy: { level: s.project_id === 'auto' ? 4 : 0, actor: 'M' } }), configForProject: () => loadConfig(), configForSession: () => loadConfig() },
});

const sessions = await import('../src/store/sessions.ts');
const { db, prep } = await import('../src/store/db.ts');
const board = await import('../src/health/board.ts');

async function mk(id: string, state: string, updatedAt: number, project = 'demo'): Promise<void> {
  await sessions.create({ id, slug: id, title: `T·${id}`, branch: 'main', project_id: project } as never);
  prep('UPDATE session SET state = ?, updated_at = ? WHERE id = ?').run(state, updatedAt, id);
}

// 递归收集 payload 所有键，**深入 events[].detail**（detail 常是 JSON 字符串：能 parse 就扫其键）。
// 隐私红线只扫顶层守不住「以后有人把 costUsd/prd_score 塞进事件流 detail」——故递归到每层键。
function deepKeys(v: unknown, into: string[]): void {
  if (v == null) return;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { deepKeys(JSON.parse(t), into); } catch { /* 非 JSON 文本，不当键扫 */ }
    }
    return;
  }
  if (Array.isArray(v)) { for (const x of v) deepKeys(x, into); return; }
  if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      into.push(k);
      deepKeys(val, into);
    }
  }
}

beforeEach(() => { db().exec('DELETE FROM session; DELETE FROM event_log;'); });

test('boardPayload：按状态分组计数 + 需关注（失败态/待人态，DONE 与运行态不入）按 updatedAt 倒序', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await mk('s2', 'GATE_A_FAILED', 200);
  await mk('s3', 'DONE', 100);
  await mk('s4', 'GATE_C_LOOP', 400);
  const b = await board.boardPayload();
  assert.equal(b.total, 4);
  assert.deepEqual(b.byState, { AWAITING_GO: 1, GATE_A_FAILED: 1, DONE: 1, GATE_C_LOOP: 1 });
  // 需关注：仅 AWAITING_GO(awaiting) + GATE_A_FAILED(failed)；DONE 终态非失败、GATE_C_LOOP 运行态 → 都不入
  assert.deepEqual(b.attention.map((a) => [a.slug, a.kind]), [['s1', 'awaiting'], ['s2', 'failed']]);
});

test('sessionsPayload：全量按 updatedAt 倒序 + 人话 label + 自治等级；states 去重排序；可按状态过滤', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await mk('s2', 'GATE_A_FAILED', 200);
  await mk('s4', 'GATE_C_LOOP', 400, 'auto'); // 该项目自治 L4
  const all = await board.sessionsPayload();
  assert.deepEqual(all.sessions.map((r) => r.slug), ['s4', 's1', 's2']); // updatedAt 倒序
  assert.deepEqual(all.states, ['AWAITING_GO', 'GATE_A_FAILED', 'GATE_C_LOOP']); // 去重排序
  assert.equal(all.sessions[0].autonomy, 4); // auto 项目 → L4
  assert.equal(all.sessions[1].autonomy, 0);
  assert.ok(all.sessions[0].label.length > 0); // 人话 label（display.stateLabel）
  // 过滤
  const only = await board.sessionsPayload('AWAITING_GO');
  assert.deepEqual(only.sessions.map((r) => r.slug), ['s1']);
  assert.deepEqual(only.states, ['AWAITING_GO', 'GATE_A_FAILED', 'GATE_C_LOOP']); // states 仍是全量（喂下拉）
});

test('查询隔离（Phase 2）：sessionsPayload(项目) 仅该项目；projects 列**全库**项目（不随过滤收窄）；项目+状态可叠加', async () => {
  await mk('c1', 'AWAITING_GO', 300, 'demo');
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  await mk('a2', 'DONE', 100, 'acme');
  const demoOnly = await board.sessionsPayload(null, 'demo');
  assert.deepEqual(demoOnly.sessions.map((r) => r.slug), ['c1']); // 仅 demo
  assert.deepEqual(demoOnly.projects, ['acme', 'demo']); // 全库项目（字母序），不因当前只看 demo 而收窄
  assert.deepEqual(demoOnly.states, ['AWAITING_GO']); // 状态集随项目视图（demo 只有这一态）
  const acmeOnly = await board.sessionsPayload(null, 'acme');
  assert.deepEqual(acmeOnly.sessions.map((r) => r.slug).sort(), ['a1', 'a2']);
  // 项目 + 状态叠加
  assert.deepEqual((await board.sessionsPayload('GATE_A_FAILED', 'acme')).sessions.map((r) => r.slug), ['a1']);
});

test('查询隔离（Phase 2）：boardPayload(项目) 只统计该项目', async () => {
  await mk('c1', 'AWAITING_GO', 300, 'demo');
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  await mk('a2', 'GATE_A_FAILED', 100, 'acme');
  const b = await board.boardPayload('acme');
  assert.equal(b.total, 2);
  assert.deepEqual(b.byState, { GATE_A_FAILED: 2 });
  assert.deepEqual(b.attention.map((x) => x.slug).sort(), ['a1', 'a2']); // 仅 acme 的需关注
  // 全局（无项目）仍统计全库
  assert.equal((await board.boardPayload()).total, 3);
});

test('收 Codex SF1：未知/空白 ?project= 回退「全部」而非空视图；空白串当无过滤', async () => {
  await mk('c1', 'AWAITING_GO', 300, 'demo');
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  // 纯未知项目（既没注册也无需求）→ 回退全部，绝不空
  assert.equal((await board.boardPayload('ghost-typo')).total, 2);
  assert.equal((await board.sessionsPayload(null, 'ghost-typo')).sessions.length, 2);
  assert.equal((await board.sessionsPayload(null, '   ')).sessions.length, 2); // 空白 → 全部
  // 已知项目仍正常收窄
  assert.equal((await board.boardPayload('acme')).total, 1);
});

test('收 Codex SF2：sessionDetail 项目守门——项目视图下不跨项目读详情；未知项目不约束', async () => {
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  await mk('c1', 'AWAITING_GO', 100, 'demo'); // 让 demo 成为「已知」项目（守门只对已知项目生效）
  assert.equal((await board.sessionDetail('a1', 'acme'))!.slug, 'a1'); // 属该项目 → 正常
  assert.equal(await board.sessionDetail('a1', 'demo'), null); // demo 已知且 a1 不属它 → null（404）
  assert.equal((await board.sessionDetail('a1'))!.slug, 'a1'); // 无项目上下文（全部视图）→ 不约束
  assert.equal((await board.sessionDetail('a1', 'ghost'))!.slug, 'a1'); // 未知项目 → normProject 归 undefined → 不约束
});

test('sessionDetail：返回运营态字段 + 事件时间线（末 200）；未知 → null', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await sessions.appendEvent('s1', 'gate_a_done', { round: 1 });
  await sessions.appendEvent('s1', 'needs_go', null);
  const d = (await board.sessionDetail('s1'))!;
  assert.equal(d.slug, 's1');
  assert.equal(d.state, 'AWAITING_GO');
  assert.ok(d.label.length > 0);
  assert.equal(d.project, 'demo');
  assert.equal(d.events.length, 3); // create 落的 intake + 追加的 2 条
  assert.equal(d.events[0].kind, 'intake'); // 按 id ASC（时间序）
  const ga = d.events.find((e) => e.kind === 'gate_a_done')!;
  assert.match(ga.detail ?? '', /round/);
  assert.equal(await board.sessionDetail('does-not-exist'), null);
});

test('安全红线：列表/详情 payload（递归含事件 detail）绝不含成本/分数字段（管理面私有）', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await sessions.appendEvent('s1', 'gate_a_done', { round: 1, verdict: 'pass' });
  const row = (await board.sessionsPayload()).sessions[0];
  const det = (await board.sessionDetail('s1'))!;
  const keys: string[] = [];
  deepKeys(row, keys);
  deepKeys(det, keys);
  assert.ok(keys.includes('round'), '递归须深入 events[].detail，否则守不住塞进 detail 的成本字段');
  for (const k of keys) {
    assert.ok(!/cost|score|usd|token|\$/i.test(k), `payload 不应暴露成本/分数字段：${k}`);
  }
});
