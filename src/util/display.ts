// 对外展示层：内部代码继续用 State / 闸A / 闸B 黑话，凡是给「人」看的（卡片、通知、issue）
// 一律走这里翻译成产品/测试/所有人都懂的话 + 统一需求编号。改词只改这一处。
import type { State } from '../statemachine/states.ts';
import type { Session } from '../types.ts';

export const REF_PREFIX = 'REQ-'; // 需求编号前缀（要换 PRD-/CR- 只改这里）

// 人类可读需求编号：收到即分配，全程流转（卡片/issue/对话都用它指代某需求）。
export function reqRef(s: Pick<Session, 'ref_num' | 'slug'>): string {
  return s.ref_num != null ? `${REF_PREFIX}${s.ref_num}` : s.slug;
}

// 内部状态 → 对外人话（PM/测试都懂；绝不出现「闸A/闸B/GATE_*」）。
const LABEL: Record<State, string> = {
  INTAKE: '📥 已收到 · 排队中',
  GATE_A_RUNNING: '🔍 需求评审中（对照代码真源）',
  AWAITING_PM_CONFIRM: '✋ 待产品确认',
  GATE_A_REVISION_REQUESTED: '🔁 依答复复评中',
  GATE_A_ADVERSARIAL: '🔬 需求复核中（AI 交叉复审）',
  GATE_A_STALLED: '⚖️ 待负责人裁决',
  CONFIRMED: '✅ 需求已确认',
  GATE_B_REQUESTED: '📐 待出技术方案',
  GATE_B_RUNNING: '📐 技术方案设计中',
  ADVERSARIAL_LOOP: '🔬 方案交叉复审中',
  AWAITING_GATE_B_INPUT: '🙋 待负责人答复（方案有拿不准的点）',
  GATE_B_REVISION_REQUESTED: '🔁 依答复修订方案中',
  AWAITING_GO: '🚦 待拍板立项',
  WRITING: '✍️ 立项中（建需求）',
  DONE: '🎉 已立项',
  // 下游：实现 + 本地CI
  GATE_C_REQUESTED: '🛠️ 待开发实现',
  GATE_C_RUNNING: '🛠️ 编码实现中（隔离工作区）',
  GATE_C_LOOP: '🛠️ 编码 + 本地自测中',
  AWAITING_GATE_C_INPUT: '🙋 待负责人答复（实现有拿不准的点）',
  GATE_C_REVISION_REQUESTED: '🔁 依答复续做中',
  // 下游：PR 复审 + 测试补强 + 合并
  AWAITING_GATE_D: '🚦 待开 PR 复审',
  GATE_D_REQUESTED: '🔀 已提 PR · 待复审',
  GATE_D_LOOP: '🔬 PR 交叉复审中',
  AWAITING_GATE_D_INPUT: '🙋 待负责人答复（PR 改动有拿不准的点）',
  GATE_D_REVISION_REQUESTED: '🔁 依复审修订中',
  GATE_D_HARDENING: '🧪 测试补强中',
  AWAITING_HUMAN_MERGE: '✋ 待人工合并上线',
  SHIPPED: '🚀 已合并上线',
  GATE_A_FAILED: '⚠️ 评审中断 · 待重试',
  GATE_B_FAILED: '⚠️ 方案中断 · 待重试',
  GATE_B_STALLED: '⚖️ 待负责人裁决（方案复审多轮未决）',
  GATE_C_FAILED: '⚠️ 实现中断 · 待重试',
  GATE_C_STALLED: '⚖️ 待负责人裁决（本地校验多轮未过）',
  GATE_D_FAILED: '⚠️ 复审中断 · 待重试',
  GATE_D_STALLED: '⚖️ 待负责人裁决（PR 复审多轮未决）',
  GO_DENIED: '⛔ 已驳回',
  WRITE_FAILED: '⚠️ 立项失败 · 待重试',
};

export function stateLabel(state: State): string {
  return LABEL[state] ?? String(state);
}

// 阶段名（人话）：闸A/闸B 的对外说法。
export const PHASE_A = '需求评审';
export const PHASE_B = '技术方案';

// 卡片/通知标题：编号 · 标题（截断），可带前缀 emoji。一眼知道是哪个需求。
export function refTitle(s: Pick<Session, 'ref_num' | 'slug' | 'title'>, prefix = ''): string {
  const t = (s.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${prefix}${reqRef(s)}${t ? ` · ${t}` : ''}`;
}
