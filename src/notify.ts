import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { configForSession } from './projects.ts';
import { log } from './util/log.ts';
import { store as sessions } from './store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { routingOf, readResidual, readGateBResidual, residualCount } from './store/readModel.ts';
import { port } from './messaging/index.ts';
import type { CardModel, CardBlock, CardButton, CardColor, FindingLine } from './messaging/index.ts';
import type { Session } from './types.ts';
import {
  parseHumanAsks,
  parseOpenQuestions,
  openQuestionsToDecisions,
  humanAsksToDecisions,
  type OpenQuestion,
  type HumanAsk,
} from './gates/envelopes.ts';
import type { State } from './statemachine/states.ts';
import { refTitle, stateLabel, ANSWER_ROUND_TAG_RE } from './util/display.ts';
import { FUN_ON, petStage, petAssetName, treeLine, finalForm, feedLine, easterEgg } from './util/pet.ts';
import { sizeBadge, type Size } from './util/sizing.ts';
import type { Recommendation } from './util/assign.ts';

// Every kind of direct-message card Forge can send. **The array is the source of truth and the type is
// derived from it**, not the other way round: a corpus that has to render "every kind" (the structural gate
// in test/slack-blockkit.test.ts, and the live rehearsal behind `forge rehearse`) can then enumerate the
// kinds instead of keeping its own hand-written copy — which is the copy that silently stops covering a new
// kind the day someone adds one.
export const NOTIFY_KINDS = [
  'needs_confirm',
  'needs_arbitration',
  'needs_gateb',
  'needs_gateb_input', // Gate B's revision escalated: the maintainer has to decide an open point
  'needs_gateb_arbitration', // Gate B's adversarial review hit its cap unresolved: the maintainer has to decide
  'needs_go',
  // The downstream gates C and D (all private decisions for the maintainer; from M2 they are text cards with a
  // CLI call to action, and interactive buttons come later)
  'needs_review_pr', // Gate C is green: the PR has to be opened for Gate D
  'needs_gatec_input', // Gate C's implementation escalated: the maintainer has to answer
  'needs_gatec_arbitration', // Gate C's CI or acceptance failed for several rounds: the maintainer has to decide
  'needs_gated_input', // Gate D's revision escalated: the maintainer has to answer
  'needs_gated_arbitration', // Gate D's adversarial review is unresolved after several rounds: the maintainer has to decide
  'needs_merge', // Gate D is done and the merge-readiness report is out: a human has to merge
  'failed',
  'done',
  'recovered',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface NotifyExtra {
  stage?: string;
  error?: string;
  issues?: { repo: string; number: number; url: string }[];
  from?: string;
  to?: string;
}

function costNum(s: Session): number {
  return (s.gate_a_cost_usd ?? 0) + (s.gate_b_cost_usd ?? 0) + (s.gate_c_cost_usd ?? 0) + (s.gate_d_cost_usd ?? 0);
}
function costOf(s: Session): string {
  const c = costNum(s);
  return c ? `$${c.toFixed(2)}` : '-';
}

interface GateARead {
  summary: string;
  open_questions: OpenQuestion[]; // normalised by the schema: options is always an array (with the recommendation and the impact)
  risks: unknown[];
}
function readGateA(path: string | null): GateARead {
  const empty: GateARead = { summary: '', open_questions: [], risks: [] };
  if (!path || !existsSync(path)) return empty;
  try {
    const raw = readFileSync(path, 'utf8');
    const j = JSON.parse(raw) as Partial<GateARead>;
    return {
      summary: j.summary ?? '',
      open_questions: parseOpenQuestions(raw), // normalise the options; an older draft with none defaults to []
      risks: Array.isArray(j.risks) ? j.risks : [],
    };
  } catch {
    return empty;
  }
}
// Gate A's multi-round review with product: the review states show the current round, so product and the
// team can see which round it is the whole way through.
function roundOf(s: Session): number | null {
  const inLoop =
    s.state === 'AWAITING_PM_CONFIRM' ||
    s.state === 'GATE_A_REVISION_REQUESTED' ||
    s.state === 'GATE_A_RUNNING' ||
    s.state === 'GATE_A_STALLED';
  return inLoop && s.gate_a_round && s.gate_a_round > 0 ? s.gate_a_round : null;
}
// The questions Gate B's revision escalated for the maintainer to answer (needs_human). The options are
// normalised by the schema (an older string[] still works).
function readHumanAsks(s: Session): HumanAsk[] {
  return parseHumanAsks(s.gate_b_human_asks);
}

// ── The text lines (the fallback for the webhook, the desktop notification and the log) ──
function buildLines(kind: NotifyKind, s: Session, x: NotifyExtra): { title: string; lines: string[]; color: CardColor } {
  switch (kind) {
    case 'needs_confirm': {
      const r = routingOf(s);
      const g = readGateA(s.gate_a_output_path);
      return {
        title: `${refTitle(s)} · waiting on product to confirm`,
        color: r?.toLead ? 'red' : 'blue',
        lines: [
          g.summary,
          `Routing: ${r?.toLead ? `needs ${r.reviewer} to review` : 'the DRI reviews it themselves'}   open questions ${g.open_questions.length}   cost ${costOf(s)}`,
          `Confirm: ./forge confirm ${s.slug} --user M`,
        ],
      };
    }
    case 'needs_arbitration': {
      const res = readResidual(s.gate_a_residual);
      const n = res.source === 'codex' ? res.findings.length : res.open_questions.length;
      const why = res.source === 'codex' ? `the adversarial AI review hit its cap with ${n} comments still open` : `after several rounds of answers from product, ${n} open questions remain`;
      return {
        title: `${refTitle(s)} · waiting on a decision (several review rounds have not settled it)`,
        color: 'red',
        lines: [`${why}, and the round cap has been reached`, `Force it through: ./forge confirm ${s.slug} --user M`],
      };
    }
    case 'needs_gateb':
      return {
        title: `${refTitle(s)} · requirement confirmed`,
        color: 'blue',
        lines: [`decided (by ${s.confirmed_by ?? 'M'})`, `Produce the technical plan: ./forge gateb ${s.slug} --user M`],
      };
    case 'needs_gateb_input': {
      const asks = readHumanAsks(s);
      return {
        title: `${refTitle(s)} · the plan is waiting on your decision`,
        color: 'orange',
        lines: [`the technical plan has ${asks.length} open points that need your decision`, `Answer: ./forge gateb-answer ${s.slug} --notes "..."`],
      };
    }
    case 'needs_gateb_arbitration': {
      const r = readGateBResidual(s.adversarial_residual);
      return {
        title: `${refTitle(s)} · the plan is waiting on a decision (${r.round} review rounds, still unsettled)`,
        color: 'red',
        lines: [`after several Codex/Claude rounds, ${r.findings.length} comments are still unresolved`, `Force the work open: ./forge gateb-go ${s.slug} --user M`],
      };
    }
    case 'needs_go':
      return {
        title: `${refTitle(s)} · waiting on the go-ahead`,
        color: 'orange',
        lines: [
          `${residualCount(s.adversarial_residual)} comments awaiting a decision   cost ${costOf(s)}`,
          s.assignee ? `Suggested DRI: ${s.assignee} (you can reassign)` : '',
          `Open the work: ./forge go ${s.slug} --user M`,
        ],
      };
    case 'needs_review_pr':
      return {
        title: `${refTitle(s)} · implementation finished · waiting to open the PR for review`,
        color: 'blue',
        lines: [`local CI is fully green   cost ${costOf(s)}`, `Open the PR and Gate D: ./forge review-pr ${s.slug} --user M`],
      };
    case 'needs_gatec_input': {
      const asks = parseHumanAsks(s.gate_c_human_asks);
      return {
        title: `${refTitle(s)} · the build has open points · waiting on your decision`,
        color: 'orange',
        lines: [`the implementation raised ${asks.length} points that need your decision`, `Answer: ./forge gatec-answer ${s.slug} --notes "..."`],
      };
    }
    case 'needs_gatec_arbitration':
      return {
        title: `${refTitle(s)} · the build is waiting on a decision (the local checks failed for several rounds)`,
        color: 'red',
        lines: [`CI and acceptance hit the cap without going green`, `Decide: ./forge gatec-answer ${s.slug} --notes "guidance for one more round"`],
      };
    case 'needs_gated_input': {
      const asks = parseHumanAsks(s.gate_d_human_asks);
      return {
        title: `${refTitle(s)} · the PR changes have open points · waiting on your decision`,
        color: 'orange',
        lines: [`the PR review's revision raised ${asks.length} points that need your decision`, `Answer: ./forge gated-answer ${s.slug} --notes "..."`],
      };
    }
    case 'needs_gated_arbitration':
      return {
        title: `${refTitle(s)} · the PR review is waiting on a decision (several rounds, still unsettled)`,
        color: 'red',
        lines: [`the Codex/Claude PR review hit its cap with comments still open`, `One more round: ./forge gated-answer ${s.slug} --notes "..."`],
      };
    case 'needs_merge':
      return {
        title: `${refTitle(s)} · ready to merge · waiting for a human to merge it`,
        color: 'green',
        lines: [
          s.pr_url ? `PR: ${s.pr_url}` : 'the PR is open',
          `Merge-readiness report: ${s.merge_readiness_path ?? '(see docs/delivery)'}   cost ${costOf(s)}`,
          `Acknowledge it once you have merged: ./forge merged ${s.slug} --user M`,
        ],
      };
    case 'failed':
      return { title: `${refTitle(s)} · processing failed`, color: 'red', lines: [(x.error ?? s.error ?? '').slice(0, 300), `Retry: ./forge retry ${s.slug}`] };
    case 'done':
      return { title: `${refTitle(s)} · work items created`, color: 'green', lines: [(x.issues ?? []).map((i) => `${i.repo}#${i.number} ${i.url}`).join('\n')] };
    case 'recovered':
      return { title: `${refTitle(s)} · recovered automatically`, color: 'grey', lines: [`${stateLabel(x.from as never)} -> ${stateLabel(x.to as never)}, and it will re-run`] };
  }
}

// ── The CardModel semantic block builders (provider-agnostic; the provider's JSON and markup are rendered by
// its adapter under messaging/) ──
const txt = (m: string): CardBlock => ({ kind: 'text', md: m });
const noteB = (m: string): CardBlock => ({ kind: 'note', md: m }); // grey text (formerly grey())
const footB = (m: string): CardBlock => ({ kind: 'footnote', md: m }); // a smaller grey footnote (formerly small())
const quoteB = (t: string): CardBlock => ({ kind: 'quote', text: t });
const dividerB: CardBlock = { kind: 'divider' };
const btnB = (text: string, style: CardButton['style'], action: string, slug: string, value?: Record<string, unknown>): CardBlock => ({
  kind: 'button',
  button: { text, style, action, slug, value },
});
const model = (color: CardColor, title: string, subtitle: string, blocks: CardBlock[]): CardModel => ({ color, title, subtitle, blocks });

// The outstanding findings and open questions turned into semantic FindingLine[] (the location and the
// suggestion appear only when known; colouring by severity is the adapter's job).
const findingsFrom = (rows: { severity?: string; issue: string; where?: string; fix?: string }[]): FindingLine[] =>
  rows.map((f) => ({
    severity: f.severity,
    lead: f.issue,
    notes: [...(f.where ? [{ label: 'where', text: f.where }] : []), ...(f.fix ? [{ label: 'suggestion', text: f.fix }] : [])],
  }));

// The snapshot of the automatic assignment recommendation (the json autoAssignOnGo persisted). Malformed or
// missing -> null, and the GO card degrades to picking someone entirely by hand.
function readReco(s: Session): Recommendation | null {
  if (!s.assign_snapshot) return null;
  try {
    return JSON.parse(s.assign_snapshot) as Recommendation;
  } catch {
    return null;
  }
}
// The "suggested DRI plus everyone's load" reasoning block on the GO card (display only; it reads the
// database and issues no IO).
function assignReasonBlocks(s: Session): CardBlock[] {
  const reco = readReco(s);
  if (!reco) return s.assignee ? [txt(`**DRI: ${s.assignee}**`)] : [];
  const incomplete = reco.probeIncomplete ? ' (some load probes failed, so those people are excluded)' : '';
  const head = reco.pick
    ? `**Suggested DRI: ${reco.pick}**${reco.allOverWip ? ' (⚠ everyone is over their WIP limit, so this is the best of them)' : ' (the lowest load in progress right now)'}${incomplete}`
    : `no recommendation could be computed${reco.probeIncomplete ? ' (the load probe failed)' : ''}; please pick someone`;
  const rows = reco.table.map((r) => {
    const mark = r.code === reco.pick ? '-> ' : '   ';
    if (r.ok === false) return `${mark}${r.code} load unknown (the probe failed, so they are out of the automatic pick)`;
    const cap = r.eligible ? '' : ' ✗ over WIP';
    return `${mark}${r.code} in progress ${r.wip}/${r.wipLimit} · load ${r.loadPoints.toFixed(1)} -> projected ${r.projected.toFixed(1)}${cap}`;
  });
  return [txt(head), footB(rows.join('\n'))];
}

// State -> the leading emoji and the card's colour
const STATE_EMOJI: Partial<Record<State, string>> = {
  INTAKE: '📥 ', GATE_A_RUNNING: '🔍 ', AWAITING_PM_CONFIRM: '🔴 ', GATE_A_REVISION_REQUESTED: '🔁 ', GATE_A_ADVERSARIAL: '🔬 ', GATE_A_STALLED: '⚖️ ', CONFIRMED: '✅ ',
  GATE_B_REQUESTED: '📐 ', GATE_B_RUNNING: '📐 ', ADVERSARIAL_LOOP: '🔬 ', AWAITING_GATE_B_INPUT: '🙋 ', GATE_B_REVISION_REQUESTED: '🔁 ', GATE_B_STALLED: '⚖️ ', AWAITING_GO: '🟡 ',
  WRITING: '✍️ ', DONE: '🎉 ', GATE_A_FAILED: '⚠️ ', GATE_B_FAILED: '⚠️ ', GO_DENIED: '⛔ ', WRITE_FAILED: '⚠️ ',
};
function stateColor(st: State): CardColor {
  if (st === 'AWAITING_PM_CONFIRM' || st === 'GATE_A_STALLED' || st === 'GATE_B_STALLED') return 'red';
  if (st === 'DONE') return 'green';
  if (st === 'AWAITING_GO' || st === 'AWAITING_GATE_B_INPUT') return 'orange';
  if (st === 'GO_DENIED' || st.endsWith('FAILED')) return 'red';
  if (st === 'CONFIRMED') return 'blue';
  return 'grey';
}
const RUN_NOTE: Partial<Record<State, string>> = {
  INTAKE: 'received, and queued for review...',
  GATE_A_RUNNING: 'reviewing the requirement against the live code...',
  GATE_A_REVISION_REQUESTED: 'your answers are in, and the re-review is running...',
  GATE_A_ADVERSARIAL: 'the requirement is clarified; running one last AI cross-check...',
  GATE_A_STALLED: 'several review rounds in and questions are still open; waiting on the owner to decide.',
  CONFIRMED: 'the requirement is confirmed, waiting for the owner to produce a technical plan.',
  GATE_B_REQUESTED: 'queued to produce the technical plan...',
  GATE_B_RUNNING: 'designing the technical plan...',
  ADVERSARIAL_LOOP: 'the technical plan is being cross-reviewed by AI...',
  AWAITING_GATE_B_INPUT: 'the technical plan has an open point; waiting on the owner to decide.',
  GATE_B_REVISION_REQUESTED: "the owner's decision is in, and the plan is being revised accordingly...",
  GATE_B_STALLED: 'several plan reviews in and comments are still open; waiting on the owner to decide.',
  AWAITING_GO: 'the technical plan is finished, waiting on the owner to open the work.',
  WRITING: 'creating the work items...',
};
// How errors are routed: on the channel side a *_FAILED state is presented as "this stage is still in
// progress" — the team is never shown that something failed, nor why.
const FAILED_AS_PROGRESS: Partial<Record<State, string>> = {
  GATE_A_FAILED: 'reviewing the requirement against the live code...',
  GATE_B_FAILED: 'designing the technical plan...',
  WRITE_FAILED: 'creating the work items...',
};

// ── The maintainer's direct-message decision card: a provider-agnostic CardModel (with button, form and pet
// semantic blocks) ──
export function buildCard(kind: NotifyKind, s: Session, x: NotifyExtra = {}): CardModel {
  // The direct-message card keeps the real dollar figure (your budget ledger) and also carries the
  // requirement-pet easter egg, so you see everything the channel card has.
  const pet = petStage(s.state);
  const emoji = (fallback: string): string => (FUN_ON ? `${pet.sprite} ` : fallback);
  // One row of "sprite on the left, line on the right" (with no image it is just the line's text). The done
  // branch and others reuse voiceEls.
  const voiceEls: CardBlock[] = FUN_ON ? [{ kind: 'petRow', asset: petAssetName(s.state), voice: pet.voice }] : [];

  switch (kind) {
    case 'needs_confirm': {
      const r = routingOf(s);
      const rd = roundOf(s);
      const g = readGateA(s.gate_a_output_path);
      const items = openQuestionsToDecisions(g.open_questions);
      return model(r?.toLead ? 'red' : 'blue', refTitle(s, emoji('🔴 ')), `Requirement review ${rd && rd > 1 ? `round ${rd}` : 'complete'} · ${r?.toLead ? `needs ${r.reviewer} to sign off` : 'the DRI reviews it themselves'}`, [
        { kind: 'stats', fields: [`**Complexity**\n${s.size ?? 'TBD'}`, `**Confidence**\n${r?.confidence ?? '-'}`, `**Open questions**\n${g.open_questions.length}`, `**Risks**\n${g.risks.length}`, `**Cost**\n${costOf(s)}`] },
        ...voiceEls,
        ...(g.summary ? [txt(`**Summary**: ${g.summary}`)] : []),
        dividerB,
        txt(`**Open questions for you to decide**${rd ? ` · round ${rd}` : ''}`),
        { kind: 'decisionList', items },
        dividerB,
        { kind: 'decisionForm', slug: s.slug, items, action: 'confirm_submit', round: rd ?? 0, verdict: true, submitText: 'Submit decisions', notesLabel: 'Overall notes (optional)', notesPlaceholder: 'e.g. Q3: top-ups do not expire; show the column as a constant 0 and note it' },
      ]);
    }
    case 'needs_arbitration': {
      const res = readResidual(s.gate_a_residual);
      const isCodex = res.source === 'codex'; // codex's unresolved adversarial findings, as opposed to open questions left after several rounds with product
      const n = isCodex ? res.findings.length : res.open_questions.length;
      const findings: FindingLine[] = isCodex
        ? findingsFrom(res.findings.slice(0, 8))
        : res.open_questions.slice(0, 8).map((q) => ({ severity: q.severity, lead: q.q, notes: q.suggestion ? [{ label: 'suggestion', text: q.suggestion }] : [] }));
      const head = isCodex
        ? `The adversarial AI review hit its cap with **${n}** comments still unresolved. Your call: force it through and close the review, or settle it offline before releasing.`
        : `After several rounds of answers from product, **${n}** open questions are still unresolved and the round cap has been reached. Your call: force it through and close the review, or settle it with product offline before releasing.`;
      return model('red', refTitle(s, emoji('⚖️ ')), 'Several review rounds, still unsettled · waiting on your decision', [
        txt(head),
        ...voiceEls,
        dividerB,
        txt(isCodex ? '**Review comments still unresolved**' : '**Open questions still unresolved**'),
        { kind: 'findingList', findings },
        dividerB,
        btnB('✅ Force through · close the review', 'primary', 'force_confirm', s.slug),
        noteB(`Or from the CLI: \`./forge confirm ${s.slug} --user M\``),
      ]);
    }
    case 'needs_gateb':
      return model('blue', refTitle(s, emoji('✅ ')), `${stateLabel('CONFIRMED')} · waiting for a technical plan`, [
        txt('The requirement is confirmed. Next: produce the technical plan and cross-review it with AI.'),
        ...voiceEls,
        ...(s.confirmed_notes ? [noteB(`Decision notes: ${s.confirmed_notes}`)] : []),
        dividerB,
        btnB('🛠 Produce the technical plan', 'primary', 'gateb', s.slug),
        noteB('Once you click, the service produces the technical plan and cross-reviews it with AI — a few minutes — and then pushes the "waiting on the go-ahead" card.'),
      ]);
    case 'needs_gateb_input': {
      const asks = readHumanAsks(s);
      const items = humanAsksToDecisions(asks);
      return model('orange', refTitle(s, emoji('🙋 ')), 'The technical plan has open points · waiting on your decision', [
        txt(`While Codex reviewed and Claude revised the technical plan, **${asks.length}** points came up that need your decision before it can continue:`),
        ...voiceEls,
        dividerB,
        { kind: 'decisionList', items },
        dividerB,
        { kind: 'decisionForm', slug: s.slug, items, action: 'gateb_answer_submit', round: s.gate_b_round ?? 0, submitText: 'Submit decisions', notesLabel: 'Notes (optional; fill this in when you pick "other" or want to be specific per item)', notesPlaceholder: 'e.g. H1: refund to the balance; accept that risk and cover it with an idempotency unit test during development' },
        noteB(`Or from the CLI: \`./forge gateb-answer ${s.slug} --notes "your decision"\``),
      ]);
    }
    case 'needs_gateb_arbitration': {
      const r = readGateBResidual(s.adversarial_residual);
      const findings = findingsFrom(r.findings.slice(0, 8));
      return model('red', refTitle(s, emoji('⚖️ ')), `${r.round} plan review rounds, still unsettled · waiting on your decision`, [
        txt(`The Codex/Claude adversarial rounds reached their cap at round **${r.round}**, with **${r.findings.length}** comments still unresolved. Your call: force the work open, or take one more round.`),
        ...voiceEls,
        dividerB,
        txt('**Comments still unresolved**'),
        { kind: 'findingList', findings },
        dividerB,
        {
          kind: 'buttonRow',
          buttons: [
            { text: '✅ Force the work open · skip the rest', style: 'primary', action: 'gateb_force_go', slug: s.slug },
            { text: '🔁 One more round', style: 'default', action: 'gateb_send_back', slug: s.slug, value: { round: r.round } },
          ],
        },
        noteB(`Or from the CLI: \`./forge gateb-go ${s.slug} --user M\` (force it open) / \`./forge gateb-answer ${s.slug} --notes "..."\` (one more round)`),
      ]);
    }
    case 'needs_go': {
      const n = residualCount(s.adversarial_residual);
      const pool = configForSession(s).assignment.pool; // configuration diverges per project: the DRI dropdown uses this project's pool
      return model('orange', refTitle(s, emoji('🟡 ')), 'The technical plan is finished · waiting on the go-ahead', [
        { kind: 'stats', fields: [`**Complexity**\n${s.size ?? 'TBD'}`, `**Comments awaiting a decision**\n${n}${n ? ' (a human has to decide)' : ''}`, `**Cost**\n${costOf(s)}`] },
        txt(`The technical plan is ready${n ? `; ${n} review comments are waiting on your decision` : ''}`),
        ...voiceEls,
        dividerB,
        txt('**Assign a DRI and open the work** (the recommendation is adopted by default; use the dropdown to change it)'),
        ...assignReasonBlocks(s),
        { kind: 'goForm', slug: s.slug, pool, picked: s.assignee },
        btnB('❌ Send back', 'danger', 'deny', s.slug),
        noteB(`Preview what would be created: \`./forge go ${s.slug} --user M --dry-run\``),
      ]);
    }
    case 'needs_review_pr':
      return model('blue', refTitle(s, emoji('🚦 ')), 'Implementation finished · local CI fully green · waiting to open the PR for review', [
        txt(`The implementation in the isolated worktree is finished and local CI is fully green. Next: open the PR for Gate D (Codex reviews the diff, Claude fixes).`),
        ...voiceEls,
        ...(s.gate_c_draft_path ? [noteB(`A summary of the changes is in ${s.gate_c_draft_path}`)] : []),
        dividerB,
        noteB(`Open the PR and Gate D: \`./forge review-pr ${s.slug} --user M\``),
      ]);
    case 'needs_gatec_input': {
      const asks = parseHumanAsks(s.gate_c_human_asks);
      return model('orange', refTitle(s, emoji('🙋 ')), 'The build has open points · waiting on your decision', [
        txt(`The implementation ran into **${asks.length}** points that need your decision:`),
        ...voiceEls,
        ...(asks.length ? [{ kind: 'findingList' as const, findings: asks.map((a) => ({ severity: a.severity, lead: a.question, notes: a.context ? [{ label: 'background', text: a.context }] : [] })) }] : []),
        dividerB,
        noteB(`Answer: \`./forge gatec-answer ${s.slug} --notes "your decision"\``),
      ]);
    }
    case 'needs_gatec_arbitration':
      return model('red', refTitle(s, emoji('⚖️ ')), 'The build is waiting on a decision · the local checks failed for several rounds', [
        txt(`The implementation and CI loop hit its cap without going green. Your call: give guidance for one more round, or take it over yourself.`),
        ...voiceEls,
        ...(s.gate_c_residual ? [noteB('a summary of what is failing is on record in gate_c_residual')] : []),
        dividerB,
        noteB(`One more round: \`./forge gatec-answer ${s.slug} --notes "how to fix it"\``),
      ]);
    case 'needs_gated_input': {
      const asks = parseHumanAsks(s.gate_d_human_asks);
      return model('orange', refTitle(s, emoji('🙋 ')), 'The PR changes have open points · waiting on your decision', [
        txt(`The PR review's revision ran into **${asks.length}** points that need your decision:`),
        ...voiceEls,
        ...(asks.length ? [{ kind: 'findingList' as const, findings: asks.map((a) => ({ severity: a.severity, lead: a.question, notes: a.context ? [{ label: 'background', text: a.context }] : [] })) }] : []),
        dividerB,
        noteB(`Answer: \`./forge gated-answer ${s.slug} --notes "your decision"\``),
      ]);
    }
    case 'needs_gated_arbitration':
      return model('red', refTitle(s, emoji('⚖️ ')), 'The PR review is waiting on a decision · several rounds, still unsettled', [
        txt(`The Codex/Claude PR review hit its cap with comments still open. Your call: take one more round, or take it over yourself.`),
        ...voiceEls,
        dividerB,
        noteB(`One more round: \`./forge gated-answer ${s.slug} --notes "..."\``),
      ]);
    case 'needs_merge':
      return model('green', refTitle(s, emoji('🚀 ')), 'Ready to merge · waiting for a human (it is never merged automatically)', [
        txt(`The PR review came back LGTM, the tests are hardened, and local CI is fully green. Please review the important parts of the diff yourself and merge.`),
        ...voiceEls,
        ...(s.pr_url ? [txt(`**PR**: ${s.pr_url}`)] : []),
        ...(s.merge_readiness_path ? [noteB(`Merge-readiness report: ${s.merge_readiness_path}`)] : []),
        ...(FUN_ON && costNum(s) > 0 ? [noteB(feedLine(costNum(s), { showDollar: true }))] : []),
        dividerB,
        noteB(`Acknowledge it once merged: \`./forge merged ${s.slug} --user M\``),
      ]);
    case 'failed':
      return model('red', refTitle(s, emoji('❌ ')), stateLabel(s.state), [
        txt(`**Something went wrong**\n${(x.error ?? s.error ?? 'unknown').slice(0, 400)}`),
        ...voiceEls,
        dividerB,
        btnB('🔁 Retry', 'primary', 'retry', s.slug),
      ]);
    case 'done': {
      const ff = FUN_ON ? finalForm(s) : '🎉';
      return model('green', refTitle(s, FUN_ON ? `${ff} ` : '🎉 '), FUN_ON ? 'Work items created · fully evolved' : 'Work items created', [
        ...voiceEls,
        txt((x.issues ?? []).map((i) => `• ${i.repo}#${i.number}  ${i.url}`).join('\n') || '(no issue information)'),
        ...(FUN_ON && costNum(s) > 0 ? [noteB(feedLine(costNum(s), { showDollar: true }))] : []),
        noteB('The technical plan is archived; please review it and submit it to the main repo'),
      ]);
    }
    case 'recovered':
      return model('grey', refTitle(s, emoji('♻️ ')), 'Recovered automatically', [txt('the last run was interrupted; it has been reset automatically and will be processed again'), ...voiceEls]);
  }
}

// ── The channel status card (a reply to product's message, edited in place the whole way through; when it is
// waiting on product it @s them and carries the form) ──
// The easter egg (the requirement pet and how it evolves): every requirement is a little creature that evolves
// with the stage. The channel card hides the cost — product does not look at internal dollars — and folds it
// into feeding the pet "compute chow" instead. FORGE_FUN=0 turns the whole thing off and goes back to the
// serious mode.
export function buildStatusCard(s: Session, x: NotifyExtra = {}): CardModel {
  const pet = petStage(s.state);
  // DONE uses finalForm in the header (the specific creature it evolved into, matching what the body reveals);
  // everything else uses the evolution tree's current sprite.
  const headEmoji = FUN_ON ? `${s.state === 'DONE' ? finalForm(s) : pet.sprite} ` : STATE_EMOJI[s.state] ?? '';
  const head = refTitle(s, headEmoji);
  // The subtitle: the state, the review round (during the multi-round loop with product), and the complexity
  // tier (so product and the boss can see it at a glance).
  const rd = roundOf(s);
  const subtitle = `${stateLabel(s.state)}${rd ? ` · review round ${rd}` : ''}${s.size ? ` · complexity ${s.size}` : ''}`;
  // The pet animation's asset name (by evolution tier; DONE uses the fully evolved one). petRow renders it as
  // one row of "sprite on the left, text on the right".
  const asset = petAssetName(s.state);
  const mentionId = s.poster_id || undefined; // @s product (the adapter renders it as a mention); with none, it falls back to addressing them generically
  // The small footnote at the bottom: (1) the complexity badge (always shown — it is a core attribute);
  // (2) the easter egg (the evolution tree, the feeding, the hidden line) when FUN is on. It sits at the
  // bottom so it does not compete with the body.
  const footer = (): CardBlock[] => {
    const lines: CardBlock[] = [];
    if (s.size) lines.push(footB(`${sizeBadge(s.size as Size)}${s.size_source === 'ai' ? ' (proposed by AI; adjustable)' : ''}`));
    if (FUN_ON) {
      const parts = [`Evolution ${treeLine(s.state)} · stage ${pet.tier}/5`];
      if (costNum(s) > 0) parts.push(feedLine(costNum(s), { showDollar: false }));
      const egg = easterEgg(s);
      if (egg) parts.push(egg);
      lines.push(footB(parts.join('  ·  ')));
    } else if (costOf(s) !== '-') {
      lines.push(footB(`Cost ${costOf(s)}`));
    }
    return lines;
  };

  if (s.state === 'AWAITING_PM_CONFIRM') {
    const g = readGateA(s.gate_a_output_path);
    const n = g.open_questions.length;
    const items = openQuestionsToDecisions(g.open_questions);
    // A re-review round (round 2 onwards) looks almost identical to the first round's form, and telling them
    // apart by the subtitle alone reads as "nothing was updated".
    // So it gets a prominent red banner at the top plus an echo of your previous answer, which makes an
    // in-place update recognisable at a glance (the maintainer chose "edit the card in place, but make it
    // obvious").
    // The tag is matched through ANSWER_ROUND_TAG_RE, the same definition actions.ts writes with — a literal
    // on each side would let one of them change and silently empty this echo.
    const isReReview = !!(rd && rd > 1);
    const lastAns = ((s.confirmed_notes ?? '').split('\n').filter((l) => ANSWER_ROUND_TAG_RE.test(l)).pop() ?? '').replace(ANSWER_ROUND_TAG_RE, '').trim().slice(0, 50);
    const reReviewBanner: CardBlock[] = isReReview
      ? [
          {
            kind: 'callout',
            tone: 'danger',
            md:
              `🔁 **Re-review, round ${rd}** — your previous answers are on record` +
              `${lastAns && !lastAns.includes('no notes') ? ` ("${lastAns}")` : ' (no specific notes were given last round)'}` +
              `, and after the re-review **the questions below are still open**. Please give **a clear decision on each one** (rather than a blanket "accepted") before submitting.`,
          },
          dividerB,
        ]
      : [];
    // The summoning line: @s product (the adapter adds the mention) plus a one-line call to action; with no
    // poster it falls back to addressing product generically.
    const lead = mentionId ? '' : 'Product — ';
    const cta = isReReview
      ? `${lead}**round ${rd} of the re-review** is back, and **${n}** questions still need your decision 👇`
      : `${lead}this requirement has **${n}** questions that need your decision; please confirm below 👇`;
    return {
      color: stateColor(s.state),
      title: head,
      subtitle,
      blocks: [
        { kind: 'petRow', asset, voice: cta, mentionId },
        ...reReviewBanner,
        // The summary as a quote block, kept understated.
        ...(g.summary ? [quoteB(g.summary)] : []),
        dividerB,
        // The focus: the questions awaiting a decision (with the count and the round) — each question with its
        // options (the recommendation starred, plus the impact).
        txt(`**📌 Waiting on your decision (${n})${rd ? ` · round ${rd}` : ''}**`),
        { kind: 'decisionList', items },
        dividerB,
        // The action: pick or write an answer per question, plus the overall verdict and notes form.
        { kind: 'decisionForm', slug: s.slug, items, action: 'confirm_submit', round: rd ?? 0, verdict: true, submitText: 'Submit decisions', notesLabel: 'Overall notes (optional)', notesPlaceholder: 'e.g. Q3: top-ups do not expire; show the column as a constant 0 and note it' },
        ...footer(),
      ],
    };
  }
  if (s.state === 'DONE') {
    const ff = FUN_ON ? finalForm(s) : '🎉';
    const lead = FUN_ON ? `${ff} the requirement egg evolved into its final form and shipped! The work items created:` : '🎉 Work items created:';
    return {
      color: stateColor(s.state),
      title: head,
      subtitle,
      blocks: [
        { kind: 'petRow', asset, voice: lead },
        txt((x.issues ?? []).map((i) => `• ${i.repo}#${i.number}  ${i.url}`).join('\n') || "(see the owner's side for details)"),
        ...footer(),
      ],
    };
  }
  if (s.state === 'GO_DENIED') {
    return {
      color: stateColor(s.state),
      title: head,
      subtitle,
      blocks: [{ kind: 'petRow', asset, voice: FUN_ON ? `${pet.voice} (the technical plan was sent back; it goes round again once revised)` : 'The technical plan was sent back; it goes round again once revised.' }, ...footer()],
    };
  }
  if (s.state.endsWith('FAILED')) {
    // How errors are routed: on the channel side (the team) it only ever says "in progress" and **never
    // exposes the actual error** — a neutral grey header, in-progress wording, nothing red and no error.
    // The actual cause goes to the owner as a bot direct message (buildCard's 'failed' keeps the error and the
    // retry button). The team *uses* the bot rather than *watching* its internals.
    const progressNote = FAILED_AS_PROGRESS[s.state] ?? 'in progress, please wait...';
    return {
      color: 'grey',
      title: refTitle(s, FUN_ON ? `${pet.sprite} ` : '⏳ '),
      subtitle: `In progress${s.size ? ` · complexity ${s.size}` : ''}`,
      blocks: [{ kind: 'petRow', asset, voice: progressNote }, ...footer()],
    };
  }
  const note = FUN_ON ? pet.voice : RUN_NOTE[s.state] ?? stateLabel(s.state);
  return { color: stateColor(s.state), title: head, subtitle, blocks: [{ kind: 'petRow', asset, voice: note }, ...footer()] };
}

// Sync the channel status card to the current state: with none yet it is created as a reply to product's
// message, and with one it is edited in place. It only applies to a channel-sourced session (one with a
// chat_id).
export async function syncGroupCard(s: Session, x: NotifyExtra = {}): Promise<void> {
  const cur = (await sessions.get(s.id)) ?? s; // read the latest status_msg_id, so a stale one does not cause a duplicate send
  if (!cur.chat_id) return; // not channel-sourced (added by hand) -> no channel card
  try {
    const card = buildStatusCard(cur, x);
    if (cur.status_msg_id) {
      await port.editGroupCard(cur.status_msg_id, card);
    } else {
      // The intake message cannot always be replied to (it may have been deleted, be too old, or the id
      // recorded during a backfill may already span a restart).
      // A failed reply **has to fall back to posting into the channel directly**: dropping the card would
      // leave this requirement with no feedback in the channel at all, and status_msg_id would stay empty, so
      // every later sync would take the same failing path and it would never appear.
      const replied = cur.intake_msg_id ? await port.replyGroupCard(cur.intake_msg_id, card) : null;
      if (cur.intake_msg_id && !replied) log.warn(`the channel status card could not be posted as a reply to ${cur.intake_msg_id}, so it is being posted into the channel directly`);
      const mid = replied ?? (await port.sendGroupCard(cur.chat_id, card));
      if (mid) await sessions.patch(cur.id, { status_msg_id: mid });
    }
  } catch (e) {
    log.warn(`syncing the channel status card failed (it does not affect the pipeline): ${String(e).slice(0, 140)}`);
  }
}

function desktop(title: string, body: string): void {
  const { env } = loadConfig();
  if (env.NOTIFY_DESKTOP === '0' || process.platform !== 'darwin') return;
  const esc = (t: string) => t.replace(/["\\]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  try {
    spawn('osascript', ['-e', `display notification "${esc(body).slice(0, 200)}" with title "${esc(title).slice(0, 80)}"`], { stdio: 'ignore' }).unref();
  } catch {
    /* a failed desktop notification does not matter */
  }
}

// The single notification exit: a bot direct-message card (with buttons), falling back to the webhook; the
// local desktop notification and the log are always there as a backstop, so nothing is ever silent.
export async function notify(kind: NotifyKind, s: Session, x: NotifyExtra = {}): Promise<void> {
  const { title, lines, color } = buildLines(kind, s, x);
  log.info(`📣 ${title} | ${lines.filter(Boolean).join(' | ')}`);
  desktop(title, lines.filter(Boolean).join(' | '));
  // In the channel: the status card (a reply to product's message, then edited in place) is always synced to
  // the current state, so product and the team can follow it the whole way.
  await syncGroupCard(s, x);
  // As a direct message: only the maintainer's own decision cards (deciding, producing a plan, opening the
  // work, retrying a failure, self-healing).
  // needs_confirm is handled in the channel by @-ing product, and done is already shown there, so neither is
  // sent as a direct message.
  const toM =
    kind === 'needs_arbitration' ||
    kind === 'needs_gateb' ||
    kind === 'needs_gateb_input' ||
    kind === 'needs_gateb_arbitration' ||
    kind === 'needs_go' ||
    kind === 'needs_review_pr' ||
    kind === 'needs_gatec_input' ||
    kind === 'needs_gatec_arbitration' ||
    kind === 'needs_gated_input' ||
    kind === 'needs_gated_arbitration' ||
    kind === 'needs_merge' ||
    kind === 'failed' ||
    kind === 'recovered';
  if (!toM) return;
  try {
    const sent = await port.sendDmCard(buildCard(kind, s, x));
    // How errors are routed: 'failed' and 'recovered' are the maintainer's private error and operational
    // notifications — even when the bot's direct message fails they must **not** leak out to the channel
    // webhook, which would send the actual error to the team. The desktop notification and the log above are
    // the only backstop. The maintainer's other decision cards keep the webhook fallback.
    if (!sent) {
      if (kind === 'failed' || kind === 'recovered') log.warn(`the bot direct message was not delivered (${kind}); by the routing rule it does not leak to the channel, leaving the desktop notification and the log: ${title}`);
      else await port.postWebhook(title, lines.filter(Boolean), color);
    }
  } catch (e) {
    log.warn(`sending the notification failed (logged; it does not affect the pipeline): ${String(e)}`);
  }
}
