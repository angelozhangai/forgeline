// 闸C「实现⇄CI」循环：复用 reviewFixLoop 引擎，但 **reviewer = 确定性 CI/验收**（非 codex）：
//  · review() = 在 worktree 跑委托 CI（forge-ci.sh）。绿→LGTM；红/未实现→CHANGES（findings=失败摘要）。
//  · fix()    = claude 在 worktree 改文件（cwd=worktree）+ forge 落提交（claude 只写码、forge 拥有 git）。
//  · 被对抗的产物是 worktree 状态：diff/CI 由 forge 现场重建（git/CI），绝不从模型输出解析代码。
// 复用引擎 → 自动获得：轮次/每-tick 上限/needs_human 升级/到上限停泊/改方解析自愈/残留落库。
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import { GateCFixResultSchema, GATE_C_FIX_CONTRACT, parseHumanAsks, findingsToMd } from './envelopes.ts';
import type { ImplEnvelope } from './envelopes.ts';
import { persistGateC, readImplEnvelope, gateCContext } from './gateC.ts';
import { runCi, hasCommitsSince, diffStatSince, changedFilesSince, commitWorktree, worktreeClean } from './ci.ts';
import { projectForSession } from '../projects.ts';
import { runClaude } from '../llm/runClaude.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome, ReviewVerdict } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

// CI affected 的 base：优先 **pin 住的 base_sha**（worktree 即 pin 在此 sha）；base_ref 仅兜底。
// 绝不默认用移动 ref base_ref=origin/<branch>——并发 refresh() 推进它时 affected 会按未来基线算 → 误测/漏测/假绿（Codex B2）。导出供单测。
export function ciBase(env: Pick<ImplEnvelope, 'base_sha' | 'base_ref'>): string | undefined {
  return env.base_sha || env.base_ref || undefined;
}

// CI 驱动产出的状态文本 → ReviewVerdict（确定性，绝不抛——故不走 schema 自愈）。导出供单测。
export function ciTextToVerdict(text: string): ReviewVerdict {
  let o: { state?: string; summary?: string };
  try {
    o = JSON.parse(text) as { state?: string; summary?: string };
  } catch {
    o = { state: 'ci_red', summary: text };
  }
  if (o.state === 'green') return { verdict: 'LGTM', findings: [] };
  const issue =
    o.state === 'unimplemented'
      ? 'Not implemented yet: the worktree has no commits after base. Implement per the tech design/issue and land the changes in files.'
      : `Local CI/acceptance failed:\n${(o.summary ?? '').slice(0, 3000)}`;
  return { verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'high', issue, where: 'worktree', fix: '', evidence: '' }] };
}

function gateCConfig(s: Session): ReviewFixConfig<ImplEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.gate_c?.max_rounds ?? 4);
  const perTick = Math.max(1, Math.min(max, cfg.runtime.gate_c?.max_rounds_per_tick ?? 1));
  const cur = async (): Promise<Session> => (await get(s.id))!; // 每次现读 DB（get 现 async）
  const pid = projectForSession(s).id;

  return {
    label: '闸C 实现',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (_kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), { ERROR: error, CONTRACT: GATE_C_FIX_CONTRACT }),
    getRound: async () => (await cur()).gate_c_round ?? 0,
    setRound: async (n) => {
      await patch(s.id, { gate_c_round: n });
    },
    // CI 是 reviewer——无状态、无会话，两个 reviewer-session 钩子 no-op。
    getReviewerSession: async () => null,
    setReviewerSession: async () => {
      /* CI 无会话 */
    },
    getFixerSession: async () => (await cur()).gate_c_fixer_session,
    setFixerSession: async (id) => {
      await patch(s.id, { gate_c_fixer_session: id });
    },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_c_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => {
      await patch(s.id, { gate_c_fix_fail_streak: n });
    },
    loadArtifact: async () => readImplEnvelope(await cur()),
    persistArtifact: async (art) => persistGateC(await cur(), art),
    peekHumanAnswer: async () => {
      const c = await cur();
      const pending = (c.gate_c_pending_input ?? '').trim();
      if (!pending) return null;
      let ctx = '';
      const asks = parseHumanAsks(c.gate_c_human_asks);
      if (asks.length) {
        ctx += `The points you escalated last round, awaiting the owner's decision:\n${asks.map((a, i) => `${i + 1}. ${a.question}`).join('\n')}\n\n`;
      }
      return `${ctx}**The owner's (M) decision**:\n${pending}`;
    },
    clearHumanAnswer: async () => {
      const c = await cur();
      await patch(s.id, { gate_c_pending_input: null, gate_c_human_asks: null });
      await appendEvent(s.id, 'gatec_human_answer_consumed', { round: c.gate_c_round });
    },
    // CI reviewer 不吃 prompt（driver 忽略）。纯构造器保持同步。
    buildInitialReviewPrompt: () => '',
    buildResumeReviewPrompt: () => '',
    parseVerdict: (text) => ciTextToVerdict(text),
    // 纯构造器保持同步：用进入循环时的 session 快照 s（context/worktree_path 进 loop 前已定）。
    buildInitialFixPrompt: (findings, humanAnswer) => {
      const base = render(loadPrompt('gate-c-implement.md', pid), {
        CONTEXT: gateCContext(s),
        FINDINGS: findingsToMd(findings),
        WORKTREE: s.worktree_path ?? '',
      });
      return humanAnswer ? `${humanAnswer}\n\n---\n\n${base}` : base; // 防御：首轮一般无人工答复
    },
    buildResumeFixPrompt: (findings, humanAnswer) =>
      render(loadPrompt('gate-c-fix-resume.md', pid), {
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
        log.warn(`闸C 改方输出解析失败 → 交引擎自愈/停泊：${String(e).slice(0, 160)}`);
        return null; // 引擎据此先 resume 回喂重出，耗尽才停泊（绝不静默放行）
      }
    },
    persistResidual: async (round, used, findings) => {
      await patch(s.id, { gate_c_residual: JSON.stringify({ round, used, verdict: 'CHANGES_REQUESTED', findings }) });
    },
    note: (kind, detail) => appendEvent(s.id, `gatec_${kind}`, detail),
  };
}

function gateCDrivers(s: Session): ReviewFixDrivers {
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
    review: async () => {
      const env = readImplEnvelope(await cur());
      const wt = env.worktree_path;
      // base 后无提交 = 尚未实现 → 不跑 CI，直接判「未实现」逼 claude 动工。
      if (!hasCommitsSince(wt, env.base_sha)) {
        return { ok: true, text: JSON.stringify({ state: 'unimplemented' }), sessionId: null, available: true, used: 'ci' };
      }
      const ciScript = proj.scripts.ci ? resolve(wt, proj.scripts.ci) : undefined;
      const ci = await runCi(wt, ciScript, {
        base: ciBase(env), // pin sha 优先，绝不用移动 ref（Codex B2，见 ciBase）
        timeoutMs: (loadConfig().runtime.gate_c?.ci_timeout_sec ?? 1800) * 1000,
      });
      dump('gatec-ci.raw.txt', ci.summary);
      // 信封 CI 字段刷新（展示，best-effort）。
      try {
        await persistGateC(await cur(), { ...env, ci_ok: ci.ok, ci_summary: ci.summary.slice(0, 2000), implemented: true, diff_stat: diffStatSince(wt, env.base_sha) });
      } catch {
        /* 展示刷新失败不阻断 */
      }
      // CI 跑不起来（脚本缺失/spawn 失败/超时）= 基础设施错 → ok:false 上抛停泊（绝不当成红让 claude 白改）。
      if (!ci.ran) {
        return { ok: false, text: '', sessionId: null, available: true, used: 'ci', error: ci.summary };
      }
      // CI 绿但 worktree 被 CI 自身改脏（codegen/format 改了 tracked 文件）→ CI 验的是 HEAD+脏、而产物/PR 是 HEAD，
      // 「CI 绿」对 HEAD 是假阳性 → 当基础设施/契约错停泊（CI 不应改 tracked 文件，同闸D Blocker）。
      if (ci.ok && !worktreeClean(wt)) {
        // 展示纠偏：上面按 ci.ok 把信封刷成了 ci_ok:true，但对 HEAD 是假阳性 → 改回 false 并标注，免停泊后排障误导（Codex SF）。
        try {
          await persistGateC(await cur(), { ...env, ci_ok: false, ci_summary: `green-but-dirty rejected（CI 绿但改脏了 worktree，CI 不应改 tracked 文件）：${ci.summary.slice(0, 1800)}`, implemented: true });
        } catch {
          /* 展示刷新失败不阻断 */
        }
        return { ok: false, text: '', sessionId: null, available: true, used: 'ci', error: `CI 绿但改脏了 worktree（CI 不应改 tracked 文件）：${ci.summary.slice(0, 200)}` };
      }
      return { ok: true, text: JSON.stringify({ state: ci.ok ? 'green' : 'ci_red', summary: ci.summary }), sessionId: null, available: true, used: 'ci' };
    },
    fix: async (prompt, opts) => {
      const wt = (await cur()).worktree_path ?? proj.root;
      // 下游整写代码远重于上游审文档 → 单调用超时用 gate_c.claude_timeout_sec（缺省回退全局）。
      const timeoutSec = loadConfig().runtime.gate_c?.claude_timeout_sec;
      let sid = opts.sessionId;
      let res: Awaited<ReturnType<typeof runClaude>>;
      if (sid) {
        res = await runClaude(prompt, { label: '闸C·实现', resume: sid, cwd: wt, timeoutSec });
      } else {
        sid = randomUUID(); // pin 新会话，便于续做 resume
        res = await runClaude(prompt, { label: '闸C·实现', sessionId: sid, cwd: wt, timeoutSec });
      }
      dump('gatec-fix.raw.txt', res.raw ?? '');
      if (res.ok) {
        // claude 只写码 → forge 落一个 WIP 提交（拥有 git）。--no-verify 跳目标项目 husky（真闸是 forge-ci.sh）。
        const round = ((await cur()).gate_c_round ?? 0) + 1;
        const cm = commitWorktree(wt, `forge(闸C ${s.slug}): round ${round}`);
        await appendEvent(s.id, 'gatec_commit', { ok: cm.ok, committed: cm.committed, output: cm.output.slice(0, 160) });
        if (res.costUsd != null) await patch(s.id, { gate_c_cost_usd: ((await cur()).gate_c_cost_usd ?? 0) + res.costUsd });
        // 提交失败/worktree 脏 → 抛停泊：否则 reviewer 的 CI 验的是脏 working tree、而非 HEAD（同闸D Blocker）。
        if (!cm.ok) throw new Error(`闸C 落提交失败 → 停泊（worktree 可能脏）：${cm.output.slice(0, 200)}`);
        if (!worktreeClean(wt)) throw new Error('闸C 提交后 worktree 仍非 clean → 停泊（CI 须验 HEAD，不验脏树）');
      }
      return { ok: res.ok, text: res.result, sessionId: res.ok ? sid : null, costUsd: res.costUsd, error: res.error };
    },
  };
}

// 跑一段闸C 实现⇄CI 循环（worker 在 GATE_C_LOOP / GATE_C_REVISION_REQUESTED 调），返回结论交 worker 转移。
export function runGateCLoop(s: Session): Promise<ReviewFixOutcome> {
  return runReviewFixLoop(gateCConfig(s), gateCDrivers(s));
}
