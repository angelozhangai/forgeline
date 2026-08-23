// Integration: runGateDHarden (Gate D test hardening). The LLM / CI / git boundaries are mocked, and it pins
// the hardening invariants:
// 1. happy path: reset to the **pinned green sha** (never a moving ref) -> harden -> commit -> CI green -> pin
//    verified_sha -> write the report -> push;
// 2. CI red -> a bounded number of self-fix rounds -> green;
// 3. still red -> roll back (to the pinned green sha) and throw;
// 4. the idempotent fast path: merge_readiness_path is set, HEAD == verified and the tree is clean -> only
//    re-push;
// 5. on the fast path with HEAD != verified -> **never push blindly**, fall through to a full re-hardening;
// 6. no pinned green sha -> throw (never harden on an unknown baseline);
// 7. the normalising reset fails -> throw;
// 8. the hardening claude fails -> roll back and throw;
// 9. the push fails after CI went green and the report was written -> throw but do **not** roll back
//    (verified_sha is kept so the next round re-pushes it idempotently).
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let claudeFix = JSON.stringify({ summary: 'added failure-path and permission-path tests', needs_human: [] });
let claudeOkQueue: boolean[] = [];
let ciOkQueue: boolean[] = [];
let ciRan = true;
let commitResult = { ok: true, committed: true, output: 'committed' };
let cleanQueue: boolean[] = [];
let resetOk = true;
let pushOk = true;
let headQueue: string[] = []; // worktreeHeadSha shifts one per call; when empty it uses headDefault
let headDefault = 'GREENHEAD';
let resetArgs: string[] = [];
let pushCalls = 0;
let commitCalls = 0;
let ciCalls = 0;
let claudeCalls = 0;
let resetCalls = 0;

let lastClaudePrompt = ''; // capture the really-rendered prompt (proving the code feeds every gate-d-harden-tests / gate-d-ci-fix template variable)
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

const DELIVERY = mkdtempSync(join(tmpdir(), 'forge-mr-'));

mock.module('../src/gates/ci.ts', {
  namedExports: {
    runCi: async () => {
      ciCalls++;
      const ok = ciOkQueue.length ? (ciOkQueue.shift() as boolean) : true;
      return { ok, ran: ciRan, summary: ok ? 'all green' : 'FAIL libs/x' };
    },
    hasCommitsSince: () => true,
    diffStatSince: () => ' a.ts | 2 +-',
    changedFilesSince: () => ['a.ts'],
    commitWorktree: () => { commitCalls++; return commitResult; },
    worktreeClean: () => (cleanQueue.length ? (cleanQueue.shift() as boolean) : true),
    pushWorktree: () => { pushCalls++; return { ok: pushOk, output: pushOk ? 'pushed' : 'push boom' }; },
    resetWorktree: (_wt: string, sha: string) => { resetCalls++; resetArgs.push(sha); return resetOk ? { ok: true, output: '' } : { ok: false, output: 'reset boom' }; },
  },
});
mock.module('../src/util/worktree.ts', { namedExports: { worktreeHeadSha: () => (headQueue.length ? (headQueue.shift() as string) : headDefault) } });

const env = {
  worktree_path: '/wt', impl_branch: 'forge/x', base_ref: 'origin/main', base_sha: 'PINSHA',
  implemented: true, diff_stat: ' a.ts | 2 +-', files_changed: ['a.ts'], ci_ok: true, ci_summary: '', last_summary: '',
};
mock.module('../src/gates/gateC.ts', {
  namedExports: { readImplEnvelope: () => env, persistGateC: () => {}, gateCContext: () => 'Tech design: build X' },
});
mock.module('../src/projects.ts', {
  namedExports: {
    projectForSession: () => ({ id: 'p', root: '/proj', repos: ['.'], repoPath: () => '/proj/repo', deliveryDir: DELIVERY, scripts: { ci: './tools/scripts/forge-ci.sh' } }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { runGateDHarden, buildMergeReadiness } = await import('../src/gates/gateDHarden.ts');
const { mkLeg } = await import('../src/gates/legs.ts');

let n = 0;
async function mk(extra: Record<string, unknown> = {}): Promise<string> {
  const id = `dh${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  await sessions.patch(id, { gate_d_green_sha: 'GREENHEAD', ...extra } as never); // a pinned green sha by default; individual tests can override it or set it to null
  return id;
}

beforeEach(() => {
  claudeFix = JSON.stringify({ summary: 'added failure-path and permission-path tests', needs_human: [] });
  claudeOkQueue = [];
  ciOkQueue = [];
  ciRan = true;
  commitResult = { ok: true, committed: true, output: 'committed' };
  cleanQueue = [];
  resetOk = true;
  pushOk = true;
  headQueue = [];
  headDefault = 'GREENHEAD';
  resetArgs = [];
  pushCalls = 0;
  commitCalls = 0;
  ciCalls = 0;
  claudeCalls = 0;
  resetCalls = 0;
  lastClaudePrompt = '';
});

test('happy path: reset to the pinned green sha (never a moving ref) -> harden -> CI green -> pin verified_sha -> write the report -> push', async () => {
  const id = await mk();
  await runGateDHarden((await sessions.get(id))!);
  const s = (await sessions.get(id))!;
  assert.equal(resetArgs[0], 'GREENHEAD'); // the key regression: the baseline is the pinned sha, not origin/forge/x
  assert.ok(!resetArgs.some((a) => a.startsWith('origin/'))); // it must never reset to a moving ref
  assert.equal(s.gate_d_harden_verified_sha, 'GREENHEAD'); // the verified HEAD is pinned
  assert.ok(s.merge_readiness_path && existsSync(s.merge_readiness_path)); // the report is written to disk (forge-local)
  assert.equal(s.gate_d_harden_round, 1);
  assert.equal(claudeCalls, 1);
  assert.equal(ciCalls, 1);
  assert.equal(pushCalls, 1);
  assert.match(readFileSync(s.merge_readiness_path!, 'utf8'), /Automatic merging is forbidden/);
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'the real gate-d-harden-tests render has an unfed variable (the code forgot a template variable)');
});

test('CI red -> a bounded number of self-fix rounds -> green', async () => {
  const id = await mk();
  ciOkQueue = [false, true];
  claudeOkQueue = [true, true];
  await runGateDHarden((await sessions.get(id))!);
  assert.equal(claudeCalls, 2);
  assert.equal(ciCalls, 2);
  assert.equal(pushCalls, 1);
  assert.ok(Math.abs(((await sessions.get(id))!.gate_d_cost_usd ?? 0) - 0.02) < 1e-9, 'the first hardening round and the self-fix after a red CI are both real billed calls, so the cost must accrue visibly');
  assert.ok((await sessions.get(id))!.merge_readiness_path);
  assert.doesNotMatch(lastClaudePrompt, /\{\{\w+\}\}/, 'the real gate-d-ci-fix render has an unfed variable (the self-fix round\'s prompt)');
});

test('CI stays red -> still red after the bounded self-fix rounds -> roll back (to the pinned green sha) and throw (nothing is pushed)', async () => {
  const id = await mk();
  ciOkQueue = [false, false, false];
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /still red/);
  assert.equal(ciCalls, 3);
  assert.equal(claudeCalls, 3);
  assert.ok(Math.abs(((await sessions.get(id))!.gate_d_cost_usd ?? 0) - 0.03) < 1e-9, 'even when it ultimately parks, the hardening and self-fix calls that did happen must still be billed and visible');
  assert.equal(pushCalls, 0);
  assert.deepEqual(resetArgs, ['GREENHEAD', 'GREENHEAD']); // both the entry normalisation and the exit rollback target the pinned green sha
});

test('the idempotent fast path: merge_readiness_path set + HEAD == verified + clean -> only re-push (no harden, CI or reset)', async () => {
  const id = await mk({ merge_readiness_path: '/tmp/already.md', gate_d_harden_verified_sha: 'GREENHEAD', gate_d_harden_round: 1 });
  headDefault = 'GREENHEAD'; // HEAD == verified
  await runGateDHarden((await sessions.get(id))!);
  assert.equal(claudeCalls, 0);
  assert.equal(ciCalls, 0);
  assert.equal(resetCalls, 0);
  assert.equal(pushCalls, 1); // it only re-pushes the already-verified commit
});

test('the fast path with HEAD != verified (the isolated tree was modified, or residue was left) -> never push blindly; fall through to a full re-hardening (resetting to the pinned green sha)', async () => {
  const id = await mk({ merge_readiness_path: '/tmp/already.md', gate_d_harden_verified_sha: 'VHEAD', gate_d_harden_round: 1 });
  headQueue = ['OTHER']; // the fast-path guard: the current HEAD is OTHER, which is not the verified VHEAD -> the fast path is skipped
  // Later calls (after the reset and after CI goes green) fall back to headDefault = 'GREENHEAD'
  await runGateDHarden((await sessions.get(id))!);
  assert.ok(claudeCalls >= 1); // it ran a full hardening pass (the fast path would leave claudeCalls at 0), proving nothing was pushed blindly
  assert.equal(resetArgs[0], 'GREENHEAD'); // the retry resets to the pinned green sha
  assert.equal(pushCalls, 1); // it only pushes after the full hardening pass (so the pushed commit is verified)
});

test('no pinned green sha -> throw (refusing to harden on an unknown or moving baseline; nothing is reset or hardened)', async () => {
  const id = await mk({ gate_d_green_sha: null });
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /pinned green sha .* is missing/);
  assert.equal(resetCalls, 0);
  assert.equal(claudeCalls, 0);
});

test('the normalising reset to the green sha fails -> throw (never harden on a tree with residue)', async () => {
  const id = await mk();
  resetOk = false;
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /normalising to the green sha .* failed/);
  assert.equal(claudeCalls, 0);
  assert.equal(ciCalls, 0);
  assert.equal(pushCalls, 0);
  assert.equal(resetCalls, 1);
});

test('the hardening claude fails -> roll back and throw (no commit, no CI, no push)', async () => {
  const id = await mk();
  claudeOkQueue = [false];
  const s = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(s), /hardening claude failed/);
  assert.equal(commitCalls, 0);
  assert.equal(ciCalls, 0);
  assert.equal(pushCalls, 0);
  assert.deepEqual(resetArgs, ['GREENHEAD', 'GREENHEAD']); // the entry normalisation plus the rollback
});

test('the push fails after CI went green and the report was written -> throw but do **not** roll back (verified_sha and the report are kept so the next round re-pushes idempotently)', async () => {
  const id = await mk();
  pushOk = false;
  const sess = (await sessions.get(id))!;
  await assert.rejects(() => runGateDHarden(sess), /failed to push the branch/);
  const s = (await sessions.get(id))!;
  assert.equal(s.gate_d_harden_verified_sha, 'GREENHEAD'); // already pinned
  assert.ok(s.merge_readiness_path); // the report was written
  assert.equal(resetCalls, 1); // only the entry normalisation - nothing rolls back once the report is written (verified work is never thrown away)
  assert.equal(pushCalls, 1);
});

test('multi-repo hardening: every PR keeps its own merge-readiness report, and a later repo never overwrites an earlier one', async () => {
  const id = await mk({
    legs: JSON.stringify([
      mkLeg('demo', { worktree_path: '/wt/demo', pr_url: 'https://x/pull/11' }),
      mkLeg('example-web', { worktree_path: '/wt/example-web', pr_url: 'https://x/pull/22' }),
    ]),
    worktree_path: '/wt/demo',
    base_shas: JSON.stringify({ demo: 'PINSHA' }),
    pr_url: 'https://x/pull/11',
    pr_number: 11,
  });

  await runGateDHarden((await sessions.get(id))!);
  const firstPath = (await sessions.get(id))!.merge_readiness_path!;
  const firstText = readFileSync(firstPath, 'utf8');
  assert.match(firstPath, /merge-readiness\.demo\.md$/);
  assert.match(firstText, /https:\/\/x\/pull\/11/);

  await sessions.patch(id, {
    worktree_path: '/wt/example-web',
    base_shas: JSON.stringify({ 'example-web': 'PINSHA' }),
    pr_url: 'https://x/pull/22',
    pr_number: 22,
    gate_d_harden_round: null,
    gate_d_harden_verified_sha: null,
    merge_readiness_path: null,
  });
  await runGateDHarden((await sessions.get(id))!);
  const secondPath = (await sessions.get(id))!.merge_readiness_path!;
  const secondText = readFileSync(secondPath, 'utf8');

  assert.notEqual(firstPath, secondPath, 'the merge evidence for several repos must stay per-repo; sharing one path would let a later repo overwrite it');
  assert.match(secondPath, /merge-readiness\.example-web\.md$/);
  assert.match(readFileSync(firstPath, 'utf8'), /https:\/\/x\/pull\/11/, 'the first repo\'s report still records its own PR');
  assert.match(secondText, /https:\/\/x\/pull\/22/, 'the second repo\'s report records its own PR');
});

test('buildMergeReadiness: carries the PR, the changes, the rollback plan and the no-automatic-merge line (a pure function)', () => {
  const s = { slug: 'x', title: 'build a feature', branch: 'main', pr_url: 'https://x/pull/9', gate_d_residual: null } as never;
  const md = buildMergeReadiness(s, env as never, { context: 'Requirement: build X', codexRound: 2, hardenSummary: 'added failure-path tests' });
  assert.match(md, /https:\/\/x\/pull\/9/);
  assert.match(md, /Automatic merging is forbidden/);
  assert.match(md, /Rollback plan/);
  assert.match(md, /a\.ts/);
  assert.match(md, /codex said LGTM in round 2/);
});
