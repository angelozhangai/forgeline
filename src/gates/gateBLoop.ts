import { readFileSync } from 'node:fs';
import { loadPrompt, render } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import { VerdictSchema, FixResultSchema, GateBSchema, VERDICT_CONTRACT, FIX_CONTRACT, parseHumanAsks, findingsToMd } from './envelopes.ts';
import type { GateBEnvelope, Verdict } from './envelopes.ts';
import { gateBPaths, persistGateB, appendResidualToDoc } from './gateB.ts';
import { projectForSession } from '../projects.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import { makeReviewFixDrivers } from '../review/drivers.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

function readDraft(s: Session): GateBEnvelope {
  const { draft } = gateBPaths(s.id);
  return GateBSchema.parse(JSON.parse(readFileSync(draft, 'utf8'))); // 缺失/坏 → 抛错（worker 停泊 GATE_B_FAILED）
}

// 构造闸B 专用的「评审⇄修订」引擎配置：钩子读写新列、产物复用 persistGateB。
function gateBConfig(s: Session): ReviewFixConfig<GateBEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.adversarial.max_rounds ?? 3);
  const perTick = Math.min(max, 2); // 每次 step() 最多跑 2 轮 fix，防霸占 tick 锁
  const cur = async (): Promise<Session> => (await get(s.id))!; // 每次现读 DB（get 现 async）
  const pid = projectForSession(s).id; // 目标项目：提示词按项目私有覆盖（缺省走默认）
  const jstr = (v: unknown): string => JSON.stringify(v, null, 2);

  return {
    label: '闸B 对抗',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), {
        ERROR: error,
        CONTRACT: kind === 'verdict' ? VERDICT_CONTRACT : FIX_CONTRACT,
      }),
    getRound: async () => (await cur()).gate_b_round ?? 0,
    setRound: async (n) => { await patch(s.id, { gate_b_round: n, adversarial_rounds: n }); },
    getReviewerSession: async () => (await cur()).gate_b_reviewer_session,
    setReviewerSession: async (id) => { await patch(s.id, { gate_b_reviewer_session: id }); },
    getFixerSession: async () => (await cur()).gate_b_fixer_session,
    setFixerSession: async (id) => { await patch(s.id, { gate_b_fixer_session: id }); },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_b_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => { await patch(s.id, { gate_b_fix_fail_streak: n }); },
    loadArtifact: async () => readDraft(await cur()),
    persistArtifact: async (art) => persistGateB(await cur(), art),
    peekHumanAnswer: async () => {
      const c = await cur();
      const pending = (c.gate_b_pending_input ?? '').trim();
      if (!pending) return null;
      let ctx = '';
      // needs_human 升级点（从 AWAITING_GATE_B_INPUT 续修）。经 schema 归一选项（旧 string[] 不崩、o.label 不空）。
      const asks = parseHumanAsks(c.gate_b_human_asks);
      if (asks.length) {
        ctx += 'The escalation points you raised last round, awaiting the owner\'s decision:\n' +
          asks.map((a, i) => `${i + 1}. ${a.question}${a.options?.length ? ` (suggested options: ${a.options.map((o) => o.label).join(' / ')})` : ''}`).join('\n') + '\n\n';
      }
      // 「再修一轮」自停泊（从 GATE_B_STALLED 续修）→ 把 Codex 仍未消解的意见也带上，供 fixer 落实。
      try {
        const r = c.adversarial_residual ? (JSON.parse(c.adversarial_residual) as { findings?: Verdict['findings'] }) : null;
        if (r?.findings?.length) ctx += `Codex findings still unresolved:\n${findingsToMd(r.findings)}\n\n`;
      } catch { /* ignore */ }
      return `${ctx}**The owner's (M) decision**:\n${pending}`;
    },
    clearHumanAnswer: async () => {
      const c = await cur();
      await patch(s.id, { gate_b_pending_input: null, gate_b_human_asks: null }); // 消费（fixer 已落 artifact）
      await appendEvent(s.id, 'gateb_human_answer_consumed', { round: c.gate_b_round });
    },
    // 纯构造器保持同步：取入参 art。
    buildInitialReviewPrompt: (art) => render(loadPrompt('adversarial.md', pid), { GATE_B_OUTPUT: jstr(art) }),
    buildResumeReviewPrompt: (art) => render(loadPrompt('gateb-review-resume.md', pid), { GATE_B_OUTPUT: jstr(art) }),
    parseVerdict: (text) => strictParse(VerdictSchema, text),
    // 纯构造器保持同步：用进入循环时的 session 快照 s 读草稿（draft_path 进 loop 前已定）。
    buildInitialFixPrompt: (findings, humanAnswer) => {
      const base = render(loadPrompt('gateb-fix.md', pid), {
        GATE_B_OUTPUT: jstr(readDraft(s)),
        FINDINGS: findingsToMd(findings),
      });
      return humanAnswer ? `${humanAnswer}\n\n---\n\n${base}` : base; // 防御：首轮一般无人工答复
    },
    buildResumeFixPrompt: (findings, humanAnswer) =>
      render(loadPrompt('gateb-fix-resume.md', pid), { FINDINGS: findingsToMd(findings), HUMAN_ANSWER: humanAnswer ?? '' }),
    parseFixResult: (text) => {
      try {
        const r = strictParse(FixResultSchema, text);
        return { artifact: r.artifact, needsHuman: r.needs_human };
      } catch (e) {
        // 返回 null → 引擎先自愈（resume 回喂重出），耗尽才停泊（绝不静默放行 / 丢负责人答复）。raw 已落 gateb-fix.raw.txt。
        log.warn(`闸B 改方输出解析失败 → 交引擎自愈/停泊：${String(e).slice(0, 160)}`);
        return null;
      }
    },
    persistResidual: async (round, used, findings) => {
      const residual = { round, used, verdict: 'CHANGES_REQUESTED', findings };
      await patch(s.id, { adversarial_residual: JSON.stringify(residual), adversarial_rounds: round });
      appendResidualToDoc(projectForSession(s).deliveryDir, (await cur()).slug, { round, used, findings: findings as Verdict['findings'] });
    },
    note: (kind, detail) => appendEvent(s.id, `gateb_${kind}`, detail),
  };
}

// 真实驱动：复用 makeReviewFixDrivers 工厂（与闸A 同一份，仅 label/落盘名/skip 日志/成本列不同）。
// 闸B 额外把 codex token 用量落 gate_b_reviewer_tokens（codex --json 无美元口径，故 cost 只计 claude 改方）。
function gateBDrivers(s: Session): ReviewFixDrivers {
  return makeReviewFixDrivers(s, {
    reviewLabel: '闸B·对抗',
    reviewClaudeLabel: '闸B·对抗·claude',
    fixLabel: '闸B·改方',
    reviewDumpName: 'gateb-review.raw.txt',
    fixDumpName: 'gateb-fix.raw.txt',
    skipLog: 'codex 未安装，on_missing=skip → 跳过对抗复审',
    accrueFixCost: async (costUsd) => {
      const c = (await get(s.id))!;
      await patch(s.id, { gate_b_cost_usd: (c.gate_b_cost_usd ?? 0) + costUsd }); // 累加，不覆盖初稿成本
    },
    persistReviewerTokens: (tokensJson) => patch(s.id, { gate_b_reviewer_tokens: tokensJson }),
  });
}

// 跑一段闸B 对抗循环（worker 在 ADVERSARIAL_LOOP / GATE_B_REVISION_REQUESTED 调用），返回结论交 worker 转移。
export function runGateBLoop(s: Session): Promise<ReviewFixOutcome> {
  return runReviewFixLoop(gateBConfig(s), gateBDrivers(s));
}
