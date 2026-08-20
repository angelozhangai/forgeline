// ProjectActions——目标项目「机械动作」端口（建 issue / 置状态 / 发技术方案 / 闸A·闸B 脚手架）。
// 照 MessagingPort 范式：核心只依赖此接口，adapter 收敛「怎么做」。当前唯一 adapter 是 demo
// 主仓脚本（委托 workspace.ts 的脚本封装）；未来 nativeGithub adapter 直调 gh/GitHub API、不依赖
// 目标项目自带脚本（开源 / 无脚本项目用）。选择点见 ./index.ts。
//
// 关键：scriptsDir / owner 由 adapter 按「该 session 的项目」注入——调用方不再手传，少一类穿线错。
import * as ws from '../workspace.ts';
import type { ScaffoldOpts, IssueCommon, EpicChild } from '../workspace.ts';
import type { CreatedIssue } from '../types.ts';
import type { ProjectFull } from '../projects.ts'; // type-only：编译期擦除，本模块运行时不依赖 projects.ts

// 从 new-req.sh epic 输出解析已建子 issue：demo 脚本子 issue 只打印 `✓ C#11`（无完整 URL，故 parseIssues 抓不到）。
// 这是 **demo 脚本输出格式**，故归 demo adapter（doWrites 不再 know 此格式——端口契约：createEpic.issues = 全部已建）。
export function parseEpicChildren(stdout: string, repoMap: Record<string, string>, owner: string): CreatedIssue[] {
  const re = /✓\s+([CUA])#(\d+)/g;
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of stdout.matchAll(re)) {
    const repo = repoMap[m[1]];
    if (!repo) continue;
    const number = Number(m[2]);
    const key = `${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` });
  }
  return out;
}

export interface ScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export interface IssueWriteResult extends ScriptResult {
  issues: CreatedIssue[];
}
// 发布结果：`published` 区分「真的发了 PR」(demo) 与「无动作」(native no-op)——DONE 文案据此，绝不谎称「PR 已自动合」。
export interface PublishResult extends ScriptResult {
  published: boolean;
}

export interface ProjectActions {
  // 闸A / 闸B 脚手架（scaffold 评审 / 技术方案文档）
  scaffoldReview(o: ScaffoldOpts): Promise<ScriptResult>;
  scaffoldTechDesign(o: ScaffoldOpts): Promise<ScriptResult>;
  approveTechDesign(slug: string, issue?: string | null, rollup?: boolean): Promise<ScriptResult>;
  // 建需求（单仓 / 多仓 Epic）+ 发布技术方案到主仓
  createSingle(repo: string, title: string, o: IssueCommon): Promise<IssueWriteResult>;
  createEpic(slug: string, title: string, children: EpicChild[], o: IssueCommon): Promise<IssueWriteResult>;
  publishTechDesign(slug: string, o: { base: string; dryRun?: boolean }): Promise<PublishResult>;
  // GitHub 查询（建 issue 配套：按 epic 标签发现子 issue / 打 size 标签）
  listEpicChildren(repo: string, slug: string): Promise<{ ok: boolean; issues: CreatedIssue[]; stderr: string }>;
  addLabel(repo: string, num: number, label: string): Promise<{ ok: boolean; stderr: string }>;
}

// demo adapter：把项目的 scriptsDir / owner 注入 workspace.ts 的主仓脚本封装。
// 调用方传 ScaffoldOpts/IssueCommon 时不必带 scriptsDir/owner——这里统一覆盖，单一真源。
export function makeDemoScriptActions(proj: ProjectFull): ProjectActions {
  const { scriptsDir, owner } = proj;
  const repoMap = proj.repoMap ?? {};
  return {
    scaffoldReview: (o) => ws.reviewReqScaffold({ ...o, scriptsDir }),
    scaffoldTechDesign: (o) => ws.techDesignScaffold({ ...o, scriptsDir }),
    approveTechDesign: (slug, issue, rollup = false) => ws.techDesignApprove(slug, issue, rollup, scriptsDir),
    createSingle: (repo, title, o) => ws.newReqSingle(repo, title, { ...o, scriptsDir, owner }),
    // 子 issue 在 stdout 只打 `✓ C#n`（无 URL）→ 这里解出并入 issues：端口契约「createEpic.issues = Epic + 全部子 issue」，
    // doWrites 不再 know demo 的 ✓C#n 格式（解耦输出契约）。
    createEpic: async (slug, title, children, o) => {
      const r = await ws.newReqEpic(slug, title, children, { ...o, scriptsDir, owner });
      const merged = [...r.issues];
      for (const ci of parseEpicChildren(r.stdout, repoMap, owner)) {
        if (!merged.some((x) => x.repo === ci.repo && x.number === ci.number)) merged.push(ci);
      }
      return { ...r, issues: merged };
    },
    publishTechDesign: (slug, o) => ws.publishTechDesign(slug, { ...o, scriptsDir }).then((r) => ({ ...r, published: r.ok })), // demo 真发 PR：ok=已发布
    listEpicChildren: (repo, slug) => ws.listEpicChildren(repo, slug, owner),
    addLabel: (repo, num, label) => ws.addLabel(repo, num, label, owner),
  };
}
