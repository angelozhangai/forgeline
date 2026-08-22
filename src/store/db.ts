import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, STATE_DIR } from '../root.ts';

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(STATE_DIR, { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL;');
  // 写并发兜底：daemon 单写 + 只读备份连接 + 状态页读 并发时，checkpoint 撞写会抛瞬时 SQLITE_BUSY。
  // 让 sqlite 在锁上自旋等到 5s 再报错，吞掉这类瞬态（绝大多数锁窗口是毫秒级）。
  d.exec('PRAGMA busy_timeout = 5000;');
  const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  // schema.sql 是**当前**基线，不是历史起点：新库建出来就已经是最新形状，不该再被历史迁移改一遍
  //（v1 的 RENAME COLUMN 在新库上会直接抛——列早就叫新名字了）。所以先探「这库是不是全新的」，
  // 建完基线再把 user_version 一次性推到最新，让迁移只服务于**存量**老库。
  const fresh = (d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='session'").get() as { n: number }).n === 0;
  d.exec(readFileSync(schemaPath, 'utf8'));
  // 轻量迁移:给已存在的旧库补新增列(CREATE TABLE IF NOT EXISTS 不会改已存在表)
  for (const col of [
    "project_id TEXT NOT NULL DEFAULT 'demo'", // 多项目：旧库存量行回填默认项目
    'adversarial_residual TEXT',
    'ref_num INTEGER',
    'poster_open_id TEXT', // pre-versioning 老库补列；v1 迁移随后把它改名成 poster_id
    'intake_msg_id TEXT',
    'status_msg_id TEXT',
    'size TEXT',
    'size_reason TEXT',
    'size_source TEXT',
    'prd_score INTEGER',
    'prd_score_dims TEXT',
    'prd_score_reason TEXT',
    'gate_a_round INTEGER',
    'gate_a_pending_input TEXT',
    'gate_a_residual TEXT',
    'gate_a_reviewer_session TEXT',
    'gate_a_fixer_session TEXT',
    'gate_a_adv_round INTEGER',
    'gate_a_fix_fail_streak INTEGER',
    'gate_b_reviewer_session TEXT',
    'gate_b_fixer_session TEXT',
    'gate_b_round INTEGER',
    'gate_b_fix_fail_streak INTEGER',
    'gate_b_pending_input TEXT',
    'gate_b_human_asks TEXT',
    'gate_b_reviewer_tokens TEXT',
    // 下游闸C
    'gate_c_requested_by TEXT',
    'gate_c_draft_path TEXT',
    'gate_c_round INTEGER',
    'gate_c_fix_fail_streak INTEGER',
    'gate_c_pending_input TEXT',
    'gate_c_human_asks TEXT',
    'gate_c_fixer_session TEXT',
    'gate_c_residual TEXT',
    'gate_c_cost_usd REAL',
    // 下游闸D
    'gate_d_requested_by TEXT',
    'gate_d_draft_path TEXT',
    'gate_d_round INTEGER',
    'gate_d_fix_fail_streak INTEGER',
    'gate_d_pending_input TEXT',
    'gate_d_human_asks TEXT',
    'gate_d_reviewer_session TEXT',
    'gate_d_fixer_session TEXT',
    'gate_d_reviewer_tokens TEXT',
    'gate_d_residual TEXT',
    'gate_d_cost_usd REAL',
    'gate_d_rollback_to TEXT', // 闸D 回滚失败毒丸：须复位到的绿 HEAD sha（置位⟺worktree 未确认态）
    'gate_d_harden_round INTEGER', // 测试补强已起轮次（>0 ⟺ 已进 GATE_D_HARDENING；planRetry 据此回 HARDENING）
    'gate_d_green_sha TEXT', // 闸D LGTM pin 的绿态 HEAD sha（补强基线，不可变；绝不用移动 ref）
    'gate_d_harden_verified_sha TEXT', // 补强后 CI 绿的 HEAD sha（幂等 fast-path 守门）
    // worktree / PR / 合并
    'target_repos TEXT', // json string[]：实现落哪些代码仓（多仓就绪；缺→回退 proj.repos[0]）
    'legs TEXT', // json Leg[]：每仓一腿（worktree/分支/CI/PR/闸D 全字段，见 src/gates/legs.ts）
    'worktree_path TEXT',
    'impl_branch TEXT',
    'base_shas TEXT',
    'pr_url TEXT',
    'pr_number INTEGER',
    'merge_readiness_path TEXT',
    'merged_by TEXT',
    'merged_at INTEGER',
    // standalone 入口 + 多租户预留
    'source_kind TEXT',
    'issue_ref TEXT',
    'tenant_id TEXT',
    'retry_count INTEGER',
    'next_retry_at INTEGER',
    'reclaim_count INTEGER',
    'dead_letter INTEGER',
    'assignee TEXT',
    'assignee_source TEXT',
    'assigned_by TEXT',
    'assigned_at INTEGER',
    'assign_snapshot TEXT',
    'lease_owner TEXT', // 多 runner 防重领：租约持有者 runner id
    'lease_expires_at INTEGER', // 租约到期时刻(ms)
  ]) {
    try {
      d.exec(`ALTER TABLE session ADD COLUMN ${col};`);
    } catch {
      /* 列已存在 → 忽略 */
    }
  }
  if (fresh) {
    // 全新库 = 已经是最新基线 → 直接盖到最新版本，跳过所有历史迁移（它们只适用于存量老库）。
    d.exec(`PRAGMA user_version = ${latestMigrationVersion(MIGRATIONS)};`);
  }
  applyMigrations(d, MIGRATIONS); // 基线对齐后，跑版本化（user_version）的非增量迁移
  ensurePartialUniqueIndexes(d); // 唯一索引在迁移**之后**建：列名/取值都已是最终形态
  _db = d;
  return d;
}

// 两条「并发竞态最后一道闸」的部分唯一索引。**必须放在 applyMigrations 之后**：v1 才把列改成
// doc_ref，之前建索引一定失败；而放进 v1 的 SQL 里更糟——旧库若有存量重复值，建索引失败会让整条
// 迁移回滚，服务直接起不来（test/store-legacy-duplicates.test.ts 守的正是这条）。
// 故：各自 try/catch 吞掉，去重仍由 findByDocRef / findByIssueRef 逻辑层兜；人工清理重复后下次启动自动建上。
function ensurePartialUniqueIndexes(d: DatabaseSync): void {
  // PRD 级去重：同一 doc_ref 并发插入只能成一条（部分索引——手动 add 无 ref 的不约束）。
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_doc_ref ON session(doc_ref) WHERE doc_ref IS NOT NULL;');
  } catch {
    /* 旧库存量重复 doc_ref → 暂不建唯一索引，待人工清理 */
  }
  // standalone 裸 issue 去重：同一 issue_ref 并发插入只能成一条。
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_issue_ref ON session(issue_ref) WHERE issue_ref IS NOT NULL;');
  } catch {
    /* 旧库存量重复 issue_ref → 暂不建唯一索引，待人工清理 */
  }
}

// ── 版本化迁移（user_version，forward-only）──
// schema.sql 建新库基线；上面的「补列」块把 pre-versioning 时代的老库幂等对齐到当前基线（只加列）。
// 此后所有**非增量**演进（改列名/数据回填/删表/重建索引）一律登记到 MIGRATIONS：按 user_version 单调
// 前进、逐条独立事务、失败即回滚并停在上一个好版本（forward-only，绝不自动回退）。
// 加一条 = 往 MIGRATIONS 末尾追加 { v: <上一个+1>, sql }；v 必须单调递增且唯一（有测试守护）。
export interface Migration {
  v: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  // v1（Phase 1，可插拔文档源）：session 上三个带「飞书」字样的列改成 provider 无关的名字，
  // 并把 doc token 升级成**带源前缀的 ref**。一条迁移一并做完，因为它们改的是同一张表、同一批调用点，
  // 拆成两次意味着两次迁移 + 两次全仓扫引用，而收尾用的纯清洁阶段通常永远不会来。
  //
  // 为什么 token 要带前缀：裸 token 做唯一索引，迟早有两个源给出同一个字符串，
  // 于是两份毫不相干的需求被判成重复（PRD 级去重是红线）。存量数据全部来自飞书 → 无条件加 'feishu:'；
  // 本迁移由 user_version 保证**只跑一次**，不会重复加前缀。
  {
    v: 1,
    sql: `
      ALTER TABLE session RENAME COLUMN feishu_doc_token TO doc_ref;
      ALTER TABLE session RENAME COLUMN feishu_chat_id TO chat_id;
      ALTER TABLE session RENAME COLUMN poster_open_id TO poster_id;
      UPDATE session SET doc_ref = 'feishu:' || doc_ref WHERE doc_ref IS NOT NULL;
      DROP INDEX IF EXISTS idx_session_doc_token;
    `, // 新唯一索引由 ensurePartialUniqueIndexes 在迁移后建——放这里会让存量重复值把整条迁移拖崩
  },
];

// MIGRATIONS 里最大的 v（空表 → 0）。新库建完基线后直接盖这个版本号，跳过历史迁移。
export function latestMigrationVersion(migrations: Migration[]): number {
  return migrations.reduce((m, x) => (x.v > m ? x.v : m), 0);
}

// 应用所有 v > 当前 user_version 的迁移（升序、各自事务、逐条 bump user_version）。返回应用后的版本。
// 纯函数式（不碰模块级 _db），可对任意 DatabaseSync 单测。
export function applyMigrations(d: DatabaseSync, migrations: Migration[]): number {
  let cur = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const m of [...migrations].sort((a, b) => a.v - b.v)) {
    if (m.v <= cur) continue;
    d.exec('BEGIN');
    try {
      d.exec(m.sql);
      d.exec(`PRAGMA user_version = ${m.v};`); // PRAGMA 不吃占位符；v 是代码内单调整数，非外部输入
      d.exec('COMMIT');
      cur = m.v;
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`schema 迁移 v${m.v} 失败（已回滚，库停在 v${cur}）：${String(e).slice(0, 200)}`);
    }
  }
  return cur;
}

// Prepared statement 缓存：node:sqlite 的 prepare() 每次都重新编译 SQL，热查询（sessions.get 等每步
// 调十几次）重复编译纯浪费。按 SQL 文本缓存编译结果、跨调用复用。绑定当前 db 实例——万一连接被重建
// （理论上不会，_db 仅初始化一次），自动清缓存重建，绝不复用旧连接的句柄。
// 动态 SQL（patch 按列集、listByStates 按占位符数）也按完整 SQL 文本缓存，同形状自然命中。
let _stmtDb: DatabaseSync | null = null;
const _stmts = new Map<string, StatementSync>();

export function prep(sql: string): StatementSync {
  const d = db();
  if (_stmtDb !== d) {
    _stmts.clear();
    _stmtDb = d;
  }
  let st = _stmts.get(sql);
  if (!st) {
    st = d.prepare(sql);
    _stmts.set(sql, st);
  }
  return st;
}
