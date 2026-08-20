// 可复用的「评审⇄修订」循环引擎：reviewer（codex，会话续接）审 → fixer（claude，会话续接）改 → 再审，
// 直到 clean / 改方升级需人工 / 到硬上限 / 到每-tick 上限。与产物无关（泛型 A），存储/prompt/解析全走 cfg 钩子委托。
// 本轮接闸B（codex审⇄claude改技术方案）；闸A 日后可复用（不在本轮）。
//
// 设计要点：
//  · 一次调用内**连跑多轮**直到上述四个停顿之一——180s 只是调度节拍，tick 锁 + 1200s 超时保护，与旧 harden 同步多轮一致。
//  · 每轮持久化 round + 两个 session id + 产物（孤儿复位最多丢一轮，绝不丢稿）。
//  · 解析失败 → 先 resume 同会话回喂模型重出（自愈，maxParseRepairRetries 次），耗尽才停泊；绝不静默丢方案。

import { parseStructured } from '../llm/structured.ts';

export interface HumanAsk {
  id: string;
  question: string;
  // 决策选项（引擎只透传、不读内部）。结构与 gates/envelopes.ts DecisionOption 对齐：标签 + 是否推荐 + 影响。
  options?: { label: string; recommended?: boolean; impact?: string }[];
  context?: string;
  severity?: string;
}

export interface ReviewVerdict {
  verdict: 'LGTM' | 'CHANGES_REQUESTED'; // LGTM=通过收尾；CHANGES_REQUESTED=要改（findings 必非空）
  findings: unknown[];
}

export interface FixOutput<A> {
  artifact: A;
  needsHuman: HumanAsk[];
}

// 跑到下一个停顿点的结论。worker 据此转移（类比 GateAOutcome）。
export interface ReviewFixOutcome {
  round: number;
  verdict: 'LGTM' | 'CHANGES_REQUESTED' | 'unknown';
  resolved: boolean; // reviewer clean / 无可用 reviewer → 完成（→ AWAITING_GO）
  needsHuman: HumanAsk[] | null; // 非空 → 暂停等 M 答复（→ AWAITING_GATE_B_INPUT）
  stalled: boolean; // 到硬上限仍未消解（→ GATE_B_STALLED）
  paused: boolean; // 到每-tick 上限 / 改方调用失败 → 自转移，下个 tick 续（留 ADVERSARIAL_LOOP）
  unresolvedFindings: unknown[];
}

// 存储/prompt/解析委托。引擎只跑控制流，不碰 DB / 文件。
export interface ReviewFixConfig<A> {
  label: string;
  maxRounds: number; // 硬上限（到顶 → stalled）
  maxRoundsPerTick: number; // 每次 step() 内最多跑几轮 fix（防霸占 tick 锁饿死他人）
  // 轮次与会话（持久化委托）。**读/写 session 现态的钩子均为 async**（SessionStore async 化后 get/patch 返回 Promise）。
  getRound(): Promise<number>;
  setRound(n: number): Promise<void>;
  getReviewerSession(): Promise<string | null>;
  setReviewerSession(id: string | null): Promise<void>;
  getFixerSession(): Promise<string | null>;
  setFixerSession(id: string | null): Promise<void>;
  // 连续 fix 调用失败的断路器（与 round 正交）：fix() 持续 ok:false（claude 超时/崩/持续故障 = 毒丸）时累加，
  // 到 maxFixFailures 跳闸 → stalled 交人（等同 SQS DLQ + 告警 / 断路器 OPEN），任一 fix 成功清零（电路复位）。
  // round 只计「成功落盘的进度」，故持续失败 round 永不前进、maxRounds 永不触发——必须有这道独立尝试预算兜底，
  // 否则毒丸无限空转烧钱、永不升级人（社区共识：恢复循环须有界 + 耗尽升级，见 circuit breaker / Temporal maxAttempts）。
  maxFixFailures: number; // 连续 fix 失败硬上限（到顶 → stalled）。默认 5（对齐 SQS maxReceiveCount/断路器典型阈值）
  getFixFailStreak(): Promise<number>;
  setFixFailStreak(n: number): Promise<void>;
  // 产物（读/写 session 现态 → async）
  loadArtifact(): Promise<A>;
  persistArtifact(art: A): Promise<void>;
  // 人工答复管线：peek 只读不清（仅 resume 后第一轮非空）；fixer 成功落盘后才 clear——
  // 失败不清 → 下个 tick 重试，负责人决定绝不丢。（读/写 session 现态 → async）
  peekHumanAnswer(): Promise<string | null>;
  clearHumanAnswer(): Promise<void>;
  // 解析失败自愈：据报错构造「重出」修复指令（cfg 用 loadPrompt+render 实现，引擎不碰文件）。
  buildParseRepairPrompt(kind: 'verdict' | 'fix', error: string): string;
  maxParseRepairRetries: number; // 解析失败最多 resume 回喂重出几次（0=不自愈）
  parseRepairSleep?: (ms: number) => Promise<void>; // 回喂调用失败退避的 sleep（默认真退避；测试注入免真睡）
  // reviewer（codex）prompt + 解析
  buildInitialReviewPrompt(art: A): string;
  buildResumeReviewPrompt(art: A): string;
  parseVerdict(text: string): ReviewVerdict;
  // fixer（claude）prompt + 解析。**解析失败返回 null**——引擎据此抛出停泊，
  // 绝不 fallback 旧稿静默放行（否则改方坏 JSON 时会消费掉负责人答复却没落进方案）。
  buildInitialFixPrompt(findings: unknown[], humanAnswer: string | null): string;
  buildResumeFixPrompt(findings: unknown[], humanAnswer: string | null): string;
  parseFixResult(text: string): FixOutput<A> | null;
  // 到硬上限的残留落盘（交人工裁决）（写 session 现态 → async）
  persistResidual(round: number, used: string, findings: unknown[]): Promise<void>;
  // 进度/审计事件（写 event_log → async）
  note(kind: string, detail: unknown): Promise<void>;
}

export interface ReviewCall {
  ok: boolean;
  text: string;
  sessionId: string | null;
  available: boolean; // false → 无可用 reviewer（on_missing=skip）；error 模式由 driver 抛出
  used: string; // 'codex' | 'claude'
  error?: string;
}
export interface FixCall {
  ok: boolean;
  text: string;
  sessionId: string | null;
  costUsd: number | null;
  error?: string;
}
// 注入的真实调用（包 runCodex/runClaude + on_missing 降级），便于单测换假驱动。
export interface ReviewFixDrivers {
  review(prompt: string, opts: { sessionId: string | null; firstCall: boolean }): Promise<ReviewCall>;
  fix(prompt: string, opts: { sessionId: string | null }): Promise<FixCall>;
}

async function resolvedOutcome<A>(cfg: ReviewFixConfig<A>, verdict: 'LGTM' | 'unknown'): Promise<ReviewFixOutcome> {
  return { round: await cfg.getRound(), verdict, resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
}

export async function runReviewFixLoop<A>(cfg: ReviewFixConfig<A>, drv: ReviewFixDrivers): Promise<ReviewFixOutcome> {
  let art: A = await cfg.loadArtifact(); // 显式 A：避免推断成 Awaited<A>（fr.artifact 为 A，泛型 A 可能本身是 Promise）
  let humanAnswer = await cfg.peekHumanAnswer(); // 仅 resume 后第一轮非空
  let roundsThisTick = 0;

  // 改方解析（坏 JSON → 自愈：resume 同 fixer 会话回喂重出）。parseFixResult 返回 null 即不合格 → 抛。
  const parseFixOrThrow = (text: string): FixOutput<A> => {
    const r = cfg.parseFixResult(text);
    if (!r) throw new Error('改方输出无法解析为约定 JSON');
    return r;
  };
  const reEmitFix = async (instruction: string): Promise<string | null> => {
    const f = await drv.fix(instruction, { sessionId: await cfg.getFixerSession() });
    return f.ok ? f.text : null;
  };
  const parseFixWithRepair = (text: string): Promise<FixOutput<A>> =>
    parseStructured<FixOutput<A>>({
      text,
      parse: parseFixOrThrow,
      reEmit: reEmitFix,
      buildRepairInstruction: (err) => cfg.buildParseRepairPrompt('fix', err),
      maxRetries: cfg.maxParseRepairRetries,
      sleep: cfg.parseRepairSleep,
      note: cfg.note,
    });

  // 续修（带负责人答复进来）：**先无条件跑一轮 fixer 把决定落入 artifact**，再进常规 review→fix 循环。
  // 否则 reviewer 对旧稿判 clean / on_missing=skip 会直接 resolved，负责人的答复被消费却没落进方案。
  // 成功落盘才 clearHumanAnswer——失败不清，下个 tick 重试，答复绝不丢。
  if (humanAnswer) {
    const fixerSid = await cfg.getFixerSession();
    const firstFix = !fixerSid;
    const fixPrompt = firstFix ? cfg.buildInitialFixPrompt([], humanAnswer) : cfg.buildResumeFixPrompt([], humanAnswer);
    const f = await drv.fix(fixPrompt, { sessionId: fixerSid });
    if (f.ok && f.sessionId && firstFix) await cfg.setFixerSession(f.sessionId);
    if (!f.ok) {
      const streak = (await cfg.getFixFailStreak()) + 1;
      await cfg.setFixFailStreak(streak);
      if (streak >= cfg.maxFixFailures) {
        // 连续 fix 失败到上限 → 断路器跳闸：stalled 交人（绝不无限空转）。answer 不清→人工 retry 后重试。
        await cfg.note('stalled_fix_failures', { stage: 'apply_human_answer', streak, error: f.error ?? null });
        return { round: await cfg.getRound(), verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: [] };
      }
      await cfg.note('fix_failed', { stage: 'apply_human_answer', streak, error: f.error ?? null });
      return { round: await cfg.getRound(), verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: [] };
    }
    await cfg.setFixFailStreak(0); // fix 成功 → 断路器复位
    // 注：上面已 setFixerSession（f.ok 时），reEmitFix 能 resume 同会话回喂。
    let fr: FixOutput<A>;
    try {
      fr = await parseFixWithRepair(f.text);
    } catch {
      // 自愈耗尽仍坏 → **绝不 fallback 旧稿 + 消费答复**。抛出停泊（raw 已落盘）；
      // 因 clearHumanAnswer 还没调，answer 仍在，retry 后重新落实负责人决定。
      await cfg.note('fix_unparsable', { stage: 'apply_human_answer' });
      throw new Error('闸B 改方输出解析失败（落实负责人答复时）');
    }
    art = fr.artifact;
    await cfg.persistArtifact(art); // 负责人决定已落 artifact
    await cfg.clearHumanAnswer(); // 成功落盘才消费
    await cfg.note('human_answer_applied', { round: await cfg.getRound() });
    humanAnswer = null;
    if (fr.needsHuman.length > 0) {
      // 答复又引出新升级 → 再次停泊等人工。
      const round = await cfg.getRound();
      await cfg.note('needs_human', { round, count: fr.needsHuman.length });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: fr.needsHuman, stalled: false, paused: false, unresolvedFindings: [] };
    }
    roundsThisTick++;
  }

  for (;;) {
    // ── 评审（codex；首次首轮，之后 resume 续接）──
    const reviewerSid = await cfg.getReviewerSession();
    const firstReview = !reviewerSid;
    const reviewPrompt = firstReview ? cfg.buildInitialReviewPrompt(art) : cfg.buildResumeReviewPrompt(art);
    const rev = await drv.review(reviewPrompt, { sessionId: reviewerSid, firstCall: firstReview });
    if (!rev.available) {
      // on_missing=skip：无可用 reviewer 是**显式配置的跳过**（非失败）→ 视为通过，保住已成稿（→ AWAITING_GO）。
      await cfg.note('review_skipped', { reason: 'reviewer_unavailable' });
      return resolvedOutcome(cfg, 'unknown');
    }
    if (!rev.ok) {
      // reviewer 在但调用失败（超时/非零退出/降级自审也失败）→ **绝不静默放行**。
      // 抛出 → worker 停泊 GATE_B_FAILED（raw 已由 driver 落盘），交人工 retry 续跑（落实「失败不静默」）。
      await cfg.note('review_failed', { used: rev.used, error: rev.error ?? null });
      throw new Error(`闸B 对抗复审调用失败（${rev.used}）：${rev.error ?? '未知'}`);
    }
    if (rev.sessionId && firstReview) await cfg.setReviewerSession(rev.sessionId);
    // 解析失败 → resume 同 reviewer 会话回喂重出（自愈）；降级 claude 自审无会话 → 带回原 prompt 提供上下文。
    const reEmitReview = async (instruction: string): Promise<string | null> => {
      const sid = await cfg.getReviewerSession();
      const p = sid ? instruction : `${reviewPrompt}\n\n---\n\n${instruction}`;
      const again = await drv.review(p, { sessionId: sid, firstCall: false });
      return again.available && again.ok ? again.text : null;
    };
    let verdict: ReviewVerdict;
    try {
      verdict = await parseStructured<ReviewVerdict>({
        text: rev.text,
        parse: cfg.parseVerdict,
        reEmit: reEmitReview,
        buildRepairInstruction: (err) => cfg.buildParseRepairPrompt('verdict', err),
        maxRetries: cfg.maxParseRepairRetries,
        sleep: cfg.parseRepairSleep,
        note: cfg.note,
      });
    } catch (e) {
      // 自愈耗尽仍坏 → 停泊（**绝不静默按通过**）→ 抛出 → GATE_B_FAILED（raw 已落盘，见 logs）。
      await cfg.note('review_unparsable', { used: rev.used });
      throw new Error(`闸B 对抗复审输出解析失败（${rev.used}）：${String(e).slice(0, 160)}`);
    }

    // 候选轮次：仅在 LGTM / 到上限 / 改方成功落盘 时才真正计入（见各 setRound）——
    // 改方临时失败不推进 round，避免被误计为「多轮未消解」而误判停泊。
    const round = (await cfg.getRound()) + 1;
    await cfg.note('review_round', { round, used: rev.used, verdict: verdict.verdict, findings: verdict.findings.length });

    // schema 已保证 LGTM⇔零 findings、CHANGES_REQUESTED⇔非空，故只认 verdict 字面量（不再脆弱地拿空 findings 当通过）。
    if (verdict.verdict === 'LGTM') {
      await cfg.setRound(round);
      return { round, verdict: 'LGTM', resolved: true, needsHuman: null, stalled: false, paused: false, unresolvedFindings: [] };
    }
    if (round >= cfg.maxRounds) {
      // 到硬上限仍有意见：落盘交人工裁决，绝不静默丢弃。
      await cfg.setRound(round);
      await cfg.persistResidual(round, rev.used, verdict.findings);
      await cfg.note('stalled', { round, findings: verdict.findings.length });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: verdict.findings };
    }

    // ── 修订（claude；首次首轮，之后 resume 续接）──
    const fixerSid = await cfg.getFixerSession();
    const firstFix = !fixerSid;
    const fixPrompt = firstFix
      ? cfg.buildInitialFixPrompt(verdict.findings, humanAnswer)
      : cfg.buildResumeFixPrompt(verdict.findings, humanAnswer);
    const f = await drv.fix(fixPrompt, { sessionId: fixerSid });
    if (f.ok && f.sessionId && firstFix) await cfg.setFixerSession(f.sessionId);
    if (!f.ok) {
      // 改方调用失败 → 暂停重试，**不推进 round**（避免临时 claude 故障被误计为「多轮未消解」而误停泊）。
      // 但连续失败必须有界：累加断路器，到 maxFixFailures 跳闸 → stalled 交人（毒丸绝不无限空转烧钱）。
      const streak = (await cfg.getFixFailStreak()) + 1;
      await cfg.setFixFailStreak(streak);
      if (streak >= cfg.maxFixFailures) {
        await cfg.persistResidual(round, rev.used, verdict.findings); // 落残留供人工裁决（同到硬上限停泊）
        await cfg.note('stalled_fix_failures', { round, streak, error: f.error ?? null });
        return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: true, paused: false, unresolvedFindings: verdict.findings };
      }
      await cfg.note('fix_failed', { round, streak, error: f.error ?? null });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: verdict.findings };
    }
    let fr: FixOutput<A>;
    try {
      fr = await parseFixWithRepair(f.text);
    } catch {
      // 自愈耗尽仍坏 → 抛出停泊（与 review 解析失败同纪律；绝不静默保留旧稿放行）。
      await cfg.note('fix_unparsable', { round });
      throw new Error('闸B 改方输出解析失败');
    }
    art = fr.artifact;
    await cfg.persistArtifact(art); // 每轮落盘，绝不丢
    await cfg.setRound(round); // 改方成功落盘 → 本轮才真正计入
    await cfg.setFixFailStreak(0); // fix 成功落盘 → 断路器复位（连续失败计数清零）
    humanAnswer = null; // 仅首个 fix 带入（已被 fix-first 消费，这里恒 null，留作防御）

    if (fr.needsHuman.length > 0) {
      await cfg.note('needs_human', { round, count: fr.needsHuman.length });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: fr.needsHuman, stalled: false, paused: false, unresolvedFindings: verdict.findings };
    }

    roundsThisTick++;
    if (roundsThisTick >= cfg.maxRoundsPerTick && round < cfg.maxRounds) {
      await cfg.note('loop_paused', { round, roundsThisTick });
      return { round, verdict: 'CHANGES_REQUESTED', resolved: false, needsHuman: null, stalled: false, paused: true, unresolvedFindings: verdict.findings };
    }
    // 继续：复审修订后的稿
  }
}
