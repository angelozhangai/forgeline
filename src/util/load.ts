// Each person's "work in progress right now" — the input to automatic assignment. ⚠️ The load formula
// mirrors the main repo's tools/weekly-load.sh (size x cross-repo breadth); to change the formula, change
// the source of truth there first and then sync it here, keeping "requirement x size (S1/M3/L8/XL20) x
// cross-repo (1/1.3/1.5)" identical.
// Where it differs from weekly-load: this only counts what is **currently in progress** (rollup state ∈
// in_progress_statuses), excluding what has shipped, and it does not apply the quality factor — it measures
// the capacity taken by "what is on their plate right now", not retrospective output.
import { run } from './proc.ts';
import { normSize, sizePoints, type Size } from './sizing.ts';
import { resolveLogin, type Config } from '../config.ts';

// Repo slug -> letter (C/U/A/E count towards cross-repo breadth, matching the short codes in the main repo's
// new-req.sh; example-project=P is the Epic itself and is not a code repo).
// This is the default project's (demo's) hardcoded set, used as scoreLoad's **default** repoCode: a direct
// call to scoreLoad (a pure-function test with no project context) still gets it.
// The production path (probeLoad) derives repoCode from the target project's repoMap + umbrella and injects
// it, so a non-demo project also gets its letters right (see buildRepoCode).
const REPO_CODE: Record<string, string> = {
  demo: 'C',
  'example-web': 'U',
  'example-admin': 'A',
  'example-engine': 'E',
  'example-project': 'P',
};

// Derive "GitHub slug -> letter" from the target project's repo identity: letter (C/U/A/E) -> local key
// (repoMap) -> slug (repoSlugs), with the umbrella repo mapping to P.
// The umbrella only gets P when its slug does not collide with a code repo's (under a monorepo the umbrella
// *is* the code repo, so it keeps its code letter rather than being wiped out by P).
// For demo this derives key-for-key the same result as REPO_CODE above (behaviour is unchanged); a non-demo
// project gets the right letters from its own configuration.
export function buildRepoCode(repoMap: Record<string, string>, umbrella: string, repoSlugs: Record<string, string>): Record<string, string> {
  const slug = (key: string): string => repoSlugs[key] ?? key;
  const out: Record<string, string> = {};
  for (const [letter, localKey] of Object.entries(repoMap)) out[slug(localKey)] = letter;
  const umbSlug = slug(umbrella);
  if (!(umbSlug in out)) out[umbSlug] = 'P'; // the umbrella (not a code repo) -> marks the Epic itself, not counted as cross-repo
  return out;
}

// The cross-repo multiplier: one repo x1.0 / two x1.3 / three x1.5 (coordination and contract cost, same as
// weekly-load).
export function crossStack(span: number): number {
  return span >= 3 ? 1.5 : span === 2 ? 1.3 : 1.0;
}

const SIZE_RANK: Record<Size, number> = { S: 1, M: 2, L: 3, XL: 4 };

export interface LoadIssue {
  repo: string; // the repo's directory name (demo / example-web / example-admin / example-project)
  number: number;
  labels: string[]; // GitHub label names (status:* / epic:* / size:*)
}

export interface LoadItem {
  key: string; // epic:<slug> (a cross-repo requirement collapses into one) or <C|U|A>#<n> (single repo)
  size: Size; // the highest tier among the sub-issues (none -> defaults to M)
  span: number; // how many code repos it spans (>= 1)
  status: number; // the rollup (the lowest, least mature status ordinal; 0 = none)
  points: number; // sizePoints x crossStack
}

export interface PersonLoad {
  wip: number; // how many requirements are in progress
  loadPoints: number; // the weighted points in progress
  items: LoadItem[];
}

function parseLabel(labels: string[], prefix: string): string | null {
  const hit = labels.find((l) => l.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
// A status label looks like "4-in-development" -> 4; missing or malformed -> 0.
function statusOrd(labels: string[]): number {
  const st = parseLabel(labels, 'status:');
  if (!st) return 0;
  const n = Number(st.split('-')[0]);
  return Number.isFinite(n) ? n : 0;
}

// A pure function: aggregate one person's issues into requirements and compute their in-progress load. Easy
// to unit-test, since it only needs an array of labels.
// repoCode: repo slug -> letter (defaulting back to the default project's REPO_CODE); in production
// probeLoad derives it from the project and injects it.
export function scoreLoad(issues: LoadIssue[], opts: { inProgressStatuses: number[]; repoCode?: Record<string, string> }): PersonLoad {
  const repoCode = opts.repoCode ?? REPO_CODE;
  interface Agg {
    repos: Set<string>;
    size: Size | null;
    codeStatus: number; // the code sub-repos' (C/U/A) rollup = min(sub-statuses); the DRI is always on every sub-issue, so these turn up in their own probe
    otherStatus: number; // the status of the P Epic itself, or of an unknown repo (a fallback used only for a pure-P requirement)
  }
  const aggs = new Map<string, Agg>();
  for (const iss of issues) {
    const epic = parseLabel(iss.labels, 'epic:');
    const code = repoCode[iss.repo] ?? '?';
    // epic:<slug> collapses the cross-repo sub-issues into one requirement (never double-counted); a
    // single-repo issue counts as one on its own.
    const key = epic ? `epic:${epic}` : `${code}#${iss.number}`;
    let a = aggs.get(key);
    if (!a) {
      a = { repos: new Set(), size: null, codeStatus: 0, otherStatus: 0 };
      aggs.set(key, a);
    }
    const isCode = code !== 'P' && code !== '?';
    if (isCode) a.repos.add(code);
    const sz = normSize(parseLabel(iss.labels, 'size:') ?? '');
    if (sz && (!a.size || SIZE_RANK[sz] > SIZE_RANK[a.size])) a.size = sz; // take the highest tier
    const ord = statusOrd(iss.labels);
    if (ord > 0) {
      // The rollup is the furthest-behind (lowest) sub-issue. They are kept apart: the code sub-repos give
      // codeStatus, and the P Epic itself only ever feeds otherStatus.
      if (isCode) {
        if (a.codeStatus === 0 || ord < a.codeStatus) a.codeStatus = ord;
      } else if (a.otherStatus === 0 || ord < a.otherStatus) a.otherStatus = ord;
    }
  }
  const inProg = new Set(opts.inProgressStatuses);
  const items: LoadItem[] = [];
  for (const [key, a] of aggs) {
    // If there are code sub-repos, judge "in progress" by their rollup — the P Epic's rollup label often lags
    // behind start-issue, and it must never make an active cross-repo requirement look idle.
    // A pure-P requirement (no code sub-issues yet) uses P's own status.
    const status = a.codeStatus > 0 ? a.codeStatus : a.otherStatus;
    if (!inProg.has(status)) continue; // count only what is currently in progress (which excludes anything with no status)
    const span = Math.max(1, a.repos.size); // attached only to the Epic (P) -> span 1
    const size = a.size ?? 'M'; // no size -> default M (same as weekly-load)
    const points = sizePoints(size) * crossStack(span);
    items.push({ key, size, span, status, points });
  }
  const loadPoints = items.reduce((s, i) => s + i.points, 0);
  return { wip: items.length, loadPoints, items };
}

export interface PersonLoadResult extends PersonLoad {
  code: string; // the short code
  login: string | null;
  ok: boolean; // whether the gh probe succeeded (on failure this person's load is unknown and the algorithm knows it; never silently treated as 0)
}

// Pull one person's open issues from each repo (thin IO). A repo that fails is recorded as ok=false rather
// than silently dropped.
async function fetchPersonIssues(
  login: string,
  repos: string[],
  owner: string,
): Promise<{ ok: boolean; issues: LoadIssue[] }> {
  const issues: LoadIssue[] = [];
  let ok = true;
  for (const repo of repos) {
    const r = await run(
      'gh',
      ['issue', 'list', '-R', `${owner}/${repo}`, '--state', 'open', '--search', `assignee:${login}`, '--limit', '100', '--json', 'number,labels'],
      { timeoutMs: 60000 },
    );
    if (r.code !== 0 || r.timedOut) {
      ok = false;
      continue;
    }
    try {
      const arr = JSON.parse(r.stdout || '[]') as { number?: number; labels?: { name?: string }[] }[];
      for (const a of arr) {
        if (typeof a.number !== 'number') continue;
        issues.push({ repo, number: a.number, labels: (a.labels ?? []).map((l) => l.name ?? '').filter(Boolean) });
      }
    } catch {
      ok = false;
    }
  }
  return { ok, issues };
}

// Probe the current in-progress load of the whole candidate pool (one gh call per person per repo, the same
// order of magnitude as weekly-load).
// The caller passes `proj` for the session's project (projectForSession(s)) — which repos to scan and which
// cross-repo letters to use are no longer hardcoded to demo.
// It takes a structural subset rather than importing ProjectFull, so that load.ts has no runtime dependency
// on projects.ts (which would make it fragile at import time under mock.module).
export interface ProbeRepoIdentity {
  owner: string; // this project's GitHub org
  repos: string[]; // the local repo keys/paths ('.' for a monorepo)
  umbrella: string; // the local umbrella repo key
  repoSlugs: Record<string, string>; // local key -> GitHub slug (a monorepo's '.' -> your-monorepo)
  repoMap: Record<string, string>; // letter (C/U/A/E) -> local key; used to derive the cross-repo letters
}
export async function probeLoad(cfg: Config, proj: ProbeRepoIdentity): Promise<PersonLoadResult[]> {
  const { owner, repos: projRepos, umbrella, repoSlugs, repoMap } = proj;
  // Local repo key/path -> GitHub slug (a monorepo's '.' -> your-monorepo) before building gh -R owner/<slug>
  // — the local path '.' must never be used as a repo name.
  const slug = (key: string): string => repoSlugs[key] ?? key;
  const keys = umbrella && !projRepos.includes(umbrella) ? [...projRepos, umbrella] : [...projRepos];
  const repos = keys.map(slug);
  // Derive the cross-repo letters for this project (slug -> letter): demo yields C/U/A/E/P (the same as
  // REPO_CODE), and a non-demo project follows its own repoMap.
  const repoCode = buildRepoCode(repoMap, umbrella, repoSlugs);
  const out: PersonLoadResult[] = [];
  for (const code of cfg.assignment.pool) {
    const login = resolveLogin(cfg, code);
    if (!login) {
      out.push({ code, login: null, ok: false, wip: 0, loadPoints: 0, items: [] });
      continue;
    }
    const { ok, issues } = await fetchPersonIssues(login, repos, owner);
    const load = scoreLoad(issues, { inProgressStatuses: cfg.assignment.in_progress_statuses, repoCode });
    out.push({ code, login, ok, ...load });
  }
  return out;
}
