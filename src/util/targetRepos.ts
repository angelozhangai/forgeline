// 目标代码仓选择（顶层规则：仓=最具体单元，实现锚到需求真正动的仓）。纯逻辑、零重依赖（只引类型）——
// 独立成模块，让 actions/intake 引用它时**不会**把 gateC/worktree 拉进部分 mock 的测试图（否则 mock.module
// 部分替换 worktree/gateC 的下游测试会因「缺导出」链接失败）。真源在此，gateC.runGateCSetup 也从这里取 primary。
import type { Session } from '../types.ts';

// 先经 repoMap 归一化（闸A repos_touched 是**字母** C/U/A/E，见 output-contract.md / gate-b prompt），
// 再 ∩ projRepos、保序去重；为空回退首仓（绝不让实现无仓可落）。`repoMap[t] ?? t` 双向兼容：字母→仓名、
// 已是仓名则原样（GATE_A_CONTRACT 示例曾写仓名，模型两种都可能产；standalone --repo 也可能传名或字母）。
// ⚠️ 没有 repoMap 而直接拿字母比仓名 → `["U"]/["A"]` 全落空静默回退首仓（错锚 bug，Codex Blocker）。
export function resolveTargetRepos(touched: readonly string[], projRepos: readonly string[], repoMap: Record<string, string> = {}): string[] {
  const normalized = touched.map((t) => repoMap[t] ?? t);
  const uniq = [...new Set(normalized.filter((r) => projRepos.includes(r)))];
  return uniq.length ? uniq : projRepos[0] ? [projRepos[0]] : [];
}

// 本 session 的目标仓列表（读 target_repos json；坏/空→回退 proj.repos[0]）。Phase 1 只用 primary（首个）；多仓每仓一树见 Phase 2。
export function targetReposOf(s: Pick<Session, 'target_repos'>, projRepos: readonly string[]): string[] {
  let parsed: unknown = [];
  try {
    if (s.target_repos) parsed = JSON.parse(s.target_repos);
  } catch {
    parsed = [];
  }
  return resolveTargetRepos(Array.isArray(parsed) ? (parsed as string[]) : [], projRepos);
}

// 主目标仓（建 worktree/分支锚定、合并后清理定位的仓）。缺→proj.repos[0]→'.'。
export function primaryTargetRepo(s: Pick<Session, 'target_repos'>, projRepos: readonly string[]): string {
  return targetReposOf(s, projRepos)[0] ?? projRepos[0] ?? '.';
}
