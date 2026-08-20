// nativeGithub adapter——直调 gh CLI 实现 ProjectActions，**不依赖目标项目自带脚本，亦不依赖 demo adapter**
// （故只 import proc.run——避开「mock workspace.ts 缺导出 → 导入期炸」的测试脆裂）。
// 用途：开源 / 无 forge 脚本约定的项目（proj.actions='native'）。选择点见 ./index.ts。
//
// 覆盖范围（诚实边界）：
//   · **单仓端到端可用**：scaffoldReview/scaffoldTechDesign 生成交付文档（含 `status: draft`，闸据此 append +
//     markReviewActive 置 active）；createSingle 按 repoMap 把短码映射成真实仓名走真 gh；addLabel/listEpicChildren
//     走真 gh；approve/publish 在通用 GitHub 无对应动作（无项目状态字段 / 不发布设计文档到主仓）→ no-op 返 ok。
//   · **多仓 Epic（createEpic）端到端可用**：Epic 本体建在伞仓、子 issue 各建在 code 仓，均带 epic:<slug> 标签
//     （listEpicChildren 据此在 retry 时重新发现），全部以**本地 repo key** 命名空间返回（与 doWrites 的覆盖校验 /
//     size 标签口径一致；gh 边界由 adapter 翻译成 slug）。简化边界：子 issue 仅挂标题+标签+DRI，整需求外环验收挂 Epic 正文。
// 命名空间契约：createSingle/createEpic 返回的 CreatedIssue.repo 一律为**本地 repo key**（demo 下 key=slug 故不变；
// monorepo 下 key='.'≠slug 'your-monorepo'）——doWrites 全程用 key/字母推理，addLabel/listEpicChildren 收 key 再翻 slug。
// 后续工作见 docs/architecture-control-plane-split.md 0.2c。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from '../util/proc.ts';
import type { ProjectActions, ScriptResult } from './actions.ts';
import type { ProjectFull } from '../projects.ts';
import type { CreatedIssue } from '../types.ts';
import type { ScaffoldOpts } from '../workspace.ts';

const TIMEOUT_MS = 60000;

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 解 gh issue create 输出里的 issue URL（去重）。
function parseIssueUrls(stdout: string, owner: string): CreatedIssue[] {
  const re = new RegExp(`https://github\\.com/${escRe(owner)}/([\\w.-]+)/issues/(\\d+)`, 'g');
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of stdout.matchAll(re)) {
    const key = `${m[1]}#${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: m[1], number: Number(m[2]), url: m[0] });
  }
  return out;
}

// 交付文档 front-matter。`status: draft` 行是闸约定：markReviewActive 用 /^status: draft.*$/ 改成 active。
function frontMatter(o: ScaffoldOpts): string {
  const fm = [`slug: ${o.slug}`, `title: ${o.title ?? o.slug}`, 'status: draft           # 闸通过后机器服务置 active'];
  if (o.owner) fm.push(`owner: ${o.owner}`);
  if (o.prd) fm.push(`prd: ${o.prd}`);
  return `---\n${fm.join('\n')}\n---\n`;
}
function reqReviewDoc(o: ScaffoldOpts): string {
  return `${frontMatter(o)}\n# ${o.title ?? o.slug} · 需求评审\n\n> forge nativeGithub adapter 生成（无项目脚本）。机器评审产出见下方追加段（🤖 机器评审产出）。\n${o.prd ? `\n## PRD\n${o.prd}\n` : ''}`;
}
function techDesignDoc(o: ScaffoldOpts): string {
  return `${frontMatter(o)}\n# ${o.title ?? o.slug} · 技术方案\n\n> forge nativeGithub adapter 生成（无项目脚本）。机器技术方案见下方追加段。\n`;
}

export function makeNativeGithubActions(proj: ProjectFull): ProjectActions {
  const { owner, repoMap, repoSlugs, deliveryDir, umbrella } = proj;
  // 短码（C/U/A，GateB 契约）→ 本地 repo key（repoMap）；demo 下 key=仓名。任一缺省原样透传。
  const localOf = (repo: string): string => repoMap[repo] ?? repo;
  // 本地 repo key → GitHub slug（repoSlugs）；monorepo '.' → 'your-monorepo'。缺省原样透传（demo 仓名即 slug）。
  const slugOf = (local: string): string => repoSlugs[local] ?? local;
  // 生成交付文档：非破坏（已存在则保留——闸 append 段 / 人工编辑 / 已置 active 不被覆盖）。dryRun 不写。
  const scaffold = (o: ScaffoldOpts, file: string, render: (o: ScaffoldOpts) => string): ScriptResult => {
    if (o.dryRun) return { ok: true, stdout: `(dry-run) native scaffold ${file}`, stderr: '' };
    const dir = resolve(deliveryDir, o.slug);
    mkdirSync(dir, { recursive: true });
    const doc = resolve(dir, file);
    const created = !existsSync(doc);
    if (created) writeFileSync(doc, render(o));
    return { ok: true, stdout: `native scaffold ${file}：${created ? '新建' : '已存在,跳过'}`, stderr: '' };
  };
  // 通用 GitHub 无项目状态字段 / 不发布设计文档到主仓：approve/publish 在 native 下无动作 → no-op ok（非失败）。
  const noop = (note: string): Promise<{ ok: boolean; stdout: string; stderr: string }> => Promise.resolve({ ok: true, stdout: `native no-op: ${note}`, stderr: '' });
  // 建单个 issue（gh issue create -R owner/<slug>）：解出 number/url，repo 置为**本地 key**（命名空间契约）。
  const createIssue = async (
    local: string,
    title: string,
    o: { labels?: (string | null | undefined)[]; assignee?: string | null; body?: string | null },
  ): Promise<{ ok: boolean; issue: CreatedIssue | null; stdout: string; stderr: string }> => {
    const args = ['issue', 'create', '-R', `${owner}/${slugOf(local)}`, '--title', title, '--body', o.body ?? ''];
    for (const l of (o.labels ?? []).filter((x): x is string => !!x)) args.push('--label', l);
    if (o.assignee) args.push('--assignee', o.assignee);
    const r = await run('gh', args, { timeoutMs: TIMEOUT_MS });
    const ok = r.code === 0 && !r.timedOut;
    const parsed = ok ? parseIssueUrls(r.stdout, owner)[0] : undefined;
    const issue = parsed ? { repo: local, number: parsed.number, url: parsed.url } : null;
    return { ok: ok && !!issue, issue, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    scaffoldReview: (o) => Promise.resolve(scaffold(o, 'req-review.md', reqReviewDoc)),
    scaffoldTechDesign: (o) => Promise.resolve(scaffold(o, 'tech-design.md', techDesignDoc)),
    approveTechDesign: () => noop('通用 GitHub 无项目状态字段，issue 建好即交付'),
    // published:false——native 未真发 PR，DONE 文案据此不谎称「PR 已自动合」。
    publishTechDesign: () => Promise.resolve({ ok: true, stdout: 'native no-op: 通用 GitHub 不发布设计文档到主仓', stderr: '', published: false }),
    createSingle: async (repo, title, o) => {
      // type/prio/area 通用映射为 GitHub label；status（项目状态字段）native 无对应、略过。
      const local = localOf(repo);
      if (o.dryRun) return { ok: true, stdout: `(dry-run) gh issue create -R ${owner}/${slugOf(local)} ${title}`, stderr: '', issues: [] };
      const r = await createIssue(local, title, { labels: [o.type, o.prio, o.area], assignee: o.assignee, body: o.body });
      return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, issues: r.issue ? [r.issue] : [] };
    },
    // 多仓 Epic：Epic 本体→伞仓、子 issue→各 code 仓，均带 epic:<slug>（retry 据此 listEpicChildren 重新发现）+ DRI。
    // 整需求外环验收挂 Epic 正文（o.body）；子 issue 仅标题（简化边界）。任一建失败 → ok=false（失败不静默，doWrites 转 WRITE_FAILED）。
    createEpic: async (slug, title, children, o) => {
      const epicLabel = `epic:${slug}`;
      if (o.dryRun) {
        const lines = [
          `(dry-run) gh issue create -R ${owner}/${slugOf(umbrella)} [Epic] ${title}`,
          ...children.map((c) => `(dry-run) gh issue create -R ${owner}/${slugOf(localOf(c.repo))} [子] ${c.title}`),
        ];
        return { ok: true, stdout: lines.join('\n'), stderr: '', issues: [] };
      }
      const issues: CreatedIssue[] = [];
      const errs: string[] = [];
      const ep = await createIssue(umbrella, title, { labels: [epicLabel, o.type], assignee: o.assignee, body: o.body });
      if (ep.issue) issues.push(ep.issue);
      else errs.push(`Epic(${umbrella}): ${(ep.stderr || ep.stdout || 'gh 无 URL').slice(0, 120)}`);
      for (const c of children) {
        const cl = localOf(c.repo);
        const ci = await createIssue(cl, c.title, { labels: [epicLabel, o.type], assignee: o.assignee });
        if (ci.issue) issues.push(ci.issue);
        else errs.push(`子(${cl}): ${(ci.stderr || ci.stdout || 'gh 无 URL').slice(0, 120)}`);
      }
      const ok = errs.length === 0;
      const stdout = issues.map((i) => `✓ ${i.repo}#${i.number} ${i.url}`).join('\n');
      return { ok, stdout, stderr: ok ? '' : errs.join('; '), issues };
    },
    addLabel: async (repo, num, label) => {
      // repo 收的是**本地 key**（doWrites 命名空间）→ 翻成 slug 再拼 gh -R。
      const r = await run('gh', ['issue', 'edit', String(num), '-R', `${owner}/${slugOf(repo)}`, '--add-label', label], { timeoutMs: TIMEOUT_MS });
      return { ok: r.code === 0 && !r.timedOut, stderr: r.stderr };
    },
    listEpicChildren: async (repo, slug) => {
      // repo 收**本地 key** → slug 拼 gh -R；返回的 issue.repo 仍置回本地 key（命名空间契约，doWrites 覆盖校验据此）。
      const r = await run('gh', ['issue', 'list', '-R', `${owner}/${slugOf(repo)}`, '-l', `epic:${slug}`, '--state', 'all', '--json', 'number,url'], { timeoutMs: TIMEOUT_MS });
      if (r.code !== 0 || r.timedOut) return { ok: false, issues: [], stderr: r.stderr || `exit ${r.code}` };
      try {
        const arr = JSON.parse(r.stdout || '[]') as { number?: number; url?: string }[];
        const issues = arr
          .filter((a) => typeof a.number === 'number' && typeof a.url === 'string')
          .map((a) => ({ repo, number: a.number as number, url: a.url as string }));
        return { ok: true, issues, stderr: '' };
      } catch {
        return { ok: false, issues: [], stderr: 'gh issue list --json 解析失败' };
      }
    },
  };
}
