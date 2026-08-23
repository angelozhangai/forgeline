// Integration: the permission gates and state transitions behind the human actions -- confirm, trigger gate
// B, go, deny and retry.
// The Feishu notifications and the real write actions are mocked; the permissions come from the real
// permissions.yaml (gate_b_allowed=[M,BD], go_approvers=[M]).
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const writeCalls: { slug: string; dryRun?: boolean }[] = [];
let writeMode: 'ok' | 'throw' = 'ok';
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', {
  namedExports: {
    doWrites: async (s: { slug: string }, opts: { dryRun?: boolean } = {}) => {
      writeCalls.push({ slug: s.slug, dryRun: opts.dryRun });
      if (writeMode === 'throw') throw new Error('the GitHub API is temporarily unavailable');
      return { ok: true, stdout: '(dry) would create A: feat(x)', issues: [{ repo: 'example-admin', number: 99, url: 'https://x/99' }] };
    },
  },
});

// The load probe behind automatic assignment shells out to the real gh, so it is mocked to an empty pool
// here (forceGateBGo reaching AWAITING_GO computes a recommendation).
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');

let n = 0;
async function at(state: string) {
  const id = `a${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'dev' });
  const path: Record<string, string[]> = {
    AWAITING_PM_CONFIRM: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM'],
    GATE_A_REVISION_REQUESTED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'GATE_A_REVISION_REQUESTED'],
    GATE_A_STALLED: ['GATE_A_RUNNING', 'GATE_A_STALLED'],
    CONFIRMED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED'],
    AWAITING_GO: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO'],
    AWAITING_GATE_B_INPUT: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GATE_B_INPUT'],
    GATE_B_STALLED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'GATE_B_STALLED'],
    GATE_B_FAILED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'GATE_B_FAILED'],
    GATE_A_FAILED: ['GATE_A_RUNNING', 'GATE_A_FAILED'],
    GATE_C_FAILED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_FAILED'],
    GATE_D_FAILED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_FAILED'],
  };
  for (const s of path[state] ?? []) await sessions.transition(id, s as never);
  if (state === 'AWAITING_GO') await sessions.patch(id, { assignee: 'M' }); // filing the work needs a DRI (the assignment gate); the tests covering the unassigned branch clear it themselves
  return id;
}

const tmp = mkdtempSync(resolve(tmpdir(), 'forge-actions-'));
function draftPath(name: string, env: Record<string, unknown>): string {
  const p = resolve(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(env));
  return p;
}

const validGateB = {
  summary: 'the refund plan',
  key_decisions: {},
  tech_design_markdown: 'extend the existing refund path',
  acceptance: {
    contracts: [{ repo: 'A', surface: 'POST /admin/refund {order_id, idem_key} -> 200 {refund_id}' }],
    scenarios: [{ id: 'AC1', repo: 'A', gherkin: 'Given a paid order\nWhen a refund is requested with an idempotency key\nThen a refund_id comes back and the order enters the refunding state' }],
  },
  issue_specs: [{ repo: 'A', title: 'feat(pay): support refunds', type: 'feat', prio: 'P1' }],
  confidence: 0.8,
};

const invalidGateB = {
  ...validGateB,
  acceptance: {
    contracts: [],
    scenarios: [{ id: 'AC1', repo: 'A', gherkin: 'Given the page\nWhen the refund button is clicked\nThen it succeeds' }],
  },
};

test('confirm: the maintainer forces AWAITING_PM_CONFIRM closed -> CONFIRMED', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  const r = await actions.confirm(id, 'M', "product's decision");
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'M');
  assert.equal(s.confirmed_notes, "product's decision");
});

test('confirm: the maintainer rules on a stalled gate A -> CONFIRMED', async () => {
  const id = await at('GATE_A_STALLED');
  const r = await actions.confirm(id, 'M', 'forced through');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED');
});

test('confirm: the history of product\'s answers across rounds is kept rather than overwritten -- gate B reads it', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  await sessions.patch(id, { confirmed_notes: '[round 1 answers] Q1: always 0' });
  await actions.confirm(id, 'M', 'forced through: the rest will be settled offline');
  const notes = (await sessions.get(id))!.confirmed_notes ?? '';
  assert.match(notes, /\[round 1 answers\]/);
  assert.match(notes, /forced through/);
});

test('confirm: already CONFIRMED returns ok idempotently, so pressing it twice is not an error', async () => {
  const id = await at('CONFIRMED');
  assert.equal((await actions.confirm(id, 'M')).ok, true);
});

test('confirm: refused from a state that is not awaiting confirmation, such as AWAITING_GO', async () => {
  const id = await at('AWAITING_GO');
  assert.equal((await actions.confirm(id, 'M')).ok, false);
});

test('confirm: a stranger pressing the button (not in go_approvers) is refused, the state does not move, and permission_denied is recorded', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  const r = await actions.confirm(id, 'ou_stranger', 'wants to force it through'); // resolveActor returns an unknown open_id unchanged, so it never lands in go_approvers
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_PM_CONFIRM'); // a stranger did not push it to CONFIRMED
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('submitPmAnswers: AWAITING_PM_CONFIRM -> GATE_A_REVISION_REQUESTED, storing pending_input', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  const r = await actions.submitPmAnswers(id, 'PM', 'Q1: no expiry, always 0');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_REVISION_REQUESTED');
  assert.equal(s.gate_a_pending_input, 'Q1: no expiry, always 0');
  assert.match(s.confirmed_notes ?? '', /\[round 1 answers\]/);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'pm_answer'));
});

test('submitPmAnswers: idempotently ok once already re-reviewing, and refused from a state that is not awaiting confirmation', async () => {
  const id = await at('GATE_A_REVISION_REQUESTED');
  assert.equal((await actions.submitPmAnswers(id, 'PM', 'x')).ok, true);
  const id2 = await at('AWAITING_GO');
  assert.equal((await actions.submitPmAnswers(id2, 'PM', 'x')).ok, false);
});

test('gateb: someone without the permission is refused and the state does not move; someone with it reaches GATE_B_REQUESTED', async () => {
  const id = await at('CONFIRMED');
  const denied = await actions.requestGateB(id, 'CC'); // CC is not in gate_b_allowed
  assert.equal(denied.ok, false);
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED');
  const ok = await actions.requestGateB(id, 'M');
  assert.ok(ok.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_REQUESTED');
});

test('go: refused without the go permission', async () => {
  const id = await at('AWAITING_GO');
  const denied = await actions.go(id, 'CC'); // CC is not in go_approvers
  assert.equal(denied.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
});

test('go --dry-run: a preview changes no state and creates nothing', async () => {
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  const r = await actions.go(id, 'M', { dryRun: true });
  assert.ok(r.ok);
  assert.match(r.msg, /dry-run/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO'); // still where it was
  assert.deepEqual(writeCalls.at(-1), { slug: id, dryRun: true });
});

test('go: a real run goes WRITING -> DONE and persists created_issues', async () => {
  writeMode = 'ok';
  const id = await at('AWAITING_GO');
  const r = await actions.go(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'DONE');
  assert.match(s.created_issues ?? '', /example-admin/);
});

test('go: acceptance that is not up to standard blocks the real issue creation, stops at AWAITING_GO, and leaves an audit event', async () => {
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, invalidGateB) });
  const r = await actions.go(id, 'M');
  const s = (await sessions.get(id))!;
  assert.equal(r.ok, false);
  assert.match(r.msg, /the outer-ring acceptance is not up to standard/);
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(writeCalls.length, 0);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'acceptance_lint_blocked'));
});

test('go --dry-run: acceptance that is not up to standard only warns, and changes no state', async () => {
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, invalidGateB) });
  const r = await actions.go(id, 'M', { dryRun: true });
  assert.ok(r.ok);
  assert.match(r.msg, /the outer-ring acceptance lint did not pass/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.deepEqual(writeCalls.at(-1), { slug: id, dryRun: true });
});

test('go --force: a human may override acceptance that is not up to standard, but it must be recorded as forced', async () => {
  writeMode = 'ok';
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, invalidGateB) });
  const r = await actions.go(id, 'M', { force: true });
  const s = (await sessions.get(id))!;
  assert.ok(r.ok);
  assert.equal(s.state, 'DONE');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'acceptance_lint_forced'));
  assert.deepEqual(writeCalls.at(-1), { slug: id, dryRun: undefined });
});

test('go: a failed write to the main repo or GitHub parks as WRITE_FAILED, never pretends to be DONE, and keeps the error for a retry', async () => {
  writeMode = 'throw';
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, validGateB) });
  const r = await actions.go(id, 'M');
  const s = (await sessions.get(id))!;
  assert.equal(r.ok, false);
  assert.equal(s.state, 'WRITE_FAILED');
  assert.match(s.error ?? '', /GitHub API/);
  assert.equal(s.created_issues, null);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'error' && (e.detail ?? '').includes('writing')));
  writeMode = 'ok';
});

test('go: with no DRI assigned the real creation is blocked, it stops at AWAITING_GO, and an audit event is left (the assignment gate)', async () => {
  writeMode = 'ok';
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: null }); // clear at()'s default assignment, simulating a failed recommendation or nobody assigned
  const r = await actions.go(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /no DRI is assigned/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.equal(writeCalls.length, 0);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'go_blocked_no_assignee'));
});

test('go --dry-run: a preview works even unassigned -- dry-run is never blocked', async () => {
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: null });
  const r = await actions.go(id, 'M', { dryRun: true });
  assert.ok(r.ok);
  assert.match(r.msg, /dry-run/);
});

test('go --assignee: overrides the session\'s assignment and records it as human', async () => {
  writeMode = 'ok';
  const id = await at('AWAITING_GO'); // assignee defaults to M
  const r = await actions.go(id, 'M', { assignee: 'de' }); // case-insensitive
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, 'DE');
  assert.equal(s.assignee_source, 'human');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'assign' && (e.detail ?? '').includes('via')));
});

test('go --assignee: a short code outside the pool blocks the go', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.go(id, 'M', { assignee: 'BD' }); // BD is not in the pool
  assert.equal(r.ok, false);
  assert.match(r.msg, /is not a valid assignee/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
});

// -- assign() -- with probeLoad mocked to [], the recommendation is always pick=null, which is exactly the
// "every probe failed" branch.
test('assign by hand: writes the assignee, marks the source human, and records an event', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.assign(id, 'M', { to: 'de' }); // case-insensitive
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, 'DE');
  assert.equal(s.assignee_source, 'human');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'assign'));
});

test('assign by hand: a short code outside the pool is refused', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.assign(id, 'M', { to: 'BD' }); // BD is not in the pool
  assert.equal(r.ok, false);
  assert.match(r.msg, /is not a valid assignee/);
});

test('assign: refused without the permission', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.assign(id, 'CC', { to: 'DE' }); // CC is not in go_approvers
  assert.equal(r.ok, false);
  assert.match(r.msg, /may not assign/);
});

test('assign --auto: when every probe fails it clears the previous automatic assignment and forces a human decision (a regression test)', async () => {
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: 'EO', assignee_source: 'auto' }); // the previous round recommended EO
  const r = await actions.assign(id, 'M', { auto: true }); // probeLoad is mocked to [], so pick=null
  assert.equal(r.ok, false);
  assert.match(r.msg, /the previous automatic assignment has been cleared/);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, null); // the stale automatic assignment is gone and can no longer slip past the go gate
  assert.equal(s.assignee_source, null);
});

test('assign --auto: when every probe fails but the previous assignment was made by a human, it is left alone', async () => {
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: 'DE', assignee_source: 'human' });
  const r = await actions.assign(id, 'M', { auto: true });
  assert.equal(r.ok, false);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, 'DE'); // an explicit human decision is not wiped out by a failed probe
  assert.equal(s.assignee_source, 'human');
});

test('confirmCommentText: product partially accepting, the engineering lead forcing it through, and an empty note', () => {
  const partial = actions.confirmCommentText(2, { who: 'PM', verdict: 'partial', notes: 'Q3: no expiry' });
  assert.match(partial, /\[Product confirmed · round 2\]/);
  assert.match(partial, /Choice: partially accepted/);
  assert.match(partial, /Notes: Q3: no expiry/);
  const force = actions.confirmCommentText(1, { who: 'M', verdict: 'force', notes: '' });
  assert.match(force, /Engineering lead confirmed/);
  assert.match(force, /forced through/);
  assert.match(force, /Notes: \(none\)/);
});

test('deny: AWAITING_GO -> GO_DENIED', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.deny(id, 'M', 'the plan needs changing');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GO_DENIED');
});

test('deny: a stranger pressing the button (not in go_approvers) is refused, the state does not move, and permission_denied is recorded', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.deny(id, 'ou_stranger', 'wants to send it back'); // an unknown open_id never lands in go_approvers
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO'); // still waiting to be filed -- no stranger sent it back
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('retry: GATE_A_FAILED on the first round goes back to INTAKE and clears the error', async () => {
  const id = await at('GATE_A_FAILED');
  await sessions.patch(id, { error: 'boom' });
  const r = await actions.retry(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'INTAKE');
});

test('retry: GATE_A_FAILED during a re-review, with pending_input, returns to GATE_A_REVISION_REQUESTED without losing the round', async () => {
  const id = await at('GATE_A_FAILED');
  await sessions.patch(id, { error: 'boom', gate_a_pending_input: "product's answer", gate_a_round: 2 });
  const r = await actions.retry(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_REVISION_REQUESTED');
});

test('retry: refused without the permission (GATE_C_FAILED needs gate_c_allowed), the state does not move, and permission_denied is recorded', async () => {
  const id = await at('GATE_C_FAILED');
  await sessions.patch(id, { error: 'boom', worktree_path: '/tmp/wt' });
  const r = await actions.retry(id, 'ou_stranger'); // a stranger, or the panel's default actor, is not in gate_c_allowed=[M]
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_FAILED'); // a failed gate was not restarted by someone without the permission
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('retry: GATE_D_FAILED needs pr_create_approvers -- the maintainer may, a stranger may not', async () => {
  const id = await at('GATE_D_FAILED');
  await sessions.patch(id, { error: 'boom', pr_url: 'https://x/pr/1' });
  assert.equal((await actions.retry(id, 'ou_stranger')).ok, false); // not in pr_create_approvers=[M]
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED');
  assert.ok((await actions.retry(id, 'M')).ok); // M is on the list -> a real reset
  assert.equal((await sessions.get(id))!.state, 'GATE_D_LOOP');
});

// -- Gate B's multi-round human-in-the-loop actions --
test('submitGateBAnswers: AWAITING_GATE_B_INPUT -> GATE_B_REVISION_REQUESTED, storing pending_input', async () => {
  const id = await at('AWAITING_GATE_B_INPUT');
  await sessions.patch(id, { gate_b_round: 2 });
  const r = await actions.submitGateBAnswers(id, 'M', 'refund to the balance; the risk is accepted');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_REVISION_REQUESTED');
  assert.equal(s.gate_b_pending_input, 'refund to the balance; the risk is accepted');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gateb_answer'));
});

test('submitGateBAnswers: idempotently ok once already revising, and refused from an unrelated state', async () => {
  const id = await at('AWAITING_GATE_B_INPUT');
  await actions.submitGateBAnswers(id, 'M', 'x');
  assert.equal((await actions.submitGateBAnswers(id, 'M', 'y')).ok, true); // already at GATE_B_REVISION_REQUESTED -> idempotent
  const id2 = await at('AWAITING_GO');
  assert.equal((await actions.submitGateBAnswers(id2, 'M', 'x')).ok, false);
});

test('submitGateBAnswers: another round from GATE_B_STALLED carries on revising and keeps the leftover findings, which are audit evidence until it resolves', async () => {
  const id = await at('GATE_B_STALLED');
  await sessions.patch(id, { gate_b_round: 3, adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'x' }] }) });
  const r = await actions.submitGateBAnswers(id, 'M', 'one more pass');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_REVISION_REQUESTED');
  assert.ok(s.adversarial_residual); // kept: if the revision fails into GATE_B_FAILED, the leftovers are still the audit evidence
});

test('submitGateBAnswers: refused without gate_b_allowed, and the state does not move', async () => {
  const id = await at('AWAITING_GATE_B_INPUT');
  const r = await actions.submitGateBAnswers(id, 'CC', 'change whatever'); // CC is not in gate_b_allowed
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GATE_B_INPUT');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('forceGateBGo: GATE_B_STALLED with the permission -> AWAITING_GO, keeping the leftover findings', async () => {
  const id = await at('GATE_B_STALLED');
  await sessions.patch(id, { adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'x' }] }) });
  const r = await actions.forceGateBGo(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GO');
  assert.ok(s.adversarial_residual); // forcing it through keeps the leftovers for the ruling before go
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gateb_force_go'));
});

test('forceGateBGo: refused without the go permission, and the state does not move', async () => {
  const id = await at('GATE_B_STALLED');
  const r = await actions.forceGateBGo(id, 'CC'); // CC is not in go_approvers
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_STALLED');
});

test('retry: GATE_B_FAILED with a draft and a round already started resumes into ADVERSARIAL_LOOP; with no draft it goes back to GATE_B_REQUESTED', async () => {
  const id = await at('GATE_B_FAILED');
  await sessions.patch(id, { error: 'boom', gate_b_draft_path: '/tmp/x.json', gate_b_round: 2 });
  assert.ok((await actions.retry(id, 'M')).ok);
  assert.equal((await sessions.get(id))!.state, 'ADVERSARIAL_LOOP');
  const id2 = await at('GATE_B_FAILED');
  await sessions.patch(id2, { error: 'boom' }); // no draft
  assert.ok((await actions.retry(id2, 'M')).ok);
  assert.equal((await sessions.get(id2))!.state, 'GATE_B_REQUESTED');
});

test('retry: GATE_B_FAILED with an answer from the maintainer still to be applied returns to the revision point, losing neither the answer nor the leftovers', async () => {
  const id = await at('GATE_B_FAILED');
  await sessions.patch(id, {
    error: 'the revised plan was bad JSON',
    gate_b_draft_path: '/tmp/x.json',
    gate_b_round: 2,
    gate_b_pending_input: "the maintainer's decision: refund to the balance, and add idempotency to the acceptance",
    adversarial_residual: JSON.stringify({ round: 2, findings: [{ issue: 'refund idempotency is undecided' }] }),
  });
  const r = await actions.retry(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_REVISION_REQUESTED');
  assert.equal(s.gate_b_pending_input, "the maintainer's decision: refund to the balance, and add idempotency to the acceptance");
  assert.match(s.adversarial_residual ?? '', /refund idempotency is undecided/);
  assert.equal(s.error, null);
});

// -- Assembling the answers from the form: the dropdowns plus the notes box, fed back to the fixer as structure --
const ask = (id: string, q: string) => ({ id, question: q, options: ['a', 'b'], context: '', severity: 'med' });

test('composeHumanAnswer: maps the selected options by position H{n}, plus the notes', () => {
  const asks = [ask('H1', 'Where does the refund go?'), ask('H2', 'Is the risk accepted?')];
  const out = actions.composeHumanAnswer(asks, { ask_H1: 'to the balance', ask_H2: 'accepted', notes: 'add an idempotency unit test during development' });
  assert.match(out, /H1 \(Where does the refund go\?\): to the balance/);
  assert.match(out, /H2 \(Is the risk accepted\?\): accepted/);
  assert.match(out, /Notes: add an idempotency unit test during development/);
});

test('composeHumanAnswer: choosing "other", or nothing at all, skips that question and leaves it to the notes', () => {
  const asks = [ask('H1', 'Q1'), ask('H2', 'Q2')];
  const out = actions.composeHumanAnswer(asks, { ask_H1: '__other__', notes: 'H1 is handled specially' });
  assert.doesNotMatch(out, /H1 \(/); // "other" is not treated as an answer to the option (see envelopes.composeDecisionAnswer for the format)
  assert.doesNotMatch(out, /H2/); // nothing selected -> skipped
  assert.match(out, /Notes: H1 is handled specially/);
});

test('composeHumanAnswer: with no id it numbers them H{n} in order; with nothing at all it returns an empty string and leaves submit to treat it as another round', () => {
  const asks = [{ id: '', question: 'Q1', options: ['x'], context: '', severity: 'med' }];
  assert.match(actions.composeHumanAnswer(asks, { ask_H1: 'x' }), /H1 \(Q1\): x/);
  assert.equal(actions.composeHumanAnswer(asks, {}), '');
});

test('composeHumanAnswer: duplicate ids from the model do not cross the questions over (H1/H2 by position, each minding its own)', () => {
  // The model labelled both escalations id:"H1" -- the positional id has to separate them into H1 and H2, each
  // matched to its own question.
  const asks = [
    { id: 'H1', question: 'Where does the refund go?', options: ['the original method', 'the balance'], context: '', severity: 'high' },
    { id: 'H1', question: 'Is the risk accepted?', options: ['accepted', 'not accepted'], context: '', severity: 'med' },
  ];
  const out = actions.composeHumanAnswer(asks, { ask_H1: 'the balance', ask_H2: 'accepted' });
  assert.match(out, /H1 \(Where does the refund go\?\): the balance/);
  assert.match(out, /H2 \(Is the risk accepted\?\): accepted/); // the second question uses H2 and is not crossed with the first's value
});
