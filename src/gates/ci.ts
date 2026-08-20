// 下游闸C/闸D 的「确定性 CI 闸」+ worktree git 读写助手。
// CI 是 reviewFixLoop 里替代 codex 的 reviewer：跑目标项目委托的 CI 脚本（forge-ci.sh），
// 绿=LGTM、红=CHANGES。CI 绝不在 forge 重造、绝不裸 nx——没配 scripts.ci 即视为「跑不起来」交人工。
import { run, runSync } from '../util/proc.ts';
import { interp } from '../util/worktree.ts';

function tail(s: string, n = 4000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

export interface CiResult {
  ok: boolean; // 退出码 0（全绿）
  ran: boolean; // 脚本真跑起来了（false=spawn 失败/超时/未配置 → 调用方 park，不当成红）
  summary: string; // 截断的 stdout+stderr（红时喂 claude 续修；绿时留痕）
}

// 在 worktree 跑委托 CI 脚本（cwd=worktree，脚本据自身位置定位仓根 = 该 worktree）。
// ciScriptAbs 缺省（项目未配 scripts.ci）→ ran:false（绝不回退裸 nx；下游必须委托项目 CI）。
export async function runCi(
  worktreePath: string,
  ciScriptAbs: string | undefined,
  opts: { timeoutMs?: number; base?: string } = {},
): Promise<CiResult> {
  if (!ciScriptAbs) {
    return { ok: false, ran: false, summary: '目标项目未配置 scripts.ci——下游必须委托项目本地 CI 脚本（绝不在 forge 重造/裸 nx）' };
  }
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const baseArgs = opts.base ? ['--base', opts.base] : [];
  const [bin, args] = interp(ciScriptAbs, ['affected', ...baseArgs]);
  const r = await run(bin, args, { cwd: worktreePath, timeoutMs });
  if (r.code === null) return { ok: false, ran: false, summary: `CI 脚本无法启动：${tail(r.stderr)}` };
  if (r.timedOut) return { ok: false, ran: false, summary: `CI 超时（${Math.round(timeoutMs / 1000)}s）` };
  return { ok: r.code === 0, ran: true, summary: tail(r.stdout + r.stderr) };
}

// ── worktree git 读写助手（同步小命令；失败降级不抛，绝不冒进）──────────────────

// base..HEAD 是否有提交（=是否已实现并落 commit）。
export function hasCommitsSince(worktreePath: string, baseSha: string): boolean {
  try {
    return runSync('git', ['-C', worktreePath, 'rev-list', '--count', `${baseSha}..HEAD`]).trim() !== '0';
  } catch {
    return false;
  }
}

// base..HEAD 的 --stat 摘要（落 ImplEnvelope 展示）。
export function diffStatSince(worktreePath: string, baseSha: string): string {
  try {
    return tail(runSync('git', ['-C', worktreePath, 'diff', '--stat', `${baseSha}..HEAD`]).trim(), 2000);
  } catch {
    return '';
  }
}

// base..HEAD 改动文件清单。
export function changedFilesSince(worktreePath: string, baseSha: string): string[] {
  try {
    return runSync('git', ['-C', worktreePath, 'diff', '--name-only', `${baseSha}..HEAD`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 推 worktree 当前分支到 origin（闸D：CI 绿后更新 PR 分支）。upstream 已由开 PR 的 push -u 设好。
// 失败返回 ok:false（调用方据此停泊，绝不假装推成功）。
export function pushWorktree(worktreePath: string): { ok: boolean; output: string } {
  try {
    const out = runSync('git', ['-C', worktreePath, 'push']);
    return { ok: true, output: out.slice(0, 300) };
  } catch (e) {
    return { ok: false, output: String(e).slice(0, 300) };
  }
}

// worktree 是否干净（无未提交改动）。CI/push 前据此确认：CI 验的、push 的，都是 HEAD 那个提交，
// 而非脏 working tree（否则 CI 绿证明不了被 push 的提交）。查不了 → 保守判脏（false），逼调用方停泊。
export function worktreeClean(worktreePath: string): boolean {
  try {
    return runSync('git', ['-C', worktreePath, 'status', '--porcelain']).trim() === '';
  } catch {
    return false;
  }
}

// 回滚 worktree 到指定提交并清未跟踪文件（reset --hard + clean -fd；-fd 不碰 .gitignore，故 node_modules 等保留）。
// 闸D 改方未达「CI 绿并推」时复位——绝不把红/未验证的 commit 留在 HEAD，被下个 tick 的 codex review-first 直接 LGTM
// 推进而绕过 CI 绿前置（Codex 闸D Blocker）。
// reset/clean 退 0 ≠ 真干净：clean -fd 跳过嵌套 git repo/submodule 残留仍退 0（Codex SF）。故复位后**再验一次** porcelain，
// 非空即 ok:false——「复位成功」必须意味着「树确已干净在 sha」，否则调用方会据此放行一个仍脏的树进 review。
// 失败返回 ok:false，调用方据此升级停泊（不能假装复位成功）。
export function resetWorktree(worktreePath: string, sha: string): { ok: boolean; output: string } {
  try {
    runSync('git', ['-C', worktreePath, 'reset', '--hard', sha]);
    runSync('git', ['-C', worktreePath, 'clean', '-fd']);
    const dirty = runSync('git', ['-C', worktreePath, 'status', '--porcelain']).trim();
    if (dirty) return { ok: false, output: `复位后 worktree 仍非 clean（嵌套 repo/submodule 残留？）：${dirty.slice(0, 200)}` };
    return { ok: true, output: '' };
  } catch (e) {
    return { ok: false, output: String(e).slice(0, 300) };
  }
}

// 把 claude 这轮在 worktree 的全部改动落一个提交（forge 拥有 git，claude 只管写码）。
// --no-verify 跳过目标项目 husky（这是 WIP 提交；真闸是 forge-ci.sh）；显式 author 防 worktree 缺 user 配置。
// 返回 ok/committed 二维区分三态（关键——绝不能把「提交失败」和「无改动」混为一谈，见 Codex 闸D Blocker）：
//  · ok:false              提交失败（git 异常；此时 add -A 可能已把改动留在 index → worktree 脏）→ 调用方必须停泊。
//  · ok:true, committed:false  无改动（worktree 本就 clean，没东西可提交）。
//  · ok:true, committed:true   正常落了一个提交（提交后 worktree clean）。
export function commitWorktree(worktreePath: string, message: string): { ok: boolean; committed: boolean; output: string } {
  try {
    runSync('git', ['-C', worktreePath, 'add', '-A']);
    const status = runSync('git', ['-C', worktreePath, 'status', '--porcelain']).trim();
    if (!status) return { ok: true, committed: false, output: '无改动，跳过提交' };
    const out = runSync('git', [
      '-C', worktreePath,
      '-c', 'user.name=forge',
      '-c', 'user.email=forge@local',
      'commit', '-m', message, '--no-verify',
    ]);
    return { ok: true, committed: true, output: out.slice(0, 500) };
  } catch (e) {
    return { ok: false, committed: false, output: String(e).slice(0, 300) };
  }
}
