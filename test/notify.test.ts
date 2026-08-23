import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCard, buildStatusCard } from '../src/notify.ts';
import { renderFeishuCard } from '../src/messaging/feishu.ts';
import type { CardModel } from '../src/messaging/model.ts';
import type { Session } from '../src/types.ts';

// Write a temporary gate-a.json for the rendering tests that read open_questions off the channel card.
function gateAFile(openQuestions: unknown[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-notify-')), 'gate-a.json');
  writeFileSync(p, JSON.stringify({ summary: 's', open_questions: openQuestions, risks: [] }));
  return p;
}

// A card is a button-callback contract: the daemon dispatches on button.behaviors[].value.{action,slug},
// so those have to be carried correctly.
function sess(p: Partial<Session>): Session {
  return { id: 'id1', slug: 'finance-report', title: 't', state: 'AWAITING_GO', branch: 'dev', gate_a_output_path: null, routing: null, adversarial_residual: null, gate_a_cost_usd: 1, gate_b_cost_usd: 2, confirmed_by: null, confirmed_notes: null, error: null, prd_url: null, ...p } as unknown as Session;
}
// buildCard/buildStatusCard now produce a provider-neutral CardModel, so the assertions go through the
// rendering pipeline and pin the Feishu JSON.
const json = (c: CardModel) => JSON.stringify(renderFeishuCard(c));

test('needs_confirm: carries the verdict/notes form, the confirm_submit callback and the slug', () => {
  const s = sess({ routing: JSON.stringify({ reviewer: 'M', toLead: true, reasons: ['a sensitive area'], confidence: 0.78 }) });
  const c = json(buildCard('needs_confirm', s));
  assert.match(c, /"schema":"2\.0"/);
  assert.match(c, /"name":"verdict"/);
  assert.match(c, /"name":"notes"/);
  assert.match(c, /"action":"confirm_submit"/);
  assert.match(c, /finance-report/);
});

test('needs_go: two callback buttons -- go to release and deny to refuse -- both carrying the slug', () => {
  const c = json(buildCard('needs_go', sess({})));
  assert.match(c, /"action":"go"/);
  assert.match(c, /"action":"deny"/);
  assert.match(c, /"slug":"finance-report"/);
});

test('needs_go: carries the DRI assignment dropdown (go_form); with a recommendation it preselects that person and shows the load reasoning', () => {
  const snapshot = JSON.stringify({
    pick: 'EO',
    allOverWip: false,
    probeIncomplete: false,
    points: 3,
    table: [
      { code: 'EO', wip: 1, loadPoints: 3, projected: 6, wipLimit: 3, eligible: true },
      { code: 'CC', wip: 0, loadPoints: 8, projected: 11, wipLimit: 3, eligible: true },
    ],
  });
  const c = json(buildCard('needs_go', sess({ assignee: 'EO', assign_snapshot: snapshot } as Partial<Session>)));
  assert.match(c, /"name":"assignee"/); // the DRI dropdown
  assert.match(c, /"initial_option":"EO"/); // the recommendation is preselected
  assert.match(c, /Suggested DRI: EO/); // the reasoning block
  assert.match(c, /"action":"go"/); // submitting still calls back with go
});

test('needs_go: when the recommendation cannot be computed it does not fall back to whoever was there, and tells the maintainer to pick a DRI by hand', () => {
  const snapshot = JSON.stringify({
    pick: null,
    allOverWip: false,
    probeIncomplete: true,
    points: 3,
    table: [
      { code: 'M', wip: 0, loadPoints: 0, projected: 3, wipLimit: 2, eligible: true, ok: false },
      { code: 'EO', wip: 0, loadPoints: 0, projected: 3, wipLimit: 3, eligible: true, ok: false },
    ],
  });
  const c = json(buildCard('needs_go', sess({ assignee: null, assign_snapshot: snapshot } as Partial<Session>)));
  assert.match(c, /no recommendation could be computed/);
  assert.match(c, /please pick someone/);
  assert.match(c, /load unknown/);
  assert.doesNotMatch(c, /"initial_option"/); // with no trustworthy recommendation, a stale default must not slip through
});

test('needs_gateb: the produce-the-technical-plan button calls back with gateb', () => {
  const c = json(buildCard('needs_gateb', sess({ confirmed_by: 'M' })));
  assert.match(c, /"action":"gateb"/);
});

test('needs_arbitration: the maintainer\'s force-through button calls back with force_confirm, and the card lists the questions left open plus the slug', () => {
  const c = json(buildCard('needs_arbitration', sess({ state: 'GATE_A_STALLED', gate_a_round: 6, gate_a_residual: JSON.stringify({ round: 6, open_questions: [{ q: 'the billing basis is still undecided', severity: 'high' }] }) } as never)));
  assert.match(c, /"action":"force_confirm"/);
  assert.match(c, /finance-report/);
  assert.match(c, /the billing basis is still undecided/);
});

test('needs_gateb_input: one interactive dropdown per question (select_static, name=ask_<id>), an "other" fallback option, a notes box, and the gateb_answer_submit callback', () => {
  const c = json(buildCard('needs_gateb_input', sess({ state: 'AWAITING_GATE_B_INPUT', gate_b_human_asks: JSON.stringify([{ id: 'H1', question: 'Should a refund go back to the balance or to the original payment method?', options: ['the original method', 'the balance'], severity: 'high' }]) } as never)));
  assert.match(c, /"action":"gateb_answer_submit"/);
  assert.match(c, /back to the balance or to the original payment method/);
  assert.match(c, /"tag":"select_static"/); // a genuinely interactive select
  assert.match(c, /"name":"ask_H1"/); // named H{n} by position, and reassembled in the same order
  assert.match(c, /Other/); // the "other, type it in" fallback
  assert.match(c, /"name":"notes"/); // the free-text box
  assert.match(c, /finance-report/);
});

test('the channel card at gate A (AWAITING_PM_CONFIRM): a dropdown per question (ask_H1), the star for the recommendation, the overall verdict, the notes box, and round carried through', () => {
  const path = gateAFile([
    { q: 'Does topped-up credit expire?', severity: 'high', options: [{ label: 'it never expires', recommended: true, impact: 'friendlier to users' }, { label: 'it expires after a year', recommended: false, impact: 'needs an expiry reminder' }] },
  ]);
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_output_path: path, gate_a_round: 1, poster_id: 'ou_pm', chat_id: 'oc' } as never)));
  assert.match(c, /"name":"ask_H1"/); // an interactive dropdown per question (not just one global verdict)
  assert.match(c, /★/); // the marker on the recommended option
  assert.match(c, /Does topped-up credit expire/);
  assert.match(c, /"name":"verdict"/); // the overall verdict is still there
  assert.match(c, /"name":"notes"/); // the global notes box at the end
  assert.match(c, /"action":"confirm_submit"/);
  assert.match(c, /"round":1/); // round carried through, so a round-2 submission on the edited-in-place card is not deduplicated away
});

test('the channel card at gate A: all 8 questions awaiting a decision get their own control, and a ninth does not squeeze onto the card', () => {
  const path = gateAFile(
    Array.from({ length: 9 }, (_, i) => ({
      q: `business question ${i + 1}`,
      severity: 'med',
      options: [{ label: `option ${i + 1}`, recommended: i === 7, impact: `impact ${i + 1}` }],
    })),
  );
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_output_path: path, gate_a_round: 3, poster_id: 'ou_pm', chat_id: 'oc' } as never)));
  assert.match(c, /"name":"ask_H1"/);
  assert.match(c, /"name":"ask_H8"/);
  assert.doesNotMatch(c, /"name":"ask_H9"/);
  assert.match(c, /business question 8/);
  assert.doesNotMatch(c, /business question 9/);
  assert.match(c, /★ option 8/);
  assert.match(c, /"round":3/);
});

test('the direct message at gate B (needs_gateb_input): options show the recommendation star and the impact note', () => {
  const asks = JSON.stringify([
    { id: 'H1', question: 'Refund to the original payment method or to the balance?', severity: 'high', options: [{ label: 'the original method', recommended: true, impact: 'cleaner for compliance' }, { label: 'the balance', recommended: false, impact: 'faster, but the money sits with us' }] },
  ]);
  const c = json(buildCard('needs_gateb_input', sess({ state: 'AWAITING_GATE_B_INPUT', gate_b_human_asks: asks, gate_b_round: 2 } as never)));
  assert.match(c, /★/);
  assert.match(c, /\(impact: cleaner for compliance\)/); // the messaging adapter decides how the impact note is formatted
  assert.match(c, /"name":"ask_H1"/);
  assert.match(c, /"round":2/);
});

test('needs_gateb_input: a question with no options gets no dropdown (it is answered in the notes box)', () => {
  const c = json(buildCard('needs_gateb_input', sess({ state: 'AWAITING_GATE_B_INPUT', gate_b_human_asks: JSON.stringify([{ id: 'H1', question: 'Please fill in the background', options: [], severity: 'med' }]) } as never)));
  assert.doesNotMatch(c, /"tag":"select_static"/);
  assert.match(c, /"name":"notes"/);
  assert.match(c, /"action":"gateb_answer_submit"/);
});

test('needs_gateb_arbitration: force it through with gateb_force_go or send it back with gateb_send_back, listing what is left plus the slug', () => {
  const c = json(buildCard('needs_gateb_arbitration', sess({ state: 'GATE_B_STALLED', adversarial_residual: JSON.stringify({ round: 3, used: 'codex', findings: [{ issue: 'the idempotency key is missing', severity: 'high', where: 'acceptance' }] }) } as never)));
  assert.match(c, /"action":"gateb_force_go"/);
  assert.match(c, /"action":"gateb_send_back"/);
  assert.match(c, /the idempotency key is missing/);
  assert.match(c, /"slug":"finance-report"/);
});

test('the channel status card in gate B\'s newer states: plain-language progress, no leaked jargon, no interactive buttons', () => {
  for (const st of ['AWAITING_GATE_B_INPUT', 'GATE_B_REVISION_REQUESTED', 'GATE_B_STALLED'] as const) {
    const c = json(buildStatusCard(sess({ state: st } as never)));
    assert.doesNotMatch(c, /Gate [ABCD]|GATE_|ADVERSARIAL/, `the channel card for ${st} leaks jargon`);
    assert.doesNotMatch(c, /"behaviors"/, `the channel card for ${st} should carry no interactive button (the maintainer decides over DM)`);
  }
});

test('failed: the retry callback button plus the error text', () => {
  const c = json(buildCard('failed', sess({ error: 'failed to parse' }), { stage: 'Gate B', error: 'failed to parse' }));
  assert.match(c, /"action":"retry"/);
  assert.match(c, /failed to parse/);
});

test('done: lists the issue links and carries no callback button', () => {
  const c = json(buildCard('done', sess({}), { issues: [{ repo: 'example-admin', number: 73, url: 'https://x/73' }] }));
  assert.match(c, /example-admin#73/);
  assert.doesNotMatch(c, /"behaviors"/); // the completion card has no interactive buttons
});

test('needs_go: when findings are left over, the count is shown', () => {
  const c = json(buildCard('needs_go', sess({ adversarial_residual: JSON.stringify({ findings: [{ issue: 'a' }, { issue: 'b' }] }) })));
  assert.match(c, /\b2\b/);
});

// The channel status card: the reply to product's message, edited in place
test('the channel status card awaiting product: @-mentions product, carries the confirmation form and a plain-language state, and leaks no jargon', () => {
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', poster_id: 'ou_pm', gate_a_output_path: null })));
  assert.match(c, /<at id=ou_pm>/); // @-mentions whoever posted the PRD
  assert.match(c, /"action":"confirm_submit"/); // the confirmation form lives on the channel card
  assert.match(c, /Waiting on product to confirm/);
  assert.doesNotMatch(c, /Gate [ABCD]|GATE_/);
});

test('the channel status card awaiting product: across rounds, the subtitle and the questions heading both show which round it is', () => {
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 2, gate_a_output_path: null } as never)));
  assert.match(c, /round 2/);
  assert.doesNotMatch(c, /Gate [ABCD]|GATE_/); // still no leaked jargon
});

test('the channel status card awaiting product: confirm_submit carries the round, so the dedup key differs per round and round 2 onwards is no longer swallowed by the SDK', () => {
  const rv = (c: string) => c.match(/"action":"confirm_submit","round":(\d+)/)?.[1];
  const r1 = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 1, gate_a_output_path: null } as never)));
  const r2 = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 2, gate_a_output_path: null } as never)));
  assert.equal(rv(r1), '1');
  assert.equal(rv(r2), '2'); // same card edited in place, same submit button, but value.round differs per round -> a different cardActionId -> not deduplicated
  assert.notEqual(rv(r1), rv(r2));
});

test('the channel status card on a re-review round (round 2 onwards): a red banner that tells it apart from the first round at a glance', () => {
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 2, gate_a_output_path: null } as never)));
  assert.match(c, /Re-review, round 2/);
});

test('the channel status card while re-reviewing: says it is reviewing again with the answers, and leaves no stale form button behind', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_REVISION_REQUESTED', gate_a_round: 2 } as never)));
  assert.match(c, /Reviewing again with your answers/);
  assert.doesNotMatch(c, /"action":"confirm_submit"/);
});

test('the channel status card while running: plain-language progress, no interactive buttons', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_RUNNING' })));
  assert.match(c, /Reviewing the requirement/);
  assert.doesNotMatch(c, /"behaviors"/);
});

test('the channel status card once the work is filed: lists the issues', () => {
  const c = json(buildStatusCard(sess({ state: 'DONE' }), { issues: [{ repo: 'example-admin', number: 88, url: 'https://x/88' }] }));
  assert.match(c, /example-admin#88/);
});

// The easter egg (the requirement pet): the channel card hides the dollar amount behind feeding and an
// evolution tree, while the maintainer's direct message keeps the real dollars and the pet.
test('the channel status card: hides the cost in dollars and shows the pet easter egg (the evolution tree plus feeding)', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_RUNNING' }))); // the session has cost $3
  assert.doesNotMatch(c, /\$/); // no amounts in the channel
  assert.match(c, /Evolution/);
  assert.match(c, /Fed \d+ bites/);
});

test('the direct-message card for needs_go: keeps the real cost in dollars and carries the pet easter egg', () => {
  const c = json(buildCard('needs_go', sess({}))); // the session has cost $3
  assert.match(c, /\$/); // the DM keeps the amount (this is your budget ledger)
  assert.match(c, /go/); // the action button is still there
});

test('complexity: both the channel card subtitle and the small footnote show the size', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_RUNNING', size: 'L', size_source: 'ai' } as never)));
  assert.match(c, /Complexity L/); // visible in the subtitle
  assert.match(c, /8pt/); // the footnote carries the points (L = 8, matching the main repo)
});

test('the direct-message card for needs_confirm: complexity appears as a stat field', () => {
  const c = json(buildCard('needs_confirm', sess({ size: 'XL' } as never)));
  assert.match(c, /Complexity/);
  assert.match(c, /XL/);
});
