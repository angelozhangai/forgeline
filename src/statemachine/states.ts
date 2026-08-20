// 每需求生命周期状态。erasable TS：用 const 数组 + union 类型，不用 enum。

export const STATES = [
  'INTAKE',
  'GATE_A_RUNNING',
  'AWAITING_PM_CONFIRM',
  'GATE_A_REVISION_REQUESTED', // PM 已答复，待同会话复评（闸A 多轮循环）
  'GATE_A_ADVERSARIAL', // 闸A codex审⇄claude改：claude 复评无开放问题后，再过一道对抗复审才确认（poller 驱动）
  'CONFIRMED',
  'GATE_B_REQUESTED',
  'GATE_B_RUNNING',
  'ADVERSARIAL_LOOP', // 闸B codex审⇄claude改 多轮循环态（poller 驱动；每-tick 上限到顶自转移续跑）
  'AWAITING_GATE_B_INPUT', // claude 改方升级 needs_human → 停泊等 M 答复（闸B 人在环）
  'GATE_B_REVISION_REQUESTED', // M 已答复，待同会话 resume 续修（对称 GATE_A_REVISION_REQUESTED）
  'AWAITING_GO',
  'WRITING',
  'DONE', // 上游终态：issue 已建（下游可从此触发闸C；漂移闭环亦锚此态）
  // ── 下游：闸C 实现 + 本地CI ──
  'GATE_C_REQUESTED', // forge implement / standalone 裸 issue intake 触发
  'GATE_C_RUNNING', // 建 worktree + 物化/校验验收红 + 起实现
  'GATE_C_LOOP', // 实现⇄CI 修复有界循环（poller 驱动；每-tick 上限自转移续跑）
  'AWAITING_GATE_C_INPUT', // claude 实现升级 needs_human → 等 M 答复
  'GATE_C_REVISION_REQUESTED', // M 答复后 resume 续做
  // ── 下游：闸D PR 对抗 review + 测试补强 + merge readiness ──
  'AWAITING_GATE_D', // 闸C 绿 → 等权限人触发开 PR + 闸D（默认人工，后续受自治策略控制）
  'GATE_D_REQUESTED', // 建 PR 后进对抗
  'GATE_D_LOOP', // codex 审 diff ⇄ claude 修（CI 夹在 fix 内；poller 驱动）
  'AWAITING_GATE_D_INPUT', // 改方升级 needs_human → 等 M 答复
  'GATE_D_REVISION_REQUESTED', // M 答复后 resume 续修
  'GATE_D_HARDENING', // LGTM 后补内环测试（杜绝镜像测试）+ 再跑 CI（poller 驱动）
  'AWAITING_HUMAN_MERGE', // 出 merge-readiness 报告，等人工合并（**永不自动 merge**）
  'SHIPPED', // 人工确认已合并（forge merged）→ 接漂移闭环
  // 停泊态
  'GATE_A_FAILED',
  'GATE_A_STALLED', // 闸A 多轮到上限仍未消解 → 停泊交 M 人工裁决
  'GATE_B_FAILED',
  'GATE_B_STALLED', // 闸B 对抗到上限仍未消解 → 停泊交 M 裁决（强制立项 / 再修一轮）
  'GATE_C_FAILED',
  'GATE_C_STALLED', // 闸C CI/验收到上限仍不绿 → 停泊交 M 裁决
  'GATE_D_FAILED',
  'GATE_D_STALLED', // 闸D 对抗到上限仍未消解 → 停泊交 M 裁决
  'GO_DENIED',
  'WRITE_FAILED',
] as const;

export type State = (typeof STATES)[number];

// 轮询驱动（无需人）即可自动推进的状态 → 下一步动作由 worker 执行。
// 注：GATE_B_REQUESTED 的 step 内部一气跑完 闸B + 对抗复审，直到 AWAITING_GO。
export const POLLER_DRIVEN: ReadonlySet<State> = new Set<State>([
  'INTAKE', // → 闸A → AWAITING_PM_CONFIRM
  'GATE_A_REVISION_REQUESTED', // → 闸A 复评（resume）→ AWAITING_PM_CONFIRM / GATE_A_ADVERSARIAL / GATE_A_STALLED
  'GATE_A_ADVERSARIAL', // → 跑 codex审⇄claude改 引擎 → CONFIRMED / GATE_A_STALLED（或 paused 自转移续跑）
  'GATE_B_REQUESTED', // → 闸B 初稿 → ADVERSARIAL_LOOP
  'ADVERSARIAL_LOOP', // → 跑 codex审⇄claude改 引擎 → AWAITING_GO / AWAITING_GATE_B_INPUT / GATE_B_STALLED（或 paused 自转移续跑）
  'GATE_B_REVISION_REQUESTED', // → M 答复后 resume 续修 → ADVERSARIAL_LOOP
  // 下游闸C
  'GATE_C_REQUESTED', // → 建 worktree + 起实现 → GATE_C_LOOP
  'GATE_C_LOOP', // → 实现⇄CI 循环 → AWAITING_GATE_D / AWAITING_GATE_C_INPUT / GATE_C_STALLED（或 paused 自转移续跑）
  'GATE_C_REVISION_REQUESTED', // → M 答复后 resume 续做 → GATE_C_LOOP
  // 下游闸D
  'GATE_D_REQUESTED', // → 建 PR → GATE_D_LOOP
  'GATE_D_LOOP', // → codex审diff⇄claude改 → GATE_D_HARDENING / AWAITING_GATE_D_INPUT / GATE_D_STALLED（或 paused 自转移续跑）
  'GATE_D_REVISION_REQUESTED', // → M 答复后 resume 续修 → GATE_D_LOOP
  'GATE_D_HARDENING', // → 补内环测试 + CI → AWAITING_HUMAN_MERGE
]);

// 等人的停顿点（worker 不碰）
export const HUMAN_GATES: ReadonlySet<State> = new Set<State>([
  'AWAITING_PM_CONFIRM',
  'GATE_A_STALLED', // 等 M 裁决（强制结束 / 给输入再跑一轮）
  'CONFIRMED', // 等有权限的人触发闸B
  'AWAITING_GATE_B_INPUT', // 等 M 答复 claude 改方的升级问题（needs_human）
  'GATE_B_STALLED', // 等 M 裁决（强制立项 / 再修一轮）
  'AWAITING_GO',
  // 下游
  'AWAITING_GATE_C_INPUT', // 等 M 答复闸C 实现的升级问题
  'GATE_C_STALLED', // 等 M 裁决（只能给输入再修一轮——CI 没绿不许跳去开 PR，红线#3）
  'AWAITING_GATE_D', // 等有权限的人触发开 PR + 闸D
  'AWAITING_GATE_D_INPUT', // 等 M 答复闸D 改方的升级问题
  'GATE_D_STALLED', // 等 M 裁决（强制前进 / 再修一轮）
  'AWAITING_HUMAN_MERGE', // 等人工合并 PR（永不自动）
]);

// 「正在跑 gate」的活跃态：claude/codex 子进程在飞。看门狗据此「有 gate 在跑则暂缓强杀」，
// 心跳/状态页据此显示活跃 gate 数。注：子进程是 async spawn，不堵 event loop（见 util/proc.ts:run）。
export const ACTIVE_GATE_STATES: ReadonlySet<State> = new Set<State>([
  'GATE_A_RUNNING',
  'GATE_A_ADVERSARIAL',
  'GATE_B_RUNNING',
  'ADVERSARIAL_LOOP',
  // 下游：子进程（claude/codex/CI）在飞 → 看门狗据此宽限不强杀
  'GATE_C_RUNNING',
  'GATE_C_LOOP',
  'GATE_D_LOOP',
  'GATE_D_HARDENING',
]);

export const TERMINAL: ReadonlySet<State> = new Set<State>([
  'DONE',
  'SHIPPED',
  'GATE_A_FAILED',
  'GATE_B_FAILED',
  'GATE_C_FAILED',
  'GATE_D_FAILED',
  'GO_DENIED',
  'WRITE_FAILED',
]);
