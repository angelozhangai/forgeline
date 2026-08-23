import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectForSession, configForSession } from '../projects.ts';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { parseStructured, strictParse } from '../llm/structured.ts';
import { runClaude } from '../llm/runClaude.ts';
import { refresh, assertFresh } from './repoFreshness.ts';
import { anchorCheck } from './repoAnchor.ts';
import { triage } from './triage.ts';
import { GateASchema, GATE_A_CONTRACT } from './envelopes.ts';
import type { GateAEnvelope } from './envelopes.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import { commentDoc } from '../docs/index.ts';
import { projectActions } from '../project/index.ts';
import { SIZE_RUBRIC, sizeBadge } from '../util/sizing.ts';
import { SCORE_RUBRIC, normScore, normDims } from '../util/scoring.ts';
import type { Session, Routing } from '../types.ts';

// The conclusion of one Gate A round (first pass or re-review): the worker decides the state transition
// from it.
export interface GateAOutcome {
  round: number;
  openQuestions: number;
  resolved: boolean; // no open questions left -> the review is complete (-> CONFIRMED)
  stalled: boolean; // still unresolved at the PM round cap -> parked for the maintainer to arbitrate (-> GATE_A_STALLED)
}

function findingsMd(env: GateAEnvelope, routing: Routing): string {
  const lines: string[] = [];
  lines.push(`**Summary**: ${env.summary || '(none)'}`);
  lines.push(`**Repos touched**: ${(env.repos_touched ?? []).join(' / ') || '(undetermined)'}`);
  lines.push(`**${sizeBadge(env.size)}** (AI proposal${env.size_reason ? `: ${env.size_reason}` : ''})`);
  lines.push(`**Confidence**: ${env.confidence} | **Routing**: ${routing.toLead ? `needs review by ${routing.reviewer}` : 'DRI self-review'} (${routing.reasons.join('; ')})`);
  lines.push('');
  lines.push('**Open questions awaiting the PM:**');
  if (env.open_questions.length === 0) lines.push('- (none)');
  env.open_questions.forEach((q, i) => {
    lines.push(`${i + 1}. [${q.severity}] ${q.q}`);
    if (q.suggestion) lines.push(`   - Suggestion: ${q.suggestion}`);
  });
  lines.push('');
  lines.push('**Risks / conflicts:**');
  if (env.risks.length === 0) lines.push('- (none)');
  env.risks.forEach((r) => {
    lines.push(`- [${r.area}] ${r.detail}${r.evidence ? ` (evidence: ${r.evidence})` : ''}`);
  });
  return lines.join('\n');
}

// Whether the document already contains a section with this anchor (idempotent de-duplication: a retry or
// an orphan recovery re-running gateA must not append the same block twice).
export function docHasSection(docPath: string, marker: string): boolean {
  if (!existsSync(docPath)) return false;
  try {
    return readFileSync(docPath, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

// First pass: append the whole "machine review output" block to the review document. Skipped if it has
// already been appended (idempotent: a retry or orphan recovery leaves no duplicate section).
function appendMachineSection(deliveryDir: string, slug: string, env: GateAEnvelope, routing: Routing): void {
  const doc = resolve(deliveryDir, slug, 'req-review.md');
  if (!existsSync(doc)) return;
  if (docHasSection(doc, '🤖 Machine review output')) return; // already there -> do not append again
  const block =
    `\n\n---\n\n## 🤖 Machine review output (pending human check)\n` +
    `> Generated automatically by \`claude -p\` against the source of truth in the code. A human confirms each item before the PM loop; this section does not replace "5. Open questions awaiting the PM".\n\n` +
    findingsMd(env, routing) +
    '\n';
  appendFileSync(doc, block);
}

// Re-review: append a "round N re-review" section to the review document each round, preserving the full
// trail of the multi-round PM loop. Skipped if this round has already been appended (idempotent).
function appendRevisionSection(deliveryDir: string, slug: string, round: number, env: GateAEnvelope, routing: Routing): void {
  const doc = resolve(deliveryDir, slug, 'req-review.md');
  if (!existsSync(doc)) return;
  if (docHasSection(doc, `Re-review round ${round}`)) return; // this round is already there -> do not append again
  const head = env.open_questions.length === 0 ? ' (no open questions remain; the review is complete)' : ` (${env.open_questions.length} still awaiting the PM)`;
  const block =
    `\n\n---\n\n## 🔁 Re-review round ${round}${head}\n` +
    `> Continued in the same \`claude\` session (resume) based on the PM's reply.\n\n` +
    findingsMd(env, routing) +
    '\n';
  appendFileSync(doc, block);
}

// Gate A's machine review -> the comment posted onto the PRD document (a top-level comment; a pure function
// so it can be unit-tested).
// A good format: a title, a summary, one line per item with severity and suggestion, optional risks, and
// the routing.
export function machineComment(env: GateAEnvelope, routing: Routing, round: number): string {
  const sevTag = (s?: string) => (s === 'high' ? '[high]' : s === 'low' ? '[low]' : '[med]');
  const parts: string[] = [round > 1 ? `[Forge Gate A review · re-review round ${round}]` : '[Forge Gate A review]'];
  if (env.summary) parts.push(`Summary: ${env.summary}`);
  parts.push('', `Open questions awaiting the product owner (${env.open_questions.length}):`);
  parts.push(
    env.open_questions.length
      ? env.open_questions
          .map((q, i) => `${i + 1}. ${sevTag(q.severity)} ${q.q}${q.suggestion ? `\n   Suggestion: ${q.suggestion}` : ''}`)
          .join('\n')
      : '(none; everything is clarified)',
  );
  if (env.risks.length) {
    parts.push('', `Risks (${env.risks.length}):`);
    parts.push(env.risks.map((r, i) => `${i + 1}. ${r.area ? `[${r.area}] ` : ''}${r.detail}`).join('\n'));
  }
  const route = routing.toLead ? `needs sign-off from ${routing.reviewer}` : 'DRI self-review';
  parts.push('', `Routing: ${route}${routing.reasons.length ? ` (${routing.reasons.join('; ')})` : ''}`);
  return parts.join('\n');
}

function maxPmRounds(): number {
  return loadConfig().runtime.gate_a?.max_pm_rounds ?? 5;
}

// Parse Gate A's output: on failure, resume the same session and feed it back to the model to re-emit
// (self-healing, see llm/structured.ts); only after the retries are exhausted does it throw.
// resumeSid: the self-pinned session id on the first pass, the resumed session id on a re-review (both paths
// guarantee the session is valid when res.ok).
async function parseGateA(s: Session, text: string, resumeSid: string, dir: string, dumpName: string): Promise<GateAEnvelope> {
  // Tiered timeout: a repair re-emit is only "send the JSON again", so it gets a shorter timeout (<=600s)
  // to stop a hung feedback loop from holding the tick lock for 1200s.
  const repairTimeout = Math.min(loadConfig().runtime.claude_timeout_sec, 600);
  let dumpN = 0; // forensic dumps are numbered by feedback attempt, preserving the whole chain (no more overwriting each other)
  try {
    return await parseStructured<GateAEnvelope>({
      text,
      parse: (t) => strictParse(GateASchema, t),
      reEmit: async (instruction) => {
        const r = await runClaude(instruction, { label: 'Gate A · repair output', resume: resumeSid, timeoutSec: repairTimeout, cwd: projectForSession(s).root });
        return r.ok ? r.result : null;
      },
      buildRepairInstruction: (error) =>
        render(loadPrompt('partials/parse-repair.md', projectForSession(s).id), { ERROR: error, CONTRACT: GATE_A_CONTRACT }),
      maxRetries: loadConfig().runtime.parse_repair_retries ?? 2,
      note: (kind, detail) => appendEvent(s.id, `gatea_${kind}`, detail),
      dump: (raw) => {
        try { writeFileSync(resolve(dir, dumpName.replace(/\.txt$/, `.repair${++dumpN}.txt`)), raw); } catch { /* a failed dump must not block */ }
      },
    });
  } catch (e) {
    try { writeFileSync(resolve(dir, dumpName), text); } catch { /* keep the original first version too (it does not collide with the repairN dumps above) */ }
    throw new Error(`Gate A output failed to parse (still failing after self-healing retries): ${String(e).slice(0, 200)} (see logs/${s.id}/${dumpName} and .repairN)`);
  }
}

// Run Gate A's **first pass**: analyse -> parse -> route -> scaffold the review document -> notify. It throws
// on failure (the worker parks the session).
// The session id is self-pinned (--session-id) so a later re-review can continue it with --resume (saving
// tokens). It returns the conclusion for the worker to transition on.
// Note: the "awaiting confirmation" notification is sent by the worker through notify (bot DM -> webhook ->
// desktop); no card is sent separately here.
export async function runGateA(s: Session): Promise<GateAOutcome> {
  const proj = projectForSession(s);
  const prdText =
    s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';
  const fresh = await refresh(s.branch, proj);
  assertFresh(fresh); // the source of truth in the code is unavailable -> park (never review against an ERROR or a stale sha)
  // Checkout anchoring check: claude reads the live checkout, so if it is not on the anchored sha or the tree
  // is dirty -> disclose it to the model (warn) or park (block).
  const { off, disclosure } = anchorCheck(proj, fresh, loadConfig().runtime.gates?.checkout_anchor ?? 'warn');
  if (off.length) {
    log.warn(`Gate A: ${off.join(', ')} checkout is not anchored to origin/${s.branch} (disclosed in the prompt; continuing the review)`);
    await appendEvent(s.id, 'checkout_off_anchor', { gate: 'A', off, branch: s.branch });
  }
  const freshnessBlock = render(loadPrompt('partials/repo-freshness.md', proj.id), {
    FETCHED_AT: fresh.fetchedAt,
    REPO_REFS: fresh.refsText + disclosure,
  });
  const prompt = render(loadPrompt('gate-a.md', proj.id), {
    REPO_FRESHNESS: freshnessBlock,
    SLUG: s.slug,
    PRD_TEXT: prdText,
    OUTPUT_CONTRACT: render(loadPrompt('partials/output-contract.md', proj.id), { SIZE_RUBRIC, SCORE_RUBRIC }),
  });

  const dir = sessionLogDir(s.id);
  writeFileSync(resolve(dir, 'gate-a.prompt.txt'), prompt);
  const sid = randomUUID(); // self-pinned session id -> a re-review continues it with --resume
  const res = await runClaude(prompt, { label: 'Gate A', sessionId: sid, cwd: proj.root });
  writeFileSync(resolve(dir, 'gate-a.raw.txt'), res.raw ?? '');
  if (!res.ok) throw new Error(`Gate A claude failed: ${res.error}`);

  const env = await parseGateA(s, res.result, sid, dir, 'gate-a.result.txt');

  const outPath = resolve(dir, 'gate-a.json');
  writeFileSync(outPath, JSON.stringify(env, null, 2));
  const routing = triage(env, configForSession(s));
  await patch(s.id, {
    gate_a_output_path: outPath,
    gate_a_session_id: sid,
    gate_a_round: 1,
    gate_a_cost_usd: res.costUsd,
    repo_shas_a: JSON.stringify(fresh.shas),
    routing: JSON.stringify(routing),
    // Complexity: the AI's proposed tier plus its reason (a reviewer can adjust it later with `forge size`).
    // Only overwritten while a human has not set it.
    ...(s.size_source === 'human' ? {} : { size: env.size, size_reason: env.size_reason, size_source: 'ai' }),
    // PRD quality score. Warning: private — persisted for internal queries only, and never reaching the
    // outward-facing surfaces below (findingsMd, the document comment, and so on). Scored on the first pass only.
    prd_score: normScore(env.prd_score),
    prd_score_dims: JSON.stringify(normDims(env.prd_score_dims)),
    prd_score_reason: env.prd_score_reason,
  });

  await projectActions(proj).scaffoldReview({
    slug: s.slug,
    prd: s.prd_url,
    owner: routing.reviewerLogin ?? undefined, // note: scaffold's --owner is the document owner (the reviewer's login), not a GitHub org
    title: s.title,
    force: true,
  });
  appendMachineSection(proj.deliveryDir, s.slug, env, routing);
  if (s.doc_ref) {
    await commentDoc(s.doc_ref, machineComment(env, routing, 1));
  }
  const n = env.open_questions.length;
  return { round: 1, openQuestions: n, resolved: n === 0, stalled: false };
}

// Run Gate A's **re-review** (round >= 2, after the PM has replied): continue the first pass's session with
// --resume, without resending the PRD, the code or the contract (saving tokens).
// It throws on failure (the worker parks the session). It returns the conclusion for the worker to
// transition on: nothing left -> CONFIRMED; at the cap -> GATE_A_STALLED; otherwise -> AWAITING_PM_CONFIRM.
export async function runGateARevision(s: Session): Promise<GateAOutcome> {
  const proj = projectForSession(s);
  const round = (s.gate_a_round ?? 1) + 1;
  const pmAnswers = (s.gate_a_pending_input ?? '').trim() || '(the PM submitted without writing a specific reply)';

  const dir = sessionLogDir(s.id);
  let res: Awaited<ReturnType<typeof runClaude>>;
  let resumeSid: string;
  if (s.gate_a_session_id) {
    // The normal path: continue the first pass's session, with the prompt carrying only this round's PM reply
    // plus the re-review instruction.
    const prompt = render(loadPrompt('gate-a-revision.md', proj.id), {
      ROUND: String(round),
      PM_ANSWERS: pmAnswers,
    });
    writeFileSync(resolve(dir, `gate-a.r${round}.prompt.txt`), prompt);
    res = await runClaude(prompt, { label: `Gate A · re-review #${round}`, resume: s.gate_a_session_id, cwd: proj.root });
    resumeSid = s.gate_a_session_id;
  } else {
    // Fallback: an older session with no session id cannot resume -> degrade to a full rerun (carrying the
    // PRD, freshness and contract plus the PM's reply), pinning a new session id.
    const prdText =
      s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';
    const fresh = await refresh(s.branch, proj);
    assertFresh(fresh); // same as the first pass: the source of truth is unavailable -> park (never silently degrade the review)
    const freshnessBlock = render(loadPrompt('partials/repo-freshness.md', proj.id), {
      FETCHED_AT: fresh.fetchedAt,
      REPO_REFS: fresh.refsText,
    });
    const base = render(loadPrompt('gate-a.md', proj.id), {
      REPO_FRESHNESS: freshnessBlock,
      SLUG: s.slug,
      PRD_TEXT: prdText,
      OUTPUT_CONTRACT: render(loadPrompt('partials/output-contract.md', proj.id), { SIZE_RUBRIC, SCORE_RUBRIC }),
    });
    const prompt = `${base}\n\n---\n\n# This is PM review round ${round}. The PM replied to last round's open questions as follows; re-review based on the replies and list only the open questions that still need a PM decision (if all are resolved, return an empty array for open_questions):\n\n\`\`\`\n${pmAnswers}\n\`\`\`\n`;
    writeFileSync(resolve(dir, `gate-a.r${round}.prompt.txt`), prompt);
    const sid = randomUUID();
    res = await runClaude(prompt, { label: `Gate A · re-review #${round}`, sessionId: sid, cwd: proj.root });
    if (res.ok) await patch(s.id, { gate_a_session_id: sid });
    resumeSid = sid;
  }

  writeFileSync(resolve(dir, `gate-a.r${round}.raw.txt`), res.raw ?? '');
  if (!res.ok) throw new Error(`Gate A re-review claude failed: ${res.error}`);

  const env = await parseGateA(s, res.result, resumeSid, dir, `gate-a.r${round}.result.txt`);

  const outPath = resolve(dir, 'gate-a.json'); // overwritten: the latest round is the source of truth for cards and notifications
  writeFileSync(outPath, JSON.stringify(env, null, 2));
  const routing = triage(env, configForSession(s));
  const n = env.open_questions.length;
  const resolved = n === 0;
  // Rounds the PM has answered = round - 1; still holding open questions at the cap -> park for the maintainer.
  const stalled = !resolved && round - 1 >= maxPmRounds();

  await patch(s.id, {
    gate_a_output_path: outPath,
    gate_a_round: round,
    gate_a_pending_input: null, // this round's reply has been digested
    gate_a_cost_usd: (s.gate_a_cost_usd ?? 0) + (res.costUsd ?? 0), // accumulated across rounds
    routing: JSON.stringify(routing),
    gate_a_residual: stalled
      ? JSON.stringify({ round, open_questions: env.open_questions, risks: env.risks })
      : null,
  });

  appendRevisionSection(proj.deliveryDir, s.slug, round, env, routing);
  if (s.doc_ref) {
    await commentDoc(s.doc_ref, machineComment(env, routing, round));
  }
  return { round, openQuestions: n, resolved, stalled };
}
