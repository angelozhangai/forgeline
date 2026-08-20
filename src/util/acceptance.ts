import type { Acceptance, GateBEnvelope } from '../gates/envelopes.ts';

// 仓字母 → 展示名（与 writes.ts REPO_NAME 同口径，util 层不反向依赖故本地一份）。
const REPO_LABEL: Record<string, string> = {
  C: 'demo',
  U: 'example-web',
  A: 'example-admin',
};

// 渲染「验收（Done 定义 · 外环）」markdown，作为 issue 正文 / 技术方案文档的工程师可见块。
// repo 给定时只取该仓相关项 + 未标 repo 的通用项；不给则全取（Epic / 技术方案文档用）。
// 外环 = 绑契约/边界、当前全红的可执行验收；内环（单元+集成）由工程师开发期按 TDD 补，差分覆盖门卡新增行。
export function acceptanceMarkdown(acc: Acceptance | undefined, repo?: string): string {
  if (!acc) return '';
  const pick = <T extends { repo?: string }>(xs: T[]): T[] =>
    repo ? xs.filter((x) => !x.repo || x.repo === repo) : xs;
  const contracts = pick(acc.contracts ?? []).filter((c) => c.surface.trim());
  const scenarios = pick(acc.scenarios ?? []).filter((s) => s.gherkin.trim());
  if (contracts.length === 0 && scenarios.length === 0) return '';

  const tag = (r: string): string => (r ? `[${REPO_LABEL[r] ?? r}] ` : '');
  const lines: string[] = ['## 验收（Done 定义 · 外环，开发前应全红）'];
  if (contracts.length) {
    lines.push('', '**契约（固定边界 — 测试绑这里，不绑内部方法）**');
    for (const c of contracts) lines.push(`- ${tag(c.repo)}${c.surface.trim()}`);
  }
  if (scenarios.length) {
    lines.push('', '**验收场景（声明式 BDD；先写、当前红，工程师按 TDD 补内环单测/集测推绿）**');
    for (const s of scenarios) {
      lines.push('', `*${s.id || 'AC'}*`, '```gherkin', s.gherkin.trim(), '```');
    }
  }
  return lines.join('\n');
}

// 命令式 UI 动作（验收应描述业务结果，不描述操作步骤）。命中即判不声明式。
const IMPERATIVE = /点击|点按钮|单击|填写|填入|输入框|勾选|下拉框|\bclick\b|\bfill in\b|\btype into\b/i;

export interface AcceptanceLint {
  ok: boolean;
  problems: string[];
}

// 外环验收的确定性 lint（GO 前闸口）：空 / 结构不全 / 命令式 / 漏仓 → 挡。
// 只做高信号项；「绑内部方法名」这类易误报的判断不放这里，交对抗复审。
export function lintAcceptance(env: GateBEnvelope): AcceptanceLint {
  const problems: string[] = [];
  const acc = env.acceptance ?? { contracts: [], scenarios: [] };
  const contracts = (acc.contracts ?? []).filter((c) => c.surface.trim());
  const scenarios = (acc.scenarios ?? []).filter((s) => s.gherkin.trim());

  if (scenarios.length === 0)
    problems.push('外环验收缺场景：acceptance.scenarios 至少 1 条声明式 Given/When/Then');
  if (contracts.length === 0)
    problems.push('外环验收缺契约：acceptance.contracts 至少 1 条固定边界（端点/schema 或导出签名）');

  for (const s of scenarios) {
    const id = s.id || '(无 id 场景)';
    const g = s.gherkin;
    if (!(/given/i.test(g) && /when/i.test(g) && /then/i.test(g)))
      problems.push(`场景 ${id} 结构不全：需同时含 Given / When / Then`);
    if (IMPERATIVE.test(g))
      problems.push(`场景 ${id} 出现命令式动作（点按钮/填输入框…）：验收须声明式描述业务结果`);
  }

  // 每个有 issue 的仓必须被外环覆盖（该仓的 contract/scenario，或未标 repo 的通用项覆盖全部）。
  const hasGeneral = contracts.some((c) => !c.repo) || scenarios.some((s) => !s.repo);
  if (!hasGeneral) {
    const covered = new Set(
      [...contracts, ...scenarios].map((x) => x.repo).filter(Boolean),
    );
    for (const r of new Set(env.issue_specs.map((i) => i.repo).filter(Boolean))) {
      if (!covered.has(r))
        problems.push(`仓 ${r} 有 issue 但无外环验收覆盖（给它配 contract/scenario，或用通用项）`);
    }
  }

  return { ok: problems.length === 0, problems };
}
