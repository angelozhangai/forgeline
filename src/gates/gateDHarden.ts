// Gate D test hardening (GATE_D_HARDENING): the last step after codex says LGTM - claude adds **inner-loop**
// tests (failure, permission and concurrency paths, with no mirror tests) and the local CI must go fully green
// again -> generate the merge-readiness report -> push the branch -> the worker moves to AWAITING_HUMAN_MERGE.
//
// Invariants (the same set Gate D's fix uses, with one fewer layer):
// - The artifact being hardened is the worktree state; the diff and the CI result are rebuilt on the spot by
//   forge, never parsed as code out of the model's output.
// - **What CI verified == what gets pushed**: commit before CI, clean both before and after CI, and a bounded
//   number of self-fix rounds when it is red.
// - **The green baseline is the immutable sha pinned at Gate D's LGTM** (worker.afterGateD writes
//   gate_d_green_sha): hardening starts with `reset --hard <green-sha>`, discarding any hardening edits left
//   behind by a previous round that died or failed midway - which is what makes re-entry idempotent. It must
//   **never use the moving ref origin/<branch>** (stale, missing or force-pushed, that would make what gets
//   hardened, CI-verified and pushed differ from what codex reviewed - Codex blocker).
// - **Any failure before CI goes green rolls back to the green baseline and then parks**; once CI green is
//   confirmed, gate_d_harden_verified_sha pins that commit, and from then on writing the report (a forge-local
//   decision document, not a PR artifact) and pushing the **code** commit do not roll back on failure (verified
//   work is never thrown away). The idempotent finish only re-pushes while "HEAD is still == verified_sha and
//   the tree is clean" - it never blindly pushes an unverified object (Codex SF).
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { GateCFixResultSchema } from './envelopes.ts';
import type { ImplEnvelope } from './envelopes.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import { persistGateC, readImplEnvelope, gateCContext } from './gateC.ts';
import { getLegs } from './legs.ts';
import { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, pushWorktree, worktreeClean, resetWorktree } from './ci.ts';
import { worktreeHeadSha } from '../util/worktree.ts';
import { projectForSession } from '../projects.ts';
import { runClaude } from '../llm/runClaude.ts';
import type { Session } from '../types.ts';

// How many bounded "CI is red -> fix it" rounds happen after hardening: once those are exhausted and it is
// still red it parks for a human (a red state never reaches merge-ready).
const MAX_HARDEN_CI_FIX_ATTEMPTS = 2;

// Assemble the hard hardening rules from the runtime.gate_d.harden configuration (fed into
// gate-d-harden-tests.md as {{HARDEN_RULES}}).
function hardenRules(): string {
  const h = loadConfig().runtime.gate_d?.harden;
  const rules: string[] = [];
  if (h?.forbid_mirror_tests !== false) rules.push('- **No mirror tests**: test observable behavior/contracts — never copy the implementation into assertions, never assert only "was called / non-empty", never mock out the unit under test itself.');
  if (h?.require_failure_path) rules.push('- **Failure paths must be covered**: bad input / exceptions / rejections / timeouts / boundaries — every non-happy path needs a test biting it.');
  if (h?.require_auth_path) rules.push('- **Permission paths must be covered**: unauthorized / privilege escalation / multi-tenant isolation access control needs tests.');
  rules.push('- Cover the **inner-loop** key paths this change touches — concurrency/idempotency, SSE/streaming, DB constraints; the tests must go red when the implementation is wrong.');
  return rules.join('\n');
}

// Any residual unresolved findings (after a normal LGTM, gate_d_residual has been cleared to null -> "none").
// Broken JSON is tolerated and also reads as "none".
function residualNote(s: Session): string {
  const NONE = '- No unresolved findings (the codex adversarial review raised zero blockers).';
  if (!s.gate_d_residual) return NONE;
  try {
    const r = JSON.parse(s.gate_d_residual) as { findings?: { severity?: string; issue?: string; where?: string }[] };
    const fs = r.findings ?? [];
    if (fs.length === 0) return NONE;
    return fs.slice(0, 12).map((f) => `- [${f.severity ?? '?'}] ${f.issue ?? ''}${f.where ? ` (${f.where})` : ''}`).join('\n');
  } catch {
    return NONE;
  }
}

// The merge-readiness report markdown (a pure function, so it is easy to unit test): the factual content is
// assembled deterministically and never passed through an LLM again - which avoids introducing a new failure
// point at the very last step, where every gate has already passed and only the document is left.
export function buildMergeReadiness(
  s: Session,
  env: ImplEnvelope,
  opts: { context: string; codexRound: number; hardenSummary: string },
): string {
  const files = env.files_changed ?? [];
  return `# Merge-readiness report · ${s.title || s.slug}

> Generated by forge Gate D. **Automatic merging is forbidden** - merging is always done by a human. Please review the important parts of the diff yourself before merging.

- PR: ${s.pr_url ?? '(not recorded)'}
- Branch: ${env.impl_branch} -> ${s.branch}
- Baseline: ${(env.base_sha ?? '').slice(0, 12) || '?'} (${env.base_ref ?? ''})

## Requirement / tech design

${opts.context.slice(0, 4000) || '(no context)'}

## Change overview

\`\`\`
${env.diff_stat || '(no diff stat)'}
\`\`\`
${files.length ? `\nFiles changed (${files.length}):\n${files.map((f) => `- ${f}`).join('\n')}\n` : ''}
## Adversarial review (codex reviews the diff / claude revises)

- Verdict: passed (codex said LGTM in round ${opts.codexRound}, and nothing is pushed until the local CI is fully green).

## Test hardening (inner loop)

- ${opts.hardenSummary || 'Inner-loop tests were added (failure, permission and concurrency paths among them), with no mirror tests.'}
- Local CI: fully green after hardening.

## Remaining risk / accepted risk

${residualNote(s)}

## Rollback plan

- To roll back after merging: click Revert on the merged PR page, or open a follow-up PR with \`git revert -m 1 <merge-commit-sha>\`.

## Must run before and after merging

- The target project's CI (the same affected-scoped script forge ran locally).
- After merging to the trunk, running the affected e2e suite once is recommended (per the project's own convention).
`;
}

function activeReportRepo(s: Session): string | null {
  const legs = getLegs(s);
  if (legs.length <= 1) return null;
  const active = legs.find((l) => l.worktree_path && l.worktree_path === s.worktree_path);
  if (active?.repo) return active.repo;
  try {
    const keys = Object.keys(JSON.parse(s.base_shas ?? '{}'));
    return keys.length === 1 ? keys[0] : null;
  } catch {
    return null;
  }
}

function reportFileName(repo: string | null): string {
  if (!repo) return 'merge-readiness.md';
  const safe = repo.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `merge-readiness.${safe}.md`;
}

// Write the merge-readiness report to disk and return its path.
function writeMergeReadiness(s: Session, env: ImplEnvelope, opts: { codexRound: number; hardenSummary: string }): string {
  const proj = projectForSession(s);
  const dir = resolve(proj.deliveryDir, s.slug);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, reportFileName(activeReportRepo(s)));
  writeFileSync(path, buildMergeReadiness(s, env, { ...opts, context: gateCContext(s) }));
  return path;
}

// Run the test hardening (the worker calls this in GATE_D_HARDENING). On success it writes
// merge_readiness_path, pushes the branch and returns (the worker then moves to AWAITING_HUMAN_MERGE).
// Any failure throws -> the worker parks at GATE_D_FAILED (planRetry sees gate_d_harden_round > 0 and returns
// to HARDENING to continue, which is idempotent on re-entry).
export async function runGateDHarden(s: Session): Promise<void> {
  const proj = projectForSession(s);
  const cur = async (): Promise<Session> => (await get(s.id))!;
  const env = readImplEnvelope(await cur());
  const wt = env.worktree_path || proj.root;
  const pid = proj.id;
  const ciScript = proj.scripts.ci ? resolve(wt, proj.scripts.ci) : undefined;
  const ciTimeout = (loadConfig().runtime.gate_d?.ci_timeout_sec ?? 1800) * 1000;
  const dump = (name: string, raw: string): void => {
    try {
      writeFileSync(resolve(sessionLogDir(s.id), name), raw);
    } catch {
      /* a failed dump must not block the flow */
    }
  };

  // The green baseline is the immutable sha pinned at Gate D's LGTM (never a moving ref). If it is missing,
  // refuse to harden on an unknown baseline.
  const greenSha = ((await cur()).gate_d_green_sha ?? '').trim();
  if (!greenSha) throw new Error('Gate D hardening: the pinned green sha (gate_d_green_sha) is missing - refusing to harden on an unknown or moving baseline -> parking');

  // The idempotent-finish fast path: hardening already went CI-green (verified_sha is set), HEAD is still that
  // verified commit, and the tree is clean -> just re-push (never blindly push an unverified object).
  // If HEAD != verified (the isolated tree was modified, residue was left behind, or a tick died) or the tree is
  // dirty, skip the fast path and fall through to a full re-hardening (resetting back to the pinned green sha).
  const verified = ((await cur()).gate_d_harden_verified_sha ?? '').trim();
  if ((await cur()).merge_readiness_path && verified && worktreeHeadSha(wt) === verified && worktreeClean(wt)) {
    const pushed = pushWorktree(wt);
    await appendEvent(s.id, 'gate_d_harden_pushed', { reused: true, ok: pushed.ok, head: verified.slice(0, 12) });
    if (!pushed.ok) throw new Error(`Gate D hardening: re-pushing the verified commit failed: ${pushed.output.slice(0, 200)}`);
    return;
  }

  const round = ((await cur()).gate_d_harden_round ?? 0) + 1;
  // Entering a full hardening pass: set harden_round first (so any later failure makes planRetry come back to
  // HARDENING), and clear the stale report and verified sha (both are regenerated below - an old verified sha
  // must never trigger the fast path and push the wrong thing).
  await patch(s.id, { gate_d_harden_round: round, merge_readiness_path: null, gate_d_harden_verified_sha: null });

  // Normalise to the pinned green sha: discard hardening edits left behind by a previous round that died or
  // failed midway (on a clean first entry this is a no-op).
  const norm = resetWorktree(wt, greenSha);
  await appendEvent(s.id, 'gate_d_harden_reset', { to: greenSha.slice(0, 12), ok: norm.ok, output: norm.output.slice(0, 120) });
  if (!norm.ok) throw new Error(`Gate D hardening: normalising to the green sha ${greenSha.slice(0, 12)} failed -> parking (never harden on a tree with residue): ${norm.output.slice(0, 160)}`);
  const head = worktreeHeadSha(wt);
  if (head !== greenSha) throw new Error(`Gate D hardening: after the reset, HEAD (${head?.slice(0, 12) ?? '?'}) is not the pinned green sha (${greenSha.slice(0, 12)}) -> parking`);
  const preHead = greenSha; // the rollback anchor is the pinned green sha (immutable)

  // Any failure before CI goes green -> roll back to the pinned green sha and park (a failed rollback throws
  // too; the next re-entry resets again as a backstop).
  const rollback = async (): Promise<void> => {
    const r = resetWorktree(wt, preHead);
    await appendEvent(s.id, 'gate_d_harden_rollback', { to: preHead.slice(0, 12), ok: r.ok });
    if (!r.ok) throw new Error(`Gate D hardening failed to roll back to ${preHead.slice(0, 12)} -> parking: ${r.output.slice(0, 160)}`);
  };
  const bail = async (msg: string): Promise<never> => {
    await rollback();
    throw new Error(msg);
  };

  // claude resumes the Gate D revision session (same worktree context) to add the inner-loop tests. Hardening
  // is another heavy downstream call, so it uses gate_d.claude_timeout_sec (falling back to the global value).
  const claudeTimeout = loadConfig().runtime.gate_d?.claude_timeout_sec;
  let sid = (await cur()).gate_d_fixer_session;
  const runStep = async (p: string): Promise<Awaited<ReturnType<typeof runClaude>>> => {
    if (sid) return runClaude(p, { label: 'Gate D · harden', resume: sid, cwd: wt, timeoutSec: claudeTimeout });
    sid = randomUUID();
    await patch(s.id, { gate_d_fixer_session: sid });
    return runClaude(p, { label: 'Gate D · harden', sessionId: sid, cwd: wt, timeoutSec: claudeTimeout });
  };

  let res = await runStep(
    render(loadPrompt('gate-d-harden-tests.md', pid), {
      WORKTREE: wt,
      DIFF_STAT: env.diff_stat || '(no diff stat)',
      CONTEXT: gateCContext(await cur()).slice(0, 4000),
      HARDEN_RULES: hardenRules(),
    }),
  );
  dump('gated-harden.raw.txt', res.raw ?? '');
  if (!res.ok) await bail(`Gate D hardening claude failed: ${res.error}`);
  if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });
  let hardenSummary = '';
  try {
    hardenSummary = strictParse(GateCFixResultSchema, res.result).summary;
  } catch {
    hardenSummary = ''; // the real gate for hardening is a green CI, not the JSON - a parse failure does not block anything, the summary is just left empty
  }

  // Commit and drive CI to green (with a bounded number of self-fix rounds); the same invariant as Gate D's
  // fix: commit -> clean -> CI -> pass only when green and still clean.
  let lastCi = '';
  for (let attempt = 0; ; attempt++) {
    const cm = commitWorktree(wt, `forge(gate D harden ${s.slug}): round ${round}${attempt ? ` ci-fix ${attempt}` : ''}`);
    await appendEvent(s.id, 'gate_d_harden_commit', { ok: cm.ok, committed: cm.committed, attempt });
    if (!cm.ok) await bail(`Gate D hardening failed to make the commit -> parking (the worktree may be dirty): ${cm.output.slice(0, 200)}`);
    if (!worktreeClean(wt)) await bail('the Gate D hardening worktree is not clean after the commit -> parking (CI must verify HEAD)');
    const ci = await runCi(wt, ciScript, { base: env.base_sha || env.base_ref || undefined, timeoutMs: ciTimeout });
    dump('gated-harden-ci.raw.txt', ci.summary);
    lastCi = ci.summary;
    if (!ci.ran) await bail(`the Gate D hardening CI could not be run (infrastructure): ${ci.summary.slice(0, 200)}`);
    if (ci.ok) {
      if (!worktreeClean(wt)) await bail('the Gate D hardening worktree was dirtied after CI -> parking (what CI verified is not the HEAD being pushed)');
      break; // green and clean on both sides -> HEAD is exactly the verified commit
    }
    if (attempt >= MAX_HARDEN_CI_FIX_ATTEMPTS) await bail(`the local CI is still red after Gate D hardening plus ${attempt} self-fix round(s) -> parking for a human (a red state never reaches merge-ready): ${ci.summary.slice(0, 200)}`);
    res = await runStep(render(loadPrompt('gate-d-ci-fix.md', pid), { CI: ci.summary.slice(0, 3000), WORKTREE: wt }));
    dump('gated-harden.raw.txt', res.raw ?? '');
    if (!res.ok) await bail(`the Gate D hardening self-fix claude call failed: ${res.error}`);
    if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });
  }

  // CI is green and the tree was clean on both sides: the hardening work is locked in (committed and
  // verified). **Pin the verified HEAD sha** as the guard for the idempotent finish - from here on, writing the
  // report and pushing do not roll back on failure (verified work is never thrown away), and a later re-entry
  // only re-pushes while HEAD is still exactly this sha (it never pushes blindly).
  const verifiedSha = worktreeHeadSha(wt);
  if (!verifiedSha) throw new Error('Gate D hardening: the HEAD sha could not be read after CI went green -> parking (the idempotent finish has nothing to anchor to)');
  await patch(s.id, { gate_d_harden_verified_sha: verifiedSha });

  const finalEnv: ImplEnvelope = {
    ...env,
    implemented: hasCommitsSince(wt, env.base_sha),
    diff_stat: diffStatSince(wt, env.base_sha),
    files_changed: changedFilesSince(wt, env.base_sha),
    ci_ok: true,
    ci_summary: lastCi.slice(0, 2000),
    last_summary: hardenSummary,
  };
  await persistGateC(await cur(), finalEnv);
  // merge-readiness is a **forge-local decision document** (written under the delivery directory; it is not a
  // PR artifact and is not pushed along with the branch).
  const mdPath = writeMergeReadiness(await cur(), finalEnv, { codexRound: (await cur()).gate_d_round ?? 1, hardenSummary });
  await patch(s.id, { merge_readiness_path: mdPath });
  await appendEvent(s.id, 'gate_d_merge_readiness', { path: mdPath });

  // Push the **code** commit to update the PR branch (the report is not part of it). A failure does not roll
  // back - verified_sha is pinned, so the next round's idempotent finish re-pushes that verified commit.
  const pushed = pushWorktree(wt);
  if (!pushed.ok) throw new Error(`Gate D hardening failed to push the branch (the verified commit ${verifiedSha.slice(0, 12)} is kept, and the next round re-pushes it idempotently): ${pushed.output.slice(0, 200)}`);
  await appendEvent(s.id, 'gate_d_harden_pushed', { round, head: verifiedSha.slice(0, 12) });
  log.ok(`${s.slug}: Gate D test hardening finished (round ${round}) + the local CI is fully green + pushed -> merge-ready`);
}
