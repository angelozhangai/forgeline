import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { strictParse } from '../llm/structured.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, get, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import { GateASchema, VerdictSchema, GateAFixResultSchema, GATE_A_VERDICT_CONTRACT, GATE_A_FIX_CONTRACT, findingsToMd } from './envelopes.ts';
import type { GateAEnvelope } from './envelopes.ts';
import { projectForSession } from '../projects.ts';
import { runReviewFixLoop } from '../review/reviewFixLoop.ts';
import { makeReviewFixDrivers } from '../review/drivers.ts';
import type { ReviewFixConfig, ReviewFixDrivers, ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import type { Session } from '../types.ts';

// gate-a.json 路径与读写（对抗 loop 就地更新 claude 复评定稿，codex 审⇄claude 改 反复刷新它）。
function gateAOutPath(s: Session): string {
  return s.gate_a_output_path ?? resolve(sessionLogDir(s.id), 'gate-a.json');
}
export function readGateAEnvelope(s: Session): GateAEnvelope {
  return GateASchema.parse(JSON.parse(readFileSync(gateAOutPath(s), 'utf8'))); // 缺/坏 → 抛（worker 停泊 GATE_A_FAILED）
}
async function persistGateAEnvelope(s: Session, env: GateAEnvelope): Promise<void> {
  const p = gateAOutPath(s);
  writeFileSync(p, JSON.stringify(env, null, 2));
  if (s.gate_a_output_path !== p) await patch(s.id, { gate_a_output_path: p });
}

// 闸A 对抗复审的「评审⇄修订」引擎配置：reviewer=codex 审 PRD 评审结论、fixer=claude 改评审 envelope。
// 与闸B 的关键差异：**不升级人在环**（PRD 拿不准走 PM loop）——peekHumanAnswer 恒 null、needsHuman 恒空。
function gateAConfig(s: Session): ReviewFixConfig<GateAEnvelope> {
  const cfg = loadConfig();
  const max = Math.max(1, cfg.runtime.adversarial.max_rounds ?? 3);
  const perTick = Math.min(max, 2); // 每次 step() 最多跑 2 轮，防霸占 tick 锁
  const cur = async (): Promise<Session> => (await get(s.id))!; // 每次现读 DB（get 现 async）
  const pid = projectForSession(s).id; // 提示词按项目私有覆盖（缺省走默认）
  const jstr = (v: unknown): string => JSON.stringify(v, null, 2);
  const prdText = s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';

  return {
    label: '闸A 对抗',
    maxRounds: max,
    maxRoundsPerTick: perTick,
    maxParseRepairRetries: Math.max(0, cfg.runtime.parse_repair_retries ?? 2),
    buildParseRepairPrompt: (kind, error) =>
      render(loadPrompt('partials/parse-repair.md', pid), {
        ERROR: error,
        CONTRACT: kind === 'verdict' ? GATE_A_VERDICT_CONTRACT : GATE_A_FIX_CONTRACT,
      }),
    getRound: async () => (await cur()).gate_a_adv_round ?? 0,
    setRound: async (n) => { await patch(s.id, { gate_a_adv_round: n }); },
    getReviewerSession: async () => (await cur()).gate_a_reviewer_session,
    setReviewerSession: async (id) => { await patch(s.id, { gate_a_reviewer_session: id }); },
    getFixerSession: async () => (await cur()).gate_a_fixer_session,
    setFixerSession: async (id) => { await patch(s.id, { gate_a_fixer_session: id }); },
    maxFixFailures: Math.max(1, cfg.runtime.max_fix_failures ?? 5),
    getFixFailStreak: async () => (await cur()).gate_a_fix_fail_streak ?? 0,
    setFixFailStreak: async (n) => { await patch(s.id, { gate_a_fix_fail_streak: n }); },
    loadArtifact: async () => readGateAEnvelope(await cur()),
    persistArtifact: async (art) => persistGateAEnvelope(await cur(), art),
    // 闸A 不升级人在环：无人工答复管线。
    peekHumanAnswer: async () => null,
    clearHumanAnswer: async () => { /* no-op：闸A 不收人工答复 */ },
    // codex 首轮带 PRD + 评审结论（resume 续接后 codex 会话已留 PRD，无需重发）。纯构造器：取入参 art，不读 session。
    buildInitialReviewPrompt: (art) => render(loadPrompt('gate-a-adversarial.md', pid), { PRD_TEXT: prdText, GATE_A_OUTPUT: jstr(art) }),
    buildResumeReviewPrompt: (art) => render(loadPrompt('gate-a-review-resume.md', pid), { GATE_A_OUTPUT: jstr(art) }),
    parseVerdict: (text) => strictParse(VerdictSchema, text),
    // 纯构造器保持同步：用进入循环时的 session 快照 s 读信封（output_path 进 loop 前已定、循环内只增不变）。
    buildInitialFixPrompt: (findings) =>
      render(loadPrompt('gate-a-fix.md', pid), { GATE_A_OUTPUT: jstr(readGateAEnvelope(s)), FINDINGS: findingsToMd(findings) }),
    buildResumeFixPrompt: (findings) =>
      render(loadPrompt('gate-a-fix-resume.md', pid), { FINDINGS: findingsToMd(findings) }),
    parseFixResult: (text) => {
      try {
        const r = strictParse(GateAFixResultSchema, text);
        return { artifact: r.artifact, needsHuman: [] }; // 闸A 不升级，恒空
      } catch (e) {
        log.warn(`闸A 改方输出解析失败 → 交引擎自愈/停泊：${String(e).slice(0, 160)}`);
        return null; // 引擎先自愈（resume 回喂重出），耗尽才停泊（绝不静默放行）
      }
    },
    persistResidual: async (round, used, findings) => {
      // 到上限仍未消解 → 落 gate_a_residual（codex 来源），交 M 裁决（needs_arbitration 卡展示）。
      await patch(s.id, { gate_a_residual: JSON.stringify({ round, source: 'codex', used, findings }) });
    },
    note: (kind, detail) => appendEvent(s.id, `gatea_adv_${kind}`, detail),
  };
}

// 真实驱动：复用 makeReviewFixDrivers 工厂（与闸B 同一份，仅 label/落盘名/skip 日志/成本列不同）。
function gateADrivers(s: Session): ReviewFixDrivers {
  return makeReviewFixDrivers(s, {
    reviewLabel: '闸A·对抗',
    reviewClaudeLabel: '闸A·对抗·claude',
    fixLabel: '闸A·改评审',
    reviewDumpName: 'gate-a-review.raw.txt',
    fixDumpName: 'gate-a-fix.raw.txt',
    skipLog: 'codex 未安装，on_missing=skip → 跳过闸A 对抗复审',
    accrueFixCost: async (costUsd) => {
      const c = (await get(s.id))!;
      await patch(s.id, { gate_a_cost_usd: (c.gate_a_cost_usd ?? 0) + costUsd }); // 累加，不覆盖评审成本
    },
    // 闸A 不落 codex token 列（仅闸B 有 gate_b_reviewer_tokens）。
  });
}

// 跑一段闸A 对抗循环（worker 在 GATE_A_ADVERSARIAL 调用），返回结论交 worker 转移。
export function runGateALoop(s: Session): Promise<ReviewFixOutcome> {
  return runReviewFixLoop(gateAConfig(s), gateADrivers(s));
}
