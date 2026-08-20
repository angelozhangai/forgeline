// 评审锚定校验：fetch 拿到的 `origin/<branch>` sha（见 repoFreshness）只是「远端真相」，但 claude 跑评审/出方案时
// `cwd=项目根` 读的是**活 checkout**。若本地 checkout 不在该 sha（错分支/落后）或有未提交改动，等于对「非锚定/未上线」
// 的代码下结论——最危险的评审误报。本模块负责发现并处置（披露给模型 / 严格停泊）。
//
// 与 repoFreshness（fetch）刻意分文件：drift.test 整体 mock 了 repoFreshness，把锚定校验放这里，测试里才能保留**真实**
// reposOffRef（drift 的对账正确性依赖它）；闸B 生产链路测试单独 mock 本模块即可。
import { runSync } from '../util/proc.ts';
import type { RepoShas } from '../types.ts';
import type { ProjectFull } from '../projects.ts';
import type { Freshness } from './repoFreshness.ts';

// 各仓本地 checkout 是否对齐给定 sha：HEAD≠sha 或工作树脏 → 未对齐。查不出 HEAD/状态 → 当未对齐（不可信，不冒进）。
export function reposOffRef(proj: Pick<ProjectFull, 'repoPath'>, shas: RepoShas): string[] {
  const off: string[] = [];
  for (const [repo, sha] of Object.entries(shas)) {
    const dir = proj.repoPath(repo);
    try {
      const head = runSync('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
      const dirty = runSync('git', ['-C', dir, 'status', '--porcelain']).trim().length > 0;
      if (head !== sha || dirty) off.push(repo);
    } catch {
      off.push(repo);
    }
  }
  return off;
}

export type AnchorMode = 'warn' | 'block';

// 闸评审/出方案前的 checkout 锚定校验。
// - 全对齐 → 空披露，照常跑。
// - 有偏移 + mode=block → 抛（调用方停泊，绝不对非锚定代码下结论）。
// - 有偏移 + mode=warn → 返回**披露文本**（注入 prompt 的 freshness 块，诚实告诉模型「这些仓 checkout 不在锚定 sha，
//   读代码以 origin/<branch> 为准」）。失败不静默：宁可告知模型也不假装锚定。
export function anchorCheck(
  proj: Pick<ProjectFull, 'repoPath'>,
  fresh: Pick<Freshness, 'branch' | 'shas'>,
  mode: AnchorMode,
): { off: string[]; disclosure: string } {
  const off = reposOffRef(proj, fresh.shas);
  if (!off.length) return { off, disclosure: '' };
  if (mode === 'block') {
    throw new Error(`代码 checkout 未锚定 origin/${fresh.branch}：${off.join(', ')}（HEAD≠该 sha 或有未提交改动）— 暂停，避免对非锚定代码下结论`);
  }
  const disclosure =
    `\n\n⚠️ **checkout 未锚定**：${off.join(', ')} 的本地 checkout 不在 \`origin/${fresh.branch}\`（HEAD 不符或有未提交改动）。` +
    `读这些仓的代码请以 \`git show origin/${fresh.branch}:<path>\` 为准，**不要把未上线 / 本地改动当作既有事实**。`;
  return { off, disclosure };
}
