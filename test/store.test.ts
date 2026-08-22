// 集成：状态机 + 持久化（真 node:sqlite，:memory: 隔离）。必须在导入前设 FORGE_DB。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { db } = await import('../src/store/db.ts');

// 护栏：ALL_COLUMNS（patch/读写依据）必须全部是实际建出的表列。漏在 schema.sql 或 db.ts 迁移
// 任一处 → patch 静默丢字段（典型：闸A/闸B 续接丢 session id → 每轮重开会话烧 token）。
test('ALL_COLUMNS ⊆ 实际 session 表列（schema.sql + 迁移合并）', () => {
  const cols = new Set((db().prepare("PRAGMA table_info('session')").all() as { name: string }[]).map((r) => r.name));
  const missing = sessions.ALL_COLUMNS.filter((c) => !cols.has(c));
  assert.deepEqual(missing, [], `ALL_COLUMNS 有列不在实际表里（schema.sql 或 db.ts 迁移漏加）：${missing.join(', ')}`);
});

function mk(id: string) {
  return sessions.create({ id, slug: id, title: `T ${id}`, branch: 'dev', prd_url: `https://x.feishu.cn/wiki/${id}` });
}

test('create → get：初始 INTAKE + 字段落库 + intake 事件', async () => {
  const s = await mk('s1');
  assert.equal(s.state, 'INTAKE');
  assert.equal((await sessions.get('s1'))!.slug, 's1');
  const ev = await sessions.events('s1');
  assert.equal(ev[0].kind, 'intake');
});

test('transition：合法跃迁改状态 + 写 transition 事件', async () => {
  await mk('s2');
  await sessions.transition('s2', 'GATE_A_RUNNING');
  assert.equal((await sessions.get('s2'))!.state, 'GATE_A_RUNNING');
  const kinds = (await sessions.events('s2')).map((e) => e.kind);
  assert.ok(kinds.includes('transition'));
});

test('transition：非法跃迁抛错、状态不变', async () => {
  await mk('s3');
  await assert.rejects(() => sessions.transition('s3', 'DONE'));
  assert.equal((await sessions.get('s3'))!.state, 'INTAKE');
});

test('patch：更新字段 + updated_at 前进', async () => {
  const s = await mk('s4');
  const before = s.updated_at;
  await sessions.patch('s4', { gate_a_cost_usd: 1.5, routing: '{"reviewer":"M"}' });
  const after = (await sessions.get('s4'))!;
  assert.equal(after.gate_a_cost_usd, 1.5);
  assert.equal(after.routing, '{"reviewer":"M"}');
  assert.ok(after.updated_at >= before);
});

test('patch：未知列被忽略（白名单），不报错不写入', async () => {
  await mk('s5');
  // @ts-expect-error 故意传非法列
  await sessions.patch('s5', { not_a_column: 'x', gate_b_cost_usd: 2 });
  assert.equal((await sessions.get('s5'))!.gate_b_cost_usd, 2);
});

test('listByStates：按状态过滤', async () => {
  await mk('s6');
  await mk('s7');
  await sessions.transition('s6', 'GATE_A_RUNNING');
  const running = (await sessions.listByStates(['GATE_A_RUNNING'])).map((s) => s.id);
  assert.ok(running.includes('s6'));
  assert.ok(!running.includes('s7'));
});

test('孤儿自愈两跳：GATE_A_RUNNING→GATE_A_FAILED→INTAKE 可执行且清 error', async () => {
  await mk('s8');
  await sessions.transition('s8', 'GATE_A_RUNNING');
  await sessions.transition('s8', 'GATE_A_FAILED', { error: 'orphan' });
  assert.equal((await sessions.get('s8'))!.error, 'orphan');
  await sessions.transition('s8', 'INTAKE', { error: null });
  const s = (await sessions.get('s8'))!;
  assert.equal(s.state, 'INTAKE');
  assert.equal(s.error, null);
});

test('adversarial_residual 列存取（迁移已补列）', async () => {
  await mk('s9');
  await sessions.patch('s9', { adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'x' }] }) });
  const r = JSON.parse((await sessions.get('s9'))!.adversarial_residual!);
  assert.equal(r.findings.length, 1);
});

test('prd_score 列存取（迁移已补列；JSON 维度回环）', async () => {
  await mk('s11');
  await sessions.patch('s11', {
    prd_score: 72,
    prd_score_dims: JSON.stringify({ clarity: 18, completeness: 15, feasibility: 22, testability: 17 }),
    prd_score_reason: '验收标准缺失',
  });
  const s = (await sessions.get('s11'))!;
  assert.equal(s.prd_score, 72);
  assert.equal(s.prd_score_reason, '验收标准缺失');
  assert.equal(JSON.parse(s.prd_score_dims!).feasibility, 22);
});

test('闸A 多轮列存取（gate_a_round / pending_input / residual，迁移已补列）', async () => {
  await mk('s12');
  await sessions.patch('s12', {
    gate_a_round: 3,
    gate_a_pending_input: 'PM 第3轮答复',
    gate_a_residual: JSON.stringify({ round: 5, open_questions: [{ q: '计费口径', severity: 'high' }] }),
  });
  const s = (await sessions.get('s12'))!;
  assert.equal(s.gate_a_round, 3);
  assert.equal(s.gate_a_pending_input, 'PM 第3轮答复');
  assert.equal(JSON.parse(s.gate_a_residual!).open_questions.length, 1);
});

test('findByPrdUrl：去重入口靠它', async () => {
  await mk('s10');
  const found = await sessions.findByPrdUrl('https://x.feishu.cn/wiki/s10');
  assert.equal(found!.id, 's10');
});

test('issue_ref 唯一索引：同 issue_ref 第二条被 DB 拒（防重复 worktree/PR）；逻辑层可据此回退去重', async () => {
  await sessions.create({ id: 'impl-a', slug: 'impl-a', title: 'A', branch: 'main', source_kind: 'issue', issue_ref: 'org/repo#7' });
  let thrown: unknown = null;
  try {
    await sessions.create({ id: 'impl-b', slug: 'impl-b', title: 'B', branch: 'main', source_kind: 'issue', issue_ref: 'org/repo#7' });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, '同 issue_ref 第二条应被唯一索引拒绝');
  assert.equal(sessions.isDuplicateIssueRefError(thrown), true, '应被识别为 issue_ref 撞索引 → 回退去重');
  assert.equal((await sessions.findByIssueRef('org/repo#7'))!.id, 'impl-a', '去重回退取抢先建好的那条');
});

test('isDuplicateIssueRefError：仅识别 issue_ref 撞唯一索引，不误判 doc_token/其它错', () => {
  assert.equal(sessions.isDuplicateIssueRefError(new Error('UNIQUE constraint failed: session.issue_ref')), true);
  assert.equal(sessions.isDuplicateIssueRefError(new Error('UNIQUE constraint failed: session.doc_ref')), false);
  assert.equal(sessions.isDuplicateIssueRefError(new Error('database is locked')), false);
});

test('listAll(projectId) 按项目过滤 + distinctProjects 去重字母序（查询隔离·Phase 2）', async () => {
  // 用唯一项目 id，免与其它用例（默认 demo）的 session 相互污染。
  await sessions.create({ id: 'iso-a1', slug: 'iso-a1', title: 'T', branch: 'main', project_id: 'iso-acme' } as never);
  await sessions.create({ id: 'iso-a2', slug: 'iso-a2', title: 'T', branch: 'main', project_id: 'iso-acme' } as never);
  await sessions.create({ id: 'iso-b1', slug: 'iso-b1', title: 'T', branch: 'main', project_id: 'iso-beta' } as never);
  assert.deepEqual((await sessions.listAll('iso-acme')).map((s) => s.id).sort(), ['iso-a1', 'iso-a2']); // 仅该项目
  assert.deepEqual((await sessions.listAll('iso-beta')).map((s) => s.id), ['iso-b1']);
  assert.ok((await sessions.listAll()).length >= 3, '无参 → 全库（poller 红线：默认绝不按项目隔离）');
  const projs = await sessions.distinctProjects();
  assert.ok(projs.includes('iso-acme') && projs.includes('iso-beta'), 'distinctProjects 含各项目');
  assert.deepEqual([...projs].sort(), projs, '字母序');
});
