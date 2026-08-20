// 评审⇄修订引擎控制流（用假驱动，不起真 codex/claude）。覆盖：clean / 升级人工 / 多轮收敛 /
// 硬上限停泊 / 每-tick 上限暂停 / reviewer 不可用降级 / 会话只捕获一次复用 / 人工答复仅首轮带入 / 改方失败重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReviewFixLoop } from '../src/review/reviewFixLoop.ts';
import type { ReviewFixConfig, ReviewFixDrivers } from '../src/review/reviewFixLoop.ts';

interface State {
  round: number;
  reviewerSession: string | null;
  fixerSession: string | null;
  artifact: { v: number };
  humanAnswer: string | null;
  residual: { round: number; used: string; findings: unknown[] } | null;
  persists: number;
  events: { k: string; d: unknown }[];
  reviewCalls: { sessionId: string | null; firstCall: boolean }[];
  fixCalls: { sessionId: string | null }[];
  fixHumanAnswers: (string | null)[];
  maxRounds: number;
  maxRoundsPerTick: number;
  maxParseRepairRetries: number;
  fixFailStreak: number;
  maxFixFailures: number;
}

function mkState(o: Partial<State> = {}): State {
  return {
    round: 0, reviewerSession: null, fixerSession: null, artifact: { v: 0 }, humanAnswer: null,
    residual: null, persists: 0, events: [], reviewCalls: [], fixCalls: [], fixHumanAnswers: [],
    maxRounds: 3, maxRoundsPerTick: 99, maxParseRepairRetries: 0, fixFailStreak: 0, maxFixFailures: 5, ...o, // 默认 0：解析失败立即抛（旧行为），自愈用例显式开
  };
}

function mkCfg(state: State): ReviewFixConfig<{ v: number }> {
  return {
    label: 'test',
    maxRounds: state.maxRounds,
    maxRoundsPerTick: state.maxRoundsPerTick,
    maxParseRepairRetries: state.maxParseRepairRetries,
    buildParseRepairPrompt: (kind, error) => `REPAIR:${kind}:${error}`,
    parseRepairSleep: async () => {}, // 免真睡，回喂调用失败退避在测试中瞬时返回
    getRound: () => state.round,
    setRound: (n) => { state.round = n; },
    getReviewerSession: () => state.reviewerSession,
    setReviewerSession: (id) => { state.reviewerSession = id; },
    getFixerSession: () => state.fixerSession,
    setFixerSession: (id) => { state.fixerSession = id; },
    maxFixFailures: state.maxFixFailures,
    getFixFailStreak: () => state.fixFailStreak,
    setFixFailStreak: (n) => { state.fixFailStreak = n; },
    loadArtifact: () => state.artifact,
    persistArtifact: (a) => { state.artifact = a; state.persists++; },
    peekHumanAnswer: () => state.humanAnswer,
    clearHumanAnswer: () => { state.humanAnswer = null; },
    buildInitialReviewPrompt: () => '',
    buildResumeReviewPrompt: () => '',
    parseVerdict: (t) => JSON.parse(t),
    buildInitialFixPrompt: (_f, ha) => { state.fixHumanAnswers.push(ha); return ''; },
    buildResumeFixPrompt: (_f, ha) => { state.fixHumanAnswers.push(ha); return ''; },
    parseFixResult: (t) => { try { const o = JSON.parse(t); return { artifact: o.artifact, needsHuman: o.needs_human ?? [] }; } catch { return null; } },
    persistResidual: (round, used, findings) => { state.residual = { round, used, findings }; },
    note: (k, d) => { state.events.push({ k, d }); },
  };
}

interface RevStep { verdict?: 'LGTM' | 'CHANGES_REQUESTED'; findings?: unknown[]; ok?: boolean; available?: boolean; sessionId?: string | null; used?: string; parseFail?: boolean }
interface FixStep { artifact?: { v: number }; needsHuman?: unknown[]; ok?: boolean; sessionId?: string | null; costUsd?: number; badText?: boolean }

function mkDrivers(state: State, reviewScript: RevStep[], fixScript: FixStep[]): ReviewFixDrivers {
  let ri = 0, fi = 0;
  return {
    review: async (_p, opts) => {
      state.reviewCalls.push({ sessionId: opts.sessionId, firstCall: opts.firstCall });
      const r = reviewScript[ri++] ?? { verdict: 'LGTM', findings: [] };
      return {
        ok: r.ok ?? true,
        text: r.parseFail ? 'oops 这不是 JSON {{{' : JSON.stringify({ verdict: r.verdict ?? 'LGTM', findings: r.findings ?? [] }),
        sessionId: r.sessionId === undefined ? 'codex-sid' : r.sessionId,
        available: r.available ?? true,
        used: r.used ?? 'codex',
        error: r.ok === false ? 'boom' : undefined,
      };
    },
    fix: async (_p, opts) => {
      state.fixCalls.push({ sessionId: opts.sessionId });
      const f = fixScript[fi++] ?? {};
      return {
        ok: f.ok ?? true,
        text: f.badText ? '改方坏 JSON {{{' : JSON.stringify({ artifact: f.artifact ?? { v: fi }, needs_human: f.needsHuman ?? [] }),
        sessionId: f.sessionId === undefined ? 'claude-sid' : f.sessionId,
        costUsd: f.costUsd ?? 0.01,
      };
    },
  };
}

test('首轮 clean → resolved，捕获 reviewer 会话', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], []));
  assert.equal(out.resolved, true);
  assert.equal(out.round, 1);
  assert.equal(st.reviewerSession, 'codex-sid');
  assert.equal(st.fixCalls.length, 0);
});

test('needs_revision → 改方升级 needs_human → 暂停等人工', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'x' }] }], [{ artifact: { v: 1 }, needsHuman: [{ id: 'H1', question: 'q' }] }]));
  assert.equal(out.resolved, false);
  assert.equal(out.stalled, false);
  assert.equal(out.paused, false);
  assert.equal(out.needsHuman?.length, 1);
  assert.equal(st.fixerSession, 'claude-sid');
  assert.equal(st.persists, 1); // 改方稿已落盘
});

test('两轮收敛：needs_revision→改→clean，第二轮 reviewer 走 resume（会话复用）', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(out.round, 2);
  assert.equal(st.reviewCalls[0].firstCall, true);
  assert.equal(st.reviewCalls[1].firstCall, false); // 第二轮 resume
  assert.equal(st.reviewCalls[1].sessionId, 'codex-sid'); // 复用同一会话
  assert.equal(st.fixCalls[0].sessionId, null); // 首个 fix 是新会话
});

test('到硬上限仍未消解 → stalled + 残留落盘', async () => {
  const st = mkState({ maxRounds: 2 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'CHANGES_REQUESTED', findings: [{ i: 2 }, { i: 3 }] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.stalled, true);
  assert.equal(out.round, 2);
  assert.equal(st.residual?.round, 2);
  assert.equal(st.residual?.findings.length, 2);
});

test('到每-tick 上限 → paused（自转移，下个 tick 续）', async () => {
  const st = mkState({ maxRoundsPerTick: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.paused, true);
  assert.equal(out.round, 1);
  assert.equal(st.reviewCalls.length, 1); // 没跑到第二轮评审
});

test('reviewer 不可用（on_missing=skip）→ resolved(unknown)，不丢稿', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ available: false }], []));
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'unknown');
  assert.equal(st.round, 0); // 不计轮
});

test('reviewer 调用失败（available 但 !ok）→ 抛出（worker 停泊，绝不静默放行）', async () => {
  const st = mkState();
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ ok: false, available: true }], [])),
    /调用失败/,
  );
});

test('reviewer 输出无法解析 → 抛出（绝不静默按通过）', async () => {
  const st = mkState();
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ parseFail: true }], [])),
    /解析失败/,
  );
});

test('续修：带人工答复时强制先 fix——即便 reviewer 随后判 clean，答复也已落 artifact（核心回归）', async () => {
  const st = mkState({ humanAnswer: 'M: 退到余额' });
  // reviewer 首轮就 clean：若不 fix-first，答复会被消费却没改稿
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ artifact: { v: 99 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 1); // fixer 被调用（fix-first）
  assert.equal(st.fixHumanAnswers[0], 'M: 退到余额'); // 答复进了 fixer
  assert.equal(st.persists, 1); // artifact 落盘
  assert.deepEqual(st.artifact, { v: 99 }); // 落的是 fixer 改后的稿
  assert.equal(st.humanAnswer, null); // 成功后才清
});

test('续修：负责人决定先落稿，随后复审意见继续被修订，且决定不被重复喂给第二次 fix', async () => {
  const st = mkState({ humanAnswer: 'M: 接受余额退款，补幂等验收' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(
      st,
      [
        { verdict: 'CHANGES_REQUESTED', findings: [{ issue: '缺少退款幂等验收' }] },
        { verdict: 'LGTM', findings: [] },
      ],
      [
        { artifact: { v: 10 }, needsHuman: [] }, // 先落实 M 的决定
        { artifact: { v: 11 }, needsHuman: [] }, // 再消化复审意见
      ],
    ));
  assert.equal(out.resolved, true);
  assert.deepEqual(st.artifact, { v: 11 });
  assert.deepEqual(st.fixHumanAnswers, ['M: 接受余额退款，补幂等验收', null]);
  assert.equal(st.persists, 2);
  assert.equal(st.humanAnswer, null);
});

test('续修：on_missing=skip 也先 fix（reviewer 不可用不让答复白丢）', async () => {
  const st = mkState({ humanAnswer: 'M: 退到余额' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ available: false }], [{ artifact: { v: 7 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 1);
  assert.equal(st.persists, 1);
  assert.deepEqual(st.artifact, { v: 7 });
});

test('续修：fix-first 调用失败 → paused 且不清 humanAnswer（下个 tick 重试，答复不丢）', async () => {
  const st = mkState({ humanAnswer: 'M: 退到余额' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ ok: false }]));
  assert.equal(out.paused, true);
  assert.equal(st.humanAnswer, 'M: 退到余额'); // 未清 → 下个 tick 重试
  assert.equal(st.persists, 0);
});

test('续修：fix-first 又引出新 needs_human → 再次停泊（答复已落、再升级）', async () => {
  const st = mkState({ humanAnswer: 'M: 部分采纳' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [], [{ artifact: { v: 5 }, needsHuman: [{ id: 'H2', question: '那退款时效？' }] }]));
  assert.equal(out.needsHuman?.length, 1);
  assert.equal(st.persists, 1); // 已落 artifact
  assert.equal(st.humanAnswer, null); // 旧答复已消费
});

test('续修：fix-first 输出坏 JSON → 抛出，且不清 humanAnswer、不落 fallback（核心回归）', async () => {
  const st = mkState({ humanAnswer: 'M: 退到余额' });
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ badText: true }])),
    /解析失败/,
  );
  assert.equal(st.humanAnswer, 'M: 退到余额'); // 未清 → retry 后重新落实
  assert.equal(st.persists, 0); // 绝不 fallback 旧稿
});

test('续修：fix-first 首发坏 JSON → 自愈 resume **同 fixer 会话** 重出 → 好（落实后才清答复）', async () => {
  // 不变量：fix-first 成功调用即 pin fixer 会话（setFixerSession），故自愈回喂走 resume 同会话——
  // 否则重出会开新会话、丢掉首发时带入的负责人答复上下文。answer 只在最终落盘成功后才清。
  const st = mkState({ humanAnswer: 'M: 退到余额', maxParseRepairRetries: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'LGTM', findings: [] }], [{ badText: true }, { artifact: { v: 88 } }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 2); // fix-first + 一次自愈重出
  assert.equal(st.fixCalls[0].sessionId, null); // 首发是新会话
  assert.equal(st.fixCalls[1].sessionId, 'claude-sid'); // 关键：自愈走 resume 同 fixer 会话（不丢答复上下文）
  assert.deepEqual(st.artifact, { v: 88 }); // 落的是重出后的稿
  assert.equal(st.persists, 1);
  assert.equal(st.humanAnswer, null); // 落盘成功后才清
});

test('改方输出坏 JSON（循环内）→ 抛出（不静默保留旧稿放行）', async () => {
  const st = mkState();
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ badText: true }])),
    /解析失败/,
  );
  assert.equal(st.persists, 0);
  assert.equal(st.round, 0); // 坏输出不是一轮有效修订，不能消耗轮次
});

test('人工答复仅首个 fix 带入，之后为 null', async () => {
  const st = mkState({ humanAnswer: 'M说原路退' });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st,
      [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'CHANGES_REQUESTED', findings: [{ i: 2 }] }, { verdict: 'LGTM', findings: [] }],
      [{ artifact: { v: 1 }, needsHuman: [] }, { artifact: { v: 2 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixHumanAnswers[0], 'M说原路退');
  assert.equal(st.fixHumanAnswers[1], null);
});

test('改方调用失败 → paused，且不推进 round（避免临时故障误计多轮未消解）', async () => {
  const st = mkState();
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(out.paused, true);
  assert.equal(st.persists, 0); // 改方失败，没落盘
  assert.equal(st.round, 0); // 关键：失败轮不计入，下个 tick 重审同一轮号
});

test('断路器：连续 fix 调用失败到 maxFixFailures → stalled（绝不无限 paused 空转，社区 maxAttempts/circuit-breaker 实践）', async () => {
  const st = mkState({ maxFixFailures: 3 }); // streak 持久在 state，跨「tick」累加
  // tick 1：review CHANGES → fix ok:false → paused，streak 1
  let out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(out.paused, true); assert.equal(out.stalled, false); assert.equal(st.fixFailStreak, 1);
  // tick 2：再失败 → paused，streak 2
  out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(out.paused, true); assert.equal(st.fixFailStreak, 2);
  // tick 3：到上限 → 断路器跳闸 stalled（交人），落残留
  out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }, { i: 2 }] }], [{ ok: false }]));
  assert.equal(out.stalled, true);
  assert.equal(out.paused, false);
  assert.equal(st.fixFailStreak, 3);
  assert.ok(st.events.some((e) => e.k === 'stalled_fix_failures')); // 显式断路事件
  assert.equal(st.residual?.findings.length, 2); // 残留落盘供人工裁决
  assert.equal(st.round, 0); // 失败从不推进 round（与 maxRounds 正交，断路器独立兜底）
});

test('断路器：fix 成功落盘 → 连续失败计数清零（电路复位）', async () => {
  const st = mkState({ maxFixFailures: 3 });
  await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }], [{ ok: false }]));
  assert.equal(st.fixFailStreak, 1); // 先攒一次失败
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }], [{ artifact: { v: 1 }, needsHuman: [] }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixFailStreak, 0); // 成功 → 复位，不会被旧 streak 误判跳闸
});

// ── 自愈：解析失败 → resume 同会话回喂重出 ──────────────────────────
test('自愈：verdict 坏一次 → resume 重发 → 好（最终通过，走了二次 review 调用）', async () => {
  const st = mkState({ maxParseRepairRetries: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st, [{ parseFail: true }, { verdict: 'LGTM', findings: [] }], []));
  assert.equal(out.resolved, true);
  assert.equal(out.verdict, 'LGTM');
  assert.equal(st.reviewCalls.length, 2); // 初评 + 一次自愈重发
  assert.equal(st.reviewCalls[1].firstCall, false); // 自愈走 resume
  assert.ok(st.events.some((e) => e.k === 'parse_repair_attempt'));
});

test('自愈：FixResult 坏一次 → resume 重发 → 好（改方落盘，收敛）', async () => {
  const st = mkState({ maxParseRepairRetries: 1 });
  const out = await runReviewFixLoop(mkCfg(st),
    mkDrivers(st,
      [{ verdict: 'CHANGES_REQUESTED', findings: [{ i: 1 }] }, { verdict: 'LGTM', findings: [] }],
      [{ badText: true }, { artifact: { v: 42 } }]));
  assert.equal(out.resolved, true);
  assert.equal(st.fixCalls.length, 2); // 改方 + 一次自愈重发
  assert.equal(st.fixCalls[1].sessionId, 'claude-sid'); // 自愈 resume 同 fixer 会话
  assert.deepEqual(st.artifact, { v: 42 });
});

test('自愈：重试耗尽仍坏 → 抛出停泊（绝不静默放行）', async () => {
  const st = mkState({ maxParseRepairRetries: 1 });
  await assert.rejects(
    () => runReviewFixLoop(mkCfg(st), mkDrivers(st, [{ parseFail: true }, { parseFail: true }], [])),
    /解析失败/,
  );
  assert.equal(st.reviewCalls.length, 2); // 初评 + 1 次自愈，均坏 → 抛
  assert.ok(st.events.some((e) => e.k === 'parse_repair_exhausted'));
});

test('自愈：回喂调用持续失败(null) → 内层有限重试后抛（P1-1：不再一抖就终结）', async () => {
  const st = mkState({ maxParseRepairRetries: 2 });
  // 初评坏 JSON + 之后回喂调用一直 ok:false（null）。内层 reEmitCallRetries 默认 2 → 单轮回喂 3 次仍 null 才抛。
  await assert.rejects(
    () => runReviewFixLoop(
      mkCfg(st),
      mkDrivers(st, [{ parseFail: true }, { ok: false, available: true }, { ok: false, available: true }, { ok: false, available: true }], []),
    ),
    /解析失败/,
  );
  assert.equal(st.reviewCalls.length, 4); // 初评 1 + 回喂重试 3（callRetries+1）
  assert.ok(st.events.some((e) => e.k === 'parse_repair_reemit_failed'));
  assert.ok(st.events.some((e) => e.k === 'parse_repair_no_reemit'));
});

test('自愈：回喂调用先瞬时失败(null)后成功 → 自愈续上不停泊（P1-1）', async () => {
  const st = mkState({ maxParseRepairRetries: 2 });
  // 初评坏 JSON → 回喂第一次 ok:false（瞬时失败）→ 退避后第二次 LGTM（成功自愈）。
  const out = await runReviewFixLoop(
    mkCfg(st),
    mkDrivers(st, [{ parseFail: true }, { ok: false, available: true }, { verdict: 'LGTM', findings: [] }], []),
  );
  assert.equal(out.resolved, true);
  assert.equal(st.reviewCalls.length, 3); // 初评 + 失败1 + 成功1
  assert.ok(st.events.some((e) => e.k === 'parse_repair_reemit_failed'));
});
