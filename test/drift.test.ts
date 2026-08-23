// The drift loop: the pure functions (contract parsing, the all-closed decision, the alert copy) plus every
// branch of reconcileDrift.
// Only the boundaries are mocked (gh issueStates / claude / git fetch / the Feishu DM); sessions, events,
// config and prompt rendering all run for real.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// -- Boundary mocks (their return values are switchable) --
let issueStatesResult: { repo: string; number: number; state: 'OPEN' | 'CLOSED' | 'UNKNOWN'; reason: string }[] = [];
mock.module('../src/workspace.ts', { namedExports: { issueStates: async () => issueStatesResult, commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }) } });

// reposOffRef uses runSync to read each repo's HEAD and dirty state -- mocked as "aligned with the
// origin/prod sha and clean" (headSha matches the sha refresh reports).
let headSha = 'abc123';
let dirty = false;
mock.module('../src/util/proc.ts', {
  namedExports: {
    runSync: (_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return `${headSha}\n`;
      if (args.includes('status')) return dirty ? ' M src/x.ts\n' : '';
      return '';
    },
  },
});

let claudeOk = true;
let claudeResult = JSON.stringify({ drifted: false, summary: 'aligned', findings: [] });
let claudeCalls = 0;
let lastPrompt = '';
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string) => {
      claudeCalls++;
      lastPrompt = prompt;
      return { ok: claudeOk, result: claudeResult, raw: claudeResult, costUsd: 0.05, sessionId: 'c', error: claudeOk ? undefined : 'claude timed out' };
    },
  },
});

let refreshBranch = '';
mock.module('../src/gates/repoFreshness.ts', {
  namedExports: {
    refresh: (branch: string) => { refreshBranch = branch; return { branch, fetchedAt: '2026-06-17T00:00:00.000Z', shas: { demo: 'abc123' }, refsText: '- demo: `origin/main` @ `abc123`' }; },
    assertFresh: () => {},
  },
});

const dmCards: { title: string; lines: string[]; color: string }[] = [];
mock.module('../src/feishu/dm.ts', {
  namedExports: {
    // drift now goes through messaging/feishu (the port), which indirectly imports all of dm (feishu/group
    // also takes base/token from ./dm), so the mock has to carry these exports or ESM instantiation fails
    // with a missing-export error.
    FEISHU_BASE: 'https://example.invalid',
    botTenantToken: async () => 'token',
    botOpenId: async () => null,
    botOpenIdCached: () => null,
    sendBotCard: async (title: string, lines: string[], color: string) => { dmCards.push({ title, lines, color }); return true; },
    sendBotCardObject: async () => true,
  },
});

const sessions = await import('../src/store/sessions.ts');
const { reconcileDrift, parseCreatedIssues, allClosed, isDropped, hasDrift, driftDm, DriftSchema } = await import('../src/drift/reconcile.ts');
const { reposOffRef } = await import('../src/gates/repoAnchor.ts'); // moved up into repoAnchor (still driven by the util/proc runSync mock)
const { strictParse } = await import('../src/llm/structured.ts');

const DRIFTED = JSON.stringify({ drifted: true, summary: 'the refund endpoint changed its status code', findings: [{ ac: 'AC1', status: 'drift', detail: 'POST /refund returns 202, not the 200 in the contract', evidence: 'demo src/refund.ts:30' }] });
const CLEAN = JSON.stringify({ drifted: false, summary: 'the implementation matches the contract', findings: [{ ac: 'AC1', status: 'ok', detail: 'satisfied', evidence: 'demo src/refund.ts:30' }] });
const INCONSISTENT_DRIFT = JSON.stringify({ drifted: false, summary: 'the top level wrongly says no drift, but the per-scenario findings show the refund endpoint does not match', findings: [{ ac: 'AC1', status: 'drift', detail: 'POST /refund returns 202, not the 200 in the contract', evidence: 'demo src/refund.ts:30' }] });

async function toDone(id: string): Promise<void> {
  for (const st of ['GATE_A_RUNNING', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE']) {
    await sessions.transition(id, st as never);
  }
}
async function mkDone(id: string, opts: { issues?: boolean; acceptance?: boolean; branch?: string } = {}): Promise<void> {
  await sessions.create({ id, slug: id, title: 'refund requirement', branch: opts.branch ?? 'main' });
  await toDone(id);
  if (opts.issues !== false) await sessions.patch(id, { created_issues: JSON.stringify([{ repo: 'demo', number: 1, url: 'https://github.com/your-org/demo/issues/1' }]) });
  if (opts.acceptance !== false) {
    const p = join(mkdtempSync(join(tmpdir(), 'forge-drift-gateb-')), 'gate-b.json');
    writeFileSync(p, JSON.stringify({ summary: 'x', issue_specs: [], acceptance: { contracts: [{ repo: 'demo', surface: 'POST /refund -> 200 {refund_id}' }], scenarios: [{ id: 'AC1', repo: 'demo', gherkin: 'Given a paid order\nWhen it is refunded\nThen 200' }] } }));
    await sessions.patch(id, { gate_b_draft_path: p });
  }
}
async function kinds(id: string): Promise<string[]> {
  return (await sessions.events(id)).map((e) => e.kind);
}
function resetMocks(): void {
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' }];
  claudeOk = true; claudeResult = CLEAN; claudeCalls = 0; lastPrompt = ''; dmCards.length = 0;
  headSha = 'abc123'; dirty = false; refreshBranch = ''; // by default the checkout is aligned with origin/main and clean
}

// Set created_issues across several repos plus the matching issueStatesResult (the multi-repo dropped-issue edge).
async function setIssues(id: string, rows: { repo: string; number: number; state: 'OPEN' | 'CLOSED' | 'UNKNOWN'; reason: string }[]): Promise<void> {
  await sessions.patch(id, { created_issues: JSON.stringify(rows.map((r) => ({ repo: r.repo, number: r.number, url: `https://github.com/your-org/${r.repo}/issues/${r.number}` }))) });
  issueStatesResult = rows;
}

// -- Pure functions --
test('DriftSchema/strictParse: both a valid drift and a valid clean parse; bad JSON throws (never silently)', () => {
  assert.equal(strictParse(DriftSchema, DRIFTED).drifted, true);
  assert.equal(strictParse(DriftSchema, CLEAN).drifted, false);
  assert.throws(() => strictParse(DriftSchema, 'not json'));
});

test('parseCreatedIssues: a valid array comes back; null, bad JSON and malformed entries are filtered out safely', () => {
  assert.equal(parseCreatedIssues(JSON.stringify([{ repo: 'demo', number: 1, url: 'u' }])).length, 1);
  assert.deepEqual(parseCreatedIssues(null), []);
  assert.deepEqual(parseCreatedIssues('{bad'), []);
  assert.equal(parseCreatedIssues(JSON.stringify([{ repo: 'demo', number: 1 }, { repo: 'x' }])).length, 1); // the second has no number -> filtered out
});

test('allClosed: empty -> false; all CLOSED -> true; any OPEN or UNKNOWN -> false', () => {
  assert.equal(allClosed([]), false);
  assert.equal(allClosed([{ state: 'CLOSED' }, { state: 'CLOSED' }]), true);
  assert.equal(allClosed([{ state: 'CLOSED' }, { state: 'OPEN' }]), false);
  assert.equal(allClosed([{ state: 'CLOSED' }, { state: 'UNKNOWN' }]), false);
});

test('isDropped: NOT_PLANNED and DUPLICATE count as dropped; COMPLETED and empty do not', () => {
  assert.equal(isDropped('NOT_PLANNED'), true);
  assert.equal(isDropped('DUPLICATE'), true);
  assert.equal(isDropped('COMPLETED'), false);
  assert.equal(isDropped(''), false);
});

test('hasDrift: the per-scenario findings win, so a wrong top-level drifted flag cannot fake a clean result', () => {
  assert.equal(hasDrift(strictParse(DriftSchema, CLEAN)), false);
  assert.equal(hasDrift(strictParse(DriftSchema, DRIFTED)), true);
  assert.equal(hasDrift(strictParse(DriftSchema, INCONSISTENT_DRIFT)), true);
});

test('reposOffRef: HEAD == sha and clean -> aligned (empty); a different sha or a dirty tree -> the repo is listed', () => {
  const proj = { repoPath: () => '/x' };
  headSha = 'abc123'; dirty = false;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), []);
  headSha = 'OTHERSHA'; dirty = false;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']); // behind, or on the wrong branch -> not aligned
  headSha = 'abc123'; dirty = true;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']); // a dirty working tree -> not aligned
});

test('driftDm: the alert carries the title, each drifted scenario, and the way to review it', () => {
  const s = { slug: 'refund', title: 'refund', ref_num: null } as never;
  const dm = driftDm(s, strictParse(DriftSchema, DRIFTED));
  assert.match(dm.title, /the implementation has drifted/);
  assert.ok(dm.lines.some((l) => /POST \/refund returns 202/.test(l)));
  assert.ok(dm.lines.some((l) => /forge show refund/.test(l)));
});

// -- Every branch of reconcileDrift --
test('reconcileDrift: not every issue is closed -> poll only, no audit, no terminal record', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'OPEN', reason: '' }];
  await mkDone('drf-open');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.ok((await kinds('drf-open')).includes('drift_polled'));
  assert.equal((await kinds('drf-open')).includes('drift_reconciled'), false);
});

test('reconcileDrift: all closed and claude finds drift -> drift_detected, a terminal record, and a DM to the maintainer', async () => {
  resetMocks();
  claudeResult = DRIFTED;
  await mkDone('drf-drift');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1);
  const k = await kinds('drf-drift');
  assert.ok(k.includes('drift_detected'));
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 1);
  assert.match(dmCards[0].title, /the implementation has drifted/);
  assert.equal(dmCards[0].color, 'red');
});

test('production path: claude says drifted=false at the top but a scenario finding shows drift -> alert, never a fake clean', async () => {
  resetMocks();
  claudeResult = INCONSISTENT_DRIFT;
  await mkDone('drf-inconsistent');
  await reconcileDrift(Date.now());
  const k = await kinds('drf-inconsistent');
  assert.ok(k.includes('drift_detected'));
  assert.equal(k.includes('drift_clean'), false);
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 1);
  assert.match(dmCards[0].lines.join('\n'), /POST \/refund returns 202/);
});

test('reconcileDrift: all closed and claude finds it aligned -> drift_clean plus a terminal record, no alert', async () => {
  resetMocks();
  claudeResult = CLEAN;
  await mkDone('drf-clean');
  await reconcileDrift(Date.now());
  const k = await kinds('drf-clean');
  assert.ok(k.includes('drift_clean'));
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 0);
});

test('reconcileDrift: already reconciled (drift_reconciled present) -> terminal, never re-run', async () => {
  resetMocks();
  await mkDone('drf-done-once');
  await sessions.appendEvent('drf-done-once', 'drift_reconciled', { drifted: false });
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.equal((await kinds('drf-done-once')).filter((x) => x === 'drift_polled').length, 0); // it did not poll again
});

test('reconcileDrift: polling is debounced -- no second poll inside the window, one only once it has passed', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'OPEN', reason: '' }]; // never merged -> never terminal, which makes the poll count easy to watch
  await mkDone('drf-throttle');
  const t0 = Date.now();
  await reconcileDrift(t0);
  await reconcileDrift(t0 + 3600 * 1000); // +1h < 24h -> debounced away
  assert.equal((await kinds('drf-throttle')).filter((x) => x === 'drift_polled').length, 1);
  await reconcileDrift(t0 + 25 * 3600 * 1000); // +25h > 24h -> polls again
  assert.equal((await kinds('drf-throttle')).filter((x) => x === 'drift_polled').length, 2);
});

test('reconcileDrift: the issue state is unreadable (UNKNOWN) -> not treated as merged, and not audited', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'UNKNOWN', reason: '' }];
  await mkDone('drf-unknown');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.equal((await kinds('drf-unknown')).includes('drift_reconciled'), false);
});

test('reconcileDrift: the backoff is exhausted (max_polls) -> give up with a terminal record and an orange alert', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'OPEN', reason: '' }];
  await mkDone('drf-giveup');
  for (let i = 0; i < 8; i++) await sessions.appendEvent('drf-giveup', 'drift_polled', { attempt: i + 1 }); // max_polls=8 reached
  await reconcileDrift(Date.now() + 100 * 3600 * 1000); // past the debounce window
  const k = await kinds('drf-giveup');
  assert.ok(k.includes('drift_reconciled')); // giving up is still recorded as terminal
  assert.equal(claudeCalls, 0);
  assert.equal(dmCards.length, 1);
  assert.match(dmCards[0].title, /giving up/);
  assert.equal(dmCards[0].color, 'orange');
});

test('reconcileDrift: no acceptance contract -> record it terminal and skip (claude is never called)', async () => {
  resetMocks();
  await mkDone('drf-noacc', { acceptance: false });
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.ok((await kinds('drf-noacc')).includes('drift_reconciled'));
});

test('reconcileDrift: claude failed -> nothing terminal this round (it retries on the next one)', async () => {
  resetMocks();
  claudeOk = false;
  await mkDone('drf-claude-fail');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1);
  assert.equal((await kinds('drf-claude-fail')).includes('drift_reconciled'), false); // a failure is never terminal -> it tries again next round
});

test('reconcileDrift: claude returns fine but the output is bad JSON (a parse failure) -> nothing terminal and nothing misreported (same discipline as a failed call)', async () => {
  // Unlike the previous test's failed call, claude returns normally here but the output will not parse as a
  // DriftSchema. auditSession throws, reconcileDrift catches it and writes no drift_reconciled -- never
  // silently let through, and retried in the next window. It reports neither a false clean nor a false drift.
  resetMocks();
  claudeOk = true;
  claudeResult = 'this is not JSON {{{';
  await mkDone('drf-parsefail');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1);
  const k = await kinds('drf-parsefail');
  assert.equal(k.includes('drift_reconciled'), false); // a parse failure is never terminal -> it retries next round
  assert.equal(k.includes('drift_clean') || k.includes('drift_detected'), false); // neither a false clean nor a false drift
  assert.equal(dmCards.length, 0);
});

// -- P1: anchor on prod (main) --
test('reconcileDrift: reconciliation always anchors on prod (main), never the session branch (dev)', async () => {
  resetMocks();
  claudeResult = CLEAN;
  await mkDone('drf-dev', { branch: 'dev' }); // the session sits on dev
  await reconcileDrift(Date.now());
  assert.equal(refreshBranch, 'main'); // refresh uses prod=main, not the session's dev
  assert.ok((await kinds('drf-dev')).includes('drift_reconciled'));
});

test('reconcileDrift: the checkout is not aligned with origin/prod (dirty, behind, or wrong branch) -> refuse to reconcile, nothing terminal (retried next round)', async () => {
  resetMocks();
  headSha = 'STALE_OR_WRONG_BRANCH'; // reposOffRef sees the mismatch -> auditSession throws before claude is called
  claudeResult = CLEAN;
  await mkDone('drf-offref');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0); // never draw a conclusion from code that is not main
  assert.equal((await kinds('drf-offref')).includes('drift_reconciled'), false);
  assert.equal(dmCards.length, 0); // neither a false clean nor a false drift
});

// -- P2: CLOSED but dropped is not the same as delivered --
test('reconcileDrift: the only issue was dropped (NOT_PLANNED) = all dropped -> record terminal, skip, do not reconcile', async () => {
  resetMocks();
  await mkDone('drf-notplanned', { issues: false });
  await setIssues('drf-notplanned', [{ repo: 'demo', number: 1, state: 'CLOSED', reason: 'NOT_PLANNED' }]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  const k = await kinds('drf-notplanned');
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(k.includes('drift_detected') || k.includes('drift_clean'), false); // skipped: neither drifted nor aligned
});

test('reconcileDrift: every child issue was dropped (NOT_PLANNED + DUPLICATE) -> the whole thing is discarded and skipped', async () => {
  resetMocks();
  await mkDone('drf-all-drop', { issues: false });
  await setIssues('drf-all-drop', [
    { repo: 'demo', number: 1, state: 'CLOSED', reason: 'NOT_PLANNED' },
    { repo: 'example-web', number: 2, state: 'CLOSED', reason: 'DUPLICATE' },
  ]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.ok((await kinds('drf-all-drop')).includes('drift_reconciled'));
});

test('reconcileDrift: the umbrella Epic was dropped -> the whole thing is discarded and skipped (even with the child issues completed)', async () => {
  resetMocks();
  await mkDone('drf-umbrella-drop', { issues: false });
  await setIssues('drf-umbrella-drop', [
    { repo: 'example-project', number: 99, state: 'CLOSED', reason: 'NOT_PLANNED' }, // the umbrella Epic itself was dropped
    { repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' },
  ]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0); // the substance is gone -> nothing to reconcile
  assert.ok((await kinds('drf-umbrella-drop')).includes('drift_reconciled'));
});

test('reconcileDrift: one child issue was a duplicate but the substance still shipped -> still reconcile, and the dropped issue reaches the prompt', async () => {
  resetMocks();
  claudeResult = CLEAN;
  await mkDone('drf-partial', { issues: false });
  await setIssues('drf-partial', [
    { repo: 'example-project', number: 99, state: 'CLOSED', reason: 'COMPLETED' }, // the Epic completed
    { repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' },
    { repo: 'example-web', number: 2, state: 'CLOSED', reason: 'DUPLICATE' }, // one child was closed as a duplicate
  ]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1); // the substance shipped -> still reconcile; one duplicate child must not drop the whole guarantee
  assert.ok((await kinds('drf-partial')).includes('drift_reconciled'));
  assert.match(lastPrompt, /example-web#2/); // the dropped issue reaches the prompt so claude can tell the difference
  assert.match(lastPrompt, /do not report drift/);
});

// -- M4: the drift loop also covers SHIPPED (forge's own implementation PR, merged by a human) --
// SHIPPED means `forge merged` -- a human confirmed the merge -- so the issue-closure checks that DONE runs
// are skipped and the merged implementation is reconciled against the acceptance contract directly.
async function mkShipped(id: string, opts: { acceptance?: boolean } = {}): Promise<void> {
  await mkDone(id, opts);
  for (const st of ['GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE', 'SHIPPED']) {
    await sessions.transition(id, st as never);
  }
}

test('reconcileDrift(SHIPPED): no acceptance contract (standalone) -> record it terminal as skipped (claude is never called, no false drift)', async () => {
  resetMocks();
  await mkShipped('shp-noacc', { acceptance: false });
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  const k = await kinds('shp-noacc');
  assert.ok(k.includes('drift_polled'));
  assert.ok(k.includes('drift_reconciled')); // nothing to reconcile against -> terminal, stated honestly rather than pretending it aligned
});

test('reconcileDrift(SHIPPED): a contract exists but the checkout is not aligned with origin/prod -> nothing terminal, retried next round', async () => {
  resetMocks();
  headSha = 'OTHERSHA'; // the local checkout is behind or on the wrong branch -> reposOffRef fires -> auditSession throws -> nothing terminal this round
  await mkShipped('shp-offref');
  await reconcileDrift(Date.now());
  const k = await kinds('shp-offref');
  assert.ok(k.includes('drift_polled'));
  assert.equal(k.includes('drift_reconciled'), false); // a failed anchor is never terminal (never draw a conclusion from code that is not prod)
});

test('reconcileDrift(SHIPPED): a contract, an aligned checkout, and claude finds drift -> alert plus a terminal record', async () => {
  resetMocks();
  claudeResult = DRIFTED;
  await mkShipped('shp-drift');
  await reconcileDrift(Date.now());
  const k = await kinds('shp-drift');
  assert.ok(k.includes('drift_detected'));
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 1);
});
