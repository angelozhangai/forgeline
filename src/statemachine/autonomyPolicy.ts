// 渐进自治策略（纯函数，无副作用，导出供单测）：把「停泊在纯授权停泊点」的 session，按自治等级映射到该自动触发的动作。
//
// 「纯授权停泊点」= 人点一下就过、**不需要人提供任何信息/判断**的闸（人只是授权前进）。只有这 4 个可自动：
//   CONFIRMED       → requestGateB    （出技术方案；内部可逆、无外向写）           L≥1
//   AWAITING_GO     → go              （立项：建 issue + 发方案；外向写 + 付费承诺）  L≥2 ⚠
//   DONE            → requestGateC    （起实现；本地 worktree + CI）                L≥3
//   AWAITING_GATE_D → requestReviewPr （开 PR；外向但可审）                         L≥4 ⚠
//
// **永不自动**（不在表中 = autoActionFor 恒返回 null，这是红线在策略层的落地）：
//   · AWAITING_HUMAN_MERGE —— 红线#1「永不自动 merge」，即便顶格自治也只人工 ackMerged。
//   · 一切 *_STALLED / *_INPUT —— 主观分歧/需人答复，自治只管「授权前进」不替人做判断。
//   · GATE_C_STALLED —— 红线#2「确定性闸永不可跳」，CI 没绿连人都只能再修。
//   · 各 *_FAILED / GO_DENIED / WRITE_FAILED —— 失败态需人介入。
//
// 阶梯是流水线序、单调（minLevel 随管线递增）：Lk 自动触发前 k 个授权点。auto-go 由 worker 以「不带 --force」调用——
// 接受度 lint / 指派不过时动作自身返回 !ok，session 老实留在原停泊点等人（确定性/政策闸仍是最后防线，自治绕不过）。
import type { State } from './states.ts';

export type AutoAction = 'requestGateB' | 'go' | 'requestGateC' | 'requestReviewPr';

const LADDER: Partial<Record<State, { action: AutoAction; minLevel: number }>> = {
  CONFIRMED: { action: 'requestGateB', minLevel: 1 },
  AWAITING_GO: { action: 'go', minLevel: 2 },
  DONE: { action: 'requestGateC', minLevel: 3 },
  AWAITING_GATE_D: { action: 'requestReviewPr', minLevel: 4 },
};

// 自治阶梯最高级（除 merge 全自动）。配置/校验/文档共用一个真源。
export const AUTONOMY_MAX_LEVEL = 4;

// 可被自治自动触发的停泊状态集合（worker 据此只查这几个状态、不扫全表）。
export const AUTONOMY_GATES: readonly State[] = Object.keys(LADDER) as State[];

// 给定状态 + 自治等级 → 该自动触发的动作；null = 不自动（非授权停泊点 / 等级不够）。纯函数。
export function autoActionFor(state: State, level: number): AutoAction | null {
  const step = LADDER[state];
  if (!step) return null;
  return level >= step.minLevel ? step.action : null;
}
