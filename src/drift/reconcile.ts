// The post-delivery drift loop (polled, reusing the tick's rhythm rather than adding a webhook) — it goes
// straight at the core problem: once a requirement is DONE (its issues all merged into main), one claude run
// reconciles the merged implementation against Gate B's acceptance contract, and any drift is sent to the
// maintainer as a direct message.
//
// Design discipline:
// - **It does not pollute the main gate flow**: DONE is terminal, and all drift progress is recorded as
//   events (drift_polled / drift_detected / drift_clean / drift_reconciled) — no new gate state and no new
//   session column. Once `drift_reconciled` lands it is terminal and never runs again.
// - **Off by default, and bounded**: `runtime.drift.enabled` defaults to false (gated at the tick). Once on,
//   each requirement is audited once; if its issues are not all merged, or the audit keeps failing, it is
//   debounced by poll_every_hours and capped by max_polls, and once exhausted it gives up and alerts rather
//   than burning tokens indefinitely.
// - **Failures are never silent**: an unreadable code source of truth, a claude failure, or output that
//   cannot be parsed all throw; the round's per-session try/catch logs it and leaves it for the next polling
//   window (without writing drift_reconciled), and only at max_polls does it give up and alert.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hours } from '../util/time.ts';
import { resolve } from 'node:path';
import { z } from 'zod';
import { store as sessions } from '../store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { projectForSession } from '../projects.ts';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { runClaude } from '../llm/runClaude.ts';
import { strictParse } from '../llm/structured.ts';
import { refresh, assertFresh } from '../gates/repoFreshness.ts';
import { reposOffRef } from '../gates/repoAnchor.ts';
import { GateBSchema } from '../gates/envelopes.ts';
import type { Acceptance } from '../gates/envelopes.ts';
import { acceptanceMarkdown } from '../util/acceptance.ts';
import { issueStates } from '../workspace.ts';
import type { IssueStateRow } from '../workspace.ts';
import { port } from '../messaging/index.ts';
import { reqRef } from '../util/display.ts';
import type { Session, CreatedIssue } from '../types.ts';

// ── The drift reconciliation's output contract ──────────────────────────────────────
export const DriftFindingSchema = z.object({
  ac: z.string().default(''), // which contract or scenario: AC1, or an endpoint signature
  status: z.enum(['ok', 'drift', 'unknown']).default('unknown'),
  detail: z.string().default(''), // the reasoning
  evidence: z.string().default(''), // repo path:line
});
export const DriftSchema = z.object({
  drifted: z.boolean().default(false),
  summary: z.string().default(''),
  findings: z.array(DriftFindingSchema).default([]),
});
export type DriftVerdict = z.infer<typeof DriftSchema>;

// The output contract fed to claude (it will also serve a future parse-repair; v1 is a single call, and a
// parse failure is simply retried in the next polling window).
export const DRIFT_CONTRACT = `\`\`\`json
{
  "drifted": false,
  "summary": "one-line overview: which contracts/scenarios drifted (or state that all are aligned)",
  "findings": [
    { "ac": "AC1, or the endpoint/function signature", "status": "ok|drift|unknown", "detail": "reasoning", "evidence": "repo path:line" }
  ]
}
\`\`\``;

// ── The pure functions (easy to unit-test) ──────────────────────────────────────

// created_issues JSON -> CreatedIssue[] (malformed data gives an empty array, which the caller skips on; it
// never crashes).
export function parseCreatedIssues(json: string | null): CreatedIssue[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as CreatedIssue[];
    return Array.isArray(arr) ? arr.filter((i) => i && typeof i.repo === 'string' && typeof i.number === 'number') : [];
  } catch {
    return [];
  }
}

// Only when every issue is CLOSED has it "left OPEN". An empty set, any OPEN, or any UNKNOWN means it cannot
// be reconciled yet.
// Note: CLOSED does not necessarily mean merged into main — a "dropped" closure (NOT_PLANNED / DUPLICATE) is
// recognised separately and skipped by reconcileDrift, and "closed normally but the implementation never
// reached main" is caught by the reconciliation anchoring to the real code at origin/<prod> (if it cannot be
// read, it honestly reports drift or unknown).
export function allClosed(states: { state: 'OPEN' | 'CLOSED' | 'UNKNOWN' }[]): boolean {
  return states.length > 0 && states.every((s) => s.state === 'CLOSED');
}

// The closure reason means "dropped" (the requirement was abandoned and must not be reconciled as if it had
// landed).
export function isDropped(reason: string): boolean {
  return reason === 'NOT_PLANNED' || reason === 'DUPLICATE';
}

// The LLM's top-level `drifted` and its per-item findings occasionally contradict each other. In production
// the more conservative reading wins: if any single acceptance item is judged drift, the round cannot be
// recorded as clean.
export function hasDrift(v: DriftVerdict): boolean {
  return v.drifted || v.findings.some((f) => f.status === 'drift');
}

// Check whether each fetched repo's working tree is "sitting exactly on that origin/<prod> sha and clean".
// It returns the names of the repos that are not aligned (empty means every one can be trusted).
// The drift reconciliation uses this to be sure claude is reading "the real code that was merged into
// <prod>", rather than the wrong branch (dev), something behind, or a dirty working tree — otherwise it would
// produce "a confident clean, against the wrong code", which is the most dangerous kind of false negative.
// Forge never touches a checkout: if it cannot read one, it honestly reports it as not aligned.
// reposOffRef has moved up to gates/repoAnchor.ts (shared between Gate A/B's review anchoring and the drift
// reconciliation), and is imported directly here.

// The wording of the drift alert's direct message (a pure function): the title, each drift, a summary, and
// where to go to check.
export function driftDm(s: Session, v: DriftVerdict): { title: string; lines: string[] } {
  const drifts = v.findings.filter((f) => f.status === 'drift');
  const unknowns = v.findings.filter((f) => f.status === 'unknown');
  return {
    title: `⚠️ the implementation has drifted · ${reqRef(s)}`,
    lines: [
      `"${s.title}" is DONE, but the merged implementation drifts from Gate B's acceptance contract in **${drifts.length}** place(s)${unknowns.length ? ` (with ${unknowns.length} more that could not be judged)` : ''}:`,
      ...drifts.slice(0, 8).map((f, i) => `${i + 1}. [${f.ac || 'contract'}] ${f.detail}${f.evidence ? ` (${f.evidence})` : ''}`),
      v.summary ? `Summary: ${v.summary}` : '',
      `To check: \`./forge show ${s.slug}\` | if it needs changing, open a follow-up issue yourself`,
    ].filter(Boolean),
  };
}

// ── Reconciling one requirement ────────────────────────────────────────────

// The acceptance contract comes from Gate B's draft envelope (gate_b_draft_path). Missing or malformed gives
// null, and the caller records a skipped terminal state rather than failing hard — the drift audit is a
// best-effort check after the fact.
function readAcceptance(s: Session): Acceptance | null {
  if (!s.gate_b_draft_path || !existsSync(s.gate_b_draft_path)) return null;
  try {
    return GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8'))).acceptance;
  } catch {
    return null;
  }
}

// Render the dropped sub-issues into a fragment of the prompt, so claude knows those repos' acceptance items
// being unimplemented is legitimate (mark them unknown, and do not report drift).
function droppedNote(dropped: IssueStateRow[]): string {
  if (dropped.length === 0) return '(none: all issues completed normally)';
  return (
    dropped.map((d) => `- ${d.repo}#${d.number} (${d.reason})`).join('\n') +
    "\n(These repos' issues were closed as **duplicate/descoped** during delivery: their acceptance items being unimplemented is **legitimate** — mark them `unknown`, note \"issue dropped for this repo\" in detail, and **do not report drift for them**.)"
  );
}

// Reconcile the drift of a DONE requirement whose main body has been delivered. `dropped` is the sub-issues
// that were dropped, carried into the prompt so claude can tell them apart.
// It records drift_detected or drift_clean, plus drift_reconciled (terminal). A failure (freshness, the
// checkout, claude, or parsing) throws, and reconcileDrift's per-session try/catch catches it and leaves it
// for the next round.
export async function auditSession(s: Session, dropped: IssueStateRow[] = []): Promise<void> {
  const acc = readAcceptance(s);
  if (!acc || (acc.contracts.length === 0 && acc.scenarios.length === 0)) {
    await sessions.appendEvent(s.id, 'drift_reconciled', { skipped: 'no_acceptance' });
    log.info(`${s.slug}: there is no acceptance contract to reconcile against, so the drift audit is skipped (recorded as terminal)`);
    return;
  }
  const proj = projectForSession(s);
  // Drift is always reconciled against **prod (= main)** — what was merged and delivered is on main, so
  // s.branch is not used (it may be dev, which would read the wrong code).
  const prod = proj.branches.prod;
  const fresh = await refresh(prod, proj);
  assertFresh(fresh); // the code source of truth cannot be read -> throw (the outer backoff retries); it never reconciles against stale or errored code
  // Anchoring: each repo's checkout has to be sitting exactly on the origin/<prod> sha just fetched, and be
  // clean. Otherwise claude reads the wrong branch, something behind, or a dirty tree, and returns "a
  // confident conclusion about code that is not main". Not aligned -> throw and retry later (capped by
  // max_polls); it never produces a wrong reconciliation.
  const off = reposOffRef(proj, fresh.shas);
  if (off.length) {
    throw new Error(`the drift reconciliation could not anchor: the checkout of ${off.join(', ')} is not aligned with origin/${prod} (wrong branch, behind, or a dirty working tree) - refusing to draw a conclusion about code that is not ${prod}`);
  }
  const prompt = render(loadPrompt('drift-audit.md', proj.id), {
    SLUG: s.slug,
    REPO_FRESHNESS: render(loadPrompt('partials/repo-freshness.md', proj.id), { FETCHED_AT: fresh.fetchedAt, REPO_REFS: fresh.refsText }),
    ACCEPTANCE: acceptanceMarkdown(acc),
    DROPPED: droppedNote(dropped),
    DRIFT_CONTRACT,
  });
  const dir = sessionLogDir(s.id);
  try { writeFileSync(resolve(dir, 'drift-audit.prompt.txt'), prompt); } catch { /* a failed write to disk does not block */ }

  const res = await runClaude(prompt, { label: 'drift reconciliation', cwd: proj.root });
  try { writeFileSync(resolve(dir, 'drift-audit.raw.txt'), res.raw ?? ''); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`the drift reconciliation's claude call failed: ${res.error}`);

  let v: DriftVerdict;
  try {
    v = strictParse(DriftSchema, res.result);
  } catch (e) {
    try { writeFileSync(resolve(dir, 'drift-audit.result.txt'), res.result); } catch { /* ignore */ }
    throw new Error(`the drift reconciliation's output could not be parsed (never let silently through): ${String(e).slice(0, 160)}`);
  }

  const drifted = hasDrift(v);
  if (drifted) {
    const dm = driftDm(s, v);
    log.warn(`${s.slug}: found ${v.findings.filter((f) => f.status === 'drift').length} place(s) where the implementation drifted -> alerting the maintainer by direct message`);
    await port.sendDmText(dm.title, dm.lines, 'red').catch((e) => log.warn(`the drift alert's direct message was not delivered (logged): ${String(e).slice(0, 120)}`));
    await sessions.appendEvent(s.id, 'drift_detected', { drifts: v.findings.filter((f) => f.status === 'drift').length, summary: v.summary });
  } else {
    log.ok(`${s.slug}: the drift reconciliation passed - the implementation is aligned with the acceptance contract`);
    await sessions.appendEvent(s.id, 'drift_clean', { findings: v.findings.length });
  }
  await sessions.appendEvent(s.id, 'drift_reconciled', { drifted }); // terminal: it never runs again
}

// ── The polling entry point (the tick calls it when drift.enabled) ──────────────────
// It scans the DONE requirements that have not been reconciled: debounce -> check whether every issue is
// closed -> if so, reconcile once. A failure is left for the next round (capped by max_polls).
export async function reconcileDrift(now: number): Promise<void> {
  const d = loadConfig().runtime.drift;
  const everyMs = hours(d?.poll_every_hours ?? 24);
  const maxPolls = d?.max_polls ?? 8;

  for (const s of await sessions.listByStates(['DONE'])) {
    if ((await sessions.lastEventTs(s.id, 'drift_reconciled')) != null) continue; // already reconciled (terminal)
    const issues = parseCreatedIssues(s.created_issues);
    if (issues.length === 0) continue; // no issues were created -> there is nothing to reconcile
    const last = await sessions.lastEventTs(s.id, 'drift_polled');
    if (last != null && now - last < everyMs) continue; // the polling debounce

    const polls = (await sessions.events(s.id)).filter((e) => e.kind === 'drift_polled').length;
    if (polls >= maxPolls) {
      // The backoff is exhausted: the issues have long failed to all close, or the audit keeps failing -> give
      // up on reconciling automatically (terminal) and alert the maintainer to check it by hand, rather than
      // burning tokens indefinitely.
      await sessions.appendEvent(s.id, 'drift_reconciled', { gave_up: true, polls });
      await port.sendDmText(
        `⚠️ giving up on the drift reconciliation · ${reqRef(s)}`,
        [`"${s.title}" still could not be reconciled after ${polls} polls (its issues are not all merged, or the audit keeps failing). Reconciling automatically has stopped; please check the implementation against the acceptance contract yourself.`],
        'orange',
      ).catch(() => undefined);
      log.warn(`${s.slug}: the drift reconciliation's backoff is exhausted (${polls} polls) -> giving up and alerting the maintainer`);
      continue;
    }
    await sessions.appendEvent(s.id, 'drift_polled', { attempt: polls + 1 });

    try {
      const states = await issueStates(issues, projectForSession(s).owner);
      if (states.some((st) => st.state === 'UNKNOWN')) {
        log.warn(`${s.slug}: the drift poll could not read some issues' state (gh failed or timed out) -> trying again next window`);
        continue; // it could not be read -> never treated as "merged"; wait for the next round
      }
      if (!allClosed(states)) continue; // something is still OPEN -> wait for the next window
      // Everything is CLOSED. Tell a "dropped" closure (NOT_PLANNED / DUPLICATE) apart from a normal one:
      // - the whole thing dropped (every issue dropped, or the umbrella Epic itself) -> the requirement was
      //   abandoned; record the terminal state and skip (no claude spend).
      // - only some sub-issues dropped (deduplicated or descoped) while the main body was still delivered ->
      //   still reconcile what was delivered, carrying the dropped information into the prompt so claude does
      //   not misjudge a descoped repo as drift — one deduplicated sub-issue must never cost the whole
      //   phase-4 guarantee.
      const dropped = states.filter((st) => isDropped(st.reason));
      if (dropped.length) {
        const umbrella = projectForSession(s).umbrella;
        const allDropped = dropped.length === states.length;
        const umbrellaDropped = dropped.some((st) => st.repo === umbrella);
        if (allDropped || umbrellaDropped) {
          await sessions.appendEvent(s.id, 'drift_reconciled', { skipped: allDropped ? 'all_dropped' : 'umbrella_dropped', issues: dropped.map((d) => `${d.repo}#${d.number}(${d.reason})`) });
          log.info(`${s.slug}: the whole requirement was dropped (${allDropped ? 'every issue' : 'the umbrella Epic'}) -> not reconciled (recorded as terminal)`);
          continue;
        }
        log.info(`${s.slug}: ${dropped.length} sub-issue(s) were dropped (deduplicated or descoped) but the main body was still delivered -> reconciling what was delivered (the dropped information goes into the prompt)`);
      }
      await auditSession(s, dropped); // the main body was delivered -> reconcile (anchored to the real code at origin/prod, with the dropped sub-issues in the prompt so they can be told apart)
    } catch (e) {
      // drift_reconciled is not written, so the next polling window retries (capped by max_polls). One
      // failure must never interrupt the whole scan.
      log.warn(`${s.slug}: the drift reconciliation failed this round (retrying next window) - ${String(e).slice(0, 160)}`);
    }
  }

  // Downstream SHIPPED: the PR forge implemented itself was **merged by a human** (confirmed through forge
  // merged), so the merge is a settled fact and the whole DONE-side issue-closure judgement is skipped — it
  // reconciles the merged implementation against Gate B's acceptance contract directly (complementing Gate
  // D's pre-merge check). It is debounced and capped by max_polls in the same way.
  // A standalone session (with no Gate B acceptance contract) has auditSession record a skipped terminal
  // state — honestly: there is no contract to reconcile against, and it does not pretend to be aligned.
  for (const s of await sessions.listByStates(['SHIPPED'])) {
    if ((await sessions.lastEventTs(s.id, 'drift_reconciled')) != null) continue; // already reconciled (terminal)
    const last = await sessions.lastEventTs(s.id, 'drift_polled');
    if (last != null && now - last < everyMs) continue; // the polling debounce
    const polls = (await sessions.events(s.id)).filter((e) => e.kind === 'drift_polled').length;
    if (polls >= maxPolls) {
      await sessions.appendEvent(s.id, 'drift_reconciled', { gave_up: true, polls });
      log.warn(`${s.slug}: the drift reconciliation (SHIPPED) exhausted its backoff (${polls} polls) -> giving up on reconciling automatically`);
      continue;
    }
    await sessions.appendEvent(s.id, 'drift_polled', { attempt: polls + 1 });
    try {
      await auditSession(s); // already merged by a human -> reconcile directly (anchored to the real code at origin/prod, with no issue-closure judgement)
    } catch (e) {
      log.warn(`${s.slug}: the drift reconciliation (SHIPPED) failed this round (retrying next window) - ${String(e).slice(0, 160)}`);
    }
  }
}
