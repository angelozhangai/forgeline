// Integration: the worker's orchestration (step advancing and parking, and the tick's orphan self-healing).
// The gates' actual LLM work and the notifications are mocked out.
process.env.FORGE_DB = ':memory:';
// A private tick-lock path (unique per process): tick.lock is a file on disk under STATE_DIR and is not
// isolated by :memory:, so parallel test processes sharing it would each wrongly conclude "a tick is already
// running" and go flaky. This file is the only one that calls worker.tick(), so isolating it here is enough.
process.env.FORGE_LOCK = `${tmpdir()}/forge-tick-${process.pid}.lock`;
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const notifyCalls: string[] = [];
let syncCardCalls = 0; // a regression guard: entering a running state must refresh the group card, so the team sees "under review" rather than a stale "queued"
// notifyThrows makes the notification layer throw, which is how a genuine "the tick itself blew up" is staged -
// the notify inside remindStuck has no try/catch, so the exception propagates all the way out of tick.
// An ESM namespace is frozen (mock.method reports "Cannot redefine property"), so the bindings worker has
// already resolved cannot be changed; the only way in is through the mock itself. Same trick as the existing
// gateAThrows in this file.
let notifyThrows = false;
mock.module('../src/notify.ts', { namedExports: { notify: async (kind: string) => { if (notifyThrows) throw new Error('the notification layer blew up'); notifyCalls.push(kind); }, syncGroupCard: async () => { syncCardCalls++; } } });

// Gate A: simulate success (writing routing), switchable to throwing; the outcome decides which branch
// afterGateA transitions down.
let gateAThrows = false;
let gateAErrorMsg = 'Gate A output failed to parse'; // switchable to a transient error (such as 'claude timed out') to exercise the automatic-retry classification
let gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
const sessionsRef: { mod?: typeof import('../src/store/sessions.ts') } = {};
mock.module('../src/gates/gateA.ts', {
  namedExports: {
    runGateA: async (s: { id: string }) => {
      if (gateAThrows) throw new Error(gateAErrorMsg);
      sessionsRef.mod!.patch(s.id, { routing: JSON.stringify({ reviewer: 'M', toLead: true, reasons: ['x'], confidence: 0.5 }), gate_a_round: 1 });
      return { ...gateAOutcome, round: 1 };
    },
    runGateARevision: async (s: { id: string; gate_a_round?: number | null }) => {
      if (gateAThrows) throw new Error('the Gate A re-review failed');
      sessionsRef.mod!.patch(s.id, { gate_a_round: (s.gate_a_round ?? 1) + 1, gate_a_pending_input: null });
      return gateAOutcome;
    },
  },
});

// The Gate B first draft: success (writing the draft path) or a throw; finalizeGateBDoc is a no-op.
let gateBThrows = false;
mock.module('../src/gates/gateB.ts', {
  namedExports: {
    runGateB: async (s: { id: string }) => {
      if (gateBThrows) throw new Error('the Gate B first draft failed');
      sessionsRef.mod!.patch(s.id, { gate_b_draft_path: '/tmp/gate-b.json', gate_b_round: 0 });
      return { summary: 'x', key_decisions: {}, tech_design_markdown: '', multi_repo: false, epic_doc_type: 'feat', issue_specs: [{ repo: 'A', title: 't', type: 'feat', prio: 'P2' }], confidence: 0.6 };
    },
    finalizeGateBDoc: () => {},
  },
});

// The Gate B adversarial loop: the outcome decides which branch afterGateB transitions down; switchable to
// throwing.
let gateBLoopThrows = false;
type RFOutcome = { round: number; verdict: string; resolved: boolean; needsHuman: unknown[] | null; stalled: boolean; paused: boolean; unresolvedFindings: unknown[] };
let gateBOutcome: RFOutcome = { round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateBLoop.ts', {
  namedExports: {
    runGateBLoop: async (_s: unknown) => {
      if (gateBLoopThrows) throw new Error('the adversarial review failed');
      return gateBOutcome;
    },
  },
});

// The Gate A adversarial loop: the outcome decides which branch afterGateAAdversarial transitions down;
// switchable to throwing.
let gateALoopThrows = false;
let gateALoopErrorMsg = 'the Gate A adversarial review failed';
let gateALoopOutcome: RFOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
mock.module('../src/gates/gateALoop.ts', {
  namedExports: {
    runGateALoop: async (_s: unknown) => {
      if (gateALoopThrows) throw new Error(gateALoopErrorMsg);
      return gateALoopOutcome;
    },
    // afterGateAAdversarial's resolved branch re-reads gate-a.json to see whether codex surfaced questions the
    // PM has not answered - it reads the real file writeGateA produced.
    readGateAEnvelope: (s: { gate_a_output_path?: string | null }) =>
      s.gate_a_output_path
        ? JSON.parse(readFileSync(s.gate_a_output_path, 'utf8'))
        : { summary: 's', open_questions: [], risks: [] },
  },
});

// Gate C: setup is a no-op; the implement/CI loop's outcome decides which branch afterGateC takes; switchable
// to throwing. The worker is the only importer, which makes this mock safe.
let gateCLoopThrows = false;
let gateCOutcome: RFOutcome = { round: 1, verdict: 'LGTM', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
mock.module('../src/gates/gateC.ts', { namedExports: { runGateCSetup: async () => {}, activateLeg: () => {}, activeLeg: () => null } });
mock.module('../src/gates/gateCLoop.ts', {
  namedExports: {
    runGateCLoop: async (_s: unknown) => {
      if (gateCLoopThrows) throw new Error('the Gate C implementation failed');
      return gateCOutcome;
    },
  },
});

// Gate D: opening the PR is a no-op (switchable to throwing); the PR adversarial loop's outcome decides which
// branch afterGateD takes.
let openPrThrows = false;
let gateDLoopThrows = false;
let gateDOutcome: RFOutcome = { round: 1, verdict: 'LGTM', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
mock.module('../src/gates/gateD.ts', {
  namedExports: { openReviewPr: async (s: { id: string }) => { if (openPrThrows) throw new Error('failed to open the PR: gh auth'); sessionsRef.mod!.patch(s.id, { pr_url: 'https://x/pull/1', pr_number: 1 }); } },
});
mock.module('../src/gates/gateDLoop.ts', {
  namedExports: {
    runGateDLoop: async (_s: unknown) => {
      if (gateDLoopThrows) throw new Error('the Gate D PR review failed');
      return gateDOutcome;
    },
    MAX_CI_FIX_ATTEMPTS: 2, // worker.lockMaxHoldSec uses it to bound the longest single tick; the mock must export it like the real module or the import fails
  },
});
// Gate D test hardening: success is a no-op (the worker then moves to AWAITING_HUMAN_MERGE and sends
// needs_merge); switchable to throwing to exercise parking.
let gateDHardenThrows = false;
mock.module('../src/gates/gateDHarden.ts', {
  namedExports: {
    runGateDHarden: async (s: { id: string }) => {
      if (gateDHardenThrows) throw new Error('the Gate D hardening failed: CI is still red');
      sessionsRef.mod!.patch(s.id, { gate_d_harden_round: 1, merge_readiness_path: '/tmp/merge-readiness.md' });
    },
  },
});

// The automatic-assignment load probe would shell out to the real gh - it is mocked as an empty pool (a clean
// afterGateB entering AWAITING_GO computes a recommendation).
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });
// The worktree helpers: the worker uses worktreeHeadSha to pin Gate D's green state, and actions (ackMerged)
// uses removeWorktree and deleteBranch.
// headSha can be switched to null to exercise "LGTM but the green HEAD cannot be read -> park".
let headSha: string | null = 'GREENSHA';
mock.module('../src/util/worktree.ts', {
  namedExports: {
    worktreeHeadSha: () => headSha,
    removeWorktree: async () => ({ ok: true, output: '' }),
    deleteBranch: () => {},
    listWorktrees: () => [], // the orphan sweep: this test has no worktrees, so the list is empty and the sweep is a no-op
    planWorktreeSweep: () => [],
  },
});

const sessions = await import('../src/store/sessions.ts');
sessionsRef.mod = sessions;
const worker = await import('../src/orchestrator/worker.ts');
// Since claims became bounded, each tick claims only the oldest max_parallel (= 2) due jobs, FIFO. Sessions
// left behind by earlier tests get revived into free poller states by reclaim/reconcile and take the slots away
// from this test's target (keepId), so the target is never claimed and never stepped. (In production FIFO
// favours the oldest and a retried older session is meant to go first, so this is purely an artefact of tests
// sharing one database.) Clearing the field: every existing session except keepId is patched straight to the
// terminal SHIPPED state (writing `state` directly and bypassing the state machine - for tests only), so this
// tick's reclaim, reconcile and claim have nothing left over to revive or claim and only keepId can advance.
async function parkLeftoverReady(keepId: string): Promise<void> {
  for (const s of await sessions.listAll()) {
    if (s.id !== keepId) await sessions.patch(s.id, { state: 'SHIPPED' });
  }
}

async function mk(id: string, state: string) {
  await sessions.create({ id, slug: id, title: 'T', branch: 'dev' });
  const toGateB = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED'];
  const toGateDLoop = [...toGateB, 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP'];
  const path: Record<string, string[]> = {
    INTAKE: [],
    GATE_B_REQUESTED: toGateB,
    ADVERSARIAL_LOOP: [...toGateB, 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP'],
    GATE_B_REVISION_REQUESTED: [...toGateB, 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GATE_B_INPUT', 'GATE_B_REVISION_REQUESTED'],
    GATE_A_RUNNING: ['GATE_A_RUNNING'],
    GATE_A_ADVERSARIAL: ['GATE_A_RUNNING', 'GATE_A_ADVERSARIAL'],
    GATE_A_REVISION_REQUESTED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'GATE_A_REVISION_REQUESTED'],
    AWAITING_GATE_D: toGateDLoop.slice(0, -2), // up to AWAITING_GATE_D (dropping the trailing GATE_D_REQUESTED and LOOP)
    GATE_D_REQUESTED: toGateDLoop.slice(0, -1),
    GATE_D_LOOP: toGateDLoop,
    GATE_D_HARDENING: [...toGateDLoop, 'GATE_D_HARDENING'],
    GATE_D_REVISION_REQUESTED: [...toGateDLoop, 'AWAITING_GATE_D_INPUT', 'GATE_D_REVISION_REQUESTED'],
  };
  for (const s of path[state] ?? []) await sessions.transition(id, s as never);
  return id;
}

// afterGateAAdversarial's resolved branch re-reads gate-a.json (to see whether codex surfaced open_questions
// the PM has not answered), so the GATE_A_ADVERSARIAL resolved cases need a real envelope on disk. The shape
// matches BASE_ENV in gateALoop.test.
const GATE_A_ENV = {
  summary: 's', repos_touched: ['C'], size: 'M', size_reason: '', open_questions: [], risks: [],
  confidence: 0.5, needs_lead: false, prd_score: 0, prd_score_dims: { clarity: 0, completeness: 0, feasibility: 0, testability: 0 }, prd_score_reason: '',
};
async function writeGateA(id: string, openQuestions: unknown[] = []) {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-wk-gatea-')), 'gate-a.json');
  writeFileSync(p, JSON.stringify({ ...GATE_A_ENV, open_questions: openQuestions }));
  await sessions.patch(id, { gate_a_output_path: p });
}

test('step(INTAKE): Gate A succeeds with open questions remaining -> AWAITING_PM_CONFIRM and a needs_confirm notification', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  const id = await mk('w1', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_PM_CONFIRM');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_a_done'));
  assert.ok(notifyCalls.includes('needs_confirm'));
});

test('step(INTAKE): entering GATE_A_RUNNING refreshes the group card (so the team sees "under review" rather than a stale "queued")', async () => {
  syncCardCalls = 0;
  gateAThrows = false;
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  const id = await mk('w1-card', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  assert.ok(syncCardCalls >= 1, 'entering a running state should refresh the group card at least once');
});

test('step(INTAKE): Gate A with no open questions -> the codex adversarial review first, not an immediate confirmation', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 1, openQuestions: 0, resolved: true, stalled: false };
  const id = await mk('w1b', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_ADVERSARIAL'); // no open questions -> enter the codex adversarial review first, rather than confirming directly
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_a_resolved'));
  assert.ok(!notifyCalls.includes('needs_gateb')); // the confirmation waits until codex passes
});

test('step(GATE_A_REVISION_REQUESTED): the re-review still has questions -> back to AWAITING_PM_CONFIRM for another round', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 2, openQuestions: 1, resolved: false, stalled: false };
  const id = await mk('wr1', 'GATE_A_REVISION_REQUESTED');
  await sessions.patch(id, { gate_a_pending_input: "the PM's answer" });
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_PM_CONFIRM');
  assert.ok(notifyCalls.includes('needs_confirm'));
});

test('step(GATE_A_REVISION_REQUESTED): the re-review leaves nothing open -> enter GATE_A_ADVERSARIAL (the codex adversarial review)', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 3, openQuestions: 0, resolved: true, stalled: false };
  const id = await mk('wr2', 'GATE_A_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_ADVERSARIAL');
  assert.ok(!notifyCalls.includes('needs_gateb'));
});

test('step(GATE_A_ADVERSARIAL): codex says LGTM -> CONFIRMED and needs_gateb', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wa1', 'GATE_A_ADVERSARIAL');
  await writeGateA(id, []); // the adversarial review surfaced no new questions -> confirm automatically
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'AI');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_resolved'));
  assert.ok(notifyCalls.includes('needs_gateb'));
});

test('step(GATE_A_ADVERSARIAL): the codex adversarial review surfaces open_questions the PM has not answered -> bounce back to AWAITING_PM_CONFIRM (no automatic confirmation)', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wa5', 'GATE_A_ADVERSARIAL');
  await sessions.patch(id, { gate_a_adv_round: 1, gate_a_reviewer_session: 'codex-x', gate_a_fixer_session: 'claude-y' });
  await writeGateA(id, [{ q: 'where does the refund go?', suggestion: 'store credit', severity: 'high', options: [] }]); // the adversarial review surfaced one missed question
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_PM_CONFIRM'); // it does not enter Gate B; it bounces back to the PM
  assert.equal(s.confirmed_by, null); // nothing was auto-confirmed
  assert.ok(notifyCalls.includes('needs_confirm'));
  assert.equal(notifyCalls.includes('needs_gateb'), false);
  assert.equal(s.gate_a_adv_round, null); // the adversarial bookkeeping is reset (after the bounce, a fresh adversarial round starts)
  assert.equal(s.gate_a_reviewer_session, null);
  assert.equal(s.gate_a_fixer_session, null);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_reopened'));
});

test('production path: the adversarial review surfaces a missed question -> the PM answers -> the re-review clears it -> only after a fresh adversarial review passes is Gate B notified', async () => {
  notifyCalls.length = 0;
  gateAThrows = false; gateALoopThrows = false;
  const actions = await import('../src/actions.ts');
  const id = await mk('prod-gatea-reopen', 'GATE_A_ADVERSARIAL');
  await sessions.patch(id, { gate_a_adv_round: 1, gate_a_reviewer_session: 'codex-old', gate_a_fixer_session: 'claude-old' });

  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  await writeGateA(id, [{
    q: 'where should the refund go?',
    suggestion: 'store credit is recommended',
    severity: 'high',
    options: [{ label: 'refund as store credit', recommended: true, impact: 'the user can keep spending, and it avoids a failed refund to the original route' }],
  }]);
  await worker.step((await sessions.get(id))!);

  let s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_PM_CONFIRM');
  assert.equal(s.confirmed_by, null);
  assert.equal(s.gate_a_adv_round, null);
  assert.equal(s.gate_a_reviewer_session, null);
  assert.equal(s.gate_a_fixer_session, null);
  assert.ok(notifyCalls.includes('needs_confirm'));
  assert.equal(notifyCalls.includes('needs_gateb'), false);

  const reply = await actions.submitPmAnswers(id, 'PM', 'H1 (where should the refund go?): as store credit');
  assert.equal(reply.ok, true);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_REVISION_REQUESTED');

  notifyCalls.length = 0;
  gateAOutcome = { round: 2, openQuestions: 0, resolved: true, stalled: false };
  await writeGateA(id, []); // a real re-review would clear the questions the PM answered; the file stands in for that change in the artifact.
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_ADVERSARIAL');
  assert.equal(s.gate_a_adv_round, 0); // the fresh-adversarial marker is written again rather than reusing the old codex/claude sessions
  assert.equal(s.gate_a_reviewer_session, null);
  assert.equal(s.gate_a_fixer_session, null);
  assert.equal(notifyCalls.includes('needs_gateb'), false);

  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'AI');
  assert.match(s.confirmed_notes ?? '', /as store credit/);
  assert.ok(notifyCalls.includes('needs_gateb'));
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_reopened'));
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_resolved'));
});

test('step(GATE_A_ADVERSARIAL): still unresolved at the cap -> GATE_A_STALLED and needs_arbitration', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 3, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wa2', 'GATE_A_ADVERSARIAL');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_STALLED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatea_adv_stalled'));
  assert.ok(notifyCalls.includes('needs_arbitration'));
});

test('step(GATE_A_ADVERSARIAL): pausing at the per-tick cap -> stay in GATE_A_ADVERSARIAL and continue next tick', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = false;
  gateALoopOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wa3', 'GATE_A_ADVERSARIAL');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_ADVERSARIAL');
  assert.ok(notifyCalls.length === 0); // a pause sends no notification
});

test('step(GATE_A_ADVERSARIAL): the adversarial review throws -> park at GATE_A_FAILED and send failed', async () => {
  notifyCalls.length = 0;
  gateALoopThrows = true;
  gateALoopErrorMsg = 'the Gate A adversarial review failed';
  const id = await mk('wa4', 'GATE_A_ADVERSARIAL');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED');
  assert.ok(notifyCalls.includes('failed'));
  gateALoopThrows = false;
});

test('step(GATE_A_REVISION_REQUESTED): still unresolved at the cap -> GATE_A_STALLED and needs_arbitration', async () => {
  notifyCalls.length = 0;
  gateAThrows = false;
  gateAOutcome = { round: 6, openQuestions: 2, resolved: false, stalled: true };
  const id = await mk('wr3', 'GATE_A_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_STALLED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_a_stalled'));
  assert.ok(notifyCalls.includes('needs_arbitration'));
});

test('step(GATE_A_REVISION_REQUESTED): the re-review throws -> park at GATE_A_FAILED and send failed', async () => {
  notifyCalls.length = 0;
  gateAThrows = true;
  const id = await mk('wr4', 'GATE_A_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(INTAKE): Gate A throws -> park at GATE_A_FAILED, record the error, and send a failed notification', async () => {
  notifyCalls.length = 0;
  gateAThrows = true;
  const id = await mk('w2', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.match(s.error ?? '', /Gate A output failed to parse/);
  assert.ok(notifyCalls.includes('failed'));
});

// -- The Gate B codex-reviews / claude-revises loop --
test('step(GATE_B_REQUESTED): the first draft plus a clean adversarial review -> AWAITING_GO and needs_go', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb1', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_b_done'));
  assert.ok(notifyCalls.includes('needs_go'));
});

test('step(GATE_B_REQUESTED): the revision escalates needs_human -> AWAITING_GATE_B_INPUT, the asks are persisted, and needs_gateb_input is sent', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 1, verdict: 'needs_revision', resolved: false, needsHuman: [{ id: 'H1', question: 'where does the refund go?' }], stalled: false, paused: false, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wb2', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GATE_B_INPUT');
  assert.match(s.gate_b_human_asks ?? '', /where does the refund go/);
  assert.ok(notifyCalls.includes('needs_gateb_input'));
});

test('step(GATE_B_REQUESTED): still unresolved at the cap -> GATE_B_STALLED and needs_gateb_arbitration', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 3, verdict: 'needs_revision', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [{ issue: 'a' }, { issue: 'b' }] };
  const id = await mk('wb3', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_STALLED');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_b_stalled'));
  assert.ok(notifyCalls.includes('needs_gateb_arbitration'));
});

test('step(GATE_B_REQUESTED): the per-tick cap -> stay in ADVERSARIAL_LOOP (no notification)', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 2, verdict: 'needs_revision', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wb4', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'ADVERSARIAL_LOOP');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gateb_loop_paused'));
  assert.equal(notifyCalls.includes('needs_go'), false);
});

test('step(ADVERSARIAL_LOOP): continuing to a clean result -> AWAITING_GO', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 3, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb5', 'ADVERSARIAL_LOOP');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.ok(notifyCalls.includes('needs_go'));
});

test('step(ADVERSARIAL_LOOP): another revision passes (resolved) -> the old parked residue is cleared (so the GO card shows no stale count)', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 2, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb9', 'ADVERSARIAL_LOOP');
  await sessions.patch(id, { adversarial_residual: JSON.stringify({ round: 1, findings: [{ issue: 'old' }] }) });
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(s.adversarial_residual, null); // resolving clears the residue
});

test('step(GATE_B_REVISION_REQUESTED): the revision after the owner answers comes back clean -> AWAITING_GO', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = false;
  gateBOutcome = { round: 2, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wb6', 'GATE_B_REVISION_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.ok(notifyCalls.includes('needs_go'));
});

test('step(GATE_B_REQUESTED): the first draft throws -> GATE_B_FAILED and failed', async () => {
  notifyCalls.length = 0;
  gateBThrows = true; gateBLoopThrows = false;
  const id = await mk('wb7', 'GATE_B_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(ADVERSARIAL_LOOP): the adversarial review throws -> GATE_B_FAILED and failed', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = true;
  const id = await mk('wb8', 'ADVERSARIAL_LOOP');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(GATE_B_REVISION_REQUESTED): when the revision fails and parks, the owner\'s answer and the old residue are kept so a retry can apply them again', async () => {
  notifyCalls.length = 0;
  gateBThrows = false; gateBLoopThrows = true;
  const id = await mk('wb10', 'GATE_B_REVISION_REQUESTED');
  await sessions.patch(id, {
    gate_b_pending_input: "the owner's decision: store-credit refunds, plus idempotency acceptance",
    adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'an older unresolved review finding' }] }),
  });
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_FAILED');
  assert.equal(s.gate_b_pending_input, "the owner's decision: store-credit refunds, plus idempotency acceptance");
  assert.match(s.adversarial_residual ?? '', /an older unresolved review finding/);
  assert.ok(notifyCalls.includes('failed'));
});

// -- The Gate D PR adversarial review (opening the PR + codex-reviews-diff / claude-revises) --
test('step(GATE_D_REQUESTED): opening the PR succeeds -> GATE_D_LOOP (the loop pauses this tick and stays there) with pr_url persisted', async () => {
  benignMocks();
  openPrThrows = false;
  gateDOutcome = { round: 1, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wd1', 'GATE_D_REQUESTED');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_LOOP');
  assert.equal(s.pr_url, 'https://x/pull/1'); // opening the PR persisted it
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gated_loop_paused'));
});

test('step(GATE_D_LOOP): codex says LGTM -> GATE_D_HARDENING with the green sha pinned (the commit that was approved becomes the hardening baseline)', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  const id = await mk('wd2', 'GATE_D_LOOP');
  await sessions.patch(id, { worktree_path: '/wt/x' }); // with an isolated tree, HEAD can be read and the green state pinned
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_HARDENING');
  assert.equal(s.gate_d_green_sha, 'GREENSHA'); // the key point: what is pinned is the current worktree HEAD, the commit codex approved
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_done'));
});

test('step(GATE_D_LOOP): codex says LGTM but the green HEAD cannot be read -> park at GATE_D_FAILED (never enter hardening; the diagnosis is pinned at the point of failure)', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  headSha = null; // worktreeHeadSha cannot read it
  const id = await mk('wd2b', 'GATE_D_LOOP');
  await sessions.patch(id, { worktree_path: '/wt/x' });
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED'); // it parks there and then, never entering HARDENING
  assert.equal((await sessions.get(id))!.gate_d_green_sha, null);
});

test('step(GATE_D_LOOP): the revision escalates needs_human -> AWAITING_GATE_D_INPUT and needs_gated_input', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 1, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: [{ id: 'H1', question: 'change the contract or the implementation?' }], stalled: false, paused: false, unresolvedFindings: [{ issue: 'x' }] };
  const id = await mk('wd3', 'GATE_D_LOOP');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GATE_D_INPUT');
  assert.match(s.gate_d_human_asks ?? '', /change the contract or the implementation/);
  assert.ok(notifyCalls.includes('needs_gated_input'));
});

test('step(GATE_D_LOOP): still unresolved at the cap -> GATE_D_STALLED and needs_gated_arbitration', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 3, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [{ issue: 'a' }] };
  const id = await mk('wd4', 'GATE_D_LOOP');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_STALLED');
  assert.ok(notifyCalls.includes('needs_gated_arbitration'));
});

test('step(GATE_D_REQUESTED): opening the PR throws -> GATE_D_FAILED and failed', async () => {
  notifyCalls.length = 0;
  benignMocks();
  openPrThrows = true;
  const id = await mk('wd5', 'GATE_D_REQUESTED');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(GATE_D_HARDENING): hardening succeeds -> AWAITING_HUMAN_MERGE and needs_merge (nothing is ever merged automatically)', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('wdh1', 'GATE_D_HARDENING');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_HUMAN_MERGE'); // merge-ready, stopping at the human merge (it never goes SHIPPED on its own)
  assert.equal(s.merge_readiness_path, '/tmp/merge-readiness.md');
  assert.ok(notifyCalls.includes('needs_merge'));
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gate_d_hardened'));
  // The automatic delivery-doc commit is off by default (runtime.yaml has no delivery_doc_commit), so the real
  // maybeCommitDeliveryDocs degrades gracefully into a no-op: no crash and no event.
  assert.ok(!(await sessions.events(id)).some((e) => e.kind === 'delivery_docs_committed'));
});

test('step(GATE_D_HARDENING): hardening throws -> GATE_D_FAILED and failed', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDHardenThrows = true;
  const id = await mk('wdh2', 'GATE_D_HARDENING');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED');
  assert.ok(notifyCalls.includes('failed'));
});

test('step(GATE_D_REVISION_REQUESTED): the stale hardening markers are cleared before returning to LOOP (so a later failure does not have planRetry wrongly return to HARDENING)', async () => {
  benignMocks();
  gateDOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wdrev', 'GATE_D_REVISION_REQUESTED');
  // Simulate the stale hardening markers left behind by a "merge-ready falls back to a revision" path.
  await sessions.patch(id, { gate_d_harden_round: 1, merge_readiness_path: '/x.md', gate_d_green_sha: 'G', gate_d_harden_verified_sha: 'V' });
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.gate_d_harden_round, null);
  assert.equal(s.merge_readiness_path, null);
  assert.equal(s.gate_d_green_sha, null);
  assert.equal(s.gate_d_harden_verified_sha, null);
});

test('tick: a transient GATE_D_FAILED whose backoff has expired -> reconcile retries it automatically back into GATE_D_LOOP (it has a pr_url)', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateDOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  const id = await mk('wd6', 'GATE_D_LOOP');
  // Pin it as a transient failure with the PR already open and the backoff expired.
  await sessions.transition(id, 'GATE_D_FAILED', { pr_url: 'https://x/pull/9', retry_count: 1, next_retry_at: Date.now() - 1 });
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_LOOP'); // if it were missing from reconcile it would be stuck at GATE_D_FAILED forever
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'auto_retry' && (e.detail ?? '').includes('GATE_D_LOOP')));
});

test('tick: a GATE_D_FAILED carrying the rollback poison pill whose backoff has expired -> reconcile returns it to LOOP, step fails again -> back to GATE_D_FAILED, with the pill surviving throughout (Codex, fourth review, SF)', async () => {
  // The worker-level poison-pill path: reconcile (planRetry does not clear the pill) -> step calls
  // runGateDLoop (the throw here stands for the real recoverPendingRollback failing its reset again and
  // rejecting) -> parkFailure returns it to GATE_D_FAILED. What is asserted is that the whole worker round trip
  // never clears the pill - otherwise the next entry into the loop has nothing to gate on and a red or dirty
  // HEAD would reach review-first. That "it does not enter the review" is proven separately in
  // gateDLoop.test.ts against the real recovery.
  notifyCalls.length = 0;
  benignMocks();
  gateDLoopThrows = true; // stands for runGateDLoop throwing because the recovery reset failed again
  const id = await mk('wd7', 'GATE_D_LOOP');
  await sessions.transition(id, 'GATE_D_FAILED', { pr_url: 'https://x/pull/9', gate_d_rollback_to: 'GREENSHA', retry_count: 1, next_retry_at: Date.now() - 1 });
  await parkLeftoverReady(id); // isolate the ready sessions left by earlier tests, so this test's target gets one of the bounded claim slots
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_D_FAILED'); // reconcile -> LOOP -> step throws again -> parked once more
  assert.equal(s.gate_d_rollback_to, 'GREENSHA'); // the pill survives throughout (neither planRetry nor parkFailure clears it), so the next entry into the loop is still gated
});

// tick() processes every ready session in the database, so the tick tests below set the mocks to benign values
// first, which keeps poller states left over from earlier tests from being advanced abnormally.
function benignMocks() {
  gateAThrows = false; gateBThrows = false; gateBLoopThrows = false;
  gateALoopThrows = false; gateALoopErrorMsg = 'the Gate A adversarial review failed';
  gateCLoopThrows = false;
  openPrThrows = false; gateDLoopThrows = false; gateDHardenThrows = false;
  headSha = 'GREENSHA';
  gateAErrorMsg = 'Gate A output failed to parse';
  gateALoopOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  gateBOutcome = { round: 1, verdict: 'clean', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
}

test('tick: an orphaned GATE_A_RUNNING (first round) self-heals -> back to INTAKE for a re-run, and it leaves the transient state', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  const id = await mk('w4', 'GATE_A_RUNNING'); // an orphan left behind by a previous tick dying midway (a first round, so no pending_input)
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.notEqual(s.state, 'GATE_A_RUNNING'); // no longer stuck in the transient state
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'recover' && (e.detail ?? '').includes('INTAKE')));
  assert.ok(notifyCalls.includes('recovered'));
});

test('tick: an orphaned GATE_A_RUNNING (a re-review) self-heals -> back to GATE_A_REVISION_REQUESTED without losing the rounds', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 2, openQuestions: 1, resolved: false, stalled: false };
  const id = await mk('w5', 'GATE_A_RUNNING');
  await sessions.patch(id, { gate_a_pending_input: "the PM's answer this round", gate_a_round: 1 }); // the marker of a re-review that died midway
  await worker.tick();
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'recover' && (e.detail ?? '').includes('GATE_A_REVISION_REQUESTED')));
  assert.notEqual((await sessions.get(id))!.state, 'GATE_A_RUNNING');
});

test('tick: an orphaned GATE_B_RUNNING (the first draft died midway) self-heals -> back to GATE_B_REQUESTED', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('w6', 'GATE_B_REQUESTED');
  await sessions.transition(id, 'GATE_B_RUNNING'); // an orphan in the first-draft transient state
  await worker.tick();
  // The tick reclaims it first (-> GATE_B_REQUESTED) and then advances normally; this only asserts that it left
  // the GATE_B_RUNNING transient state and recorded a recover event.
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'recover' && (e.detail ?? '').includes('GATE_B_REQUESTED')));
  assert.notEqual((await sessions.get(id))!.state, 'GATE_B_RUNNING');
});

// -- The step-failure retry machinery --
test('step(INTAKE): a transient failure (a timeout) -> schedule an automatic retry with a backoff (recording retry_count and next_retry_at, and sending no failed notification)', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAThrows = true; gateAErrorMsg = 'Gate A claude failed: claude timed out';
  const id = await mk('rt1', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.equal(s.retry_count, 1);
  assert.ok((s.next_retry_at ?? 0) > Date.now());
  assert.equal(s.dead_letter, null); // not dead-lettered
  assert.equal(notifyCalls.includes('failed'), false); // a transient failure sends no notification
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'retry_scheduled'));
});

test('tick: the backoff expires -> reconcile retries automatically, and the retry bookkeeping is cleared once it advances successfully', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  gateAThrows = true; gateAErrorMsg = 'claude timed out'; // stage one transient failure so a retry is scheduled
  const id = await mk('rt2', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED');
  assert.equal((await sessions.get(id))!.retry_count, 1);
  // The backoff expires and the next attempt succeeds -> the tick retries automatically
  await sessions.patch(id, { next_retry_at: Date.now() - 1 });
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 2, resolved: false, stalled: false };
  await parkLeftoverReady(id); // isolate the ready sessions left by earlier tests, so this test's target gets one of the bounded claim slots
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_PM_CONFIRM'); // the retry advanced successfully
  assert.equal(s.retry_count, null); // clearRetry cleared the bookkeeping
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'auto_retry'));
});

test('production path: a transient failure on the first Gate A adversarial round -> after the backoff it continues the adversarial loop in place, rather than falling back to INTAKE and re-asking the PM', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAOutcome = { round: 1, openQuestions: 0, resolved: true, stalled: false };
  const id = await mk('rt-gatea-adv-first-fail', 'INTAKE');
  await worker.step((await sessions.get(id))!);
  let s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_ADVERSARIAL');
  assert.equal(s.gate_a_adv_round, 0);

  gateALoopThrows = true;
  gateALoopErrorMsg = 'codex timed out';
  await worker.step((await sessions.get(id))!);
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.equal(s.gate_a_adv_round, 0);
  assert.equal(s.retry_count, 1);
  assert.ok((s.next_retry_at ?? 0) > Date.now());
  assert.equal(notifyCalls.includes('failed'), false);

  await sessions.patch(id, { next_retry_at: Date.now() - 1 });
  gateALoopThrows = false;
  gateALoopOutcome = { round: 1, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
  await writeGateA(id, []);
  await parkLeftoverReady(id); // isolate the ready sessions left by earlier tests, so this test's target gets one of the bounded claim slots
  await worker.tick();
  s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'AI');
  assert.equal(s.retry_count, null);
  assert.equal(s.next_retry_at, null);
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'auto_retry' && (e.detail ?? '').includes('GATE_A_ADVERSARIAL')), true);
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'transition' && (e.detail ?? '').includes('"to":"INTAKE"')), false);
  assert.ok(notifyCalls.includes('needs_gateb'));
  assert.equal(notifyCalls.includes('needs_confirm'), false);
});

test('step: a transient failure whose retries are exhausted (at the cap) -> dead letter plus a failed notification', async () => {
  notifyCalls.length = 0;
  benignMocks();
  gateAThrows = true; gateAErrorMsg = 'claude timed out';
  const id = await mk('rt3', 'INTAKE');
  await sessions.patch(id, { retry_count: 3 }); // already at max_auto_retries (3)
  await worker.step((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED');
  assert.equal(s.dead_letter, 1);
  assert.equal(s.next_retry_at, null);
  assert.ok(notifyCalls.includes('failed'));
});

test('tick: orphan resets reaching the cap -> dead letter (the poison-pill guard), with no further revivals', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('rt4', 'GATE_A_RUNNING');
  await sessions.patch(id, { reclaim_count: 3 }); // already at max_reclaims (3)
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_FAILED'); // it was not revived back to INTAKE
  assert.equal(s.dead_letter, 1);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'dead_letter'));
  assert.equal(notifyCalls.includes('failed'), true);
});

test('tick: a dead-lettered session is not retried automatically by reconcile', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('rt5', 'INTAKE');
  // Pin it directly as a dead-lettered GATE_A_FAILED whose backoff has already expired
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'GATE_A_FAILED', { dead_letter: 1, next_retry_at: Date.now() - 1, retry_count: 3 });
  await worker.tick();
  assert.equal((await sessions.get(id))!.state, 'GATE_A_FAILED'); // a dead letter does not move
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'auto_retry'), false);
});

test('tick: a transient GATE_C_FAILED whose backoff has expired -> reconcile retries it automatically back into GATE_C_LOOP (SF1: no more "a retry was scheduled but it silently stalls")', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = 'rt-gatec';
  await sessions.create({ id, slug: id, title: 'T', branch: 'dev' });
  for (const st of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED']) {
    await sessions.transition(id, st as never);
  }
  // A transient failure scheduled a backoff (with a worktree, planRetry returns to GATE_C_LOOP) and it has now
  // expired.
  gateCOutcome = { round: 2, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
  await sessions.transition(id, 'GATE_C_FAILED', { worktree_path: '/wt/x', retry_count: 1, next_retry_at: Date.now() - 1 });
  // reconcileRetries runs before the step phase, so it picks up the GATE_C_FAILED and flips it to GATE_C_LOOP;
  // the step in the same tick runs the (mocked) implementation loop, which pauses and stays in LOOP.
  await worker.tick();
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_C_LOOP'); // if GATE_C_FAILED were missing from reconcile it would stall at GATE_C_FAILED forever
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'auto_retry' && (e.detail ?? '').includes('GATE_C_LOOP')));
});

test('retry (manual): clears the dead letter and the retry bookkeeping, and flips it back into a runnable state', async () => {
  benignMocks();
  const actions = await import('../src/actions.ts');
  const id = await mk('rt6', 'INTAKE');
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'GATE_A_FAILED', { dead_letter: 1, retry_count: 3, next_retry_at: Date.now() + 999999 });
  const r = await actions.retry(id, 'M');
  assert.equal(r.ok, true);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'INTAKE'); // no pending_input -> back to INTAKE
  assert.equal(s.dead_letter, null);
  assert.equal(s.retry_count, null);
  assert.equal(s.next_retry_at, null);
});

// -- Deciding whether a tick lock is stale --
test('lockActive: a dead process voids the lock; alive and within the window is a live lock; alive but past it may be taken over; the old format with no timestamp is conservatively treated as alive', () => {
  const aliveAll = () => true;
  const deadAll = () => false;
  const now = 1_000_000_000;
  assert.equal(worker.lockActive(`123\n${now}`, now, 1000, deadAll), false); // the pid is dead
  assert.equal(worker.lockActive(`123\n${now}`, now, 1000, aliveAll), true); // alive, and the lock was just taken
  assert.equal(worker.lockActive(`123\n${now - 5000}`, now, 1000, aliveAll), false); // alive but past maxHold -> may be taken over
  assert.equal(worker.lockActive('123', now, 1000, aliveAll), true); // the old format has no timestamp -> treated as now, so alive
  assert.equal(worker.lockActive('', now, 1000, aliveAll), false); // empty -> void
});

test('lockMaxHoldSec: upstream-only takes claude × 6; downstream is estimated from the real longest tick (including the CI self-fix rounds, parse-repair and the per-tick rounds), so a long downstream tick is not mistaken for a hang and taken over into a double run', () => {
  const rt = (p: Record<string, unknown>) => p as unknown as Parameters<typeof worker.lockMaxHoldSec>[0];
  // The formula: (N+1)·(1+P)·(C+I)·(K+2), where K = MAX_CI_FIX_ATTEMPTS = 2 so (K+2) = 4; N = the effective
  // per-tick rounds; P = parse_repair_retries (2 by default).
  // With no downstream configuration the upstream value dominates: 1200 × 6 = 7200
  assert.equal(worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200 })), 7200);
  // The default downstream (claude 2400 / CI 1800 / parse-repair 2 / per-tick defaulting to 1):
  // (1+1)·(1+2)·4200·4 = 100800, far above the upstream 7200
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_c: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 }, gate_d: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    100800,
  );
  // parse-repair really is a factor: the same configuration with P=0 gives (1+1)·(1+0)·4200·4 = 33600 (below
  // the 100800 for P=2, which proves parse-repair is counted).
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, parse_repair_retries: 0, gate_d: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    33600,
  );
  // max_rounds_per_tick is a real factor too: setting Gate D to 2 rounds per tick gives N=2 ->
  // (2+1)·3·4200·4 = 151200, above the 100800 for N=1 (guarding against a double-run regression after retuning).
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_d: { max_rounds: 3, max_rounds_per_tick: 2, claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    151200,
  );
  // The effective N is clamped by max_rounds: per_tick=5 with max_rounds=1 gives N=1 ->
  // (1+1)·3·4200·4 = 100800 (an inflated per_tick cannot blow the bound up).
  assert.equal(
    worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_d: { max_rounds: 1, max_rounds_per_tick: 5, claude_timeout_sec: 2400, ci_timeout_sec: 1800 } })),
    100800,
  );
  // With no downstream claude configured it falls back to the global 1200, and CI to its default 1800:
  // (1+1)·(1+2)·(1200+1800)·4 = 72000, above the upstream value
  assert.equal(worker.lockMaxHoldSec(rt({ claude_timeout_sec: 1200, gate_c: { max_rounds: 4 } })), 72000);
  // The one-hour floor: even a tiny configuration never drops below 3600
  assert.equal(worker.lockMaxHoldSec(rt({ claude_timeout_sec: 60, gate_c: { claude_timeout_sec: 60, ci_timeout_sec: 60 }, gate_d: { claude_timeout_sec: 60, ci_timeout_sec: 60 } })), 3600);
});

test('lockActive x lockMaxHoldSec: under the default downstream configuration, a tick within the longest legitimate duration (including parse-repair and the per-tick rounds) is not taken over, and only one beyond it is (guarding against a double run)', () => {
  const rt = { claude_timeout_sec: 1200, parse_repair_retries: 2, gate_c: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 }, gate_d: { claude_timeout_sec: 2400, ci_timeout_sec: 1800 } };
  const holdMs = worker.lockMaxHoldSec(rt as unknown as Parameters<typeof worker.lockMaxHoldSec>[0]) * 1000; // 100800_000
  const alive = () => true;
  const now = 10_000_000_000;
  // A legitimately long downstream tick a moment before the bound is still a live lock, so the next tick must
  // stand aside (no takeover means no double run).
  assert.equal(worker.lockActive(`777\n${now - (holdMs - 1)}`, now, holdMs, alive), true);
  // Genuinely past the bound (a manual tick that appears to have hung) -> it may be taken over.
  assert.equal(worker.lockActive(`777\n${now - (holdMs + 1)}`, now, holdMs, alive), false);
});

// -- Atomically acquiring and taking over the tick lock (guarding against a double run: paying twice, and both
//    sides fighting over git in the same worktree) --
test('acquireLock: the wx atomic exclusive create - the first acquire in an empty directory succeeds and writes this pid; with this process alive and the lock fresh, a second acquire stands aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const lock = join(dir, 'tick.lock');
  assert.equal(worker.acquireLock(lock), true);
  assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}\\n`));
  assert.equal(worker.acquireLock(lock), false, 'this process is alive and the lock is fresh -> the second acquire stands aside (no double run)');
  worker.releaseLock(lock);
  assert.ok(!existsSync(lock));
  rmSync(dir, { recursive: true, force: true });
});

test('acquireLock: a stale lock (its holder is dead) -> taken over through the claim arbitration and rewritten with this pid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const lock = join(dir, 'tick.lock');
  writeFileSync(lock, `2147483646\n${Date.now()}`); // a huge pid -> kill(pid, 0) gives ESRCH -> pidAlive is false (dead)
  assert.equal(worker.acquireLock(lock), true, 'the holder is dead -> take it over');
  assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}\\n`));
  assert.ok(!existsSync(`${lock}.claim`), 'the claim is cleaned up after the takeover');
  worker.releaseLock(lock);
  rmSync(dir, { recursive: true, force: true });
});

test('releaseLock: it deletes only a lock held by this pid and leaves another pid\'s alone (never deleting someone else\'s live lock)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const lock = join(dir, 'tick.lock');
  writeFileSync(lock, `2147483646\n${Date.now()}`);
  worker.releaseLock(lock);
  assert.ok(existsSync(lock), "a lock held by another pid is not deleted by release");
  writeFileSync(lock, `${process.pid}\n${Date.now()}`);
  worker.releaseLock(lock);
  assert.ok(!existsSync(lock), 'a lock held by this pid is deleted');
  rmSync(dir, { recursive: true, force: true });
});

test('acquireClaim: the wx exclusive arbitration - the first claim wins; claiming again while it is fresh stands aside (so two takeover attempts can never both succeed); and a stale claim can be reclaimed and won', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claim-'));
  const claim = join(dir, 'tick.lock.claim');
  assert.equal(worker.acquireClaim(claim), true, 'the first claim');
  assert.equal(worker.acquireClaim(claim), false, 'a fresh claim is already held -> stand aside');
  writeFileSync(claim, `2147483646\n${Date.now() - 60_000}`); // a stale claim (residue from a crash)
  assert.equal(worker.acquireClaim(claim), true, 'the stale claim is reclaimed and won');
  rmSync(dir, { recursive: true, force: true });
});

// -- The parked-session reconciliation reminder --
test('remindStuck: below the threshold it does not interrupt; a long-parked session gets its card re-sent; and it does not repeat within the debounce window', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('sk1', 'GATE_B_REQUESTED');
  await sessions.transition(id, 'GATE_B_RUNNING');
  await sessions.transition(id, 'ADVERSARIAL_LOOP');
  await sessions.transition(id, 'AWAITING_GO');

  // 1. Just parked (now - updated_at is roughly 0, below 6h) -> no reminder
  await worker.remindStuck(Date.now());
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'), false);
  assert.equal(notifyCalls.includes('needs_go'), false);

  // 2. Simulating 7h later (above 6h) -> the card is re-sent
  const future = Date.now() + 7 * 3600 * 1000;
  await worker.remindStuck(future);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'));
  assert.ok(notifyCalls.includes('needs_go'));

  // 3. The debounce: it does not repeat within 12h
  notifyCalls.length = 0;
  await worker.remindStuck(future);
  assert.equal((await sessions.events(id)).filter((e) => e.kind === 'stuck_reminded').length, 1);
  assert.equal(notifyCalls.includes('needs_go'), false);
});

test('remindStuck: a *_FAILED state with an automatic retry already scheduled does not count as parked (no interruption)', async () => {
  notifyCalls.length = 0;
  benignMocks();
  const id = await mk('sk3', 'INTAKE');
  await sessions.transition(id, 'GATE_A_RUNNING');
  await sessions.transition(id, 'GATE_A_FAILED', { retry_count: 1, next_retry_at: Date.now() + 60000 }); // inside the backoff
  const future = Date.now() + 7 * 3600 * 1000;
  await worker.remindStuck(future);
  assert.equal((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'), false);
  // But a dead letter (automation has given up) should be reminded about
  await sessions.patch(id, { dead_letter: 1, next_retry_at: null });
  await worker.remindStuck(future);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'stuck_reminded'));
  assert.ok(notifyCalls.includes('failed'));
});

// -- The tick lifecycle hooks (the extension seam) --
//
// The contract (the scenarios first, then the assertions):
//   T1 on a round that actually ran: onTickStart and onTickEnd each fire exactly once;
//   T2 on a round **blocked by the lock, neither fires** - otherwise anything downstream reconciling against
//      tick events would count "squeezed out by another tick" as an idle round, inventing batches that never
//      happened;
//   T3 onTickEnd carries how many sessions this round actually advanced; an idle round is processed=0 with
//      ok=true (idle is not a failure);
//   T4 when the tick itself throws, onTickEnd still fires with ok=false and the error still propagates to the
//      caller (the hooks never swallow an exception);
//   T5 onTickEnd fires **after the lock is released** - a slow hook must not keep the next tick waiting at the
//      door;
//   T6 a hook throwing does not affect the tick's return value or what it advanced.
const ext = await import('../src/ext/index.ts');
const extTmp = mkdtempSync(join(tmpdir(), 'forge-worker-ext-'));

/** Install an extension pack that records tick events onto globalThis; `body` lets a hook do something extra
 *  (such as T5's lock probe). */
async function loadTickProbe(extra = '', preamble = ''): Promise<Array<Record<string, unknown>>> {
  ext.resetExtensionsForTest();
  const seen: Array<Record<string, unknown>> = [];
  (globalThis as unknown as { __tickSeen: unknown[] }).__tickSeen = seen;
  const dir = mkdtempSync(join(extTmp, 'pack-'));
  writeFileSync(
    join(dir, 'index.ts'),
    `${preamble}
     export default {
       name: 'tick-probe',
       hooks: {
         onTickStart: (e) => { globalThis.__tickSeen.push({ k: 'start', ...e }); },
         onTickEnd: (e) => { globalThis.__tickSeen.push({ k: 'end', ...e }); ${extra} },
       },
     };\n`,
  );
  await ext.loadExtensions(dir);
  return seen;
}

test('tick hooks: on a round that ran, start and end each fire once, and an idle round is processed=0 with ok=true', async () => {
  benignMocks();
  const seen = await loadTickProbe();
  try {
    for (const s of await sessions.listAll()) await sessions.patch(s.id, { state: 'SHIPPED' }); // clear the field, so this round is necessarily idle
    const n = await worker.tick();
    assert.equal(n, 0);
    assert.deepEqual(seen.map((e) => e.k), ['start', 'end']);
    assert.equal(seen[1].processed, 0);
    assert.equal(seen[1].ok, true, 'an idle round is not a failure');
    assert.equal(typeof seen[0].at, 'number');
  } finally {
    ext.resetExtensionsForTest();
  }
});

test('tick hooks: a round blocked by the lock fires no event at all (otherwise downstream would count "squeezed out" as an idle round)', async () => {
  benignMocks();
  const seen = await loadTickProbe();
  const lock = process.env.FORGE_LOCK as string;
  try {
    // Stage a live lock: this process's pid plus the current timestamp - acquireLock judges that someone is
    // already running and stands aside.
    writeFileSync(lock, `${process.pid}\n${Date.now()}`);
    const n = await worker.tick();
    assert.equal(n, 0);
    assert.deepEqual(seen, [], 'not getting the lock means the round never ran, so there should be no lifecycle event at all');
  } finally {
    rmSync(lock, { force: true });
    ext.resetExtensionsForTest();
  }
});

test('tick hooks: when it throws internally, onTickEnd still fires with ok=false and the error still propagates to the caller', async () => {
  benignMocks();
  const seen = await loadTickProbe();
  const { db } = await import('../src/store/db.ts');
  try {
    // Stage a session parked for 7h with nobody attending to it: the tick's remindStuck sends it a reminder,
    // and that notify call has no try/catch.
    // patch() always writes updated_at as now, so backdating has to go through raw SQL (this file already has a
    // precedent for writing `state` directly and bypassing the state machine).
    const id = await mk('tkh-boom', 'INTAKE');
    await sessions.transition(id, 'GATE_A_RUNNING');
    await sessions.transition(id, 'GATE_A_FAILED', { dead_letter: 1, next_retry_at: null });
    db().prepare('UPDATE session SET updated_at = ? WHERE id = ?').run(Date.now() - 7 * 3600 * 1000, id);

    notifyThrows = true;
    await assert.rejects(() => worker.tick(), /the notification layer blew up/, 'the hooks must not swallow the tick\'s exception');
    assert.deepEqual(seen.map((e) => e.k), ['start', 'end'], 'even a round that blew up must still be closed out');
    assert.equal(seen[1].ok, false, 'a round that died midway must not be reported as a normal completion');
    assert.equal(seen[1].processed, 0);
  } finally {
    notifyThrows = false;
    for (const s of await sessions.listAll()) await sessions.patch(s.id, { state: 'SHIPPED' });
    ext.resetExtensionsForTest();
  }
});

test('tick hooks: by the time onTickEnd fires the lock has been released (a slow hook must not keep the next round waiting at the door)', async () => {
  benignMocks();
  // The hook peeks at whether the lock file still exists: if it does, the release happens after the hooks, and
  // one stuck hook would block every subsequent tick.
  const seen = await loadTickProbe(
    `globalThis.__tickSeen.push({ k: 'lockHeld', v: fs.existsSync(process.env.FORGE_LOCK) });`,
    `import * as fs from 'node:fs';`, // an extension pack is ESM, so there is no require
  );
  try {
    for (const s of await sessions.listAll()) await sessions.patch(s.id, { state: 'SHIPPED' });
    await worker.tick();
    const probe = seen.find((e) => e.k === 'lockHeld');
    assert.ok(probe, 'the probe never ran');
    assert.equal(probe.v, false, 'the lock should already be released when onTickEnd fires');
  } finally {
    ext.resetExtensionsForTest();
  }
});

test('tick hooks: a hook throwing does not affect the tick\'s return value or what it advanced', async () => {
  benignMocks();
  ext.resetExtensionsForTest();
  const dir = mkdtempSync(join(extTmp, 'boom-'));
  writeFileSync(
    join(dir, 'index.ts'),
    `export default { name: 'boom', hooks: {
       onTickStart: () => { throw new Error('start boom'); },
       onTickEnd: () => { throw new Error('end boom'); },
     } };\n`,
  );
  await ext.loadExtensions(dir);
  try {
    const id = await mk('tkh1', 'INTAKE');
    await parkLeftoverReady(id);
    const n = await worker.tick();
    assert.equal(n, 1, 'a hook throwing must not cost this round one advanced session');
    // This only asserts that it really advanced, not which state it landed in - that depends on the
    // gateAOutcome earlier tests in this file have already changed, and pinning it would test the mock's
    // current configuration rather than the hooks.
    assert.notEqual((await sessions.get(id))!.state, 'INTAKE', 'a hook throwing must not leave the session where it was');
  } finally {
    ext.resetExtensionsForTest();
  }
});
