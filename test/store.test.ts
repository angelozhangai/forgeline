// Integration: the state machine plus persistence (real node:sqlite, isolated with :memory:). FORGE_DB must be
// set before the imports.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { db } = await import('../src/store/db.ts');

// A guardrail: every entry in ALL_COLUMNS (what patch and the reads and writes are keyed on) must be a column
// that actually exists. Missing one from either schema.sql or the db.ts migrations makes patch silently drop
// that field - the classic symptom being Gate A or Gate B losing its session id, so every round opens a fresh
// session and burns tokens.
test('ALL_COLUMNS is a subset of the real session table columns (schema.sql plus the migrations)', () => {
  const cols = new Set((db().prepare("PRAGMA table_info('session')").all() as { name: string }[]).map((r) => r.name));
  const missing = sessions.ALL_COLUMNS.filter((c) => !cols.has(c));
  assert.deepEqual(missing, [], `ALL_COLUMNS names columns that are not in the real table (schema.sql or a db.ts migration is missing them): ${missing.join(', ')}`);
});

function mk(id: string) {
  return sessions.create({ id, slug: id, title: `T ${id}`, branch: 'dev', prd_url: `https://x.feishu.cn/wiki/${id}` });
}

test('create -> get: it starts at INTAKE, the fields are persisted, and an intake event is recorded', async () => {
  const s = await mk('s1');
  assert.equal(s.state, 'INTAKE');
  assert.equal((await sessions.get('s1'))!.slug, 's1');
  const ev = await sessions.events('s1');
  assert.equal(ev[0].kind, 'intake');
});

test('transition: a legal transition changes the state and writes a transition event', async () => {
  await mk('s2');
  await sessions.transition('s2', 'GATE_A_RUNNING');
  assert.equal((await sessions.get('s2'))!.state, 'GATE_A_RUNNING');
  const kinds = (await sessions.events('s2')).map((e) => e.kind);
  assert.ok(kinds.includes('transition'));
});

test('transition: an illegal transition throws and the state does not change', async () => {
  await mk('s3');
  await assert.rejects(() => sessions.transition('s3', 'DONE'));
  assert.equal((await sessions.get('s3'))!.state, 'INTAKE');
});

test('patch: updates the fields and moves updated_at forward', async () => {
  const s = await mk('s4');
  const before = s.updated_at;
  await sessions.patch('s4', { gate_a_cost_usd: 1.5, routing: '{"reviewer":"M"}' });
  const after = (await sessions.get('s4'))!;
  assert.equal(after.gate_a_cost_usd, 1.5);
  assert.equal(after.routing, '{"reviewer":"M"}');
  assert.ok(after.updated_at >= before);
});

test('patch: unknown columns are ignored (the allowlist), with no error and no write', async () => {
  await mk('s5');
  // @ts-expect-error deliberately passing a column that does not exist
  await sessions.patch('s5', { not_a_column: 'x', gate_b_cost_usd: 2 });
  assert.equal((await sessions.get('s5'))!.gate_b_cost_usd, 2);
});

test('listByStates: filters by state', async () => {
  await mk('s6');
  await mk('s7');
  await sessions.transition('s6', 'GATE_A_RUNNING');
  const running = (await sessions.listByStates(['GATE_A_RUNNING'])).map((s) => s.id);
  assert.ok(running.includes('s6'));
  assert.ok(!running.includes('s7'));
});

test('orphan self-healing in two hops: GATE_A_RUNNING -> GATE_A_FAILED -> INTAKE is legal and clears the error', async () => {
  await mk('s8');
  await sessions.transition('s8', 'GATE_A_RUNNING');
  await sessions.transition('s8', 'GATE_A_FAILED', { error: 'orphan' });
  assert.equal((await sessions.get('s8'))!.error, 'orphan');
  await sessions.transition('s8', 'INTAKE', { error: null });
  const s = (await sessions.get('s8'))!;
  assert.equal(s.state, 'INTAKE');
  assert.equal(s.error, null);
});

test('the adversarial_residual column reads and writes (the migration added it)', async () => {
  await mk('s9');
  await sessions.patch('s9', { adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'x' }] }) });
  const r = JSON.parse((await sessions.get('s9'))!.adversarial_residual!);
  assert.equal(r.findings.length, 1);
});

test('the prd_score columns read and write (the migration added them; the JSON dimensions round-trip)', async () => {
  await mk('s11');
  await sessions.patch('s11', {
    prd_score: 72,
    prd_score_dims: JSON.stringify({ clarity: 18, completeness: 15, feasibility: 22, testability: 17 }),
    prd_score_reason: 'the acceptance criteria are missing',
  });
  const s = (await sessions.get('s11'))!;
  assert.equal(s.prd_score, 72);
  assert.equal(s.prd_score_reason, 'the acceptance criteria are missing');
  assert.equal(JSON.parse(s.prd_score_dims!).feasibility, 22);
});

test('the Gate A multi-round columns read and write (gate_a_round / pending_input / residual, added by the migration)', async () => {
  await mk('s12');
  await sessions.patch('s12', {
    gate_a_round: 3,
    gate_a_pending_input: "the PM's round-3 answer",
    gate_a_residual: JSON.stringify({ round: 5, open_questions: [{ q: 'how is billing calculated', severity: 'high' }] }),
  });
  const s = (await sessions.get('s12'))!;
  assert.equal(s.gate_a_round, 3);
  assert.equal(s.gate_a_pending_input, "the PM's round-3 answer");
  assert.equal(JSON.parse(s.gate_a_residual!).open_questions.length, 1);
});

test('findByPrdUrl: the deduplication entry point relies on it', async () => {
  await mk('s10');
  const found = await sessions.findByPrdUrl('https://x.feishu.cn/wiki/s10');
  assert.equal(found!.id, 's10');
});

test('the issue_ref unique index: a second row with the same issue_ref is rejected by the database (which prevents a duplicate worktree and PR), and the logic layer falls back to deduplication', async () => {
  await sessions.create({ id: 'impl-a', slug: 'impl-a', title: 'A', branch: 'main', source_kind: 'issue', issue_ref: 'org/repo#7' });
  let thrown: unknown = null;
  try {
    await sessions.create({ id: 'impl-b', slug: 'impl-b', title: 'B', branch: 'main', source_kind: 'issue', issue_ref: 'org/repo#7' });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'the second row with the same issue_ref should be rejected by the unique index');
  assert.equal(sessions.isDuplicateIssueRefError(thrown), true, 'it should be recognised as an issue_ref index collision -> fall back to deduplication');
  assert.equal((await sessions.findByIssueRef('org/repo#7'))!.id, 'impl-a', 'the deduplication fallback takes the row that got there first');
});

test('isDuplicateIssueRefError: recognises only an issue_ref unique-index collision, and never misjudges a doc_ref or any other error', () => {
  assert.equal(sessions.isDuplicateIssueRefError(new Error('UNIQUE constraint failed: session.issue_ref')), true);
  assert.equal(sessions.isDuplicateIssueRefError(new Error('UNIQUE constraint failed: session.doc_ref')), false);
  assert.equal(sessions.isDuplicateIssueRefError(new Error('database is locked')), false);
});

test('listAll(projectId) filters by project, and distinctProjects returns them deduplicated and alphabetical (query isolation)', async () => {
  // Unique project ids, so this does not pollute or get polluted by other tests (which use the default 'demo').
  await sessions.create({ id: 'iso-a1', slug: 'iso-a1', title: 'T', branch: 'main', project_id: 'iso-acme' } as never);
  await sessions.create({ id: 'iso-a2', slug: 'iso-a2', title: 'T', branch: 'main', project_id: 'iso-acme' } as never);
  await sessions.create({ id: 'iso-b1', slug: 'iso-b1', title: 'T', branch: 'main', project_id: 'iso-beta' } as never);
  assert.deepEqual((await sessions.listAll('iso-acme')).map((s) => s.id).sort(), ['iso-a1', 'iso-a2']); // only that project
  assert.deepEqual((await sessions.listAll('iso-beta')).map((s) => s.id), ['iso-b1']);
  assert.ok((await sessions.listAll()).length >= 3, 'with no argument it returns the whole database (the poller red line: driving is never isolated per project by default)');
  const projs = await sessions.distinctProjects();
  assert.ok(projs.includes('iso-acme') && projs.includes('iso-beta'), 'distinctProjects includes every project');
  assert.deepEqual([...projs].sort(), projs, 'alphabetical order');
});
