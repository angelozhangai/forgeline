// 多仓「每仓一腿」模型（Phase 2）：一条需求动 N 个仓 → N 条 leg，各自独立 worktree / 实现分支 / baseSha / CI /
// PR / 闸D 复审。顶层规则「worktree 归属具体仓」的运行期载体——每条 leg 锚一个具体仓，绝不再把多仓挤进 repos[0]。
//
// 存为 session.legs（json string[]，对齐本仓 base_shas/created_issues/residual 等既有 JSON 列惯例，非新表）。
// 单仓需求 = 恰 1 条 leg；下游闸C/闸D/merged 按 leg 迭代（2b/2c 接入；2a 只建模 + 闸C setup 落 legs，行为不变）。
import { store } from '../store/index.ts';
const { patch, get } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import type { Session } from '../types.ts';

export interface Leg {
  repo: string; // 仓 dir 名（该 leg 锚定的具体仓）
  // ── 闸C：隔离 worktree + 实现 + 本地 CI（2a 建树落这些；2b 驱动实现/CI）──
  worktree_path: string | null; // <repo>/.forge/worktrees/<key>；null=尚未建树（pending）
  impl_branch: string | null; // forge/<key>
  base_sha: string | null; // 建树锚定的 origin/<branch> 不可变 sha
  gate_c_round: number | null;
  gate_c_fixer_session: string | null; // claude 实现 session_id（续做 resume）
  gate_c_fix_fail_streak: number | null;
  gate_c_residual: string | null;
  ci_ok: boolean | null; // 该 leg 本地 CI 是否绿
  // ── 闸D：开 PR + codex 审 diff ⇄ claude 改 + 测试补强（2c 接入）──
  pr_url: string | null;
  pr_number: number | null;
  gate_d_round: number | null;
  gate_d_reviewer_session: string | null; // codex thread_id
  gate_d_fixer_session: string | null; // claude 改 worktree session_id
  gate_d_fix_fail_streak: number | null;
  gate_d_residual: string | null;
  gate_d_green_sha: string | null; // LGTM pin 的绿态 HEAD sha
  gate_d_rollback_to: string | null; // 回滚失败毒丸
  gate_d_harden_round: number | null;
  gate_d_harden_verified_sha: string | null;
  merge_readiness_path: string | null;
  merged: boolean | null; // 该 leg 的 PR 是否已人工合并并核验
}

// 新建一条 leg（仅锚仓名，其余字段空 = pending；建树/实现时再逐步填）。纯函数，导出供单测。
export function mkLeg(repo: string, fields: Partial<Leg> = {}): Leg {
  return {
    repo,
    worktree_path: null,
    impl_branch: null,
    base_sha: null,
    gate_c_round: null,
    gate_c_fixer_session: null,
    gate_c_fix_fail_streak: null,
    gate_c_residual: null,
    ci_ok: null,
    pr_url: null,
    pr_number: null,
    gate_d_round: null,
    gate_d_reviewer_session: null,
    gate_d_fixer_session: null,
    gate_d_fix_fail_streak: null,
    gate_d_residual: null,
    gate_d_green_sha: null,
    gate_d_rollback_to: null,
    gate_d_harden_round: null,
    gate_d_harden_verified_sha: null,
    merge_readiness_path: null,
    merged: null,
    ...fields,
  };
}

// 读 session.legs（坏/空 → []）。纯函数，导出供单测。
export function getLegs(s: Pick<Session, 'legs'>): Leg[] {
  if (!s.legs) return [];
  try {
    const arr = JSON.parse(s.legs);
    return Array.isArray(arr) ? (arr as Leg[]) : [];
  } catch {
    return [];
  }
}

// 按 target repos 建初始 legs（保序、首仓为 primary）。各 leg 的 worktree/分支用 builder 填（2a 只填 primary）。纯函数，导出供单测。
export function buildLegs(repos: readonly string[], builder: (repo: string, index: number) => Partial<Leg>): Leg[] {
  return repos.map((repo, i) => mkLeg(repo, builder(repo, i)));
}

// 落库 legs（整组替换）。
export async function setLegs(s: Pick<Session, 'id'>, legs: Leg[]): Promise<void> {
  await patch(s.id, { legs: JSON.stringify(legs) });
}

// 顺序驱动「下一步」决策（纯函数，导出供单测）：把当前活跃 leg 视作刚 CI 绿，返回下一条**未绿且已建树**的 leg repo；
// 无 → null（全绿 = 闸C 完成）。afterGateC 据此 activate 下一条 / 推进 AWAITING_GATE_D。绝不并发两条 leg。
export function planLegAdvance(legs: Leg[], activeRepo: string | null): { nextRepo: string | null } {
  const after = legs.map((l) => (l.repo === activeRepo ? { ...l, ci_ok: true } : l));
  return { nextRepo: after.find((l) => !l.ci_ok && l.worktree_path)?.repo ?? null };
}

// 闸D 顺序驱动「下一步」决策（纯函数，导出供单测）：把当前活跃 leg 视作刚补强完成（闸D 终态），返回下一条
// **已开 PR、已建树、尚未过闸D（无 harden 验证 sha）** 的 leg repo；无 → null（全部 leg 过闸D = 可进合并就绪）。
// 与 planLegAdvance 同形——闸C 以 ci_ok 标完成、闸D 以 gate_d_harden_verified_sha 标完成（补强 CI 绿才 pin）。绝不并发两条 leg。
export function planGateDAdvance(legs: Leg[], activeRepo: string | null): { nextRepo: string | null } {
  const after = legs.map((l) => (l.repo === activeRepo ? { ...l, gate_d_harden_verified_sha: l.gate_d_harden_verified_sha ?? 'done' } : l));
  return { nextRepo: after.find((l) => !l.gate_d_harden_verified_sha && l.pr_url && l.worktree_path)?.repo ?? null };
}

// 更新某一条 leg（按 repo 定位）并落库；repo 不存在则不变（不冒进新增）。
// ⚠️ 从 DB **重读** session.legs（按 id），绝不用入参 s 的旧 legs 快照——否则同一 s 连续 patch 多条 leg 会互相覆盖
// （openReviewPr 逐 leg 开 PR 即如此）。读最新→改一条→落库。
export async function patchLeg(s: Pick<Session, 'id'>, repo: string, fields: Partial<Leg>): Promise<Leg[]> {
  const cur = await get(s.id);
  const legs = getLegs(cur ?? { legs: null }).map((l) => (l.repo === repo ? { ...l, ...fields } : l));
  await setLegs(s, legs);
  return legs;
}
