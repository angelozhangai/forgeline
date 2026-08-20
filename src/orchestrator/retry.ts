// 节点失败的「瞬时 vs 永久」分类 + 退避调度 + 重试目标态规划。
// 瞬时(超时/限流/网络/git fetch 抖)→ 自动退避重试，耗尽转死信；永久(解析/契约/权限/配置)→ 立即停泊等人。
// 纯函数为主便于单测：worker 据此排程，actions.retry 复用 planRetry（手动/自动同口径）。

import { loadConfig } from '../config.ts';
import type { Session } from '../types.ts';
import type { State } from '../statemachine/states.ts';

export type FailureClass = 'transient' | 'permanent';

// 瞬时信号：基础设施抖动，重试大概率自愈。其余一律按**永久**（默认安全——永久只是多等一次人工 retry，
// 而误判永久为瞬时会反复烧 token + 死循环）。匹配 claude/codex/git 实际错误串与常见网络/限流码。
// 含 claude/codex CLI 把 API 层错误塞进 stream-json result 的实际措辞：
// "API Error: The socket connection was closed unexpectedly." → socket connection / closed unexpectedly / connection was closed 三重命中。
const TRANSIENT_RE =
  /超时|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|socket connection|closed unexpectedly|fetch failed|connection error|\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|fetch 失败|EPIPE|EAGAIN|EBUSY|temporarily unavailable|connection (?:was )?(?:reset|refused|closed|timed out)/i;

export function classifyError(err: unknown): FailureClass {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_RE.test(msg) ? 'transient' : 'permanent';
}

// 退避：30s / 2min / 5min（指数 + 封顶），attempt 从 1 起。jitter ±20% 防多 session 雷同重试同时砸限流墙。
const BACKOFF_MS = [30_000, 120_000, 300_000];
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1) - 1, BACKOFF_MS.length - 1)];
  const jitter = base * 0.2 * (rand * 2 - 1); // ±20%
  return Math.round(base + jitter);
}

export function maxAutoRetries(): number {
  return loadConfig().runtime.retry?.max_auto_retries ?? 3;
}
export function maxReclaims(): number {
  return loadConfig().runtime.retry?.max_reclaims ?? 3;
}

// 重试目标态：把停泊态翻回可重跑态（与 forge retry 同口径，自动重试与手动 retry 复用）。
// 返回 null = 该态无自动重试路径（如 WRITE_FAILED 须人工 go，不自动建 issue）。
// fields 仅含状态相关复位，不含 retry 簿记（retry_count/dead_letter 由调用方按自动/手动各自决定是否清）。
export function planRetry(s: Session): { to: State; fields: Partial<Session> } | null {
  if (s.state === 'GATE_A_FAILED') {
    // 对抗复审中途失败 → 原地复位续跑对抗（不丢评审定稿+轮次+codex 线，不退回 INTAKE 重打扰 PM）。
    // 进对抗即落 gate_a_adv_round=0 标记（worker.afterGateA），故 `!= null` 能覆盖「首轮 codex 调用就失败、
    // 尚未计轮/起 codex 线」的窗口——这正是漏判会退回 INTAKE 的洞。
    if (s.gate_a_adv_round != null || s.gate_a_reviewer_session) {
      return { to: 'GATE_A_ADVERSARIAL', fields: { error: null } };
    }
    // 复评失败（仍挂 pending_input）→ 回复评点不丢已累计轮次；首轮失败 → 回 INTAKE 全量重跑。
    const to: State = s.gate_a_pending_input ? 'GATE_A_REVISION_REQUESTED' : 'INTAKE';
    return { to, fields: { error: null } };
  }
  if (s.state === 'GATE_B_FAILED') {
    const hasDraft = !!s.gate_b_draft_path && (s.gate_b_round ?? 0) > 0;
    if (hasDraft) {
      // 有初稿+已起轮 → 原地复位续跑对抗（不丢轮次+会话）。
      const to: State = s.gate_b_pending_input ? 'GATE_B_REVISION_REQUESTED' : 'ADVERSARIAL_LOOP';
      return { to, fields: { error: null } };
    }
    // 无初稿/未起轮 → 干净重跑：清旧对抗会话/轮次/残留/升级问题（避免旧 codex 线续接到新初稿）。
    return {
      to: 'GATE_B_REQUESTED',
      fields: {
        error: null,
        gate_b_reviewer_session: null,
        gate_b_fixer_session: null,
        gate_b_round: null,
        gate_b_pending_input: null,
        gate_b_human_asks: null,
        adversarial_residual: null,
      },
    };
  }
  if (s.state === 'GATE_C_FAILED') {
    // worktree 已建 → 原地复位续跑实现循环（不丢轮次/会话；绝不重 setup 撞已存在的 worktree）。
    if (s.worktree_path) {
      const to: State = s.gate_c_pending_input ? 'GATE_C_REVISION_REQUESTED' : 'GATE_C_LOOP';
      return { to, fields: { error: null } };
    }
    // 未建树/setup 失败 → 干净重跑 setup（清可能的半残会话/轮次）。
    return {
      to: 'GATE_C_REQUESTED',
      fields: { error: null, gate_c_fixer_session: null, gate_c_round: null, gate_c_pending_input: null, gate_c_human_asks: null, gate_c_residual: null },
    };
  }
  if (s.state === 'GATE_D_FAILED') {
    // 回滚毒丸优先级最高：未确认复位的 worktree 必须先经 runGateDLoop 入口的 recoverPendingRollback 强制复位确认，
    // 绝不让它绕到 HARDENING（那里不跑 rollback recovery）。正常路径毒丸与 harden_round 不共存，这是对「异常/旧数据
    // 让二者并存」的防御兜底（Codex M4 二审 SF）。回 LOOP/续修点即过 recover 守门。
    if (s.gate_d_rollback_to) {
      const to: State = s.gate_d_pending_input ? 'GATE_D_REVISION_REQUESTED' : 'GATE_D_LOOP';
      return { to, fields: { error: null } };
    }
    // 已进测试补强阶段（harden_round>0）→ 回 GATE_D_HARDENING 续补，绝不回 LOOP 白烧一轮 codex
    // （补强自身幂等重入：进 HARDENING 先 reset 到 pin 的 gate_d_green_sha 不可变绿态基线）。
    if ((s.gate_d_harden_round ?? 0) > 0) {
      return { to: 'GATE_D_HARDENING', fields: { error: null } };
    }
    // PR 已开 → 原地复位续跑 PR 对抗循环（不丢轮次/双侧会话；pending 则回续修点）。
    if (s.pr_url) {
      const to: State = s.gate_d_pending_input ? 'GATE_D_REVISION_REQUESTED' : 'GATE_D_LOOP';
      return { to, fields: { error: null } };
    }
    // 开 PR 失败/未开 → 回 GATE_D_REQUESTED 重开（forge-create-pr.sh 幂等，不会重复建）。
    return { to: 'GATE_D_REQUESTED', fields: { error: null } };
  }
  return null;
}
