// 状态页只读 payload 构造（纯查询、无副作用，导出供单测）：看板分组 + 全量需求列表（可按状态过滤）+ 单条详情（含事件时间线）。
// **安全红线**：只暴露**运营态**（状态/标签/PR/指派/自治等级/事件流），**绝不含成本/分数**（管理面私有，见 README）。
import { store as sessions } from '../store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { stateLabel, reqRef } from '../util/display.ts';
import { projectForSession } from '../projects.ts';
import { loadConfig } from '../config.ts';
import { HUMAN_GATES, TERMINAL } from '../statemachine/states.ts';
import { panelActionsFor } from './action-gateway.ts';
import type { Session } from '../types.ts';

// 已知项目 = 注册表声明的（含默认）∪ 库内出现过的。注册但还没需求的项目也算「已知」（过滤→空集是对的）。
async function knownProjectIds(): Promise<Set<string>> {
  const ids = new Set<string>(await sessions.distinctProjects());
  const reg = loadConfig().projects;
  if (reg) {
    ids.add(reg.default_project);
    for (const k of Object.keys(reg.projects)) ids.add(k);
  }
  return ids;
}

// 规整外部传入的 ?project=：去空白后为空 → 全部（undefined）；非空但**纯未知**（既没注册也无需求，多来自手敲/陈旧 URL）
// → 也回退全部，绝不变成令人困惑的空视图（约束：未知项目回退「全部」，而非空）。已知项目（含注册空项目）→ 原样过滤。
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

// 看板：按状态分组计数 + 需关注（失败态 / 待人停泊）列表。projectId 给定（且已知）→ 仅该项目（查询隔离）。
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
  label: string; // 人话状态（display.stateLabel）
  title: string;
  project: string;
  autonomy: number; // 该 session 所属项目的自治等级（看哪些在自治驱动）
  updatedAt: number;
}

function toRow(s: Session): SessionRow {
  return { ref: reqRef(s), slug: s.slug, state: s.state, label: stateLabel(s.state), title: s.title, project: s.project_id, autonomy: projectForSession(s).autonomy.level, updatedAt: s.updated_at };
}

// 全量需求列表（可选按项目 + 状态过滤）+ 该视图状态集 + **全部**项目集（喂前端两个下拉）。按 updatedAt 倒序。
// projectId 给定 → 仅该项目（查询隔离）；projects 始终列全库项目（供切换，不随当前过滤收窄）。
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
  actions: string[]; // 该状态下面板可触发的动作键（前端据此画按钮；真校验在被调 action）
  events: { ts: number; kind: string; detail: string | null }[];
}

// 单条需求详情 + 事件时间线（末 200 条）。找不到 → null（server 据此 404）。
// projectId 给定（且已知）→ 该需求须属此项目，否则 null——项目视图下不跨项目读详情（与列表/看板口径一致）。
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
