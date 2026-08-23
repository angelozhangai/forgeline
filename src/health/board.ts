// Building the status page's read-only payloads (pure queries with no side effects, exported for unit
// tests): the board's grouping, the full requirement list (optionally filtered by state), and one
// requirement's detail (with its event timeline).
// **The security red line**: it exposes the **operational** state only (state, label, PR, assignee, autonomy
// level, event stream) and **never cost or score** (those are private to the management surface, see the
// README).
import { store as sessions } from '../store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { stateLabel, reqRef } from '../util/display.ts';
import { projectForSession } from '../projects.ts';
import { loadConfig } from '../config.ts';
import { HUMAN_GATES, TERMINAL } from '../statemachine/states.ts';
import { panelActionsFor } from './action-gateway.ts';
import type { Session } from '../types.ts';

// The known projects are the ones the registry declares (including the default) plus the ones that have
// appeared in the database. A registered project with no requirements yet still counts as known (filtering
// down to an empty set is the right answer).
async function knownProjectIds(): Promise<Set<string>> {
  const ids = new Set<string>(await sessions.distinctProjects());
  const reg = loadConfig().projects;
  if (reg) {
    ids.add(reg.default_project);
    for (const k of Object.keys(reg.projects)) ids.add(k);
  }
  return ids;
}

// Normalise an externally supplied ?project=: empty after trimming -> everything (undefined); non-empty but
// **entirely unknown** (neither registered nor present in the database, usually a hand-typed or stale URL)
// -> also falls back to everything, never a confusing empty view (the rule: an unknown project falls back to
// "all", not to nothing). A known project (including a registered empty one) filters as given.
async function normProject(projectId?: string | null): Promise<string | undefined> {
  const p = projectId?.trim();
  if (!p) return undefined;
  return (await knownProjectIds()).has(p) ? p : undefined;
}

export interface AttentionItem {
  ref: string;
  slug: string;
  state: string;
  title: string;
  updatedAt: number;
  kind: 'failed' | 'awaiting';
}

// The board: counts grouped by state, plus the list needing attention (a failed state, or parked waiting on
// a human). Given a projectId (and a known one) -> that project only (the query is isolated).
export async function boardPayload(projectId?: string | null): Promise<{ byState: Record<string, number>; total: number; attention: AttentionItem[] }> {
  const all = await sessions.listAll(await normProject(projectId));
  const byState: Record<string, number> = {};
  const attention: AttentionItem[] = [];
  for (const s of all) {
    byState[s.state] = (byState[s.state] ?? 0) + 1;
    const isFailed = TERMINAL.has(s.state) && s.state !== 'DONE';
    const isAwaiting = HUMAN_GATES.has(s.state);
    if (isFailed || isAwaiting) {
      attention.push({ ref: reqRef(s), slug: s.slug, state: s.state, title: s.title, updatedAt: s.updated_at, kind: isFailed ? 'failed' : 'awaiting' });
    }
  }
  attention.sort((a, b) => b.updatedAt - a.updatedAt);
  return { byState, total: all.length, attention };
}

export interface SessionRow {
  ref: string;
  slug: string;
  state: string;
  label: string; // the state in plain language (display.stateLabel)
  title: string;
  project: string;
  autonomy: number; // the autonomy level of the project this session belongs to (so you can see which are being driven autonomously)
  updatedAt: number;
}

function toRow(s: Session): SessionRow {
  return { ref: reqRef(s), slug: s.slug, state: s.state, label: stateLabel(s.state), title: s.title, project: s.project_id, autonomy: projectForSession(s).autonomy.level, updatedAt: s.updated_at };
}

// The full requirement list (optionally filtered by project and state), plus this view's set of states and
// the set of **all** projects (which feed the front end's two dropdowns). Sorted by updatedAt, descending.
// Given a projectId -> that project only (the query is isolated); `projects` always lists every project in
// the database (so you can switch), and does not narrow with the current filter.
export async function sessionsPayload(stateFilter?: string | null, projectId?: string | null): Promise<{ sessions: SessionRow[]; states: string[]; projects: string[] }> {
  const all = await sessions.listAll(await normProject(projectId));
  const states = [...new Set(all.map((s) => s.state))].sort();
  const rows = (stateFilter ? all.filter((s) => s.state === stateFilter) : all).map(toRow).sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions: rows, states, projects: await sessions.distinctProjects() };
}

export interface SessionDetail {
  ref: string;
  slug: string;
  state: string;
  label: string;
  title: string;
  project: string;
  branch: string;
  prUrl: string | null;
  assignee: string | null;
  size: string | null;
  autonomy: number;
  createdAt: number;
  updatedAt: number;
  actions: string[]; // the action keys the panel can trigger in this state (the front end draws its buttons from this; the real validation happens in the action being called)
  events: { ts: number; kind: string; detail: string | null }[];
}

// One requirement's detail plus its event timeline (the last 200). Not found -> null (which the server turns
// into a 404).
// Given a projectId (and a known one) -> the requirement must belong to that project, otherwise null: within
// a project view no detail is read across projects (the same rule as the list and the board).
export async function sessionDetail(idOrSlug: string, projectId?: string | null): Promise<SessionDetail | null> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) return null;
  const pid = await normProject(projectId);
  if (pid && s.project_id !== pid) return null;
  const ev = await sessions.events(s.id);
  return {
    ref: reqRef(s),
    slug: s.slug,
    state: s.state,
    label: stateLabel(s.state),
    title: s.title,
    project: s.project_id,
    branch: s.branch,
    prUrl: s.pr_url ?? null,
    assignee: s.assignee ?? null,
    size: s.size ?? null,
    autonomy: projectForSession(s).autonomy.level,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    actions: panelActionsFor(s.state),
    events: ev.slice(-200).map((e) => ({ ts: e.ts, kind: e.kind, detail: e.detail ?? null })),
  };
}
