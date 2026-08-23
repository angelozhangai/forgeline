// Typed wrappers around the main repo's existing scripts. The service calls them, and never rewrites them.
// Note: the Feishu document calls (read, comment-add, token, docx raw) moved to src/docs/feishu.ts in phase 1
// — they are a **document source's** implementation detail, not a general wrapper around a project script.
import { resolve } from 'node:path';
import { run } from './util/proc.ts';
import { SCRIPTS_DIR } from './root.ts';
import type { CreatedIssue } from './types.ts';

// The default project's GitHub org as a fallback; on the production path the caller passes
// project(s.project_id).owner explicitly (see writes.ts and reconcile.ts).
const DEFAULT_OWNER = 'your-org';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// dir is the target project's scripts directory (with several projects, the caller passes
// project(s.project_id).scriptsDir).
// It falls back to the default project's SCRIPTS_DIR, for shared infrastructure scripts and for callers that
// have not been threaded through yet.
function scriptPath(name: string, dir: string = SCRIPTS_DIR): string {
  return resolve(dir, name);
}

async function bash(script: string, args: string[], dir?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await run('bash', [scriptPath(script, dir), ...args], { timeoutMs: 120000 });
  return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr };
}

function flag(args: string[], name: string, val?: string | null): void {
  if (val != null && val !== '') {
    args.push(name, val);
  }
}

function parseIssues(stdout: string, owner: string = DEFAULT_OWNER): CreatedIssue[] {
  const re = new RegExp(`https://github\\.com/${escapeRe(owner)}/([\\w.-]+)/issues/(\\d+)`, 'g');
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of stdout.matchAll(re)) {
    const key = `${m[1]}#${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: m[1], number: Number(m[2]), url: m[0] });
  }
  return out;
}

// ── Gate A ──────────────────────────────────────────────
export interface ScaffoldOpts {
  slug: string;
  prd?: string | null;
  repos?: string | null; // "C,U,A"
  issues?: string | null;
  owner?: string | null;
  title?: string | null;
  force?: boolean;
  dryRun?: boolean;
  scriptsDir?: string; // the target project's scripts directory (defaulting to the default project's)
}

export function reviewReqScaffold(o: ScaffoldOpts) {
  const a = ['scaffold', o.slug];
  flag(a, '--prd', o.prd);
  flag(a, '--repos', o.repos);
  flag(a, '--issues', o.issues);
  flag(a, '--owner', o.owner);
  flag(a, '--title', o.title);
  if (o.force) a.push('--force');
  if (o.dryRun) a.push('--dry-run');
  return bash('review-req.sh', a, o.scriptsDir);
}

// ── Gate B ──────────────────────────────────────────────
export function techDesignScaffold(o: ScaffoldOpts) {
  const a = ['scaffold', o.slug];
  flag(a, '--prd', o.prd);
  flag(a, '--repos', o.repos);
  flag(a, '--issues', o.issues);
  flag(a, '--owner', o.owner);
  flag(a, '--title', o.title);
  if (o.force) a.push('--force');
  if (o.dryRun) a.push('--dry-run');
  return bash('tech-design.sh', a, o.scriptsDir);
}

export function techDesignApprove(slug: string, issue?: string | null, rollup = false, scriptsDir?: string) {
  const a = ['approve', slug];
  flag(a, '--issue', issue);
  if (rollup) a.push('--rollup');
  return bash('tech-design.sh', a, scriptsDir);
}

// ── Creating the work items ───────────────────────────────────────────
export interface IssueCommon {
  type?: string | null;
  prio?: string | null;
  area?: string | null;
  status?: number | null;
  assignee?: string | null; // a short code, or a login
  docUrl?: string | null;
  body?: string | null;
  dryRun?: boolean;
  scriptsDir?: string; // the target project's scripts directory (defaulting to the default project's)
  owner?: string; // that project's GitHub org (used to parse the created issue's URL); DEFAULT_OWNER by default
}

function commonFlags(a: string[], o: IssueCommon): void {
  flag(a, '--type', o.type);
  flag(a, '--prio', o.prio);
  flag(a, '--area', o.area);
  flag(a, '--status', o.status != null ? String(o.status) : null);
  flag(a, '--assignee', o.assignee);
  flag(a, '--doc-url', o.docUrl);
  flag(a, '--body', o.body);
  if (o.dryRun) a.push('--dry-run');
}

export async function newReqSingle(
  repo: string,
  title: string,
  o: IssueCommon,
): Promise<{ ok: boolean; stdout: string; stderr: string; issues: CreatedIssue[] }> {
  const a = ['single', repo, '--title', title];
  commonFlags(a, o);
  const r = await bash('new-req.sh', a, o.scriptsDir);
  return { ...r, issues: parseIssues(r.stdout, o.owner) };
}

export interface EpicChild {
  repo: string; // C/U/A/E
  title: string;
}

export async function newReqEpic(
  slug: string,
  title: string,
  children: EpicChild[],
  o: IssueCommon,
): Promise<{ ok: boolean; stdout: string; stderr: string; issues: CreatedIssue[] }> {
  const a = ['epic', slug, '--title', title];
  commonFlags(a, o);
  for (const c of children) a.push('--child', `${c.repo}:${c.title}`);
  const r = await bash('new-req.sh', a, o.scriptsDir);
  return { ...r, issues: parseIssues(r.stdout, o.owner) };
}

// Publish the technical-design document to the main repo (commit, PR, merge — see
// scripts/publish-tech-design.sh). Idempotent: if it is already published the script skips and exits 0.
export async function publishTechDesign(
  slug: string,
  o: { base: string; dryRun?: boolean; scriptsDir?: string },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const a = [slug, '--base', o.base];
  if (o.dryRun) a.push('--dry-run');
  return bash('publish-tech-design.sh', a, o.scriptsDir);
}

// Find the sub-issues that already exist in a repo by their epic:<slug> label (including any filled in by
// hand with add-child). A multi-repo retry refreshes created_issues from this: the main repo's epic script
// prints a sub-issue as just `✓ C#n` with no full URL, so after a partial failure a re-run can only
// rediscover them from GitHub.
export async function listEpicChildren(repo: string, slug: string, owner: string = DEFAULT_OWNER): Promise<{ ok: boolean; issues: CreatedIssue[]; stderr: string }> {
  const r = await run('gh', ['issue', 'list', '-R', `${owner}/${repo}`, '-l', `epic:${slug}`, '--state', 'all', '--json', 'number,url'], { timeoutMs: 60000 });
  if (r.code !== 0 || r.timedOut) return { ok: false, issues: [], stderr: r.stderr || `exit ${r.code}` };
  try {
    const arr = JSON.parse(r.stdout || '[]') as { number?: number; url?: string }[];
    const issues = arr
      .filter((a) => typeof a.number === 'number' && typeof a.url === 'string')
      .map((a) => ({ repo, number: a.number as number, url: a.url as string }));
    return { ok: true, issues, stderr: '' };
  } catch {
    return { ok: false, issues: [], stderr: 'gh issue list --json could not be parsed' };
  }
}

// Read an issue's open/closed state and why it was closed (used by the drift loop). One gh issue view each.
// state is OPEN / CLOSED / UNKNOWN — an answer that cannot be obtained (gh failed, timed out, or returned
// malformed JSON) is UNKNOWN, and is never treated as "merged".
// reason is a closed issue's stateReason: COMPLETED means it finished normally and is roughly "it landed";
// NOT_PLANNED and DUPLICATE mean it was dropped and must not be reconciled as if it had landed.
export interface IssueStateRow {
  repo: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  reason: string; // the raw stateReason (COMPLETED / NOT_PLANNED / DUPLICATE / ''); '' when it could not be read
}
export async function issueStates(issues: CreatedIssue[], owner: string = DEFAULT_OWNER): Promise<IssueStateRow[]> {
  const out: IssueStateRow[] = [];
  for (const it of issues) {
    const r = await run('gh', ['issue', 'view', String(it.number), '-R', `${owner}/${it.repo}`, '--json', 'state,stateReason'], { timeoutMs: 60000 });
    let state: 'OPEN' | 'CLOSED' | 'UNKNOWN' = 'UNKNOWN';
    let reason = '';
    if (r.code === 0 && !r.timedOut) {
      try {
        const j = JSON.parse(r.stdout || '{}') as { state?: string; stateReason?: string };
        if (j.state === 'OPEN' || j.state === 'CLOSED') state = j.state;
        if (typeof j.stateReason === 'string') reason = j.stateReason;
      } catch {
        /* malformed JSON -> it stays UNKNOWN */
      }
    }
    out.push({ repo: it.repo, number: it.number, state, reason });
  }
  return out;
}

// Check whether a PR really was merged (the verification before confirm-merge's irreversible cleanup; an
// answer that cannot be obtained is never treated as merged).
// The PR's URL goes straight to gh, with no need to split out owner/repo. state===MERGED, or a mergedAt being
// present, counts as merged.
export async function prMergeState(prUrl: string): Promise<{ ok: boolean; merged: boolean; state: string; error?: string }> {
  const r = await run('gh', ['pr', 'view', prUrl, '--json', 'state,mergedAt'], { timeoutMs: 60000 });
  if (r.code !== 0 || r.timedOut) return { ok: false, merged: false, state: 'UNKNOWN', error: r.stderr.slice(0, 300) || `exit ${r.code}` };
  try {
    const j = JSON.parse(r.stdout || '{}') as { state?: string; mergedAt?: string | null };
    return { ok: true, merged: j.state === 'MERGED' || !!j.mergedAt, state: j.state ?? 'UNKNOWN' };
  } catch {
    return { ok: false, merged: false, state: 'UNKNOWN', error: 'gh pr view --json could not be parsed' };
  }
}

// ── Labels ─────────────────────────────────────────────
// Add a label (size:*, and so on) to an issue that already exists. The size labels are pre-created in every
// repo by sync-labels, so this just adds them.
export async function addLabel(repo: string, num: number, label: string, owner: string = DEFAULT_OWNER): Promise<{ ok: boolean; stderr: string }> {
  const r = await run('gh', ['issue', 'edit', String(num), '-R', `${owner}/${repo}`, '--add-label', label], { timeoutMs: 60000 });
  return { ok: r.code === 0 && !r.timedOut, stderr: r.stderr };
}

// ── Committing the delivery documents automatically (gated by config, off by default, and it **never
// pushes**) ────────────────────
// It commits the target project's docs/delivery/<slug>/ onto **the current branch**. The safety boundaries
// (matching the concerns raised in the README):
//  · the `-- docs/delivery/<slug>` pathspec only: it touches that slug's delivery documents and never sweeps
//    up anything else that happens to be staged;
//  · no git checkout and no branch switching — it never disturbs the live checkout the gates anchor to;
//  · it never runs git push (an absolute rule);
//  · idempotent: with no change under that path the commit is skipped (committed:false, ok:true).
export async function commitDeliveryDocs(opts: { root: string; slug: string; refNum?: number }): Promise<{ ok: boolean; committed: boolean; stderr: string }> {
  const pathspec = `docs/delivery/${opts.slug}`;
  const C = ['-C', opts.root];
  const add = await run('git', [...C, 'add', '--', pathspec], { timeoutMs: 30000 });
  if (add.code !== 0) return { ok: false, committed: false, stderr: add.stderr.slice(0, 300) };
  // diff --cached --quiet: exit 0 means nothing is staged under that path (skip), 1 means there is (commit).
  const diff = await run('git', [...C, 'diff', '--cached', '--quiet', '--', pathspec], { timeoutMs: 30000 });
  if (diff.code === 0) return { ok: true, committed: false, stderr: '' };
  const msg = `docs(delivery): archive ${opts.refNum != null ? `REQ-${opts.refNum} ` : ''}${opts.slug}'s review and technical plan (committed automatically by forge; not pushed)`;
  const commit = await run('git', [...C, 'commit', '-m', msg, '--', pathspec], { timeoutMs: 30000 });
  if (commit.code !== 0) return { ok: false, committed: false, stderr: commit.stderr.slice(0, 300) };
  return { ok: true, committed: true, stderr: '' };
}
