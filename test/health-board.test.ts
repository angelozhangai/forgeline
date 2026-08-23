// Unit: building the status page's read-only payloads (src/health/board.ts) — the board's grouping and
// attention list, the full list with its state filter, and one requirement's detail with its event stream.
// The security assertion: the payload **never carries a cost or score** field (those are private to the
// management surface — a red line). projects is mocked to control the autonomy level, and raw SQL sets the
// state (only the read model is under test).
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const { loadConfig } = await import('../src/config.ts'); // a dynamic import (never a static one! a static import hoists above FORGE_DB=':memory:', so root.ts would resolve the real database and concurrent tests would share it). The stub falls back to the real config.

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

// Collect every key in the payload recursively, **descending into events[].detail** (which is usually a JSON
// string: if it parses, its keys are scanned too).
// Scanning only the top level would not hold the privacy line against someone later stuffing costUsd or
// prd_score into an event's detail — hence the recursion into every level.
function deepKeys(v: unknown, into: string[]): void {
  if (v == null) return;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { deepKeys(JSON.parse(t), into); } catch { /* not JSON text, so it is not scanned for keys */ }
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

test('boardPayload: counts grouped by state, plus the attention list (failed and waiting-on-a-human states; DONE and running states do not appear) sorted by updatedAt descending', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await mk('s2', 'GATE_A_FAILED', 200);
  await mk('s3', 'DONE', 100);
  await mk('s4', 'GATE_C_LOOP', 400);
  const b = await board.boardPayload();
  assert.equal(b.total, 4);
  assert.deepEqual(b.byState, { AWAITING_GO: 1, GATE_A_FAILED: 1, DONE: 1, GATE_C_LOOP: 1 });
  // The attention list: only AWAITING_GO (awaiting) and GATE_A_FAILED (failed); DONE is terminal but not a
  // failure, and GATE_C_LOOP is running, so neither appears
  assert.deepEqual(b.attention.map((a) => [a.slug, a.kind]), [['s1', 'awaiting'], ['s2', 'failed']]);
});

test('sessionsPayload: everything sorted by updatedAt descending, with a plain-language label and the autonomy level; states deduplicated and sorted; filterable by state', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await mk('s2', 'GATE_A_FAILED', 200);
  await mk('s4', 'GATE_C_LOOP', 400, 'auto'); // this project is at autonomy level 4
  const all = await board.sessionsPayload();
  assert.deepEqual(all.sessions.map((r) => r.slug), ['s4', 's1', 's2']); // updatedAt descending
  assert.deepEqual(all.states, ['AWAITING_GO', 'GATE_A_FAILED', 'GATE_C_LOOP']); // deduplicated and sorted
  assert.equal(all.sessions[0].autonomy, 4); // the auto project -> level 4
  assert.equal(all.sessions[1].autonomy, 0);
  assert.ok(all.sessions[0].label.length > 0); // the plain-language label (display.stateLabel)
  // Filtering
  const only = await board.sessionsPayload('AWAITING_GO');
  assert.deepEqual(only.sessions.map((r) => r.slug), ['s1']);
  assert.deepEqual(only.states, ['AWAITING_GO', 'GATE_A_FAILED', 'GATE_C_LOOP']); // states still lists everything (it feeds the dropdown)
});

test('query isolation (phase 2): sessionsPayload(project) returns that project only; projects lists **every** project in the database (it does not narrow with the filter); project and state stack', async () => {
  await mk('c1', 'AWAITING_GO', 300, 'demo');
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  await mk('a2', 'DONE', 100, 'acme');
  const demoOnly = await board.sessionsPayload(null, 'demo');
  assert.deepEqual(demoOnly.sessions.map((r) => r.slug), ['c1']); // demo only
  assert.deepEqual(demoOnly.projects, ['acme', 'demo']); // every project in the database (alphabetical); it does not narrow just because the view is on demo
  assert.deepEqual(demoOnly.states, ['AWAITING_GO']); // the set of states follows the project view (demo has only this one)
  const acmeOnly = await board.sessionsPayload(null, 'acme');
  assert.deepEqual(acmeOnly.sessions.map((r) => r.slug).sort(), ['a1', 'a2']);
  // Project and state stacked
  assert.deepEqual((await board.sessionsPayload('GATE_A_FAILED', 'acme')).sessions.map((r) => r.slug), ['a1']);
});

test('query isolation (phase 2): boardPayload(project) counts that project only', async () => {
  await mk('c1', 'AWAITING_GO', 300, 'demo');
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  await mk('a2', 'GATE_A_FAILED', 100, 'acme');
  const b = await board.boardPayload('acme');
  assert.equal(b.total, 2);
  assert.deepEqual(b.byState, { GATE_A_FAILED: 2 });
  assert.deepEqual(b.attention.map((x) => x.slug).sort(), ['a1', 'a2']); // acme's attention list only
  // Globally (with no project) it still counts the whole database
  assert.equal((await board.boardPayload()).total, 3);
});

test('Codex SF1: an unknown or blank ?project= falls back to "everything" rather than an empty view; a blank string counts as no filter', async () => {
  await mk('c1', 'AWAITING_GO', 300, 'demo');
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  // An entirely unknown project (neither registered nor present) -> falls back to everything, never empty
  assert.equal((await board.boardPayload('ghost-typo')).total, 2);
  assert.equal((await board.sessionsPayload(null, 'ghost-typo')).sessions.length, 2);
  assert.equal((await board.sessionsPayload(null, '   ')).sessions.length, 2); // blank -> everything
  // A known project still narrows normally
  assert.equal((await board.boardPayload('acme')).total, 1);
});

test("Codex SF2: sessionDetail's project gate — within a project view no detail is read across projects; an unknown project imposes no constraint", async () => {
  await mk('a1', 'GATE_A_FAILED', 200, 'acme');
  await mk('c1', 'AWAITING_GO', 100, 'demo'); // makes demo a "known" project (the gate only applies to known ones)
  assert.equal((await board.sessionDetail('a1', 'acme'))!.slug, 'a1'); // it belongs to that project -> fine
  assert.equal(await board.sessionDetail('a1', 'demo'), null); // demo is known and a1 does not belong to it -> null (a 404)
  assert.equal((await board.sessionDetail('a1'))!.slug, 'a1'); // no project context (the all view) -> no constraint
  assert.equal((await board.sessionDetail('a1', 'ghost'))!.slug, 'a1'); // an unknown project -> normProject returns undefined -> no constraint
});

test('sessionDetail: returns the operational fields plus the event timeline (the last 200); unknown -> null', async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await sessions.appendEvent('s1', 'gate_a_done', { round: 1 });
  await sessions.appendEvent('s1', 'needs_go', null);
  const d = (await board.sessionDetail('s1'))!;
  assert.equal(d.slug, 's1');
  assert.equal(d.state, 'AWAITING_GO');
  assert.ok(d.label.length > 0);
  assert.equal(d.project, 'demo');
  assert.equal(d.events.length, 3); // the intake event create records, plus the 2 appended
  assert.equal(d.events[0].kind, 'intake'); // ordered by id ascending (chronologically)
  const ga = d.events.find((e) => e.kind === 'gate_a_done')!;
  assert.match(ga.detail ?? '', /round/);
  assert.equal(await board.sessionDetail('does-not-exist'), null);
});

test("the security red line: the list and detail payloads (recursively, including an event's detail) never carry a cost or score field (they are private to the management surface)", async () => {
  await mk('s1', 'AWAITING_GO', 300);
  await sessions.appendEvent('s1', 'gate_a_done', { round: 1, verdict: 'pass' });
  const row = (await board.sessionsPayload()).sessions[0];
  const det = (await board.sessionDetail('s1'))!;
  const keys: string[] = [];
  deepKeys(row, keys);
  deepKeys(det, keys);
  assert.ok(keys.includes('round'), "the recursion has to descend into events[].detail, or it cannot hold the line against a cost field stuffed in there");
  for (const k of keys) {
    assert.ok(!/cost|score|usd|token|\$/i.test(k), `the payload should not expose a cost or score field: ${k}`);
  }
});
