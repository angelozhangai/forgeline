// Inbound operator identity resolution: maps an IM operatorId (a Feishu open_id) to a Forge short code
// (M/BD/…), so the permission gates (gate_b_allowed / go_approvers) decide on **who actually clicked**
// rather than treating everyone as the maintainer.
//
// Design (two hard rules, one for safety and one for backward compatibility):
//  1. operators unconfigured (single-person dogfooding, no such section in permissions.yaml) -> always
//     fall back to 'M', preserving the old behaviour with zero change.
//  2. operators configured but the openId is not in the table (a stranger clicked the card) -> return
//     the openId itself. It matches no allowlist, so the permission check naturally denies it, and it
//     **never impersonates M to escalate privilege** (better to deny a real person than to admit a
//     stranger).
export function resolveActor(operatorId: string | undefined, operators: Record<string, string>): string {
  if (Object.keys(operators).length === 0) return 'M'; // unconfigured -> single-person mode
  if (operatorId && operators[operatorId]) return operators[operatorId];
  return operatorId ?? 'unknown'; // configured but unrecognised -> no privilege escalation
}
