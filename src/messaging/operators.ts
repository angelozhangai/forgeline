// 入站操作者身份解析：把 IM 的 operatorId（飞书 open_id）映射成 Forge 短码（M/BD/…），
// 让权限闸（gate_b_allowed / go_approvers）按**真实点击人**裁决，而非一律当作 M。
//
// 设计（安全 + 向后兼容，两条铁律）：
//  1. 未配 operators（单人 dogfood，permissions.yaml 无该段）→ 一律回退 'M'，沿用旧行为、零变化。
//  2. 配了 operators 但 openId 不在表里（陌生人点了卡）→ 返回 openId 原值——它落不进任何允许名单，
//     权限校验自然拒绝，**绝不冒充 M 提权**（宁可拒真人，不可放陌生人）。
export function resolveActor(operatorId: string | undefined, operators: Record<string, string>): string {
  if (Object.keys(operators).length === 0) return 'M'; // 未配 → 单人模式
  if (operatorId && operators[operatorId]) return operators[operatorId];
  return operatorId ?? 'unknown'; // 配了却不认识 → 不提权
}
