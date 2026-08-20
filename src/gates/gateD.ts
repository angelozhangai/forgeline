// 闸D 开 PR：闸C 绿后由有权限的人触发，委托目标项目 forge-create-pr.sh 推分支 + 建 PR（**绝不自动 merge**）。
// 被对抗的产物仍是 worktree 状态（复用闸C 的 ImplEnvelope）；开 PR 只是把 worktree 分支暴露成 PR，供闸D codex 审 diff。
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionLogDir } from '../util/render.ts';
import { projectForSession } from '../projects.ts';
import { interp } from '../util/worktree.ts';
import { run } from '../util/proc.ts';
import { loadConfig } from '../config.ts';
import { readImplEnvelope, gateCContext } from './gateC.ts';
import { getLegs, patchLeg, type Leg } from './legs.ts';
import { diffStatSince } from './ci.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import type { Session } from '../types.ts';

function tail(s: string, n = 2000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

// 从 forge-create-pr.sh 的 stdout 取 PR URL（约定：末行即 URL）。
function parsePrUrl(stdout: string): string {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^https?:\/\//.test(last) ? last : '';
}

// 从 GitHub PR URL 解析编号（.../pull/123 → 123）。取不到返回 null（不阻断）。
function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// PR 描述：标题 + 技术方案/需求上下文 + diff stat（M3 精简版；M4 的 merge-readiness 更全）。
function buildPrBody(s: Session, repo: string, diffStat: string): string {
  return [
    `## ${s.title || s.slug}${repo && repo !== '.' ? `（${repo}）` : ''}`,
    '',
    '> 本 PR 由 forge 闸C（实现 + 本地 CI 绿）产出，进入闸D（codex 对抗 review）。**严禁自动合并**——合并永远人工。',
    '',
    '### 需求 / 技术方案',
    gateCContext(s).slice(0, 4000),
    '',
    '### 改动概览',
    '```',
    diffStat || '（无 diff stat）',
    '```',
  ].join('\n');
}

// 文件名安全的仓键（'.' → 'root'；非字母数字 → '-'）。供 per-leg PR body 文件名用。
function repoFileKey(repo: string): string {
  return repo === '.' ? 'root' : repo.replace(/[^a-zA-Z0-9]+/g, '-');
}

// 为一条 worktree 开 PR（委托 proj.scripts.create_pr，cwd=worktree，脚本据自身位置定位仓根=该 worktree）。返回 PR URL。失败抛。
async function createPr(s: Session, proj: ReturnType<typeof projectForSession>, repo: string, wt: string, baseSha: string): Promise<string> {
  mkdirSync(sessionLogDir(s.id), { recursive: true });
  const bodyPath = resolve(sessionLogDir(s.id), `pr-body-${repoFileKey(repo)}.md`);
  writeFileSync(bodyPath, buildPrBody(s, repo, diffStatSince(wt, baseSha))); // 现场重算该仓 diff（绝不依赖可能被切 leg 覆盖的 gate-c.json）
  const title = `${(s.title || s.slug).slice(0, 110)}${repo && repo !== '.' ? ` (${repo})` : ''}`.slice(0, 120);
  const script = resolve(wt, proj.scripts.create_pr as string);
  const [bin, args] = interp(script, ['--title', title, '--body-file', bodyPath, '--base', s.branch]);
  const r = await run(bin, args, { cwd: wt, timeoutMs: (loadConfig().runtime.gate_d?.ci_timeout_sec ?? 1800) * 1000 });
  if (r.code !== 0) throw new Error(`开 PR 失败（${repo}，退码 ${r.code}）：${tail(r.stdout + r.stderr)}`);
  const url = parsePrUrl(r.stdout);
  if (!url) throw new Error(`开 PR 脚本未在末行输出 PR URL（${repo}）：${tail(r.stdout + r.stderr)}`);
  return url;
}

// 开 PR：**每条 leg 一个 PR**（每仓一树一PR）。失败抛 → worker 停泊 GATE_D_FAILED。脚本幂等；本地已记 pr_url 的 leg 跳过（不重复外向写）。
// 兜底：无 legs（旧 in-flight session）→ 退回基于 session worktree 的单 PR（旧行为）。session.pr_url 落 primary leg 的（向后兼容闸D loop/notify；逐仓审见 2c）。
export async function openReviewPr(s: Session): Promise<void> {
  const proj = projectForSession(s);
  if (!proj.scripts.create_pr) throw new Error('目标项目未配置 scripts.create_pr——闸D 开 PR 必走委托脚本（绝不在 forge 重造 gh）');
  const legs = getLegs(s);
  if (!legs.length) {
    // 旧 in-flight（无 legs）：单 PR，基于 session 信封。
    if (s.pr_url) {
      await appendEvent(s.id, 'gated_pr_reused', { url: s.pr_url, number: s.pr_number ?? null });
      return;
    }
    const env = readImplEnvelope(s);
    if (!env.worktree_path) throw new Error('闸D 开 PR 缺 worktree_path（闸C 信封异常）');
    const url = await createPr(s, proj, '.', env.worktree_path, env.base_sha);
    await patch(s.id, { pr_url: url, pr_number: parsePrNumber(url) });
    await appendEvent(s.id, 'gated_pr_opened', { url, number: parsePrNumber(url) });
    return;
  }
  for (const leg of legs as Leg[]) {
    if (!leg.worktree_path) continue; // 未建树（理论上 2b setup 全建了）
    if (leg.pr_url) {
      await appendEvent(s.id, 'gated_pr_reused', { repo: leg.repo, url: leg.pr_url, number: leg.pr_number ?? null });
      continue;
    }
    const url = await createPr(s, proj, leg.repo, leg.worktree_path, leg.base_sha ?? '');
    await patchLeg(s, leg.repo, { pr_url: url, pr_number: parsePrNumber(url) }); // patchLeg 内部从 DB 重读，多 leg 连写不互相覆盖
    await appendEvent(s.id, 'gated_pr_opened', { repo: leg.repo, url, number: parsePrNumber(url) });
  }
  // session.pr_url = primary leg 的（向后兼容：闸D loop 当前审 session.pr_url；逐仓审 2c）。
  const primary = getLegs((await get(s.id)) ?? s)[0];
  if (primary?.pr_url) await patch(s.id, { pr_url: primary.pr_url, pr_number: primary.pr_number ?? null });
}
