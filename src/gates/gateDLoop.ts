// 闸D「PR 对抗 review」循环：复用 reviewFixLoop 引擎，**这是 claude+codex 异质互审真正发力处**：
//  · review() = codex（cwd=worktree，只读）审 base..HEAD 的 diff → VerdictSchema（LGTM / CHANGES + findings）。
//  · fix()    = claude（cwd=worktree）按 codex 意见改文件 → forge 落提交 → **本地 CI 必须绿才推**分支更新 PR。
//  · 被对抗的产物是 worktree 状态：diff 由 forge 现场重建（git），绝不从模型输出解析代码（同闸C）。
// 复用引擎 → 自动获得：轮次/每-tick 上限/needs_human 升级/到上限停泊/解析自愈/残留落库/双侧会话 resume。
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import {
  VerdictSchema,
  GateCFixResultSchema,
  GATE_D_VERDICT_CONTRACT,
  GATE_D_FIX_CONTRACT,
  parseHumanAsks,
  findingsToMd,
} from './envelopes.ts';
import type { ImplEnvelope, Verdict } from './envelopes.ts';
import { persistGateC, readImplEnvelope, gateCContext } from './gateC.ts';
import { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, pushWorktree, worktreeClean, resetWorktree } from './ci.ts';
import { worktreeHeadSha } from '../util/worktree.ts';
import { projectForSession } from '../projects.ts';
import { runCodex } from '../llm/runCodex.ts';
import { runClaude } from '../llm/runClaude.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

// fix 内「CI 红→claude 自修」的有限轮数（CI 夹在 fix 内）：超过仍红才停泊交人。初始改方 + 这么多轮自修。
// 一次 drv.fix 内「初轮 + ≤本数 次 CI 自修」的 CI 自修轮上限。导出供 tick 锁宽限估算单 tick 最长合法时长。
export const MAX_CI_FIX_ATTEMPTS = 2;

function gateDConfig(s: Session): ReviewFixConfig<ImplEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.gate_d?.max_rounds ?? 3);
  const perTick = Math.max(1, Math.min(max, cfg.runtime.gate_d?.max_rounds_per_tick ?? 1));
  const cur = async (): Promise<Session> => (await get(s.id))!; // 每次现读 DB（get 现 async）
  const pid = projectForSession(s).id;

  return {
    label: '闸D PR 复审',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), {
        ERROR: error,
        CONTRACT: kind === 'verdict' ? GATE_D_VERDICT_CONTRACT : GATE_D_FIX_CONTRACT,
      }),
    getRound: async () => (await cur()).gate_d_round ?? 0,
    setRound: async (n) => {
      await patch(s.id, { gate_d_round: n });
    },
    getReviewerSession: async () => (await cur()).gate_d_reviewer_session,
    setReviewerSession: async (id) => {
      await patch(s.id, { gate_d_reviewer_session: id });
    },
    getFixerSession: async () => (await cur()).gate_d_fixer_session,
    setFixerSession: async (id) => {
      await patch(s.id, { gate_d_fixer_session: id });
    },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_d_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => {
      await patch(s.id, { gate_d_fix_fail_streak: n });
    },
    loadArtifact: async () => readImplEnvelope(await cur()),
    persistArtifact: async (art) => persistGateC(await cur(), art),
    peekHumanAnswer: async () => {
      const c = await cur();
      const pending = (c.gate_d_pending_input ?? '').trim();
      if (!pending) return null;
      let ctx = '';
      const asks = parseHumanAsks(c.gate_d_human_asks);
      if (asks.length) {
        ctx += `The points you escalated last round, awaiting the owner's decision:\n${asks.map((a, i) => `${i + 1}. ${a.question}`).join('\n')}\n\n`;
      }
      try {
        const r = c.gate_d_residual ? (JSON.parse(c.gate_d_residual) as { findings?: Verdict['findings'] }) : null;
        if (r?.findings?.length) ctx += `codex findings still unresolved:\n${findingsToMd(r.findings)}\n\n`;
      } catch {
        /* 残留坏 JSON 忽略 */
      }
      return `${ctx}**The owner's (M) decision**:\n${pending}`;
    },
    clearHumanAnswer: async () => {
      const c = await cur();
      await patch(s.id, { gate_d_pending_input: null, gate_d_human_asks: null });
      await appendEvent(s.id, 'gated_human_answer_consumed', { round: c.gate_d_round });
    },
    // 纯构造器保持同步：用进入循环时的 session 快照 s（context/base_sha/worktree_path 进 loop 前已定）。
    buildInitialReviewPrompt: () =>
      render(loadPrompt('gate-d-pr-review.md', pid), {
        CONTEXT: gateCContext(s),
        BASE: readImplEnvelope(s).base_sha,
        WORKTREE: s.worktree_path ?? '',
      }),
    buildResumeReviewPrompt: () =>
      render(loadPrompt('gate-d-pr-review-resume.md', pid), {
        BASE: readImplEnvelope(s).base_sha,
        WORKTREE: s.worktree_path ?? '',
      }),
    parseVerdict: (text) => strictParse(VerdictSchema, text),
    buildInitialFixPrompt: (findings, humanAnswer) => {
      const base = render(loadPrompt('gate-d-fix.md', pid), {
        FINDINGS: findingsToMd(findings),
        WORKTREE: s.worktree_path ?? '',
      });
      return humanAnswer ? `${humanAnswer}\n\n---\n\n${base}` : base;
    },
    buildResumeFixPrompt: (findings, humanAnswer) =>
      render(loadPrompt('gate-d-fix-resume.md', pid), {
        FINDINGS: findingsToMd(findings),
        HUMAN_ANSWER: humanAnswer ?? '',
        WORKTREE: s.worktree_path ?? '',
      }),
    parseFixResult: (text) => {
      try {
        const r = strictParse(GateCFixResultSchema, text);
        // 重建信封：claude 改了 worktree 文件（代码不在 text 里），diff/files 从 git 现场读。
        // 同步解析钩子：用 session 快照 s 读信封（draft_path 进 loop 前已定，循环内不变）。
        const env = readImplEnvelope(s);
        const wt = env.worktree_path;
        const merged: ImplEnvelope = {
          ...env,
          implemented: hasCommitsSince(wt, env.base_sha),
          diff_stat: diffStatSince(wt, env.base_sha),
          files_changed: changedFilesSince(wt, env.base_sha),
          last_summary: r.summary,
        };
        return { artifact: merged, needsHuman: r.needs_human };
      } catch (e) {
        log.warn(`闸D 改方输出解析失败 → 交引擎自愈/停泊：${String(e).slice(0, 160)}`);
        return null;
      }
    },
    persistResidual: async (round, used, findings) => {
      await patch(s.id, { gate_d_residual: JSON.stringify({ round, used, verdict: 'CHANGES_REQUESTED', findings }) });
    },
    note: (kind, detail) => appendEvent(s.id, `gated_${kind}`, detail),
  };
}

function gateDDrivers(s: Session): ReviewFixDrivers {
  const proj = projectForSession(s);
  const cur = async (): Promise<Session> => (await get(s.id))!;
  const dump = (name: string, raw: string): void => {
    try {
      writeFileSync(resolve(sessionLogDir(s.id), name), raw);
    } catch {
      /* 落盘失败不阻断 */
    }
  };
  return {
    // codex 审 worktree 的 diff（cwd=worktree，只读）。on_missing 降级/跳过/报错同闸B。
    review: async (prompt, opts) => {
      const cfg = loadConfig();
      const wt = (await cur()).worktree_path ?? proj.root;
      if (cfg.runtime.adversarial.reviewer === 'codex') {
        const c = await runCodex(
          prompt,
          opts.sessionId ? { threadId: opts.sessionId, label: '闸D·PR审', cwd: wt } : { label: '闸D·PR审', readOnly: true, cwd: wt },
        );
        dump('gated-review.raw.txt', c.raw ?? '');
        if (c.ok) {
          if (c.tokens) await patch(s.id, { gate_d_reviewer_tokens: JSON.stringify(c.tokens) });
          return { ok: true, text: c.result, sessionId: c.threadId, available: true, used: 'codex' };
        }
        if (!c.available) {
          if (cfg.runtime.adversarial.on_missing === 'skip') {
            log.warn('codex 未安装，on_missing=skip → 跳过闸D PR 对抗复审');
            return { ok: false, text: '', sessionId: null, available: false, used: 'codex' };
          }
          if (cfg.runtime.adversarial.on_missing === 'error') throw new Error('codex 不可用且 on_missing=error');
          log.warn('codex 未安装，降级用 claude 自审 PR（独立性弱，装上 codex 自动切回）');
        } else {
          log.warn(`闸D codex 复审失败（${c.error}），降级用 claude`);
        }
      }
      // claude 自审降级（cwd=worktree，无会话续接，每轮重发——独立性弱，仅 codex 缺失时兜底；失败上抛停泊不静默放行）。
      // 审整份 PR diff 同属下游重调用 → 用 gate_d.claude_timeout_sec（缺省回退全局）。
      const r = await runClaude(prompt, { label: '闸D·PR审·claude', cwd: wt, timeoutSec: loadConfig().runtime.gate_d?.claude_timeout_sec });
      dump('gated-review.raw.txt', r.raw ?? '');
      if (!r.ok) return { ok: false, text: '', sessionId: null, available: true, used: 'claude', error: r.error };
      return { ok: true, text: r.result, sessionId: null, available: true, used: 'claude' };
    },
    // claude 按意见改 worktree → 落提交 → **CI 必须绿且 worktree 干净才推**（绝不推红/未验证进 PR）。CI 夹在 fix 内：
    // 红了带 CI 摘要让 claude 有限轮自修；耗尽/基础设施错/任何「未达 CI 绿并推」→ **回滚到 fix 前 HEAD** 再停泊/暂停，
    // 保证「被 review-first 看到的 committed HEAD 永远是 CI 绿的那个」，否则下个 tick codex LGTM 一个红 HEAD 就绕过了 CI 闸（Codex 闸D Blocker）。
    fix: async (prompt, opts) => {
      const env = readImplEnvelope(await cur());
      const wt = env.worktree_path || proj.root;
      const pid = projectForSession(await cur()).id;
      const ciScript = proj.scripts.ci ? resolve(wt, proj.scripts.ci) : undefined;
      const ciTimeout = (loadConfig().runtime.gate_d?.ci_timeout_sec ?? 1800) * 1000;
      const round = ((await cur()).gate_d_round ?? 0) + 1;
      const preHead = worktreeHeadSha(wt); // 回滚锚点 = 上一个 CI 绿并已推的 HEAD（闸C 绿态 / 上一 D 轮推的提交）
      if (!preHead) throw new Error('闸D 改方：取不到 worktree HEAD，无法建立回滚点 → 停泊');
      const claudeTimeout = loadConfig().runtime.gate_d?.claude_timeout_sec; // PR 级修复重，缺省回退全局
      let sid = opts.sessionId;
      const runStep = (p: string): Promise<Awaited<ReturnType<typeof runClaude>>> => {
        if (sid) return runClaude(p, { label: '闸D·改方', resume: sid, cwd: wt, timeoutSec: claudeTimeout });
        sid = randomUUID();
        return runClaude(p, { label: '闸D·改方', sessionId: sid, cwd: wt, timeoutSec: claudeTimeout });
      };
      // 复位到 preHead；复位失败 → 落毒丸标记后抛（绝不带红/脏 HEAD 回到 review-first）。
      // 关键：复位本身失败时，worktree 处于「未确认复位」态。仅抛错不够——worker 停泊 GATE_D_FAILED 后，
      // planRetry 会把已开 PR 的 GATE_D_FAILED 直接送回 GATE_D_LOOP（无论该失败被分类为瞬时/永久），
      // 让红/脏 HEAD 跑进下一次 review-first、绕过 CI 绿前置（Codex 闸D Blocker）。故记 gate_d_rollback_to，
      // 由进 loop 前的 recoverPendingRollback 强制先复位确认才放行。
      const rollback = async (): Promise<void> => {
        const r = resetWorktree(wt, preHead);
        await appendEvent(s.id, 'gated_rollback', { to: preHead.slice(0, 12), ok: r.ok, output: r.output.slice(0, 120) });
        if (!r.ok) {
          await patch(s.id, { gate_d_rollback_to: preHead }); // 毒丸：未确认复位，下次进 loop 前必先复位确认
          throw new Error(`闸D 回滚 worktree 到 ${preHead.slice(0, 12)} 失败 → 停泊（避免红 HEAD 被后续 review 误进）：${r.output.slice(0, 160)}`);
        }
      };
      const bail = async (msg: string): Promise<never> => {
        await rollback();
        throw new Error(msg);
      };

      let res = await runStep(prompt);
      dump('gated-fix.raw.txt', res.raw ?? '');
      // claude 调用失败（瞬时）→ 回滚 + ok:false：引擎暂停重试（不推进 round），且不留任何半成品在 HEAD/worktree。
      if (!res.ok) {
        await rollback();
        return { ok: false, text: res.result, sessionId: null, costUsd: res.costUsd, error: res.error };
      }
      if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });

      // 落提交 + CI；红则有限轮自修。提交失败/CI 前后非 clean/CI 跑不起来/耗尽 → 回滚 + 停泊。
      for (let attempt = 0; ; attempt++) {
        const cm = commitWorktree(wt, `forge(闸D ${s.slug}): round ${round}${attempt ? ` CI 修${attempt}` : ' fix'}`);
        await appendEvent(s.id, 'gated_commit', { ok: cm.ok, committed: cm.committed, attempt, output: cm.output.slice(0, 160) });
        if (!cm.ok) await bail(`闸D 落提交失败 → 停泊（worktree 可能脏）：${cm.output.slice(0, 200)}`);
        if (!worktreeClean(wt)) await bail('闸D 提交后 worktree 非 clean → 停泊（CI 须验 HEAD，不验脏树）');

        const ci = await runCi(wt, ciScript, { base: env.base_sha || env.base_ref || undefined, timeoutMs: ciTimeout });
        dump('gated-ci.raw.txt', ci.summary);
        if (!ci.ran) await bail(`闸D CI 跑不起来（基础设施）：${ci.summary.slice(0, 200)}`);
        if (ci.ok) {
          // CI 绿后再验一次 clean：委托的 CI 脚本若自身改了 tracked 文件（codegen/format）并退 0，
          // CI 验的就是 HEAD+脏，而 push 只有 HEAD → 仍是「CI 验的对象 ≠ push 的对象」（Codex 二审 Blocker）。
          if (!worktreeClean(wt)) await bail('闸D CI 后 worktree 被改脏 → 停泊（CI 验的对象 ≠ 被 push 的 HEAD；CI 不应改 tracked 文件）');
          break; // 绿 + 前后皆 clean → HEAD 即被验证的提交，去 push
        }
        if (attempt >= MAX_CI_FIX_ATTEMPTS) await bail(`闸D 改方 + ${attempt} 轮自修后本地 CI 仍红 → 停泊交 M（绝不推红进 PR）：${ci.summary.slice(0, 200)}`);
        // 红：带 CI 摘要让 claude 再修一轮（同会话 resume）。自修 claude 瞬断 → 回滚 + 暂停（绝不留红 commit 在 HEAD）。
        res = await runStep(render(loadPrompt('gate-d-ci-fix.md', pid), { CI: ci.summary.slice(0, 3000), WORKTREE: wt }));
        dump('gated-fix.raw.txt', res.raw ?? '');
        if (!res.ok) {
          await rollback();
          return { ok: false, text: res.result, sessionId: null, costUsd: res.costUsd, error: res.error };
        }
        if (res.costUsd != null) await patch(s.id, { gate_d_cost_usd: ((await cur()).gate_d_cost_usd ?? 0) + res.costUsd });
      }

      const pushed = pushWorktree(wt);
      if (!pushed.ok) await bail(`闸D 推分支更新 PR 失败：${pushed.output.slice(0, 200)}`);
      await appendEvent(s.id, 'gated_pushed', { round });
      return { ok: true, text: res.result, sessionId: sid, costUsd: res.costUsd };
    },
  };
}

// 进 loop 前的毒丸守门：上一轮改方回滚失败会留 gate_d_rollback_to（worktree 处「未确认复位」态）。
// 无论该失败被 classifyError 判瞬时(reconcile 自动退避重试)还是永久(人工 retry)，planRetry 都会把已开 PR 的
// GATE_D_FAILED 送回 GATE_D_LOOP——若不在 review-first 跑之前强制复位确认，就会让红/脏 HEAD 进 review、绕过 CI 绿前置。
// 故：标记在 → 先 resetWorktree 复位（其内部已再验 clean）→ 成功才清标记放行；失败抛错继续停泊/死信。
// 放行只认「复位确认成功」这一确定性事实，绝不靠错误文案分类（Codex 闸D Blocker）。
async function recoverPendingRollback(s: Session): Promise<void> {
  const c = (await get(s.id))!;
  const target = (c.gate_d_rollback_to ?? '').trim();
  if (!target) return;
  const wt = c.worktree_path;
  if (!wt) {
    await appendEvent(s.id, 'gated_rollback_recover', { ok: false, reason: 'missing_worktree_path', to: target.slice(0, 12) });
    throw new Error('闸D 回滚恢复：标记要求复位但 worktree_path 缺失 → 继续停泊');
  }
  const r = resetWorktree(wt, target);
  await appendEvent(s.id, 'gated_rollback_recover', { to: target.slice(0, 12), ok: r.ok, output: r.output.slice(0, 120) });
  if (!r.ok) throw new Error(`闸D 回滚恢复失败：worktree 仍无法复位到 ${target.slice(0, 12)} → 继续停泊（绝不带红/脏 HEAD 进 review）：${r.output.slice(0, 160)}`);
  await patch(s.id, { gate_d_rollback_to: null }); // 复位确认成功 → 清毒丸，放行进 review-first
}

// 跑一段闸D PR 对抗循环（worker 在 GATE_D_LOOP / GATE_D_REVISION_REQUESTED 调），返回结论交 worker 转移。
// async：让 recoverPendingRollback 的同步抛也成为 promise rejection（worker await-in-try 统一捕获停泊）。
export async function runGateDLoop(s: Session): Promise<ReviewFixOutcome> {
  await recoverPendingRollback(s); // 毒丸守门：未确认复位的 worktree 绝不进 review-first
  return runReviewFixLoop(gateDConfig(s), gateDDrivers(s));
}
