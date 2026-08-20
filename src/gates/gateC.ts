// 闸C 初始化 + 产物持久化 + 实现上下文拼装。
// setup：fetch 取 origin/<branch> 新 baseSha（只读真源）→ 委托脚本建隔离 worktree（pin 到 baseSha）→ 落初始信封。
// worktree 是改码/CI/PR 的隔离地，主 checkout 不被污染（故 setup 不读主 checkout 工作文件、无需 anchorCheck）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sessionLogDir } from '../util/render.ts';
import { projectForSession } from '../projects.ts';
import { refresh, assertFresh } from './repoFreshness.ts';
import { loadConfig } from '../config.ts';
import { createWorktree, removeWorktree, listWorktrees, deleteBranch, defaultWorktreePath, ensureWorktreeExcluded } from '../util/worktree.ts';
import { targetReposOf } from '../util/targetRepos.ts';
import { mkLeg, getLegs, setLegs, type Leg } from './legs.ts';
import { ImplEnvelopeSchema, GateBSchema } from './envelopes.ts';
import type { ImplEnvelope } from './envelopes.ts';
import { acceptanceMarkdown } from '../util/acceptance.ts';
import { slugify } from '../util/slug.ts';
import { store } from '../store/index.ts';
const { patch, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import type { Session } from '../types.ts';

export function gateCPaths(id: string): { draft: string; input: string } {
  const dir = sessionLogDir(id);
  return { draft: resolve(dir, 'gate-c.json'), input: resolve(dir, 'gatec-input.md') };
}


export async function persistGateC(s: Session, env: ImplEnvelope): Promise<void> {
  const { draft } = gateCPaths(s.id);
  mkdirSync(sessionLogDir(s.id), { recursive: true });
  writeFileSync(draft, JSON.stringify(env, null, 2));
  await patch(s.id, { gate_c_draft_path: draft });
}

// 缺失/坏 → 抛（worker 停泊 GATE_C_FAILED）。绝不静默喂空壳。
export function readImplEnvelope(s: Session): ImplEnvelope {
  if (!s.gate_c_draft_path || !existsSync(s.gate_c_draft_path)) throw new Error('缺 gate-c 信封（实现状态丢失）');
  return ImplEnvelopeSchema.parse(JSON.parse(readFileSync(s.gate_c_draft_path, 'utf8')));
}

// 实现上下文（喂 claude 的「要做什么」）：
// - 链式（source_kind=prd）：闸B 技术方案 markdown + 外环验收契约（Done 定义）。
// - standalone（source_kind=issue）：建任务时落盘的 issue 正文（gatec-input.md）。
export function gateCContext(s: Session): string {
  // 链式优先读闸B 草稿（含 acceptance 外环契约——闸C 的确定性目标）。
  if (s.gate_b_draft_path && existsSync(s.gate_b_draft_path)) {
    try {
      const env = GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8')));
      const accept = acceptanceMarkdown(env.acceptance);
      return [
        '## Tech design (gate B final)',
        env.tech_design_markdown || env.summary || '(empty)',
        accept ? `## Outer-loop acceptance contract (definition of Done — the implementation must flip these from red to green)\n${accept}` : '',
      ].filter(Boolean).join('\n\n');
    } catch {
      /* 落空走下面的 input 兜底 */
    }
  }
  const { input } = gateCPaths(s.id);
  if (existsSync(input)) return readFileSync(input, 'utf8');
  return '(no tech design / issue context — implement from the session title and the existing code; escalate anything uncertain via needs_human)';
}

// 隔离工作树 + 实现分支的**稳定唯一身份**：必须用 session.id（= <slug>-<shortId>，PK 唯一、且自带可读 slug 前缀），
// 绝不能用 s.slug——slug 非唯一（schema 无 UNIQUE，同标题→同 slug）。用 slug 时 setup 幂等前清会按同一确定性路径
// 误删另一条同 slug **活** session 的 worktree + forge/<slug> 分支，毁掉「被对抗的产物是 worktree 状态」的隔离性（Codex B1）。
// 用 id 后路径 session-私有：前清只可能命中本 session 自己的崩溃孤儿，无需再扫他 session 引用。导出供单测锁此不变量。
export function implIdentity(repoDir: string, id: string): { worktreePath: string; implBranch: string } {
  // git-ref/path 安全 + 有界 + **唯一**，且对同一 id 恒等（前清/重跑能复现同一路径）。
  // 关键：绝不能对整 id 用带 .slice(40) 的 slugify 当 key——长 slug 会切掉尾部 shortId，
  // 而 shortId=Date.now()+随机，近同时建的同 slug session 仅尾部不同 → 截断后撞 key → 前清误删活 worktree（Codex 四审 B）。
  // 故 key = 可读前缀(slugify 截 24，仅展示) + 全 id 短哈希(10 hex，保唯一，与截断/shortId 存活无关)。
  const prefix = slugify(id).slice(0, 24).replace(/-+$/, '') || 'impl';
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 10);
  const key = `${prefix}-${hash}`;
  return { worktreePath: defaultWorktreePath(repoDir, key), implBranch: `forge/${key}` };
}

// 建一个仓的隔离 worktree（幂等前清 + 委托建树 + pin 到不可变 base sha）。失败抛 → 调用方停泊 GATE_C_FAILED。
async function createLegWorktree(s: Session, proj: ReturnType<typeof projectForSession>, repo: string, baseSha: string, timeoutMs: number): Promise<Leg> {
  const repoDir = proj.repoPath(repo);
  ensureWorktreeExcluded(repoDir); // 把 .forge/ 写进该仓本地 .git/info/exclude（不入库、不动产品仓 .gitignore）
  if (!baseSha) throw new Error(`refresh 未返回 ${repo} 的 base sha——无法 pin 工作树基线（拒绝对移动 ref / 错仓基线建树）`);
  // 身份按 s.id 派生（唯一）——绝不用 s.slug（非唯一→前清误删他 session 活 worktree，Codex B1）。不同仓 repoDir 不同 → 路径天然各异。
  const { worktreePath, implBranch } = implIdentity(repoDir, s.id);
  const addScript = proj.scripts.worktree_add ? resolve(proj.root, proj.scripts.worktree_add) : undefined;
  const removeScript = proj.scripts.worktree_remove ? resolve(proj.root, proj.scripts.worktree_remove) : undefined;
  // 幂等前清：确定性路径已存在 = 上轮在「create 成功」与落库间崩溃的物理孤儿（树停在 base 无改动，删之无损）。
  if (existsSync(worktreePath) || listWorktrees(repoDir).includes(worktreePath)) {
    const rm = await removeWorktree({ repoDir, path: worktreePath, removeScript });
    deleteBranch(repoDir, implBranch);
    await appendEvent(s.id, 'gatec_worktree_orphan_cleaned', { repo, worktreePath, ok: rm.ok, output: rm.output.slice(0, 160) });
  }
  const r = await createWorktree({
    repoDir,
    path: worktreePath,
    branch: implBranch,
    baseCommitish: baseSha, // pin 到不可变 sha，不用移动 ref（并发 fetch 会让基线漂离 base_sha，Codex B1）
    addScript,
    timeoutMs,
  });
  if (!r.ok) throw new Error(`建 ${repo} worktree 失败：${r.output.slice(0, 300)}`);
  await appendEvent(s.id, 'gatec_worktree_ready', { repo, worktreePath, baseSha: baseSha.slice(0, 12), branch: implBranch });
  return mkLeg(repo, { worktree_path: worktreePath, impl_branch: implBranch, base_sha: baseSha });
}

// 把 session「完整指向」某条 leg：实现⇄CI / PR 对抗循环都复用既有单 worktree 机制跑 s.worktree_path（=该 leg）；
// 切 leg 时重置**闸C 与闸D 全套循环态** + 设该 leg 的 pr_url/pr_number、写该 leg 的 gate-c.json 信封。这是顺序驱动
// 对闸C/闸D 都成立的原语——同一刻只一条活跃 leg，循环态留 session 级即可（绝不并发两条 leg）。切 leg 不清残留会把
// 上条 leg 的轮次/双侧会话/绿态/补强 pin 带歪下条 leg 的审与补强，故 gate_d_* 一并归零（闸C 阶段它们本就 null=no-op）。
export async function activateLeg(s: Session, leg: Leg): Promise<void> {
  await patch(s.id, {
    worktree_path: leg.worktree_path,
    impl_branch: leg.impl_branch,
    base_shas: JSON.stringify(leg.base_sha ? { [leg.repo]: leg.base_sha } : {}),
    pr_url: leg.pr_url, // 闸C 阶段 leg 未开 PR=null；闸D 阶段重指 leg 时带上该 leg 的 PR（审/合并/通知都对齐该 leg）
    pr_number: leg.pr_number,
    gate_c_round: null,
    gate_c_fixer_session: null,
    gate_c_fix_fail_streak: null,
    gate_c_residual: null,
    gate_c_pending_input: null,
    gate_c_human_asks: null,
    gate_d_round: null,
    gate_d_reviewer_session: null,
    gate_d_fixer_session: null,
    gate_d_fix_fail_streak: null,
    gate_d_residual: null,
    gate_d_pending_input: null,
    gate_d_human_asks: null,
    gate_d_green_sha: null,
    gate_d_rollback_to: null,
    gate_d_harden_round: null,
    gate_d_harden_verified_sha: null,
    merge_readiness_path: null,
  });
  await persistGateC(s, {
    worktree_path: leg.worktree_path ?? '',
    impl_branch: leg.impl_branch ?? '',
    base_ref: `origin/${s.branch}`,
    base_sha: leg.base_sha ?? '',
    implemented: false,
    diff_stat: '',
    files_changed: [],
    ci_ok: false,
    ci_summary: '',
    last_summary: '',
  });
}

// 当前活跃 leg：优先按 worktree_path 命中（= session 正指向的）；否则取首条未绿 leg。无 legs → null。
export function activeLeg(s: Pick<Session, 'worktree_path' | 'legs'>): Leg | null {
  const legs = getLegs(s);
  if (!legs.length) return null;
  return legs.find((l) => l.worktree_path && l.worktree_path === s.worktree_path) ?? legs.find((l) => !l.ci_ok) ?? null;
}

// setup：为**每个目标仓**建隔离工作树（每仓一腿）→ 指向 primary 进实现⇄CI。失败抛 → worker 停泊 GATE_C_FAILED。
export async function runGateCSetup(s: Session): Promise<void> {
  const proj = projectForSession(s);
  const rt = loadConfig().runtime;
  if (!proj.scripts.ci) throw new Error('目标项目未配置 scripts.ci——下游 CI 必须委托项目脚本（绝不在 forge 重造/裸 nx）');
  if (!proj.scripts.worktree_add) throw new Error('目标项目未配置 scripts.worktree_add（your-monorepo 必走 tools/scripts/wt.sh）');

  const targets = targetReposOf(s, proj.repos); // 链式取闸A repos_touched∩proj.repos、standalone 取 --repo；空回退首仓
  if (!targets.length) throw new Error('闸C setup 无目标仓（target_repos 与 proj.repos 均空）——无法建树');
  // fetch 取 origin/<branch> 最新 sha（绝不对陈旧 sha 起步；失败→assertFresh 抛，归类瞬时退避重试）。一次 refresh 覆盖全仓。
  const fresh = await refresh(s.branch, proj);
  assertFresh(fresh);

  const timeoutMs = (rt.gate_c?.ci_timeout_sec ?? 1800) * 1000;
  const legs: Leg[] = [];
  for (const repo of targets) {
    // 精确读本 repo 的 sha——绝不回退 fresh.shas['.']：named repo 缺 key 时静默拿错仓 sha 会对错基线建树（Codex SF）。
    legs.push(await createLegWorktree(s, proj, repo, fresh.shas[repo] ?? '', timeoutMs));
  }
  await setLegs(s, legs);
  await activateLeg(s, legs[0]); // 指向 primary leg（顺序驱动：绿一条切下一条，全绿才进 AWAITING_GATE_D，见 worker.afterGateC）
}
