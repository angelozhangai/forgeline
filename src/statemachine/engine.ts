import type { State } from './states.ts';

// 合法转移表。自转移（from===to）放行，便于 ADVERSARIAL_LOOP 循环与幂等 patch。
const ALLOWED: Record<State, State[]> = {
  INTAKE: ['GATE_A_RUNNING', 'GATE_A_FAILED'],
  // 闸A 首轮或复评跑完后：还有问题→等 PM；无剩余→进 codex 对抗复审；到上限→停泊裁决；失败→停泊。
  // （CONFIRMED 保留：M 在 AWAITING_PM_CONFIRM/STALLED 强制结束的目的态，FSM 层放行。）
  GATE_A_RUNNING: ['AWAITING_PM_CONFIRM', 'GATE_A_ADVERSARIAL', 'CONFIRMED', 'GATE_A_STALLED', 'GATE_A_FAILED'],
  // PM 答复→进复评点；CONFIRMED 留给 M 强制结束。
  AWAITING_PM_CONFIRM: ['GATE_A_REVISION_REQUESTED', 'CONFIRMED'],
  GATE_A_REVISION_REQUESTED: ['GATE_A_RUNNING', 'GATE_A_FAILED'],
  // 闸A 对抗：codex LGTM 且无新开放问题→确认；对抗补出 PM 未答的漏问→弹回 PM 答复；到上限→停泊裁决；
  // 每-tick 上限→自转移续跑；失败→停泊。不升级人在环（PRD 拿不准走 PM loop）。
  GATE_A_ADVERSARIAL: ['GATE_A_ADVERSARIAL', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_A_STALLED', 'GATE_A_FAILED'],
  // M 裁决：强制通过 / 补输入再跑一轮。
  GATE_A_STALLED: ['CONFIRMED', 'GATE_A_REVISION_REQUESTED'],
  CONFIRMED: ['GATE_B_REQUESTED'],
  GATE_B_REQUESTED: ['GATE_B_RUNNING', 'GATE_B_FAILED'],
  GATE_B_RUNNING: ['ADVERSARIAL_LOOP', 'GATE_B_FAILED'],
  // 对抗循环：clean→GO；claude 升级→等 M 答复；到上限→停泊裁决；每-tick 上限→自转移续跑；失败→停泊。
  ADVERSARIAL_LOOP: ['ADVERSARIAL_LOOP', 'AWAITING_GO', 'AWAITING_GATE_B_INPUT', 'GATE_B_STALLED', 'GATE_B_FAILED'],
  // M 答复升级问题 → 进续修点。
  AWAITING_GATE_B_INPUT: ['GATE_B_REVISION_REQUESTED'],
  // M 答复后 resume 续修 → 回循环态再评；失败→停泊。
  GATE_B_REVISION_REQUESTED: ['ADVERSARIAL_LOOP', 'GATE_B_FAILED'],
  // M 裁决：强制立项 / 再修一轮。
  GATE_B_STALLED: ['AWAITING_GO', 'GATE_B_REVISION_REQUESTED'],
  AWAITING_GO: ['WRITING', 'GO_DENIED'],
  WRITING: ['DONE', 'WRITE_FAILED'],
  // 下游入口：issue 已建后由带权限的 forge implement 触发闸C（standalone 裸 issue 直接置 GATE_C_REQUESTED）。
  DONE: ['GATE_C_REQUESTED'],
  // ── 下游闸C：实现 + 本地CI ──
  GATE_C_REQUESTED: ['GATE_C_RUNNING', 'GATE_C_FAILED'],
  GATE_C_RUNNING: ['GATE_C_LOOP', 'GATE_C_FAILED'],
  // 实现⇄CI 循环：绿→等开PR；升级→等 M 答复；到上限→停泊裁决；每-tick 上限→自转移续跑；失败→停泊。
  GATE_C_LOOP: ['GATE_C_LOOP', 'AWAITING_GATE_D', 'AWAITING_GATE_C_INPUT', 'GATE_C_STALLED', 'GATE_C_FAILED'],
  AWAITING_GATE_C_INPUT: ['GATE_C_REVISION_REQUESTED'],
  GATE_C_REVISION_REQUESTED: ['GATE_C_LOOP', 'GATE_C_FAILED'],
  // M 裁决：只能给输入再修一轮——**绝不能跳到 AWAITING_GATE_D**。闸C 的 stall = 确定性 CI/验收未绿，
  // 红线#3「确定性闸永不可人工跳过」在此落地：CI 没绿就不许进开 PR（区别于闸D stall 是主观分歧、且 CI 已绿，故闸D 可放行）。
  GATE_C_STALLED: ['GATE_C_REVISION_REQUESTED'],
  // ── 下游闸D：PR 对抗 review + 测试补强 + merge readiness ──
  AWAITING_GATE_D: ['GATE_D_REQUESTED'],
  GATE_D_REQUESTED: ['GATE_D_LOOP', 'GATE_D_FAILED'],
  // 对抗循环：LGTM→补内环测试；升级→等 M 答复；到上限→停泊裁决；每-tick 上限→自转移续跑；失败→停泊。
  GATE_D_LOOP: ['GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_GATE_D_INPUT', 'GATE_D_STALLED', 'GATE_D_FAILED'],
  AWAITING_GATE_D_INPUT: ['GATE_D_REVISION_REQUESTED'],
  GATE_D_REVISION_REQUESTED: ['GATE_D_LOOP', 'GATE_D_FAILED'],
  // 单仓/最后一条 leg 补强完 → 合并就绪；多仓还有未审 leg → 切下一条 leg 回 GATE_D_LOOP 复审（逐仓一树一PR，
  // 全部 leg 补强完才 AWAITING_HUMAN_MERGE，见 worker.runGateDHardenStep + legs.planGateDAdvance）。
  GATE_D_HARDENING: ['AWAITING_HUMAN_MERGE', 'GATE_D_LOOP', 'GATE_D_FAILED'],
  // M 裁决：强制前进到合并就绪 / 再修一轮。
  GATE_D_STALLED: ['AWAITING_HUMAN_MERGE', 'GATE_D_REVISION_REQUESTED'],
  // 人工合并后确认；或要求再改 → 回续修点。
  AWAITING_HUMAN_MERGE: ['SHIPPED', 'GATE_D_REVISION_REQUESTED'],
  SHIPPED: [],
  // retry / 孤儿复位：首轮失败回 INTAKE；复评失败回复评点；对抗失败原地续跑（不丢已累计的 PM 轮次）。
  GATE_A_FAILED: ['GATE_A_RUNNING', 'INTAKE', 'GATE_A_REVISION_REQUESTED', 'GATE_A_ADVERSARIAL'],
  // retry / 孤儿复位：无初稿→干净重跑；有初稿→原地复位续跑（ADVERSARIAL_LOOP / 续修点，不丢轮次）。
  GATE_B_FAILED: ['GATE_B_RUNNING', 'GATE_B_REQUESTED', 'ADVERSARIAL_LOOP', 'GATE_B_REVISION_REQUESTED'],
  // retry / 孤儿复位：原地复位续跑（建树/实现/续做点）。
  GATE_C_FAILED: ['GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_REVISION_REQUESTED'],
  GATE_D_FAILED: ['GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_REVISION_REQUESTED', 'GATE_D_HARDENING'],
  GO_DENIED: ['AWAITING_GO'],
  WRITE_FAILED: ['WRITING'],
};

export function canTransition(from: State, to: State): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.includes(to) ?? false;
}
