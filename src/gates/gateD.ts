// Gate D opens the PR: once Gate C is green, someone with permission triggers this, and the target project's
// own create-PR script pushes the branch and opens the PR (**it never merges automatically**).
// The artifact under adversarial review is still the worktree state (reusing Gate C's ImplEnvelope); opening
// the PR merely exposes the worktree branch as a PR so Gate D's codex can review the diff.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionLogDir } from '../util/render.ts';
import { projectForSession } from '../projects.ts';
import { interp } from '../util/worktree.ts';
import { run } from '../util/proc.ts';
import { loadConfig } from '../config.ts';
import { readImplEnvelope, gateCContext } from './gateC.ts';
import { getLegs, patchLeg, type Leg } from './legs.ts';
import { diffStatSince } from './ci.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // take the local implementation methods through the SessionStore seam (free functions have no `this`, so destructuring is safe)
import type { Session } from '../types.ts';

function tail(s: string, n = 2000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

// Take the PR URL out of the create-PR script's stdout (the convention: the last line is the URL).
function parsePrUrl(stdout: string): string {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^https?:\/\//.test(last) ? last : '';
}

// Parse the number out of a GitHub PR URL (.../pull/123 -> 123). Returns null when it cannot be read (which
// does not block anything).
function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// The PR description: title + tech design / requirement context + diff stat (a trimmed version; the
// merge-readiness report produced later is fuller).
function buildPrBody(s: Session, repo: string, diffStat: string): string {
  return [
    `## ${s.title || s.slug}${repo && repo !== '.' ? ` (${repo})` : ''}`,
    '',
    '> This PR was produced by forge Gate C (implementation + a green local CI) and is entering Gate D (codex adversarial review). **Automatic merging is forbidden** - merging is always done by a human.',
    '',
    '### Requirement / tech design',
    gateCContext(s).slice(0, 4000),
    '',
    '### Change overview',
    '```',
    diffStat || '(no diff stat)',
    '```',
  ].join('\n');
}

// A filename-safe repo key ('.' -> 'root'; anything non-alphanumeric -> '-'). Used for the per-leg PR body
// filenames.
function repoFileKey(repo: string): string {
  return repo === '.' ? 'root' : repo.replace(/[^a-zA-Z0-9]+/g, '-');
}

// Open a PR for one worktree (delegating to proj.scripts.create_pr with cwd = the worktree, so the script
// locates the repo root from its own position, which is that worktree). Returns the PR URL. Throws on failure.
async function createPr(s: Session, proj: ReturnType<typeof projectForSession>, repo: string, wt: string, baseSha: string): Promise<string> {
  mkdirSync(sessionLogDir(s.id), { recursive: true });
  const bodyPath = resolve(sessionLogDir(s.id), `pr-body-${repoFileKey(repo)}.md`);
  writeFileSync(bodyPath, buildPrBody(s, repo, diffStatSince(wt, baseSha))); // recompute this repo's diff on the spot (never rely on gate-c.json, which a leg switch may have overwritten)
  const title = `${(s.title || s.slug).slice(0, 110)}${repo && repo !== '.' ? ` (${repo})` : ''}`.slice(0, 120);
  const script = resolve(wt, proj.scripts.create_pr as string);
  const [bin, args] = interp(script, ['--title', title, '--body-file', bodyPath, '--base', s.branch]);
  const r = await run(bin, args, { cwd: wt, timeoutMs: (loadConfig().runtime.gate_d?.ci_timeout_sec ?? 1800) * 1000 });
  if (r.code !== 0) throw new Error(`failed to open the PR (${repo}, exit code ${r.code}): ${tail(r.stdout + r.stderr)}`);
  const url = parsePrUrl(r.stdout);
  if (!url) throw new Error(`the create-PR script did not print a PR URL on its last line (${repo}): ${tail(r.stdout + r.stderr)}`);
  return url;
}

// Open the PRs: **one PR per leg** (one repo, one tree, one PR). Throws on failure -> the worker parks at
// GATE_D_FAILED. The script is idempotent, and a leg that already has a pr_url recorded locally is skipped (so
// it never writes outward twice).
// Fallback: no legs (an older in-flight session) -> fall back to a single PR based on the session worktree (the
// old behaviour). session.pr_url is set to the primary leg's, for backward compatibility with the Gate D loop
// and the notifications.
export async function openReviewPr(s: Session): Promise<void> {
  const proj = projectForSession(s);
  if (!proj.scripts.create_pr) throw new Error('the target project has no scripts.create_pr configured - opening the Gate D PR must go through the delegated script (never re-create gh inside forge)');
  const legs = getLegs(s);
  if (!legs.length) {
    // An older in-flight session (no legs): a single PR, based on the session envelope.
    if (s.pr_url) {
      await appendEvent(s.id, 'gated_pr_reused', { url: s.pr_url, number: s.pr_number ?? null });
      return;
    }
    const env = readImplEnvelope(s);
    if (!env.worktree_path) throw new Error('opening the Gate D PR has no worktree_path (the Gate C envelope is malformed)');
    const url = await createPr(s, proj, '.', env.worktree_path, env.base_sha);
    await patch(s.id, { pr_url: url, pr_number: parsePrNumber(url) });
    await appendEvent(s.id, 'gated_pr_opened', { url, number: parsePrNumber(url) });
    return;
  }
  for (const leg of legs as Leg[]) {
    if (!leg.worktree_path) continue; // no worktree was created (in practice setup creates one for every leg)
    if (leg.pr_url) {
      await appendEvent(s.id, 'gated_pr_reused', { repo: leg.repo, url: leg.pr_url, number: leg.pr_number ?? null });
      continue;
    }
    const url = await createPr(s, proj, leg.repo, leg.worktree_path, leg.base_sha ?? '');
    await patchLeg(s, leg.repo, { pr_url: url, pr_number: parsePrNumber(url) }); // patchLeg re-reads from the DB, so writing several legs in a row does not have them overwrite each other
    await appendEvent(s.id, 'gated_pr_opened', { repo: leg.repo, url, number: parsePrNumber(url) });
  }
  // session.pr_url = the primary leg's (backward compatibility: the Gate D loop currently reviews
  // session.pr_url).
  const primary = getLegs((await get(s.id)) ?? s)[0];
  if (primary?.pr_url) await patch(s.id, { pr_url: primary.pr_url, pr_number: primary.pr_number ?? null });
}
