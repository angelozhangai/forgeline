// 委托式 git worktree 生命周期：为下游闸C/闸D 建/清理/列出**隔离工作树**。
// 设计纪律（对齐顶层「机械动作调目标项目脚本、不重造」）：
//  · 创建优先走目标项目的 worktree_add 脚本（your-monorepo 必走 tools/scripts/wt.sh——它额外同步
//    node_modules / .envrc / 密钥，裸 `git worktree add` 会缺这些跑不起来）；项目没配脚本才回退裸 git。
//  · 清理走 worktree_remove 脚本或裸 `git worktree remove --force` + `prune`（移除不在 your-monorepo 禁令内，禁的是裸 add）。
//  · 主 checkout 仍由 repoAnchor 锚定 origin/<branch>（只读真源）；worktree 是改码/CI/PR 的隔离地，二者井水不犯河水。
import { resolve, basename } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { run, runSync } from './proc.ts';

// 按扩展名挑解释器（与 workspace.ts 的 bash 约定一致）：.sh→bash、.js/.mjs→node、其余→直接执行（须有可执行位）。
export function interp(script: string, args: string[]): [string, string[]] {
  if (script.endsWith('.sh')) return ['bash', [script, ...args]];
  if (script.endsWith('.js') || script.endsWith('.mjs')) return ['node', [script, ...args]];
  return [script, args];
}

// 输出截断（落库/日志有界，绝不灌满）。
function tail(s: string, n = 4000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

// 顶层规则（见 CLAUDE.md「worktree 归属具体仓」）：隔离工作树**落在该仓自己的隐藏目录** <repoDir>/.forge/worktrees/<key>，
// 绝不堆进 umbrella / 兄弟目录。.forge/ 经 ensureWorktreeExcluded 写进该仓 .git/info/exclude（本地生效、永不入库）。
// 孤儿识别按路径段 `/.forge/worktrees/`（见 planWorktreeSweep）。key 由 gateC.implIdentity 唯一派生（基于 session.id）。
export const WORKTREE_DIR_SEGMENT = `${'/'}.forge/worktrees/`; // 孤儿识别/排除锚点（用变量避免散落字面量）
export function worktreeRoot(repoDir: string): string {
  return resolve(repoDir, '.forge', 'worktrees');
}
export function defaultWorktreePath(repoDir: string, key: string): string {
  return resolve(worktreeRoot(repoDir), key);
}

// 把 forge 隔离工作树根 `.forge/` 写进该仓**本地** .git/info/exclude，让它不被产品仓跟踪——
// 且**不动**产品仓被跟踪的 .gitignore（顶层规则：Forge 绝不在产品仓留杂改/杂提交）。.git/info/exclude
// 在 git common dir、为该仓所有 worktree 共享，写主 checkout 一次即覆盖全部。幂等：已含则跳过。
// best-effort：写失败不致命（worktree 仍能建，只是主仓 git status 会多出未跟踪噪声），故吞异常不抛。
export function ensureWorktreeExcluded(repoDir: string): void {
  try {
    const gitPath = resolve(repoDir, '.git');
    if (!existsSync(gitPath) || !statSync(gitPath).isDirectory()) return; // 仅主 checkout（.git 为目录）；worktree/裸仓跳过
    const infoDir = resolve(gitPath, 'info');
    const excludePath = resolve(infoDir, 'exclude');
    const pattern = '/.forge/';
    const cur = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === pattern)) return; // 已排除
    mkdirSync(infoDir, { recursive: true });
    const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${sep}# forge 隔离工作树（本地，勿提交/推送）\n${pattern}\n`);
  } catch {
    /* 写 exclude 失败不致命：见上 */
  }
}

export interface CreateWorktreeOpts {
  repoDir: string; // 主 checkout 仓目录（git worktree 挂载源）
  path: string; // 目标 worktree 绝对路径
  branch: string; // 新分支名，如 forge/<id>
  baseCommitish: string; // 建树锚点——**必须传不可变 sha**（非移动 ref 如 origin/main）：并发/外部 fetch 推进
  // origin/<branch> 时，用移动 ref 建树会让 worktree 基线漂离已记录的 base_sha，把上游新提交误算成实现（Codex B1）。
  addScript?: string; // 绝对路径：proj.scripts.worktree_add（缺省回退裸 git worktree add）
  timeoutMs?: number; // 缺省 10min（wt.sh 含 pnpm install，给足）
}

export interface WorktreeResult {
  ok: boolean;
  path: string;
  branch: string;
  output: string; // 截断的 stdout+stderr（失败排障 / 成功留痕）
}

// 建隔离工作树。委托脚本与裸 git 的参数都对齐 `git worktree add <path> [-b <branch>] [<commit-ish>]`。
// 失败不抛——返回 ok:false + output，交调用方（gateC）决定停泊/重试（瞬时 vs 永久由 orchestrator/retry 分类）。
export async function createWorktree(o: CreateWorktreeOpts): Promise<WorktreeResult> {
  const timeoutMs = o.timeoutMs ?? 600_000;
  const [bin, args] = o.addScript
    ? interp(o.addScript, [o.path, '-b', o.branch, o.baseCommitish])
    : ['git', ['-C', o.repoDir, 'worktree', 'add', o.path, '-b', o.branch, o.baseCommitish]];
  const r = await run(bin, args, { cwd: o.repoDir, timeoutMs });
  return { ok: r.code === 0 && !r.timedOut, path: o.path, branch: o.branch, output: tail(r.stdout + r.stderr) };
}

export interface RemoveWorktreeOpts {
  repoDir: string;
  path: string;
  removeScript?: string; // 绝对路径：proj.scripts.worktree_remove（缺省回退裸 git）
  timeoutMs?: number;
}

// 清理隔离工作树（终态/失败后）。裸回退：remove --force（弃未提交改动）+ prune（清残留登记）。
// best-effort：返回 ok 供审计，但调用方通常不因清理失败而停泊（worktree 残留由孤儿清扫兜底）。
export async function removeWorktree(o: RemoveWorktreeOpts): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  if (o.removeScript) {
    const [bin, args] = interp(o.removeScript, [o.path]);
    const r = await run(bin, args, { cwd: o.repoDir, timeoutMs });
    return { ok: r.code === 0 && !r.timedOut, output: tail(r.stdout + r.stderr) };
  }
  const rm = await run('git', ['-C', o.repoDir, 'worktree', 'remove', '--force', o.path], { cwd: o.repoDir, timeoutMs });
  await run('git', ['-C', o.repoDir, 'worktree', 'prune'], { cwd: o.repoDir, timeoutMs });
  return { ok: rm.code === 0 && !rm.timedOut, output: tail(rm.stdout + rm.stderr) };
}

// 列出主 checkout 下所有 worktree 绝对路径（孤儿清扫用）。best-effort：失败返回 []（不抛、不冒进）。
export function listWorktrees(repoDir: string): string[] {
  try {
    const out = runSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 工作树当前 HEAD sha（记 base_shas / 校验 pin 用）。失败返回 null（不抛）。
export function worktreeHeadSha(worktreePath: string): string | null {
  try {
    return runSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

// best-effort 删本地分支（孤儿清理：worktree 移除后 `-b` 创建的分支会残留，重建 `-b` 会撞名）。
// 失败吞掉——分支不存在是常态；真撞名重建仍会失败 → park，由调用方处理（不在此冒进）。
export function deleteBranch(repoDir: string, branch: string): void {
  try {
    runSync('git', ['-C', repoDir, 'branch', '-D', branch]);
  } catch {
    /* 分支不存在 / 删除失败：不冒进 */
  }
}

// 孤儿 worktree 清扫决策（纯函数，导出供单测）。给一批 on-disk worktree（含目录 mtime 年龄）+ session 归属，
// 决定哪些可清。**保守三不碰**：① 非终态 session 在用的（含 STALLED/FAILED/dead-letter 留给人工查/重试）；
// ② 太新的（age < minAgeMs：可能正在建、worktree_path 尚未落库，清了会毁在建）；③ 既无 SHIPPED owner、又非
// forge 命名（`-forge-`）的（别误删用户/他人 worktree）。**只清**：SHIPPED 终态遗留（ackMerged 清理失败/漏跑）、
// 以及无任何 owner 的 forge 命名孤儿（DB 重置等残留）。
export function planWorktreeSweep(args: {
  onDisk: { path: string; ageMs: number }[];
  shippedPaths: Set<string>; // SHIPPED session 的 worktree_path
  livePaths: Set<string>; // 非 SHIPPED session 的 worktree_path（在用，绝不碰）
  minAgeMs: number; // 年龄保护窗
}): string[] {
  const out: string[] = [];
  for (const w of args.onDisk) {
    if (args.livePaths.has(w.path)) continue; // 在用
    if (w.ageMs < args.minAgeMs) continue; // 太新，可能在建
    if (args.shippedPaths.has(w.path)) {
      out.push(w.path); // SHIPPED 遗留
      continue;
    }
    // 无 owner 的 forge 孤儿：新约定按路径段 `/.forge/worktrees/`；兼容清理旧约定的 `<repo>-forge-<key>` 命名残留。
    if (w.path.includes(WORKTREE_DIR_SEGMENT) || /-forge-/.test(basename(w.path))) out.push(w.path);
  }
  return out;
}
