import { prep } from './db.ts';
import { canTransition } from '../statemachine/engine.ts';
import type { State } from '../statemachine/states.ts';
import type { Session } from '../types.ts';
import type { SessionStore, NewSession, EventRow } from './port.ts';

// NewSession / EventRow 的真源在 port.ts（SessionStore 契约的一部分）；这里再导出供既有具名 import 不破。
export type { NewSession, EventRow } from './port.ts';

// 导出供一致性测试：ALL_COLUMNS 必须 ⊆ 实际 session 表列（schema.sql + db.ts 迁移），否则 patch 静默丢字段。
export const ALL_COLUMNS = [
  'id', 'ref_num', 'slug', 'title', 'state', 'project_id', 'branch', 'prd_url', 'prd_text_path',
  'feishu_chat_id', 'feishu_doc_token', 'poster_open_id', 'intake_msg_id', 'status_msg_id',
  'size', 'size_reason', 'size_source',
  'prd_score', 'prd_score_dims', 'prd_score_reason',
  'gate_a_output_path', 'gate_a_session_id', 'gate_a_round', 'gate_a_pending_input', 'gate_a_residual',
  'gate_a_reviewer_session', 'gate_a_fixer_session', 'gate_a_adv_round', 'gate_a_fix_fail_streak',
  'gate_a_cost_usd', 'repo_shas_a', 'routing', 'confirmed_at', 'confirmed_by',
  'confirmed_notes', 'gate_b_requested_by', 'gate_b_draft_path', 'issue_specs_path',
  'repo_shas_b', 'adversarial_rounds', 'adversarial_residual', 'gate_b_cost_usd',
  'gate_b_reviewer_session', 'gate_b_fixer_session', 'gate_b_round', 'gate_b_fix_fail_streak', 'gate_b_pending_input',
  'gate_b_human_asks', 'gate_b_reviewer_tokens',
  // 下游闸C
  'gate_c_requested_by', 'gate_c_draft_path', 'gate_c_round', 'gate_c_fix_fail_streak', 'gate_c_pending_input',
  'gate_c_human_asks', 'gate_c_fixer_session', 'gate_c_residual', 'gate_c_cost_usd',
  // 下游闸D
  'gate_d_requested_by', 'gate_d_draft_path', 'gate_d_round', 'gate_d_fix_fail_streak', 'gate_d_pending_input',
  'gate_d_human_asks', 'gate_d_reviewer_session', 'gate_d_fixer_session', 'gate_d_reviewer_tokens',
  'gate_d_residual', 'gate_d_cost_usd', 'gate_d_rollback_to', 'gate_d_harden_round',
  'gate_d_green_sha', 'gate_d_harden_verified_sha',
  // worktree / PR / 合并
  'target_repos', 'legs',
  'worktree_path', 'impl_branch', 'base_shas', 'pr_url', 'pr_number', 'merge_readiness_path',
  'merged_by', 'merged_at',
  // standalone 入口 + 多租户预留
  'source_kind', 'issue_ref', 'tenant_id',
  'assignee', 'assignee_source', 'assigned_by', 'assigned_at', 'assign_snapshot',
  'go_by', 'go_at',
  'created_issues', 'techdesign_branch', 'error',
  'retry_count', 'next_retry_at', 'reclaim_count', 'dead_letter',
  'lease_owner', 'lease_expires_at', // 多 runner 防重领（lease）
  'created_at', 'updated_at',
] as const;

// project_id 与 id/created_at/ref_num 一样入库即定、不可 patch（项目绑定全程不变）。
const SETTABLE = new Set(
  ALL_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at' && c !== 'ref_num' && c !== 'project_id'),
);

// ⚠️ 自由函数现为 **async**（SessionStore async 契约，Phase 2）：底层 node:sqlite 同步，包成 async（无副作用、
// 语义不变），为 remoteApi 就绪。内部互调（create→get/appendEvent、transition→get/patch/appendEvent 等）均 await。
export async function create(s: NewSession): Promise<Session> {
  const now = Date.now();
  // 人类可读编号：收到即分配单调序号 → 全程显示 REQ-<ref_num>。单进程单线程，MAX+1 无竞态。
  const refNum = (prep('SELECT COALESCE(MAX(ref_num), 0) + 1 AS n FROM session').get() as { n: number }).n;
  prep(
    `INSERT INTO session (id, ref_num, slug, title, state, project_id, branch, prd_url, prd_text_path,
        feishu_chat_id, feishu_doc_token, poster_open_id, intake_msg_id, source_kind, issue_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.id, refNum, s.slug, s.title, s.state ?? 'INTAKE', s.project_id ?? 'demo', s.branch,
    s.prd_url ?? null, s.prd_text_path ?? null,
    s.feishu_chat_id ?? null, s.feishu_doc_token ?? null,
    s.poster_open_id ?? null, s.intake_msg_id ?? null,
    s.source_kind ?? null, s.issue_ref ?? null, now, now,
  );
  await appendEvent(s.id, 'intake', { ref: `REQ-${refNum}`, slug: s.slug, prd_url: s.prd_url ?? null, source_kind: s.source_kind ?? 'prd', issue_ref: s.issue_ref ?? null });
  return (await get(s.id))!;
}

// standalone 实现任务去重键：同一 issue_ref 只建一条（重复 implement --issue 复用既有）。
export async function findByIssueRef(ref: string): Promise<Session | null> {
  if (!ref) return null;
  return (
    (prep('SELECT * FROM session WHERE issue_ref = ? ORDER BY created_at ASC LIMIT 1').get(ref) as unknown as Session) ?? null
  );
}

// create() 撞 doc token 唯一索引（并发竞态：另一条相同 PRD 抢先插入）→ 据此回退去重路径。【纯谓词·同步】
export function isDuplicateTokenError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && /feishu_doc_token/i.test(msg);
}

// create() 撞 issue_ref 唯一索引（并发竞态：另一条相同 standalone issue 抢先插入）→ 据此回退去重路径。【纯谓词·同步】
export function isDuplicateIssueRefError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && /issue_ref/i.test(msg);
}

export async function get(id: string): Promise<Session | null> {
  return (prep('SELECT * FROM session WHERE id = ?').get(id) as unknown as Session) ?? null;
}

export async function getBySlug(slug: string): Promise<Session | null> {
  return (
    (prep('SELECT * FROM session WHERE slug = ? ORDER BY created_at DESC LIMIT 1')
      .get(slug) as unknown as Session) ?? null
  );
}

export async function findByPrdUrl(url: string): Promise<Session | null> {
  return (
    (prep('SELECT * FROM session WHERE prd_url = ? LIMIT 1').get(url) as unknown as Session) ??
    null
  );
}

// 按飞书文档 token 找（PRD 级去重的真源：URL 各种变体/查询参数都归一到同一 doc token）。
// 取最早一条作为该 PRD 的规范 session（重复提交复用它）。
export async function findByDocToken(token: string): Promise<Session | null> {
  if (!token) return null;
  return (
    (prep('SELECT * FROM session WHERE feishu_doc_token = ? ORDER BY created_at ASC LIMIT 1')
      .get(token) as unknown as Session) ?? null
  );
}

// 接受 id 或 slug，便于 CLI 用 slug 操作
export async function resolve(idOrSlug: string): Promise<Session | null> {
  return (await get(idOrSlug)) ?? (await getBySlug(idOrSlug));
}

export async function listByStates(states: State[]): Promise<Session[]> {
  if (states.length === 0) return [];
  const placeholders = states.map(() => '?').join(',');
  return prep(`SELECT * FROM session WHERE state IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...states) as unknown as Session[];
}

// 全量列表。projectId 给定 → 仅该项目（查询隔离：面板/cost/CLI 按项目分视图）；缺省 → 全库
// （**红线**：poller/孤儿清扫/漂移等 daemon 全局动作一律不传 projectId，绝不按项目隔离驱动）。
export async function listAll(projectId?: string): Promise<Session[]> {
  if (projectId) {
    return prep('SELECT * FROM session WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as unknown as Session[];
  }
  return prep('SELECT * FROM session ORDER BY created_at DESC').all() as unknown as Session[];
}

// 库内出现过的项目 id（去重、字母序）——供面板/CLI 的项目过滤下拉（只列真有需求的项目）。
export async function distinctProjects(): Promise<string[]> {
  const rows = prep('SELECT DISTINCT project_id AS p FROM session WHERE project_id IS NOT NULL ORDER BY project_id').all() as unknown as { p: string }[];
  return rows.map((r) => r.p);
}

// 各状态计数（健康看板 / 活跃 gate 数用）。一次聚合查询，避免取全表。
export async function countByState(): Promise<Record<string, number>> {
  const rows = prep('SELECT state, COUNT(*) AS n FROM session GROUP BY state')
    .all() as unknown as { state: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export async function countByStates(states: State[]): Promise<number> {
  if (states.length === 0) return 0;
  const placeholders = states.map(() => '?').join(',');
  const row = prep(`SELECT COUNT(*) AS n FROM session WHERE state IN (${placeholders})`)
    .get(...states) as { n: number };
  return row.n;
}

export async function patch(id: string, fields: Partial<Session>): Promise<Session> {
  const keys = Object.keys(fields).filter((k) => SETTABLE.has(k as never));
  if (keys.length === 0) return (await get(id))!;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => {
    const v = (fields as Record<string, unknown>)[k];
    return v === undefined ? null : (v as string | number | null);
  });
  prep(`UPDATE session SET ${setSql}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
  return (await get(id))!;
}

export async function transition(id: string, to: State, fields: Partial<Session> = {}): Promise<Session> {
  const s = await get(id);
  if (!s) throw new Error(`session not found: ${id}`);
  if (!canTransition(s.state, to)) {
    throw new Error(`illegal transition ${s.state} → ${to} (session ${id})`);
  }
  const res = await patch(id, { ...fields, state: to });
  if (s.state !== to) await appendEvent(id, 'transition', { from: s.state, to });
  return res;
}

export async function appendEvent(id: string, kind: string, detail?: unknown): Promise<void> {
  prep('INSERT INTO event_log (session_id, ts, kind, detail) VALUES (?,?,?,?)')
    .run(id, Date.now(), kind, detail != null ? JSON.stringify(detail) : null);
}

export async function events(id: string): Promise<EventRow[]> {
  return prep('SELECT ts, kind, detail FROM event_log WHERE session_id = ? ORDER BY id ASC')
    .all(id) as unknown as EventRow[];
}

// 某 session 某类事件最近一次时刻（去抖告警/对账用）；无则 null。
// 命中复合索引 idx_event_session_kind_ts(session_id, kind, ts)——index 内求 MAX，不扫该 session 全部事件。
export async function lastEventTs(id: string, kind: string): Promise<number | null> {
  const row = prep('SELECT MAX(ts) AS ts FROM event_log WHERE session_id = ? AND kind = ?')
    .get(id, kind) as { ts: number | null };
  return row.ts ?? null;
}

// 原子领取到期 job（多 runner 防重领）：一条 `UPDATE...RETURNING` 把「本 runner 可领的到期 job」一次性占住并取回。
// 可领集 = 状态 ∈ states ∩（无主 / 租约过期 / 本就自己持有=续租）。**别的 runner 未过期的租约不在内 → 绝不重领**。
// 跨进程原子：sqlite 对 UPDATE 取写锁、语句级原子；控制面单进程时所有领取经同一连接、天然串行。
//
// **limit = 本 runner 本轮能并发开跑的容量（max_parallel）**，FIFO（created_at ASC）取最旧 limit 条。关键：**只领你
// 这一轮就会开跑的量**——绝不一次把整个 backlog 占租住（否则排队未开跑的 job 也从领取时刻倒 TTL，若批次被前面长
// step 拖过 TTL，会被另一 runner 当过期重领 → 同 worktree 双跑；且整个 backlog 被一个 runner 独占、多 runner 不分摊）。
// 多 runner 各领 ≤limit 条 → backlog 自然分摊；每条领后即本轮开跑（无排队）→ 租约窗 ≈ 单 step，TTL≥单 step 口径成立。
// ⚠️ **绝不写 updated_at**：租约是编排簿记、非业务状态变更——bump 会刷新 remindStuck 的 idle 判定（误判「刚动过」永不提醒）。
export async function leaseClaim(states: State[], runnerId: string, ttlMs: number, limit: number): Promise<Session[]> {
  if (states.length === 0 || limit < 1) return [];
  const now = Date.now();
  const placeholders = states.map(() => '?').join(',');
  // sqlite 的 UPDATE 不带 LIMIT（除非特编译）→ 用子查询先按 FIFO 选出至多 limit 个 id，再 UPDATE...RETURNING。
  return prep(
    `UPDATE session SET lease_owner = ?, lease_expires_at = ?
       WHERE id IN (
         SELECT id FROM session
           WHERE state IN (${placeholders})
             AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)
           ORDER BY created_at ASC
           LIMIT ?
       )
     RETURNING *`,
  ).all(runnerId, now + ttlMs, ...states, now, runnerId, limit) as unknown as Session[];
}

// ── localSqlite adapter ──
// 把上面的自由函数（本地 sqlite 直连实现）bundle 成 SessionStore，供选择点 store/index.ts 接线。
// 自由函数仍单独导出（迁移期既有 import 不破；迁完后核心只经 `store`，本模块即「localSqlite 实现」）。
// 这些函数无 `this`（纯 prep 调用），故按对象方法引用/解构均安全。
export const localSqliteStore: SessionStore = {
  create,
  findByIssueRef,
  isDuplicateTokenError,
  isDuplicateIssueRefError,
  get,
  getBySlug,
  findByPrdUrl,
  findByDocToken,
  resolve,
  listByStates,
  listAll,
  distinctProjects,
  countByState,
  countByStates,
  patch,
  transition,
  appendEvent,
  events,
  lastEventTs,
  leaseClaim,
};
