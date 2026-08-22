// 状态层薄缝——**SessionStore**：核心与具体存储后端（本地 sqlite / 未来控制面 HTTP）之间的唯一接口。
// 照 MessagingPort 范式：接口（本文件）+ 单一选择点（store/index.ts `store`）+ adapter（localSqlite=sessions.ts）。
// 核心永不直接 import store/sessions.ts；只 `import { store } from './store/index.ts'`，要换后端在选择点一处换。
//
// 当前唯一实现是本地 sqlite（store/sessions.ts 的 `localSqliteStore`）。控制/Runner 分离后会有 `remoteApi`
// 实现（runner 经 HTTP 读写控制面状态）。
//
// **异步契约（Phase 2 深水）**：IO 方法（读写/查询/事件）返回 Promise——为 remoteApi（HTTP 天然异步）就绪。
// localSqlite 底层 node:sqlite 同步，包成 async（无副作用、语义不变）；消费方一律 `await store.*`。
// 例外：`isDuplicate*Error` 是**纯谓词**（分类一个 error 对象，无 IO）→ 保持同步（remoteApi 分类 HTTP 409 同样无 IO）。
// 注：Phase 1 曾以**同步**接口先立接缝（行为零变更）；本阶段兑现 async 化（见 docs/architecture-control-plane-split.md Phase 2）。
import type { Session } from '../types.ts';
import type { State } from '../statemachine/states.ts';

// create() 入参：建一条 session 的最小必填 + 可选初始字段（其余字段建后经 patch/transition 落）。
export interface NewSession {
  id: string;
  slug: string;
  title: string;
  project_id?: string; // 目标项目 id（缺省 'demo'，迁移期/旧测试免传）
  branch: string;
  state?: State; // 起始态（缺省 INTAKE；standalone 裸 issue 直起 GATE_C_REQUESTED）
  prd_url?: string | null;
  prd_text_path?: string | null;
  chat_id?: string | null;
  doc_ref?: string | null; // '<source>:<token>'
  poster_id?: string | null;
  intake_msg_id?: string | null;
  source_kind?: string | null; // 'prd' | 'issue'
  issue_ref?: string | null; // standalone 去重键
}

export interface EventRow {
  ts: number;
  kind: string;
  detail: string | null;
}

// 会话状态读写面（get/create/patch/transition/event/聚合查询）。localSqlite 是现状实现，远端 HTTP 是将来。
export interface SessionStore {
  // ── 建 / 去重 ──
  create(s: NewSession): Promise<Session>;
  findByIssueRef(ref: string): Promise<Session | null>; // standalone 实现任务去重键
  isDuplicateDocRefError(e: unknown): boolean; // create 撞 doc_ref 唯一索引（并发竞态）→ 回退去重【纯谓词·同步】
  isDuplicateIssueRefError(e: unknown): boolean; // create 撞 issue_ref 唯一索引（并发竞态）→ 回退去重【纯谓词·同步】

  // ── 读 ──
  get(id: string): Promise<Session | null>;
  getBySlug(slug: string): Promise<Session | null>;
  findByPrdUrl(url: string): Promise<Session | null>;
  findByDocRef(ref: string): Promise<Session | null>; // PRD 级去重真源（'<source>:<token>'，URL 各变体已归一）
  resolve(idOrSlug: string): Promise<Session | null>; // CLI 用 id 或 slug 操作

  // ── 列表 / 聚合 ──
  listByStates(states: State[]): Promise<Session[]>;
  // 全量列表。projectId 给定 → 仅该项目（查询隔离）；缺省 → 全库（**红线**：daemon 全局动作绝不传 projectId）。
  listAll(projectId?: string): Promise<Session[]>;
  distinctProjects(): Promise<string[]>; // 库内出现过的项目 id（面板/CLI 过滤下拉）
  countByState(): Promise<Record<string, number>>;
  countByStates(states: State[]): Promise<number>;

  // ── 写 / 状态机 ──
  patch(id: string, fields: Partial<Session>): Promise<Session>;
  transition(id: string, to: State, fields?: Partial<Session>): Promise<Session>; // 非法转移抛错（状态机守门）

  // ── 事件日志 ──
  appendEvent(id: string, kind: string, detail?: unknown): Promise<void>;
  events(id: string): Promise<EventRow[]>;
  lastEventTs(id: string, kind: string): Promise<number | null>; // 某类事件最近一次时刻（去抖/对账），无则 null

  // ── 租约（多 runner 防重领）──
  // 原子领取：状态 ∈ states ∩（无主/过期/自持）的到期 job，FIFO 取至多 limit 条、占租 ttlMs 后返回。
  // limit = 本 runner 本轮并发容量（绝不一次占租整个 backlog——见 sessions.ts leaseClaim 说明）。别 runner 未过期的租约不在内。
  leaseClaim(states: State[], runnerId: string, ttlMs: number, limit: number): Promise<Session[]>;
}
