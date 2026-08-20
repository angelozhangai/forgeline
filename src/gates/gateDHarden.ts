// 闸D 测试补强（GATE_D_HARDENING）：codex LGTM 后的最后一道——claude 补**内环**测试（失败/权限/并发路径，
// 杜绝镜像测试）+ 本地 CI 必须再次全绿 → 生成 merge-readiness 报告 → 推分支 → worker 置 AWAITING_HUMAN_MERGE。
//
// 不变量（沿用闸D fix 那套，且更省一层）：
// - 被补强的产物是 worktree 状态；diff/CI 由 forge 现场重建，绝不解析模型输出的代码。
// - **CI 验的对象 == 被 push 的对象**：commit-before-CI、CI 前后皆 clean、红则有限轮自修。
// - **绿态基线 = 闸D LGTM 时 pin 的不可变 sha**（worker.afterGateD 落 gate_d_green_sha）：补强前 `reset --hard <green-sha>`
//   丢弃上轮中途死/失败残留的补强改动——故重入幂等。**绝不用移动 ref origin/<branch>**（陈旧/缺失/被 force-push 会让
//   harden/CI/push 的对象 ≠ 被 codex 审过的对象，Codex M4 Blocker）。
// - **CI 绿前任何失败一律回滚到绿态基线再停泊**；CI 绿确认后 pin 下 gate_d_harden_verified_sha 锁定该提交，此后写报告
//   （forge 本地决策文档，非 PR 产物）+ 推**代码**提交，失败不回滚（绝不丢已验证工作）。幂等收尾只在「HEAD 仍 == verified_sha 且干净」时补推（绝不盲推未验证对象，Codex M4 SF）。
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { GateCFixResultSchema } from './envelopes.ts';
import type { ImplEnvelope } from './envelopes.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import { persistGateC, readImplEnvelope, gateCContext } from './gateC.ts';
import { getLegs } from './legs.ts';
import { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, pushWorktree, worktreeClean, resetWorktree } from './ci.ts';
import { worktreeHeadSha } from '../util/worktree.ts';
import { projectForSession } from '../projects.ts';
import { runClaude } from '../llm/runClaude.ts';
import type { Session } from '../types.ts';

// 补强后「CI 红→自修」的有限轮数：超过仍红即停泊交人（绝不带红进合并就绪）。
const MAX_HARDEN_CI_FIX_ATTEMPTS = 2;

// 据 runtime.gate_d.harden 配置拼补强硬规则（喂进 gate-d-harden-tests.md 的 {{HARDEN_RULES}}）。
function hardenRules(): string {
  const h = loadConfig().runtime.gate_d?.harden;
  const rules: string[] = [];
  if (h?.forbid_mirror_tests !== false) rules.push('- **No mirror tests**: test observable behavior/contracts — never copy the implementation into assertions, never assert only "was called / non-empty", never mock out the unit under test itself.');
  if (h?.require_failure_path) rules.push('- **Failure paths must be covered**: bad input / exceptions / rejections / timeouts / boundaries — every non-happy path needs a test biting it.');
  if (h?.require_auth_path) rules.push('- **Permission paths must be covered**: unauthorized / privilege escalation / multi-tenant isolation access control needs tests.');
  rules.push('- Cover the **inner-loop** key paths this change touches — concurrency/idempotency, SSE/streaming, DB constraints; the tests must go red when the implementation is wrong.');
  return rules.join('\n');
}

// 残留未决意见（正常 LGTM 解析后 gate_d_residual 已清为 null → 「无」）。坏 JSON 容错为「无」。
function residualNote(s: Session): string {
  if (!s.gate_d_residual) return '- 无未决意见（codex 对抗复审零 Blocker）。';
  try {
    const r = JSON.parse(s.gate_d_residual) as { findings?: { severity?: string; issue?: string; where?: string }[] };
    const fs = r.findings ?? [];
    if (fs.length === 0) return '- 无未决意见（codex 对抗复审零 Blocker）。';
    return fs.slice(0, 12).map((f) => `- [${f.severity ?? '?'}] ${f.issue ?? ''}${f.where ? `（${f.where}）` : ''}`).join('\n');
  } catch {
    return '- 无未决意见（codex 对抗复审零 Blocker）。';
  }
}

// 合并就绪报告 markdown（纯函数，便于单测）：事实性内容确定性拼装——绝不再过一遍 LLM（避免在「过了所有闸、只差出文档」处引入新失败点）。
export function buildMergeReadiness(
  s: Session,
  env: ImplEnvelope,
  opts: { context: string; codexRound: number; hardenSummary: string },
): string {
  const files = env.files_changed ?? [];
  return `# 合并就绪报告 · ${s.title || s.slug}

> 本报告由 forge 闸D 生成。**严禁自动合并**——合并永远由人完成。请人工 review 关键 diff 后再合。

- PR：${s.pr_url ?? '（未记录）'}
- 分支：${env.impl_branch} → ${s.branch}
- 基线：${(env.base_sha ?? '').slice(0, 12) || '?'}（${env.base_ref ?? ''}）

## 需求 / 技术方案

${opts.context.slice(0, 4000) || '（无上下文）'}

## 改动概览

\`\`\`
${env.diff_stat || '（无 diff stat）'}
\`\`\`
${files.length ? `\n改动文件（${files.length}）：\n${files.map((f) => `- ${f}`).join('\n')}\n` : ''}
## 对抗复审（codex 审 diff ⇄ claude 改）

- 结论：通过（第 ${opts.codexRound} 轮 codex LGTM，本地 CI 全绿才推）。

## 测试补强（内环）

- ${opts.hardenSummary || '已补内环测试（失败/权限/并发等关键路径），杜绝镜像测试。'}
- 本地 CI：补强后全绿。

## 剩余风险 / Accepted Risk

${residualNote(s)}

## 回滚方案

- 合并后如需回滚：在 PR 合并页点 Revert，或 \`git revert -m 1 <merge-commit-sha>\` 另开 PR 回退。

## 合并前/后必跑

- 目标项目 CI（forge-ci.sh affected，与 forge 本地所跑同一套）。
- 合并到主干后建议跑一次受影响 e2e（按项目约定）。
`;
}

function activeReportRepo(s: Session): string | null {
  const legs = getLegs(s);
  if (legs.length <= 1) return null;
  const active = legs.find((l) => l.worktree_path && l.worktree_path === s.worktree_path);
  if (active?.repo) return active.repo;
  try {
    const keys = Object.keys(JSON.parse(s.base_shas ?? '{}'));
    return keys.length === 1 ? keys[0] : null;
  } catch {
    return null;
  }
}

function reportFileName(repo: string | null): string {
  if (!repo) return 'merge-readiness.md';
  const safe = repo.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `merge-readiness.${safe}.md`;
}

// 落盘合并就绪报告，返回路径。
function writeMergeReadiness(s: Session, env: ImplEnvelope, opts: { codexRound: number; hardenSummary: string }): string {
  const proj = projectForSession(s);
  const dir = resolve(proj.deliveryDir, s.slug);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, reportFileName(activeReportRepo(s)));
  writeFileSync(path, buildMergeReadiness(s, env, { ...opts, context: gateCContext(s) }));
  return path;
}

// 跑测试补强（worker 在 GATE_D_HARDENING 调）。成功 → 落 merge_readiness_path + 推分支并返回（worker 据此置 AWAITING_HUMAN_MERGE）；
// 任何失败抛 → worker 停泊 GATE_D_FAILED（planRetry 据 gate_d_harden_round>0 回 HARDENING 续补，重入幂等）。
export async function runGateDHarden(s: Session): Promise<void> {
  const proj = projectForSession(s);
  const cur = async (): Promise<Session> => (await get(s.id))!;
  const env = readImplEnvelope(await cur());
  const wt = env.worktree_path || proj.root;
  const pid = proj.id;
  const ciScript = proj.scripts.ci ? resolve(wt, proj.scripts.ci) : undefined;
  const ciTimeout = (loadConfig().runtime.gate_d?.ci_timeout_sec ?? 1800) * 1000;
  const dump = (name: string, raw: string): void => {
    try {
      writeFileSync(resolve(sessionLogDir(s.id), name), raw);
    } catch {
      /* 落盘失败不阻断 */
    }
  };

  // 绿态基线 = 闸D LGTM 时 pin 的不可变 sha（绝不用移动 ref）。缺失 → 拒绝在未知基线上补强。
  const greenSha = ((await cur()).gate_d_green_sha ?? '').trim();
  if (!greenSha) throw new Error('闸D 补强：缺 pin 的绿态 sha（gate_d_green_sha）——拒绝在未知/移动基线上补强 → 停泊');

  // 幂等收尾 fast-path：补强已 CI 绿（verified_sha 在）且 HEAD 仍是那个被验证的提交且干净 → 只补推（绝不盲推未验证对象）。
  // HEAD != verified（隔离树被改/残留/dead-tick）或脏 → 不走 fast-path，落到全量补强重来（reset 回 pin 绿态）。
  const verified = ((await cur()).gate_d_harden_verified_sha ?? '').trim();
  if ((await cur()).merge_readiness_path && verified && worktreeHeadSha(wt) === verified && worktreeClean(wt)) {
    const pushed = pushWorktree(wt);
    await appendEvent(s.id, 'gate_d_harden_pushed', { reused: true, ok: pushed.ok, head: verified.slice(0, 12) });
    if (!pushed.ok) throw new Error(`闸D 补强：补推已验证提交失败：${pushed.output.slice(0, 200)}`);
    return;
  }

  const round = ((await cur()).gate_d_harden_round ?? 0) + 1;
  // 进全量补强：先置位 harden_round（任何后续失败都让 planRetry 回 HARDENING）；清陈旧报告/已验证 sha（下面重新生成，绝不让旧 verified 触发 fast-path 误推）。
  await patch(s.id, { gate_d_harden_round: round, merge_readiness_path: null, gate_d_harden_verified_sha: null });

  // 规范化到 pin 的绿态 sha：丢弃上轮中途死/失败残留的补强改动（干净首入即 no-op）。
  const norm = resetWorktree(wt, greenSha);
  await appendEvent(s.id, 'gate_d_harden_reset', { to: greenSha.slice(0, 12), ok: norm.ok, output: norm.output.slice(0, 120) });
  if (!norm.ok) throw new Error(`闸D 补强：规范化到绿态 ${greenSha.slice(0, 12)} 失败 → 停泊（绝不在残留树上补强）：${norm.output.slice(0, 160)}`);
  const head = worktreeHeadSha(wt);
  if (head !== greenSha) throw new Error(`闸D 补强：reset 后 HEAD(${head?.slice(0, 12) ?? '?'}) ≠ pin 绿态(${greenSha.slice(0, 12)}) → 停泊`);
  const preHead = greenSha; // 回滚锚点 = pin 的绿态（不可变）

  // CI 绿前任何失败 → 回滚到 pin 绿态再停泊（回滚失败也抛，下轮重入会再 reset 兜底）。
  const rollback = async (): Promise<void> => {
    const r = resetWorktree(wt, preHead);
    await appendEvent(s.id, 'gate_d_harden_rollback', { to: preHead.slice(0, 12), ok: r.ok });
    if (!r.ok) throw new Error(`闸D 补强回滚到 ${preHead.slice(0, 12)} 失败 → 停泊：${r.output.slice(0, 160)}`);
  };
  const bail = async (msg: string): Promise<never> => {
    await rollback();
    throw new Error(msg);
  };

  // claude 续接闸D 改方会话（同 worktree 上下文）补内环测试。补强同属下游重调用 → 用 gate_d.claude_timeout_sec（缺省回退全局）。
  const claudeTimeout = loadConfig().runtime.gate_d?.claude_timeout_sec;
  let sid = (await cur()).gate_d_fixer_session;
  const runStep = async (p: string): Promise<Awaited<ReturnType<typeof runClaude>>> => {
    if (sid) return runClaude(p, { label: '闸D·补强', resume: sid, cwd: wt, timeoutSec: claudeTimeout });
    sid = randomUUID();
    await patch(s.id, { gate_d_fixer_session: sid });
    return runClaude(p, { label: '闸D·补强', sessionId: sid, cwd: wt, timeoutSec: claudeTimeout });
  };

  let res = await runStep(
    render(loadPrompt('gate-d-harden-tests.md', pid), {
      WORKTREE: wt,
      DIFF_STAT: env.diff_stat || '（无 diff stat）',
      CONTEXT: gateCContext(await cur()).slice(0, 4000),
      HARDEN_RULES: hardenRules(),
    }),
  );
  dump('gated-harden.raw.txt', res.raw ?? '');
  if (!res.ok) await bail(`闸D 补强 claude 失败：${res.error}`);
  if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });
  let hardenSummary = '';
  try {
    hardenSummary = strictParse(GateCFixResultSchema, res.result).summary;
  } catch {
    hardenSummary = ''; // 补强真闸是 CI 绿，不是 JSON——解析失败不阻断，摘要留空
  }

  // 落提交 + CI 绿（有限轮自修）；同闸D fix 不变量：commit→clean→CI→（绿且 clean 才过）。
  let lastCi = '';
  for (let attempt = 0; ; attempt++) {
    const cm = commitWorktree(wt, `forge(闸D 补强 ${s.slug}): round ${round}${attempt ? ` CI 修${attempt}` : ''}`);
    await appendEvent(s.id, 'gate_d_harden_commit', { ok: cm.ok, committed: cm.committed, attempt });
    if (!cm.ok) await bail(`闸D 补强落提交失败 → 停泊（worktree 可能脏）：${cm.output.slice(0, 200)}`);
    if (!worktreeClean(wt)) await bail('闸D 补强提交后 worktree 非 clean → 停泊（CI 须验 HEAD）');
    const ci = await runCi(wt, ciScript, { base: env.base_sha || env.base_ref || undefined, timeoutMs: ciTimeout });
    dump('gated-harden-ci.raw.txt', ci.summary);
    lastCi = ci.summary;
    if (!ci.ran) await bail(`闸D 补强 CI 跑不起来（基础设施）：${ci.summary.slice(0, 200)}`);
    if (ci.ok) {
      if (!worktreeClean(wt)) await bail('闸D 补强 CI 后 worktree 被改脏 → 停泊（CI 验的对象 ≠ 被 push 的 HEAD）');
      break; // 绿 + 前后皆 clean → HEAD 即被验证的提交
    }
    if (attempt >= MAX_HARDEN_CI_FIX_ATTEMPTS) await bail(`闸D 补强 + ${attempt} 轮自修后本地 CI 仍红 → 停泊交人工（绝不带红进合并就绪）：${ci.summary.slice(0, 200)}`);
    res = await runStep(render(loadPrompt('gate-d-ci-fix.md', pid), { CI: ci.summary.slice(0, 3000), WORKTREE: wt }));
    dump('gated-harden.raw.txt', res.raw ?? '');
    if (!res.ok) await bail(`闸D 补强自修 claude 失败：${res.error}`);
    if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });
  }

  // CI 绿 + 前后皆 clean：补强工作已锁定（committed、被验证）。**pin 下被验证的 HEAD sha**作幂等收尾守门——
  // 此后写报告 + 推，失败不回滚（绝不丢已验证工作）；下轮重入只在 HEAD 仍 == 此 sha 时补推（绝不盲推）。
  const verifiedSha = worktreeHeadSha(wt);
  if (!verifiedSha) throw new Error('闸D 补强：CI 绿后取不到 HEAD sha → 停泊（无法锚定幂等收尾）');
  await patch(s.id, { gate_d_harden_verified_sha: verifiedSha });

  const finalEnv: ImplEnvelope = {
    ...env,
    implemented: hasCommitsSince(wt, env.base_sha),
    diff_stat: diffStatSince(wt, env.base_sha),
    files_changed: changedFilesSince(wt, env.base_sha),
    ci_ok: true,
    ci_summary: lastCi.slice(0, 2000),
    last_summary: hardenSummary,
  };
  await persistGateC(await cur(), finalEnv);
  // merge-readiness 是 **forge 本地决策文档**（落 docs/delivery/<slug>/，非 PR 产物，不随分支推送）。
  const mdPath = writeMergeReadiness(await cur(), finalEnv, { codexRound: (await cur()).gate_d_round ?? 1, hardenSummary });
  await patch(s.id, { merge_readiness_path: mdPath });
  await appendEvent(s.id, 'gate_d_merge_readiness', { path: mdPath });

  // 推**代码**提交更新 PR 分支（报告不在内）。失败不回滚——verified_sha 已 pin，下轮幂等收尾会补推这个被验证的提交。
  const pushed = pushWorktree(wt);
  if (!pushed.ok) throw new Error(`闸D 补强推分支失败（已验证提交 ${verifiedSha.slice(0, 12)} 留存，下轮幂等补推）：${pushed.output.slice(0, 200)}`);
  await appendEvent(s.id, 'gate_d_harden_pushed', { round, head: verifiedSha.slice(0, 12) });
  log.ok(`${s.slug}: 闸D 测试补强完成（第${round}轮）+ 本地 CI 全绿 + 已推 → 合并就绪`);
}
