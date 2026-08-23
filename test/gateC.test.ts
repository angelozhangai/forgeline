// Integration: gate C's human actions -- requestGateC when chained, submitGateCAnswers, and the standalone
// addImplementTask -- through the permission gate and the state transitions, plus the pure ciTextToVerdict.
// The real permissions.yaml is used (gate_c_allowed=[M]); Feishu, the write actions and the load probe are
// mocked.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', { namedExports: { doWrites: async () => ({ ok: true, stdout: '', issues: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');
const intake = await import('../src/intake.ts');
const { ciTextToVerdict, ciBase } = await import('../src/gates/gateCLoop.ts');
const gateC = await import('../src/gates/gateC.ts');

let n = 0;
// Drive a session to the target state along legal edges only.
async function at(target: string): Promise<string> {
  const id = `c${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  const toDone = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE'];
  const path: Record<string, string[]> = {
    DONE: toDone,
    GATE_C_REQUESTED: [...toDone, 'GATE_C_REQUESTED'],
    AWAITING_GATE_C_INPUT: [...toDone, 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_C_INPUT'],
    GATE_C_STALLED: [...toDone, 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_STALLED'],
    CONFIRMED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED'],
  };
  for (const st of path[target] ?? []) await sessions.transition(id, st as never);
  return id;
}

test('requestGateC: DONE plus the permission (M) -> GATE_C_REQUESTED', async () => {
  const id = await at('DONE');
  const r = await actions.requestGateC(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_REQUESTED');
  assert.equal((await sessions.get(id))!.gate_c_requested_by, 'M');
});

test('requestGateC: refused from any state other than DONE (pointing at `implement --issue` for a standalone run)', async () => {
  const id = await at('CONFIRMED');
  const r = await actions.requestGateC(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /it has to be DONE/);
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED');
});

test('requestGateC: someone without the permission is refused, the state does not move, and permission_denied is recorded', async () => {
  const id = await at('DONE');
  const r = await actions.requestGateC(id, 'ZZ');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'DONE');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('requestGateC: already at GATE_C_REQUESTED is idempotently ok', async () => {
  const id = await at('GATE_C_REQUESTED');
  assert.ok((await actions.requestGateC(id, 'M')).ok);
});

test('requestGateC when chained: gate A\'s repos_touched letter U anchors target_repos to the right repo, example-web (through proj.repoMap -- a regression test for a blocker codex found)', async () => {
  const id = await at('DONE');
  const dir = mkdtempSync(join(tmpdir(), 'forge-ga-'));
  const p = join(dir, 'gate-a.json');
  writeFileSync(p, JSON.stringify({ repos_touched: ['U'] })); // the gate A envelope emits letters, never repo names
  await sessions.patch(id, { gate_a_output_path: p });
  assert.ok((await actions.requestGateC(id, 'M')).ok);
  assert.deepEqual(JSON.parse((await sessions.get(id))!.target_repos ?? '[]'), ['example-web']); // the letter U resolves to the repo name (no more silent fallback to demo)
});

test('submitGateCAnswers: AWAITING_GATE_C_INPUT -> GATE_C_REVISION_REQUESTED, storing pending_input', async () => {
  const id = await at('AWAITING_GATE_C_INPUT');
  const r = await actions.submitGateCAnswers(id, 'M', 'refund to the balance, and add an idempotency key');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_C_REVISION_REQUESTED');
  assert.equal(s.gate_c_pending_input, 'refund to the balance, and add an idempotency key');
});

test('submitGateCAnswers: ruling on a stalled gate C carries on, and even an empty answer counts as another round', async () => {
  const id = await at('GATE_C_STALLED');
  const r = await actions.submitGateCAnswers(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_REVISION_REQUESTED');
});

test('submitGateCAnswers: refused from the wrong state, or without the permission', async () => {
  assert.equal((await actions.submitGateCAnswers(await at('DONE'), 'M')).ok, false);
  assert.equal((await actions.submitGateCAnswers(await at('AWAITING_GATE_C_INPUT'), 'ZZ')).ok, false);
});

test('addImplementTask: a bare issue starts straight at GATE_C_REQUESTED with source_kind=issue and issue_ref stored; with no --repo, target_repos falls back to the first repo', async () => {
  const r = await intake.addImplementTask({ issueRef: 'your-org/x#42', title: 'fix the lost login session', by: 'M' });
  assert.ok(r.ok && r.created);
  const s = r.session!;
  assert.equal(s.state, 'GATE_C_REQUESTED');
  assert.equal(s.source_kind, 'issue');
  assert.equal(s.issue_ref, 'your-org/x#42');
  assert.equal(s.gate_c_requested_by, 'M');
  assert.deepEqual(JSON.parse(s.target_repos ?? '[]'), ['demo']); // no --repo given -> falls back to proj.repos[0]
});

test('addImplementTask: a valid --repo is stored in target_repos; an invalid one errors and creates nothing (never implement in the wrong repo)', async () => {
  const ok = await intake.addImplementTask({ issueRef: 'your-org/x#43', title: 'change the front end', repo: 'example-web', by: 'M' });
  assert.ok(ok.ok && ok.created);
  assert.deepEqual(JSON.parse(ok.session!.target_repos ?? '[]'), ['example-web']);
  const byLetter = await intake.addImplementTask({ issueRef: 'your-org/x#45', title: 'the admin side', repo: 'A', by: 'M' }); // a letter is accepted too (through repoMap)
  assert.ok(byLetter.ok && byLetter.created);
  assert.deepEqual(JSON.parse(byLetter.session!.target_repos ?? '[]'), ['example-admin']);
  const bad = await intake.addImplementTask({ issueRef: 'your-org/x#44', title: 'x', repo: 'nope-repo', by: 'M' });
  assert.equal(bad.ok, false);
  assert.equal(bad.created, false);
  assert.match(bad.msg, /is not among the project/);
});

test('addImplementTask: the same issue_ref is deduplicated (the second call reuses it rather than creating another)', async () => {
  const a = await intake.addImplementTask({ issueRef: 'your-org/x#777', title: 'dup', by: 'M' });
  const b = await intake.addImplementTask({ issueRef: 'your-org/x#777', title: 'dup again', by: 'M' });
  assert.ok(a.created);
  assert.equal(b.created, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.session!.id, b.session!.id);
});

test('addImplementTask: refused without an issue or a title', async () => {
  assert.equal((await intake.addImplementTask({ issueRef: '', title: 't', by: 'M' })).ok, false);
  assert.equal((await intake.addImplementTask({ issueRef: 'r#1', title: '', by: 'M' })).ok, false);
});

test('ciBase: prefers the pinned base_sha over the moving base_ref; with neither, undefined (guarding B2\'s false green against a one-line regression)', () => {
  assert.equal(ciBase({ base_sha: 'SHA_PINNED', base_ref: 'origin/main' }), 'SHA_PINNED'); // the pinned sha wins
  assert.equal(ciBase({ base_sha: '', base_ref: 'origin/main' }), 'origin/main'); // only a missing sha falls back to the ref
  assert.equal(ciBase({ base_sha: '', base_ref: '' }), undefined);
});

test('implIdentity: safe as a git ref and as a path, and identical for the same id (so an orphan sweep or a re-run reproduces the same path)', () => {
  const a = gateC.implIdentity('/ws/X', 'fix-login-aaaa1111');
  assert.match(a.implBranch, /^forge\/[a-z0-9][a-z0-9-]*$/); // safe characters only in the branch name
  assert.match(a.worktreePath, /^\/ws\/X\/\.forge\/worktrees\/[a-z0-9][a-z0-9-]*$/); // lands in that repo's hidden .forge/worktrees/<key>, safe characters only
  assert.deepEqual(gateC.implIdentity('/ws/X', 'fix-login-aaaa1111'), a); // deterministic: the same id gives the same answer
});

test('implIdentity: the same slug in different sessions must give different paths and branches (so a sweep cannot delete a live worktree -- codex B1)', () => {
  const a = gateC.implIdentity('/ws/X', 'fix-login-aaaa1111');
  const b = gateC.implIdentity('/ws/X', 'fix-login-bbbb2222');
  assert.notEqual(a.worktreePath, b.worktreePath);
  assert.notEqual(a.implBranch, b.implBranch);
});

test('implIdentity: a long slug that hits slugify\'s .slice(40), differing only in the trailing shortId, still does not collide (the hash keeps it unique -- it does not depend on the shortId surviving; codex, fourth review, B)', () => {
  const slug = 'a'.repeat(40); // long enough to hit slugify's truncation, which cuts the trailing shortId off
  const a = gateC.implIdentity('/ws/X', `${slug}-aaaa1111`);
  const b = gateC.implIdentity('/ws/X', `${slug}-bbbb2222`);
  assert.notEqual(a.implBranch, b.implBranch); // with the tail truncated away, the hash of the full id still tells them apart
  assert.notEqual(a.worktreePath, b.worktreePath);
});

test('implIdentity: a non-ASCII or otherwise unsafe id (a --slug override in another script) normalises to a git-ref-safe key and stays unique (codex SF)', () => {
  // The id is written as escapes on purpose: the source of this repo is English, but the input it handles is
  // not, and this test exists precisely to pin the non-ASCII case.
  const a = gateC.implIdentity('/ws/X', '\u4e2d\u6587 \u6807\u9898-a1b2c3'); // a raw override leaking into the id (CJK plus a space)
  const b = gateC.implIdentity('/ws/X', '\u4e2d\u6587 \u6807\u9898-d4e5f6');
  assert.match(a.implBranch, /^forge\/[a-z0-9][a-z0-9-]*$/); // the branch name does not blow up
  assert.match(a.worktreePath, /^\/ws\/X\/\.forge\/worktrees\/[a-z0-9][a-z0-9-]*$/);
  assert.notEqual(a.implBranch, b.implBranch); // with the prefix collapsed away, the hash still tells them apart
});

test('ciTextToVerdict: green -> LGTM with no findings; unimplemented and ci_red -> CHANGES_REQUESTED with one', () => {
  assert.deepEqual(ciTextToVerdict(JSON.stringify({ state: 'green' })), { verdict: 'LGTM', findings: [] });
  const un = ciTextToVerdict(JSON.stringify({ state: 'unimplemented' }));
  assert.equal(un.verdict, 'CHANGES_REQUESTED');
  assert.equal(un.findings.length, 1);
  const red = ciTextToVerdict(JSON.stringify({ state: 'ci_red', summary: 'FAIL x' }));
  assert.equal(red.verdict, 'CHANGES_REQUESTED');
  assert.match((red.findings[0] as { issue: string }).issue, /FAIL x/);
  // Not JSON at all (the CI driver threw bare text) -> treated as ci_red, never let through as green, with
  // the raw text carried into the finding.
  const raw = ciTextToVerdict('panic: the script crashed\nstack...');
  assert.equal(raw.verdict, 'CHANGES_REQUESTED');
  assert.match((raw.findings[0] as { issue: string }).issue, /the script crashed/);
});

// gateCContext: how the "what to build" context handed to claude is assembled per source -- the chained
// tech design plus acceptance, a standalone issue body, or the fallback.
// This is where gate C's implementation quality comes from: feed it the wrong thing, or nothing, and claude
// goes off course, so all three source branches are pinned as they really assemble.
test('gateCContext: chained (a gate-b.json exists) -> the tech design plus the outer-loop acceptance contract (the definition of done, which must carry the scenarios)', async () => {
  const id = await at('DONE');
  const gb = join(mkdtempSync(join(tmpdir(), 'forge-gb-')), 'gate-b.json');
  writeFileSync(gb, JSON.stringify({
    tech_design_markdown: '## Design\nkeep the login session alive with a refresh token',
    acceptance: { contracts: [{ repo: 'C', surface: 'POST /login -> 200' }], scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a signed-in user When the page refreshes Then they are still signed in' }] },
  }));
  await sessions.patch(id, { gate_b_draft_path: gb });
  const ctx = gateC.gateCContext((await sessions.get(id))!);
  assert.match(ctx, /keep the login session alive with a refresh token/); // the tech design markdown
  assert.match(ctx, /Outer-loop acceptance contract/); // the definition-of-done heading
  assert.match(ctx, /AC1/); // the acceptance scenario is materialised into the context (the implementation has to turn it green)
});

test('gateCContext: standalone (no gate-b, but a gatec-input.md) -> returns the issue body written to disk', async () => {
  const id = await at('DONE'); // no gate_b_draft_path
  const { input } = gateC.gateCPaths(id);
  mkdirSync(join(input, '..'), { recursive: true });
  writeFileSync(input, '# Issue\nFix the lost login session: refreshing signs the user out');
  const ctx = gateC.gateCContext((await sessions.get(id))!);
  assert.match(ctx, /Fix the lost login session/);
});

test('gateCContext: no design and no issue -> the fallback prompt (work from the title and the existing code, and escalate when unsure) -- never an empty shell', async () => {
  const id = await at('DONE');
  const ctx = gateC.gateCContext((await sessions.get(id))!);
  assert.ok(ctx.trim().length > 0); // never an empty shell
  assert.match(ctx, /no tech design/); // what identifies the fallback branch, as against the chained design or a standalone issue body -- this wording is deliberate guidance
  assert.match(ctx, /needs_human/); // pin "escalate when unsure" by the stable concept keyword rather than the exact phrasing (codex nit 1)
});

test('gateCContext: a corrupt gate-b.json does not crash, it degrades gracefully to the fallback (a bad upstream draft must never take the implementer down)', async () => {
  const id = await at('DONE');
  const gb = join(mkdtempSync(join(tmpdir(), 'forge-gb-bad-')), 'gate-b.json');
  writeFileSync(gb, 'this is not valid JSON {{{'); // a corrupt upstream draft
  await sessions.patch(id, { gate_b_draft_path: gb });
  const ctx = gateC.gateCContext((await sessions.get(id))!); // the parse throws, the catch swallows it, and it lands on the fallback (with no input file)
  assert.ok(ctx.trim().length > 0); // the same standard as the fallback assertion above (codex, second review, nit 3)
  assert.match(ctx, /no tech design/);
  assert.match(ctx, /needs_human/);
});
