// Integration: runGateDLoop driving the real reviewFixLoop engine (codex reviews the diff / claude edits the
// worktree), with the LLM / CI / git boundaries mocked.
// It pins the invariants specific to Gate D: (1) codex says LGTM -> resolved; (2) CHANGES -> claude revises ->
// CI green -> **push** -> codex says LGTM -> resolved; (3) CI red after the revision -> **throw** (a red state
// is never pushed into the PR, and the worker parks at GATE_D_FAILED); (4) claude escalating needs_human ->
// the needsHuman exit.
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A queue of codex verdicts (one shifted per round); a queue of claude ok values (one shifted per call,
// defaulting to ok); CI green/red is controllable; a worktreeClean queue (defaulting to true); the commit
// result is controllable; reset / push / ci / claude all record their calls.
let codexVerdicts: string[] = [];
let claudeFix = JSON.stringify({ summary: 'revised per the findings', needs_human: [] });
let claudeOkQueue: boolean[] = [];
let ciOk = true;
let ciRan = true;
let commitResult = { ok: true, committed: true, output: 'committed' };
let cleanQueue: boolean[] = [];
let resetOk = true;
let pushCalls = 0;
let commitCalls = 0;
let ciCalls = 0;
let claudeCalls = 0;
let resetCalls = 0;
let codexCalls = 0;
let lastCodexPrompt = ''; // capture the really-rendered prompt, proving the code fed every template variable (no leftover {{X}})
let lastClaudePrompt = '';

mock.module('../src/llm/runCodex.ts', {
  namedExports: {
    runCodex: async (prompt: string) => {
      codexCalls++;
      lastCodexPrompt = prompt;
      const v = codexVerdicts.shift() ?? JSON.stringify({ verdict: 'LGTM', findings: [] });
      return { ok: true, result: v, threadId: 't-codex', tokens: { input: 1, cachedInput: 0, output: 1 }, raw: v, available: true, error: null };
    },
  },
});
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string) => {
      claudeCalls++;
      lastClaudePrompt = prompt;
      const ok = claudeOkQueue.length ? (claudeOkQueue.shift() as boolean) : true;
      return ok
        ? { ok: true, result: claudeFix, sessionId: null, costUsd: 0.01, raw: claudeFix, error: null }
        : { ok: false, result: '', sessionId: null, costUsd: null, raw: '', error: 'claude dropped out' };
    },
  },
});
mock.module('../src/gates/ci.ts', {
  namedExports: {
    runCi: async () => { ciCalls++; return { ok: ciOk, ran: ciRan, summary: ciOk ? 'all green' : 'FAIL libs/x' }; },
    hasCommitsSince: () => true,
    diffStatSince: () => ' a.ts | 2 +-',
    changedFilesSince: () => ['a.ts'],
    commitWorktree: () => { commitCalls++; return commitResult; },
    worktreeClean: () => (cleanQueue.length ? (cleanQueue.shift() as boolean) : true),
    pushWorktree: () => { pushCalls++; return { ok: true, output: 'pushed' }; },
    resetWorktree: () => { resetCalls++; return resetOk ? { ok: true, output: '' } : { ok: false, output: 'reset boom (nested residue)' }; },
  },
});
mock.module('../src/util/worktree.ts', { namedExports: { worktreeHeadSha: () => 'PREHEAD' } });
const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: true, diff_stat: '', files_changed: [], ci_ok: true, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: { readImplEnvelope: () => env, persistGateC: () => {}, gateCContext: () => 'Tech design: build X' },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', scripts: { ci: './tools/scripts/forge-ci.sh' } }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateDLoop } = await import('../src/gates/gateDLoop.ts');

let n = 0;
async function mk(): Promise<string> {
  const id = `dl${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  return id;
}

beforeEach(() => {
  codexVerdicts = [];
  claudeFix = JSON.stringify({ summary: 'revised per the findings', needs_human: [] });
  claudeOkQueue = [];
  ciOk = true;
  ciRan = true;
  commitResult = { ok: true, committed: true, output: 'committed' };
  cleanQueue = [];
  resetOk = true;
  pushCalls = 0;
  commitCalls = 0;
  ciCalls = 0;
  claudeCalls = 0;
  resetCalls = 0;
  codexCalls = 0;
  lastCodexPrompt = '';
  lastClaudePrompt = '';
});

test('the really-rendered prompts leave no placeholder (the code feeds every gate-d-pr-review / gate-d-fix template variable; SF3 catches a variable the code forgot)', async () => {
  codexVerdicts = [CHANGES]; // go through review(CHANGES) -> fix, so both really-rendered prompts are captured
  await runGateDLoop((await sessions.get(await mk()))!);
  assert.doesNotMatch(lastCodexPrompt, /\{\{\w+\}\}/, 'the codex review prompt has an unfed variable (the code forgot a template variable)');
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'the claude revision prompt has an unfed variable (the code forgot a template variable)');
});

const CHANGES = JSON.stringify({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue: 'x', where: 'a.ts:1', fix: '', evidence: '' }] });

test('the resume round renders with nothing left over (gate-d-pr-review-resume + gate-d-fix-resume; the code feeds every continuation variable, SF4 covering the resume branch)', async () => {
  // The earlier render assertions only covered the initial branch (gate-d-pr-review / gate-d-fix); the resume
  // branch had no backstop proving the code really feeds its variables (Codex SF4).
  // Run two full ticks: tick 1 takes the initial branch (pinning both sides' sessions), and tick 2 takes the
  // resume branch because both sessions now exist.
  codexVerdicts = [CHANGES, CHANGES]; // CHANGES both rounds -> each tick reviews once and revises once (CI green -> push, then pause)
  ciOk = true;
  const id = await mk();
  await runGateDLoop((await sessions.get(id))!); // tick 1: initial review + initial fix
  await runGateDLoop((await sessions.get(id))!); // tick 2: resume review + resume fix
  assert.doesNotMatch(lastCodexPrompt, /\{\{\w+\}\}/, 'gate-d-pr-review-resume has an unfed variable (the code forgot a template variable)');
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-d-fix-resume has an unfed variable (the code forgot a template variable)');
});

test('codex says LGTM on the first round -> resolved (no revision, no push)', async () => {
  codexVerdicts = [JSON.stringify({ verdict: 'LGTM', findings: [] })];
  const out = await runGateDLoop((await sessions.get(await mk()))!);
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'LGTM');
  assert.equal(commitCalls, 0); // LGTM triggers no revision
  assert.equal(pushCalls, 0);
});

test('codex says CHANGES -> claude revises -> CI green -> push (per-tick = 1, so this round pauses); the next tick codex says LGTM -> resolved', async () => {
  codexVerdicts = [
    JSON.stringify({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue: 'the failure path is not covered', where: 'a.ts:1', fix: '', evidence: '' }] }),
    JSON.stringify({ verdict: 'LGTM', findings: [] }),
  ];
  ciOk = true;
  const id = await mk();
  const first = await runGateDLoop((await sessions.get(id))!);
  assert.equal(first.paused, true); // per-tick = 1 (CI is expensive): revise, CI green, push, then pause and continue next tick
  assert.ok(commitCalls >= 1); // the revision was committed
  assert.ok(pushCalls >= 1); // the branch is only pushed once CI is green
  const second = await runGateDLoop((await sessions.get(id))!); // the next tick: codex reviews again
  assert.equal(second.resolved, true);
  assert.equal(second.verdict, 'LGTM');
});

test('CI stays red after the revision -> still red once claude\'s bounded self-fix rounds are exhausted -> roll back and throw (a red state is never pushed; the CI call count pins the off-by-one)', async () => {
  codexVerdicts = [CHANGES];
  ciOk = false; // CI is red every round
  const id = await mk();
  await assert.rejects(async () => runGateDLoop((await sessions.get(id))!), /still red/);
  assert.equal(pushCalls, 0); // a red state is never pushed
  assert.equal(ciCalls, 3); // MAX_CI_FIX_ATTEMPTS = 2: the initial CI + one CI after each of the 2 self-fix rounds = exactly 3 (which pins termination)
  assert.equal(claudeCalls, 3); // the initial revision + 2 self-fix rounds
  assert.ok(Math.abs(((await sessions.get(id))!.gate_d_cost_usd ?? 0) - 0.03) < 1e-9, 'the initial revision and both self-fix rounds are real billed calls, so the cost must accrue visibly');
  assert.equal(resetCalls, 1); // it rolls back to preHead before exiting (leaving no red commit behind)
  // A render backstop for gate-d-ci-fix at the **loop's self-fix call site** (Codex, second review, nit 2: that
  // call site had no capture before - only gateDHarden's hardening self-fix site did). At this point
  // lastClaudePrompt is the final gate-d-ci-fix render.
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'gate-d-ci-fix (the loop self-fix call site) has an unfed variable (the code forgot CI or WORKTREE)');
});

test('CI cannot run after the revision (infrastructure) -> roll back and throw (park, with no push and no self-fix)', async () => {
  codexVerdicts = [CHANGES];
  ciRan = false;
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /CI could not be run/);
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1);
});

test('blocker: the commit fails (the worktree may be dirty) -> roll back and throw, and never run CI or push', async () => {
  codexVerdicts = [CHANGES];
  commitResult = { ok: false, committed: false, output: 'commit boom' };
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /failed to make the commit/);
  assert.equal(ciCalls, 0); // CI is never run on a dirty tree
  assert.equal(pushCalls, 0); // nothing is pushed
  assert.equal(resetCalls, 1);
});

test('blocker: the worktree is not clean after the commit (before CI) -> roll back and throw, and never run CI or push', async () => {
  codexVerdicts = [CHANGES];
  cleanQueue = [false]; // dirty right after the commit
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /CI must verify HEAD/);
  assert.equal(ciCalls, 0);
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1);
});

test('blocker: CI is green but CI itself dirtied the worktree -> roll back and throw, and never push (what CI verified is not the HEAD being pushed)', async () => {
  codexVerdicts = [CHANGES];
  ciOk = true;
  cleanQueue = [true, false]; // clean before CI, dirtied by the CI script afterwards (codegen or formatting)
  await assert.rejects(async () => runGateDLoop((await sessions.get(await mk()))!), /dirtied after CI/);
  assert.equal(ciCalls, 1);
  assert.equal(pushCalls, 0); // never push something CI did not actually verify at HEAD
  assert.equal(resetCalls, 1);
});

test('blocker: the self-fix claude drops out after a red CI -> roll back and pause (a red commit must never be left at HEAD for the next tick to LGTM)', async () => {
  codexVerdicts = [CHANGES];
  ciOk = false; // the initial CI is red -> a self-fix is triggered
  claudeOkQueue = [true, false]; // the initial revision succeeds, the self-fix claude drops out
  const out = await runGateDLoop((await sessions.get(await mk()))!);
  assert.equal(out.paused, true); // a drop-out -> the engine pauses and retries (without advancing the round)
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1); // rolled back to preHead: the next tick's review-first sees the previous green HEAD, so it cannot LGTM a red change
});

test('a no-op revision (no edits, worktree clean) + CI green -> no throw, and it may push (HEAD is exactly the commit CI verified)', async () => {
  codexVerdicts = [CHANGES];
  commitResult = { ok: true, committed: false, output: 'no changes' }; // claude edited no files
  ciOk = true; // cleanQueue defaults to all true (clean before and after CI)
  const first = await runGateDLoop((await sessions.get(await mk()))!); // per-tick = 1 -> pause after one revision round
  assert.equal(first.paused, true);
  assert.ok(ciCalls >= 1 && pushCalls >= 1); // CI verified HEAD and HEAD was pushed (no mismatch)
});

test('blocker: the revision needs a rollback but resetWorktree fails -> record the gate_d_rollback_to poison pill and throw (the worktree reset is unconfirmed, so the gate takes over)', async () => {
  const id = await mk();
  await sessions.patch(id, { worktree_path: '/wt' });
  codexVerdicts = [CHANGES];
  ciOk = false; // CI stays red -> the self-fix rounds are exhausted -> bail -> rollback
  resetOk = false; // the rollback itself fails
  await assert.rejects(async () => runGateDLoop((await sessions.get(id))!), /failed to roll the worktree back to/);
  assert.equal(pushCalls, 0); // nothing is pushed
  assert.equal(resetCalls, 1); // it attempted the rollback once
  assert.equal((await sessions.get(id))!.gate_d_rollback_to, 'PREHEAD'); // the poison pill records the HEAD at the fix entry (from the worktreeHeadSha mock)
});

test('blocker: a poison pill left by a previous failed rollback (gate_d_rollback_to) -> the loop forces a reset first; if that reset fails too -> throw, and review-first is never entered', async () => {
  // This is the regression for Codex's third-review blocker: a failed rollback parks at GATE_D_FAILED, and
  // planRetry sends it - PR already open - back to GATE_D_LOOP. Without a confirmed reset before the loop runs,
  // codex's review-first would LGTM a red or dirty HEAD and walk straight past the CI gate.
  const id = await mk();
  await sessions.patch(id, { gate_d_rollback_to: 'GREENSHA', worktree_path: '/wt' });
  resetOk = false; // the reset fails again
  codexVerdicts = [JSON.stringify({ verdict: 'LGTM', findings: [] })]; // even if codex would say LGTM, it must never be called
  await assert.rejects(async () => runGateDLoop((await sessions.get(id))!), /rollback recovery failed/);
  assert.equal(codexCalls, 0); // the reset was not confirmed -> review-first must not run (a red or dirty HEAD may not enter the review)
  assert.equal(resetCalls, 1); // the loop attempts the reset once on entry
  assert.equal((await sessions.get(id))!.gate_d_rollback_to, 'GREENSHA'); // the poison pill stays, so the next retry is gated again and nothing is let through on error classification
});

test('the rollback poison pill: the reset is confirmed on entry -> the pill is cleared and review-first proceeds (codex says LGTM -> resolved)', async () => {
  const id = await mk();
  await sessions.patch(id, { gate_d_rollback_to: 'GREENSHA', worktree_path: '/wt' });
  resetOk = true; // the reset is confirmed
  codexVerdicts = [JSON.stringify({ verdict: 'LGTM', findings: [] })];
  const out = await runGateDLoop((await sessions.get(id))!);
  assert.equal(out.resolved, true);
  assert.equal(resetCalls, 1); // the reset is confirmed once
  assert.ok(codexCalls >= 1); // the review only proceeds after the reset is confirmed
  assert.equal((await sessions.get(id))!.gate_d_rollback_to, null); // a successful reset clears the poison pill
});

test('the claude revision escalates needs_human -> the needsHuman exit (CI green, already pushed)', async () => {
  codexVerdicts = [CHANGES];
  claudeFix = JSON.stringify({ summary: 'revised, but there is a trade-off to decide', needs_human: [{ id: 'H1', question: 'change the contract or the implementation?', options: [], context: '', severity: 'high' }] });
  ciOk = true;
  const out = await runGateDLoop((await sessions.get(await mk()))!);
  assert.ok(out.needsHuman && out.needsHuman.length === 1);
  assert.ok(pushCalls >= 1); // the change landed and CI is green -> pushed; what escalated is a decision, not a blockage
});
