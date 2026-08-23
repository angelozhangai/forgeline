// Integration: runGateCLoop driving the real reviewFixLoop engine (**the reviewer is deterministic CI, not
// codex**; the fixer is claude editing the worktree).
// The LLM / CI / git / project boundaries are mocked, with a real sessions store (:memory:) and real
// render / strictParse / config / engine. It pins the invariants specific to Gate C:
//  1. not implemented (no commits after base) -> return unimplemented and **do not run CI** (no CI is wasted on
//     an empty tree, and claude is forced to start working);
//  2. implemented -> CI green -> LGTM -> resolved, with the diff and file list **rebuilt live from git by
//     forge** (the model's text is never trusted - what is under adversarial review is the worktree state);
//  3. CI red -> the failure summary is fed back to claude for another fix (the implement/CI loop closes);
//  4. later fix rounds use the resume prompt;
//  5. CI failing to run (ran=false, an infrastructure error) -> **throw and park**, never treated as red and
//     never sent to claude to fix nothing;
//  6. CI green but CI itself dirtied the worktree (green-but-dirty) -> throw (a false positive for HEAD, never
//     let through);
//  7. a failed commit, or a tree that is not clean after committing -> throw (CI must verify HEAD, never a
//     dirty tree);
//  8. a claude drop-out -> paused, with no commit;
//  9. claude escalating needs_human -> the needsHuman exit;
//  10. REVISION: after the owner's answer is applied fix-first, the pending input is cleared;
//  11. still not green at the hard cap -> stalled, with the residue persisted to gate_c_residual (handed to the
//      owner to arbitrate, never silently let through).
// It also captures the really-rendered prompt and asserts there is no leftover {{X}} - proving the code feeds
// every gate-c-implement / gate-c-fix-resume template variable (SF3, which catches the code forgetting one).
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Extract the body of one "## heading" section of the template (up to the next ## or the end): this asserts a
// variable landed in the **right section** rather than merely appearing somewhere in the prompt - which is what
// catches swapped variables (with FINDINGS and WORKTREE exchanged, a global match still passes while a
// per-section match must fail; Codex, second review, SF5).
function section(prompt: string, heading: string): string {
  const i = prompt.indexOf(heading);
  if (i < 0) return '';
  const after = prompt.slice(i + heading.length);
  const next = after.indexOf('\n## ');
  return next < 0 ? after : after.slice(0, next);
}
// intro = the body before the first ## (the resume template puts {{WORKTREE}} at the very top, not under any
// ## section).
function intro(prompt: string): string {
  const i = prompt.indexOf('\n## ');
  return i < 0 ? prompt : prompt.slice(0, i);
}

let claudeFix = JSON.stringify({ summary: 'implemented login-session persistence', needs_human: [] });
let claudeTextQueue: string[] = []; // a queue of runClaude.result texts (each call shifts one; empty -> claudeFix). Used for the broken-JSON self-healing case
let claudeOkQueue: boolean[] = []; // a queue of runClaude.ok values (each call shifts one; empty -> true)
let ciOkQueue: boolean[] = []; // a queue of runCi.ok values (each call shifts one; empty -> ciOkDefault)
let ciOkDefault = true;
let ciRan = true;
let commitResult = { ok: true, committed: true, output: 'committed' };
let commitQueue: { ok: boolean; committed: boolean; output: string }[] = []; // a queue of commitWorktree results (each call shifts one; empty -> commitResult)
let cleanQueue: boolean[] = []; // a queue of worktreeClean results (each call shifts one; empty -> cleanDefault)
let cleanDefault = true;
let hasCommits = false; // the hasCommitsSince flag; flipped to true after a successful commit (simulating "the implementation landed a commit")
let claudeCalls = 0;
let ciCalls = 0;
let commitCalls = 0;
let lastClaudePrompt = ''; // the really-rendered prompt (proving the code feeds every gate-c-* template variable)
let lastPersisted: Record<string, unknown> | null = null; // the envelope persistArtifact wrote (verifying forge rebuilds diff/files live)
// Capturing the second argument (Codex SF1/SF2): a mock that ignores its arguments means the tests only check
// the prompt text, and cannot catch a driver that stops passing - or passes the wrong - sessionId / resume /
// cwd / base, which is a silent wiring regression.
let claudeOptsLog: { sessionId: string | null; resume: string | null; cwd: string | undefined }[] = [];
let ciArgsLog: { wt: string; script: string | undefined; base: string | undefined }[] = [];

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string, opts: { sessionId?: string; resume?: string; cwd?: string } = {}) => {
      claudeCalls++;
      lastClaudePrompt = prompt;
      claudeOptsLog.push({ sessionId: opts.sessionId ?? null, resume: opts.resume ?? null, cwd: opts.cwd });
      const ok = claudeOkQueue.length ? (claudeOkQueue.shift() as boolean) : true;
      const text = claudeTextQueue.length ? (claudeTextQueue.shift() as string) : claudeFix;
      return ok
        ? { ok: true, result: text, sessionId: null, costUsd: 0.01, raw: text, error: null }
        : { ok: false, result: '', sessionId: null, costUsd: null, raw: '', error: 'claude dropped out' };
    },
  },
});
mock.module('../src/gates/ci.ts', {
  namedExports: {
    runCi: async (wt: string, script: string | undefined, opts: { base?: string } = {}) => {
      ciCalls++;
      ciArgsLog.push({ wt, script, base: opts?.base });
      const ok = ciOkQueue.length ? (ciOkQueue.shift() as boolean) : ciOkDefault;
      return { ok, ran: ciRan, summary: ok ? 'all green' : 'FAIL libs/x tests did not pass' };
    },
    hasCommitsSince: () => hasCommits,
    diffStatSince: () => ' libs/a.ts | 10 ++++',
    changedFilesSince: () => ['libs/a.ts'],
    commitWorktree: () => {
      commitCalls++;
      const r = commitQueue.length ? (commitQueue.shift() as { ok: boolean; committed: boolean; output: string }) : commitResult;
      if (r.ok && r.committed) hasCommits = true; // a real commit means base..HEAD has commits from now on (a no-op committed:false does not flip it)
      return r;
    },
    worktreeClean: () => (cleanQueue.length ? (cleanQueue.shift() as boolean) : cleanDefault),
  },
});
const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: false, diff_stat: '', files_changed: [], ci_ok: false, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: {
    readImplEnvelope: () => env,
    persistGateC: (_s: unknown, e: Record<string, unknown>) => { lastPersisted = e; },
    gateCContext: () => 'Tech design: implement login-session persistence. Outer-loop acceptance: AC1 still signed in after a refresh (currently red)',
  },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', scripts: { ci: './tools/scripts/forge-ci.sh' } }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateCLoop } = await import('../src/gates/gateCLoop.ts');

let n = 0;
async function mk(extra: Record<string, unknown> = {}): Promise<string> {
  const id = `cl${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  await sessions.patch(id, { worktree_path: '/wt', impl_branch: 'forge/x', base_shas: JSON.stringify({ '.': 'PINSHA' }), ...extra } as never);
  return id;
}

beforeEach(() => {
  claudeFix = JSON.stringify({ summary: 'implemented login-session persistence', needs_human: [] });
  claudeTextQueue = [];
  claudeOkQueue = [];
  ciOkQueue = [];
  ciOkDefault = true;
  ciRan = true;
  commitResult = { ok: true, committed: true, output: 'committed' };
  commitQueue = [];
  cleanQueue = [];
  cleanDefault = true;
  hasCommits = false;
  claudeCalls = 0;
  ciCalls = 0;
  commitCalls = 0;
  lastClaudePrompt = '';
  lastPersisted = null;
  claudeOptsLog = [];
  ciArgsLog = [];
});

test('not implemented (no commits after base) -> unimplemented, **CI is not run**, and claude is forced to start; the real gate-c-implement render leaves no placeholder (SF3)', async () => {
  const out = await runGateCLoop((await sessions.get(await mk()))!);
  assert.equal(ciCalls, 0); // no CI wasted on an empty tree - unimplemented short-circuits before runCi
  assert.equal(claudeCalls, 1); // claude is pushed straight into implementing
  assert.equal(commitCalls, 1); // once claude has written code, forge makes the commit
  assert.equal(out.paused, true); // per-tick = 1 (CI is expensive): one implementation round then pause, and CI runs on the next tick
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'the real gate-c-implement render has an unfed variable (the code forgot a template variable)');
  // The per-section sentinels (Codex, second review, SF5): "no leftover {{X}}" only catches a variable that was
  // never fed; a global match cannot catch one fed into the wrong place. These pin the values to their sections:
  assert.match(section(lastClaudePrompt, '## Workspace'), /\/wt/, 'WORKTREE must land in the "Workspace" section');
  assert.match(section(lastClaudePrompt, '## What to implement'), /Tech design: implement login-session persistence/, 'CONTEXT must land in the "What to implement" section');
  assert.doesNotMatch(section(lastClaudePrompt, '## Workspace'), /Tech design: implement login-session persistence/, 'CONTEXT leaking into the Workspace section means the variables were swapped, and must fail');
  // The prompt-injection guardrail must be rendered along with the prompt (untrusted requirement text reaches a
  // code-writing claude with pre-approved Bash, so the guardrail must not be silently dropped).
  assert.match(lastClaudePrompt, /[Ss]ecurity boundary/, 'gate-c-implement must carry the prompt-injection security boundary');
  assert.match(lastClaudePrompt, /untrusted data/, 'the guardrail must explicitly mark the context as untrusted data');
});

test('happy path (2 ticks): implement -> CI green -> LGTM -> resolved; the diff and file list are rebuilt live from git by forge (the model text is not trusted)', async () => {
  const id = await mk();
  const first = await runGateCLoop((await sessions.get(id))!); // tick 1: unimplemented -> implement -> pause (the commit flips hasCommits)
  assert.equal(first.paused, true);
  // The key regression (invariant 2): the envelope's diff_stat / files_changed / implemented come from git
  // (diffStatSince / changedFilesSince / hasCommitsSince), never from claude's JSON - claude only returns a
  // summary.
  assert.equal(lastPersisted!.implemented, true);
  assert.equal(lastPersisted!.diff_stat, ' libs/a.ts | 10 ++++');
  assert.deepEqual(lastPersisted!.files_changed, ['libs/a.ts']);
  assert.equal(lastPersisted!.last_summary, 'implemented login-session persistence'); // the only field that comes from the model's text

  const second = await runGateCLoop((await sessions.get(id))!); // tick 2: HEAD now has commits -> run CI -> green
  assert.equal(second.resolved, true);
  assert.equal(second.verdict, 'LGTM');
  assert.equal(ciCalls, 1); // tick 1 ran no CI (unimplemented); tick 2 runs it exactly once
  // CI really runs in the worktree, with the pinned base_sha (Codex SF2; this catches a missing base, a base
  // that degraded into a moving ref, or a mis-resolved script path - ciBase being a correct pure function does
  // not prove the driver wired it up).
  assert.deepEqual(ciArgsLog[0], { wt: '/wt', script: '/wt/tools/scripts/forge-ci.sh', base: 'PINSHA' });
});

test('CI red -> the failure summary is fed back to claude for another fix -> green -> resolved (the implement/CI loop closes)', async () => {
  const id = await mk();
  hasCommits = true; // already implemented (as when resuming); the reviewer goes straight to CI
  ciOkQueue = [false, true]; // tick 1 red, tick 2 green
  const first = await runGateCLoop((await sessions.get(id))!);
  assert.equal(first.paused, true);
  assert.match(lastClaudePrompt, /FAIL libs\/x/, 'the CI failure summary must be fed back to claude (otherwise it does not know what went red)');
  assert.deepEqual(ciArgsLog[0], { wt: '/wt', script: '/wt/tools/scripts/forge-ci.sh', base: 'PINSHA' }); // CI runs in the worktree with the pinned base (SF2)
  const second = await runGateCLoop((await sessions.get(id))!);
  assert.equal(second.resolved, true);
  assert.equal(second.verdict, 'LGTM');
});

test('later fix rounds: really resume the same fixer session (not a fresh one each time), and gate-c-fix-resume renders with every variable fed', async () => {
  const id = await mk();
  hasCommits = true;
  ciOkDefault = false; // red both rounds -> one fix per tick across two ticks
  await runGateCLoop((await sessions.get(id))!); // tick 1: fix #1 (initial, pinning a new fixer session)
  await runGateCLoop((await sessions.get(id))!); // tick 2: fix #2 (resume, since the fixer session now exists)
  // A real resume (Codex SF1): the first round pins a new sessionId (with no resume); the second round's resume
  // equals the persisted fixer session, with cwd = the worktree.
  // If the driver regressed into opening a fresh claude session every round (while still rendering the resume
  // prompt), the assertions below go red - checking the prompt text alone would not catch it.
  const fixer = (await sessions.get(id))!.gate_c_fixer_session;
  assert.ok(fixer, 'the fixer session must be pinned and persisted');
  assert.equal(claudeOptsLog[0].sessionId, fixer); // first round: the new session is the one that was persisted
  assert.equal(claudeOptsLog[0].resume, null); // the first round does not resume
  assert.equal(claudeOptsLog[0].cwd, '/wt'); // code edits must happen in the isolated worktree
  assert.equal(claudeOptsLog[1].resume, fixer); // second round: resume the same session (carrying the context, losing nothing from the previous round)
  assert.equal(claudeOptsLog[1].cwd, '/wt');
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'the real gate-c-fix-resume render has an unfed variable');
  // Per-section sentinels (SF5) catching swapped variables: FINDINGS belongs in the "Feedback to address this
  // round" section, WORKTREE in the intro.
  assert.match(section(lastClaudePrompt, '## Feedback to address this round'), /FAIL libs\/x/, 'FINDINGS must land in the "Feedback to address this round" section');
  assert.match(intro(lastClaudePrompt), /\/wt/, 'WORKTREE must be in the intro (the top of the resume template)');
  assert.doesNotMatch(section(lastClaudePrompt, '## Feedback to address this round'), /\/wt/, 'the worktree path leaking into the feedback section means the variables were swapped, and must fail');
});

test('CI cannot run (ran=false, an infrastructure error) -> throw and park; never treated as red and never sent to claude to fix nothing', async () => {
  const id = await mk();
  hasCommits = true; // already implemented -> the review goes straight to CI
  ciRan = false; // a missing script, a spawn failure, or a timeout
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s)); // the engine throws on review ok:false -> the worker parks at GATE_C_FAILED
  assert.equal(claudeCalls, 0); // an infrastructure error is not a red result: no revision is triggered
  assert.equal(commitCalls, 0);
});

test('CI green but CI itself dirtied the worktree (green-but-dirty) -> throw and park (a false positive for HEAD, never let through)', async () => {
  const id = await mk();
  hasCommits = true;
  ciOkQueue = [true]; // CI exits 0
  cleanQueue = [false]; // but the worktree is dirty after CI ran (codegen or formatting touched tracked files)
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s), /dirtied the worktree/);
  assert.equal(claudeCalls, 0); // review-first throws, so no revision happens
});

test('fix: the commit fails (the worktree may be dirty) -> throw and park, and CI is never run on a dirty tree', async () => {
  const id = await mk();
  commitResult = { ok: false, committed: false, output: 'commit boom' };
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s), /failed to make the commit/);
  assert.equal(commitCalls, 1);
  assert.equal(ciCalls, 0); // the unimplemented review ran no CI, and fix throws at the commit, so CI never sees a dirty tree
});

test('fix: the worktree is still not clean after the commit -> throw and park (CI must verify HEAD, not a dirty tree)', async () => {
  const id = await mk();
  cleanQueue = [false]; // still dirty after the commit
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateCLoop(s), /CI must verify HEAD/);
  assert.equal(commitCalls, 1);
  assert.equal(ciCalls, 0);
});

test('the claude revision call fails (a drop-out) -> paused, no advance, no commit (a failure must not be counted as another unresolved round)', async () => {
  const id = await mk();
  claudeOkQueue = [false]; // the revision claude drops out
  const out = await runGateCLoop((await sessions.get(id))!);
  assert.equal(out.paused, true);
  assert.equal(commitCalls, 0); // res.ok = false -> nothing is ever committed
  assert.equal(claudeCalls, 1);
});

test('claude escalates needs_human -> the needsHuman exit (the implementation landed; it is waiting on the owner to decide)', async () => {
  const id = await mk();
  claudeFix = JSON.stringify({ summary: 'implemented, but there is a trade-off to decide', needs_human: [{ id: 'H1', question: 'refund as store credit, or back to the original route?', options: [], context: '', severity: 'high' }] });
  const out = await runGateCLoop((await sessions.get(id))!);
  assert.ok(out.needsHuman && out.needsHuman.length === 1);
  assert.equal(commitCalls, 1); // this round's implementation was committed; what escalated is a decision, not a blockage
});

test('REVISION: the owner answers -> fix-first applies it unconditionally (carrying the previous round\'s escalated question and the answer into the prompt) -> on success the pending input is cleared and an event is recorded', async () => {
  const id = await mk({
    gate_c_pending_input: 'refund back to the original route, and add an idempotency key to prevent double refunds',
    // The point claude escalated last round, awaiting a decision: peekHumanAnswer must splice it into the
    // context so claude knows which question is being answered.
    gate_c_human_asks: JSON.stringify([{ id: 'H1', question: 'refund method: store credit or the original route?', options: [], context: '', severity: 'high' }]),
  });
  const out = await runGateCLoop((await sessions.get(id))!);
  assert.match(lastClaudePrompt, /refund method: store credit or the original route/, 'the previous round\'s escalated question must be carried back as context (otherwise the answer floats free of the question)');
  assert.match(lastClaudePrompt, /refund back to the original route/, 'the owner\'s answer must be fed into the fixer prompt (otherwise the decision is lost)');
  const s = (await sessions.get(id))!;
  assert.equal(s.gate_c_pending_input, null); // the answer is only consumed once it has been persisted successfully
  assert.equal(s.gate_c_human_asks, null); // consuming the answer clears the stale escalated question too
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gatec_human_answer_consumed'));
  assert.equal(out.resolved, true); // after fix-first, the follow-up review sees a green CI -> LGTM
});

test('a revision with broken JSON -> parseFixResult returns null, which triggers the engine\'s self-healing (resume and feed back for a re-emit) -> it recovers, and the old draft is never silently let through', async () => {
  const id = await mk();
  // The first revision output is broken JSON (it fails to parse), and the re-emit returns valid JSON.
  // parseFixResult must return null so the engine runs parse-repair, rather than swallowing it and letting the
  // old draft through.
  claudeTextQueue = ['a natural-language answer that is not JSON at all', JSON.stringify({ summary: 're-emitted: implementation complete', needs_human: [] })];
  // The second call (the repair re-emit) only re-emits JSON and changes no files -> modelled as a no-op commit
  // (committed:false). The driver must tolerate it: no throw, no stall.
  commitQueue = [{ ok: true, committed: true, output: 'committed' }, { ok: true, committed: false, output: 'no changes (the repair re-emit edited no files)' }];
  const out = await runGateCLoop((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(out.paused, true); // the self-heal succeeded -> normal progress (per-tick = 1 -> pause; no throw, no park)
  assert.equal(lastPersisted!.last_summary, 're-emitted: implementation complete'); // what is persisted is the valid re-emitted draft
  // Tightening (Codex SF3 + second review, nit 1): a repair re-emit must not pollute the round counter or the
  // cost, and a no-op commit must not make the driver throw or stall.
  assert.equal(claudeCalls, 2); // exactly: one broken JSON + one resume re-emit (nothing swallowed, nothing extra)
  assert.equal(s.gate_c_round, 1); // the self-heal completes inside the *same* round - a repair is never counted as an extra round
  assert.equal(commitCalls, 2); // the driver tries to commit after every successful claude call; the second returns committed:false (a no-op) and the driver carries on
  assert.ok(Math.abs((s.gate_c_cost_usd ?? 0) - 0.02) < 1e-9, 'both claude calls are billed (a repair costs money too), so exactly 0.02'); // guards against missed or double billing
});

test('still not green at the hard cap -> stalled, with the residue persisted to gate_c_residual (handed to the owner to arbitrate, never silently let through)', async () => {
  const id = await mk();
  hasCommits = true;
  ciOkDefault = false; // CI is red every round
  let out = await runGateCLoop((await sessions.get(id))!);
  for (let i = 0; i < 4 && !out.stalled; i++) out = await runGateCLoop((await sessions.get(id))!); // max_rounds = 4, per-tick = 1 -> the cap is hit on round 4
  assert.equal(out.stalled, true);
  const residual = (await sessions.get(id))!.gate_c_residual;
  assert.ok(residual, 'reaching the cap must persist the residue for a human to arbitrate');
  const parsed = JSON.parse(residual!) as { used: string; findings: unknown[] };
  assert.equal(parsed.used, 'ci'); // the reviewer is deterministic CI
  assert.ok(parsed.findings.length >= 1); // the residual findings (the CI failure summary) are not empty
});
