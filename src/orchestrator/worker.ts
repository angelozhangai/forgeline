import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { hours } from '../util/time.ts';
import { STATE_DIR } from '../root.ts';
import { store as sessions } from '../store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { jobSource } from './jobs/index.ts'; // 控制面/Runner 边界接缝：tick 经此取到期 job，不直接 DB 枚举
import type { State } from '../statemachine/states.ts';
import { runGateA, runGateARevision } from '../gates/gateA.ts';
import type { GateAOutcome } from '../gates/gateA.ts';
import { runGateB, finalizeGateBDoc } from '../gates/gateB.ts';
import { runGateBLoop } from '../gates/gateBLoop.ts';
import { runGateALoop, readGateAEnvelope } from '../gates/gateALoop.ts';
import { runGateCSetup, activateLeg, activeLeg } from '../gates/gateC.ts';
import { getLegs, patchLeg, planLegAdvance, planGateDAdvance } from '../gates/legs.ts';
import { runGateCLoop } from '../gates/gateCLoop.ts';
import { openReviewPr } from '../gates/gateD.ts';
import { runGateDLoop, MAX_CI_FIX_ATTEMPTS } from '../gates/gateDLoop.ts';
import { runGateDHarden } from '../gates/gateDHarden.ts';
import { writePrdTruth } from '../gates/prdTruth.ts';
import { worktreeHeadSha } from '../util/worktree.ts';
import { reconcileDrift } from '../drift/reconcile.ts';
import type { ReviewFixOutcome } from '../review/reviewFixLoop.ts';
import { markReviewActive, autoAssignOnGo, requestGateB, go, requestGateC, requestReviewPr } from '../actions.ts';
import type { ActionResult } from '../actions.ts';
import { autoActionFor, AUTONOMY_GATES, type AutoAction } from '../statemachine/autonomyPolicy.ts';
import { maybeCommitDeliveryDocs } from '../writes.ts';
import { projectForSession, project, defaultProjectId } from '../projects.ts';
import { listWorktrees, removeWorktree, deleteBranch, planWorktreeSweep } from '../util/worktree.ts';
import { runLimited } from './queue.ts';
import { classifyError, backoffMs, maxAutoRetries, maxReclaims, planRetry } from './retry.ts';
import { loadConfig } from '../config.ts';
import type { RuntimeConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { notify, syncGroupCard } from '../notify.ts';
import type { NotifyKind } from '../notify.ts';
import type { Session } from '../types.ts';

// ── 节点失败统一停泊：分类 → 瞬时则排程退避自动重试（耗尽转死信），永久则立即停泊等人 ──
// 替换原先「一律 transition(*_FAILED) + notify」，把瞬时基础设施抖动与语义失败分流（落实 P0-A/B）。
async function parkFailure(
  id: string,
  failState: State,
  stages: { event: string; label: string },
  err: unknown,
): Promise<void> {
  const s = (await sessions.get(id))!;
  const klass = classifyError(err);
  const msg = String(err).slice(0, 500);
  const tries = s.retry_count ?? 0;

  // 瞬时 + 未达上限 + 未死信 → 排程退避自动重试（不发通知避免噪声；下个 tick 到点 reconcile 拾起）。
  if (klass === 'transient' && tries < maxAutoRetries() && !s.dead_letter) {
    const attempt = tries + 1;
    const delay = backoffMs(attempt);
    await sessions.transition(id, failState, { error: msg, retry_count: attempt, next_retry_at: Date.now() + delay });
    await sessions.appendEvent(id, 'retry_scheduled', { stage: stages.event, attempt, max: maxAutoRetries(), klass, delay_ms: delay });
    log.warn(`${s.slug}: ${stages.label} 瞬时失败（第${attempt}/${maxAutoRetries()}次）→ ${Math.round(delay / 1000)}s 后自动重试 — ${msg.slice(0, 120)}`);
    return;
  }

  // 永久 / 瞬时重试耗尽 → 停泊等人。耗尽的瞬时标死信（automation 放弃，人工 retry 清）。
  const exhausted = klass === 'transient' && tries >= maxAutoRetries();
  await sessions.transition(id, failState, { error: msg, next_retry_at: null, ...(exhausted ? { dead_letter: 1 } : {}) });
  await sessions.appendEvent(id, 'error', { stage: stages.event, msg: String(err), klass, dead_letter: exhausted ? 1 : 0 });
  log.err(`${s.slug}: ${stages.label} 失败（${klass}${exhausted ? '·重试耗尽→死信' : ''}）— ${msg.slice(0, 160)}`);
  await notify('failed', (await sessions.get(id))!, { stage: stages.label, error: String(err) });
}

// 成功推进 → 清重试簿记（下次失败从零计数；毒丸计数归零）。仅在确有簿记时写，省无谓 UPDATE。
async function clearRetry(id: string): Promise<void> {
  const s = (await sessions.get(id))!;
  if (s.retry_count || s.next_retry_at || s.reclaim_count || s.dead_letter) {
    await sessions.patch(id, { retry_count: null, next_retry_at: null, reclaim_count: null, dead_letter: null });
  }
}

// 闸A 一轮（首轮/复评）跑完，据结论转移：无剩余→进 codex 对抗复审；到上限→GATE_A_STALLED；否则→等 PM 下一轮。
async function afterGateA(id: string, outcome: GateAOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.resolved) {
    // PM loop 无剩余开放问题 → 不直接确认，先过一道 codex 对抗复审（不通过继续，过了才 CONFIRMED）。
    // 进对抗即落 gate_a_adv_round=0 标记：万一首轮 codex 调用就失败（计轮/起线之前），retry 也能据此原地续跑
    // 对抗（不退回 INTAKE 重跑整闸 A、不重新打扰 PM）——见 planRetry。
    await sessions.transition(id, 'GATE_A_ADVERSARIAL', { gate_a_adv_round: 0 });
    await sessions.appendEvent(id, 'gate_a_resolved', { round: outcome.round });
    log.ok(`${s.slug}: 闸A 第${outcome.round}轮无剩余开放问题 → 进 codex 对抗复审`);
    await syncGroupCard((await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    await sessions.transition(id, 'GATE_A_STALLED');
    await sessions.appendEvent(id, 'gate_a_stalled', { round: outcome.round, open_questions: outcome.openQuestions });
    log.warn(`${s.slug}: 闸A 到 ${outcome.round - 1} 轮 PM 评审仍有 ${outcome.openQuestions} 条未决 → 停泊交 M 裁决`);
    await notify('needs_arbitration', (await sessions.get(id))!);
    return;
  }
  await sessions.transition(id, 'AWAITING_PM_CONFIRM');
  await sessions.appendEvent(id, 'gate_a_done', { round: outcome.round, open_questions: outcome.openQuestions });
  log.ok(`${s.slug}: 闸A 第${outcome.round}轮完成（${outcome.openQuestions} 条待 PM）→ 待 PM 确认`);
  await notify('needs_confirm', (await sessions.get(id))!);
}

// 闸B codex审⇄claude改 循环跑到下一停顿点，据结论转移：
// clean→待 GO；改方升级→等 M 答复；到上限→停泊裁决；每-tick 上限/重试→留循环态（下个 tick 续）。
async function afterGateB(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    // 留在 ADVERSARIAL_LOOP（poller 驱动，下个 tick 自动续跑）；不发通知，避免噪声。
    await sessions.appendEvent(id, 'gateb_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: 闸B 对抗第${outcome.round}轮暂停（每-tick 上限/重试）→ 下个 tick 续`);
    return;
  }
  if (outcome.resolved) {
    // 复审通过 → 清掉「再修一轮」可能残留的旧停泊意见（到此才有新结论；失败路径不经这里，残留得以留证）。
    await sessions.patch(id, { adversarial_residual: null });
    finalizeGateBDoc((await sessions.get(id))!);
    await sessions.transition(id, 'AWAITING_GO');
    await sessions.appendEvent(id, 'gate_b_done', { round: outcome.round, verdict: outcome.verdict });
    log.ok(`${s.slug}: 闸B codex审⇄claude改 第${outcome.round}轮通过 → 待 GO`);
    // 算自动指派推荐并落库（best-effort），供 GO 卡展示「建议 DRI + 各人负载」。
    await autoAssignOnGo(id);
    await notify('needs_go', (await sessions.get(id))!);
    return;
  }
  if (outcome.needsHuman) {
    await sessions.patch(id, { gate_b_human_asks: JSON.stringify(outcome.needsHuman) });
    await sessions.transition(id, 'AWAITING_GATE_B_INPUT');
    await sessions.appendEvent(id, 'gate_b_needs_human', { round: outcome.round, count: outcome.needsHuman.length });
    log.warn(`${s.slug}: 闸B 改方第${outcome.round}轮升级 ${outcome.needsHuman.length} 个问题 → 待 M 答复`);
    await notify('needs_gateb_input', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    finalizeGateBDoc((await sessions.get(id))!);
    await sessions.transition(id, 'GATE_B_STALLED');
    await sessions.appendEvent(id, 'gate_b_stalled', { round: outcome.round, findings: outcome.unresolvedFindings.length });
    log.warn(`${s.slug}: 闸B 对抗到 ${outcome.round} 轮仍有 ${outcome.unresolvedFindings.length} 条未决 → 停泊交 M 裁决`);
    await notify('needs_gateb_arbitration', (await sessions.get(id))!);
  }
}

// 闸A codex审⇄claude改 对抗循环跑到下一停顿点，据结论转移：
// LGTM→CONFIRMED（进闸B）；到上限→停泊裁决；每-tick 上限/重试→留循环态。闸A 不升级人在环（无 needsHuman）。
async function afterGateAAdversarial(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    await sessions.appendEvent(id, 'gatea_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: 闸A 对抗第${outcome.round}轮暂停（每-tick 上限/重试）→ 下个 tick 续`);
    return;
  }
  if (outcome.resolved) {
    // codex 对抗复审可能据「漏问」补进新的 open_questions（gate-a-fix.md 明确要求）——这些是 PM 还没答的问题。
    // 若有，绝不自动确认进闸B（那正是 Phase 2 要堵的「漏问→实现漂移」）：作废本轮对抗、重置对抗簿记，弹回
    // PM 答复；PM 答复→闸A 复评清空 open_questions→再起一轮 fresh 对抗。
    const env = readGateAEnvelope((await sessions.get(id))!);
    if (env.open_questions.length > 0) {
      await sessions.transition(id, 'AWAITING_PM_CONFIRM', {
        gate_a_adv_round: null,
        gate_a_reviewer_session: null,
        gate_a_fixer_session: null,
        gate_a_residual: null,
      });
      await sessions.appendEvent(id, 'gatea_adv_reopened', { round: outcome.round, open_questions: env.open_questions.length });
      log.warn(`${s.slug}: 闸A 对抗第${outcome.round}轮补出 ${env.open_questions.length} 条 PM 未答问题 → 弹回 PM 答复（不自动确认）`);
      await notify('needs_confirm', (await sessions.get(id))!);
      return;
    }
    await sessions.patch(id, { gate_a_residual: null }); // 清掉「停泊裁决」可能残留的旧 codex 意见
    markReviewActive(projectForSession(s).deliveryDir, s.slug);
    const note = '闸A 评审 + AI 对抗复审通过，自动确认';
    await sessions.transition(id, 'CONFIRMED', {
      confirmed_by: 'AI',
      confirmed_at: Date.now(),
      confirmed_notes: s.confirmed_notes ? `${s.confirmed_notes}\n[闸A] ${note}` : note,
    });
    await sessions.appendEvent(id, 'gatea_adv_resolved', { round: outcome.round, verdict: outcome.verdict });
    // 封口：把「已多轮评审 + PM 确认」机械合成进 prd-truth.md（闸B 唯一需求输入）。best-effort——
    // 失败不挡确认（闸B loadPrdTruth 会即时兜底合成）。
    try {
      if (writePrdTruth((await sessions.get(id))!)) await sessions.appendEvent(id, 'prd_truth_written', { at: 'gate_a_adversarial' });
    } catch (e) {
      log.warn(`${s.slug}: PRD 真源封口写盘失败（闸B 会兜底重建）— ${String(e).slice(0, 120)}`);
    }
    log.ok(`${s.slug}: 闸A codex 对抗第${outcome.round}轮通过 → 已确认`);
    await notify('needs_gateb', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    // residual（codex findings）已由 loop 的 persistResidual 落 gate_a_residual；交 M 裁决。
    await sessions.transition(id, 'GATE_A_STALLED');
    await sessions.appendEvent(id, 'gatea_adv_stalled', { round: outcome.round, findings: outcome.unresolvedFindings.length });
    log.warn(`${s.slug}: 闸A 对抗到 ${outcome.round} 轮仍有 ${outcome.unresolvedFindings.length} 条未决 → 停泊交 M 裁决`);
    await notify('needs_arbitration', (await sessions.get(id))!);
  }
}

// 跑闸A 对抗循环并据结论转移；失败统一走 parkFailure（瞬时退避自动重试 / 永久停泊 GATE_A_FAILED）。
async function runGateALoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateALoop((await sessions.get(id))!);
    await afterGateAAdversarial(id, outcome);
    await clearRetry(id);
  } catch (e) {
    await parkFailure(id, 'GATE_A_FAILED', { event: stage, label: '闸A 对抗' }, e);
  }
}

// 跑闸B 对抗循环并据结论转移；失败统一走 parkFailure（瞬时退避自动重试 / 永久停泊 GATE_B_FAILED）。
async function runGateBLoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateBLoop((await sessions.get(id))!);
    await afterGateB(id, outcome);
    await clearRetry(id); // 跑到停顿点（含 paused 续跑）即视为推进，清重试簿记
  } catch (e) {
    await parkFailure(id, 'GATE_B_FAILED', { event: stage, label: '闸B 对抗' }, e);
  }
}

// 闸C 实现⇄CI 循环跑到下一停顿点，据结论转移：
// 绿→AWAITING_GATE_D（待开 PR）；升级→等 M 答复；到上限→停泊裁决；每-tick 上限/重试→留循环态。
async function afterGateC(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    await sessions.appendEvent(id, 'gatec_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: 闸C 实现第${outcome.round}轮暂停（每-tick 上限/重试）→ 下个 tick 续`);
    return;
  }
  if (outcome.resolved) {
    await sessions.patch(id, { gate_c_residual: null });
    // 多仓顺序驱动：当前 leg CI 绿 → 标记；还有未绿 leg → activate 它续跑（留 GATE_C_LOOP）；全绿才进 AWAITING_GATE_D。
    // 单仓 = 恰 1 腿 → 直接全绿进 AWAITING_GATE_D（行为不变）。无 legs（旧 in-flight）→ activeLeg null，同样直接推进。
    const active = activeLeg((await sessions.get(id))!);
    const { nextRepo } = planLegAdvance(getLegs((await sessions.get(id))!), active?.repo ?? null);
    if (active) await patchLeg((await sessions.get(id))!, active.repo, { ci_ok: true });
    if (nextRepo) {
      const next = getLegs((await sessions.get(id))!).find((l) => l.repo === nextRepo);
      if (next) await activateLeg((await sessions.get(id))!, next);
      await sessions.appendEvent(id, 'gate_c_leg_done', { repo: active?.repo ?? null, round: outcome.round, next: nextRepo });
      log.ok(`${s.slug}: 闸C 仓 ${active?.repo} 本地 CI 绿（第${outcome.round}轮）→ 切下一仓 ${nextRepo} 续实现（GATE_C_LOOP）`);
      return; // 留 GATE_C_LOOP，下个 tick 跑 next leg
    }
    await sessions.transition(id, 'AWAITING_GATE_D');
    await sessions.appendEvent(id, 'gate_c_done', { round: outcome.round, repos: getLegs((await sessions.get(id))!).map((l) => l.repo) });
    log.ok(`${s.slug}: 闸C 全部目标仓本地 CI 全绿 → 待开 PR 复审`);
    await notify('needs_review_pr', (await sessions.get(id))!);
    return;
  }
  if (outcome.needsHuman) {
    await sessions.patch(id, { gate_c_human_asks: JSON.stringify(outcome.needsHuman) });
    await sessions.transition(id, 'AWAITING_GATE_C_INPUT');
    await sessions.appendEvent(id, 'gate_c_needs_human', { round: outcome.round, count: outcome.needsHuman.length });
    log.warn(`${s.slug}: 闸C 实现第${outcome.round}轮升级 ${outcome.needsHuman.length} 个问题 → 待 M 答复`);
    await notify('needs_gatec_input', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    await sessions.transition(id, 'GATE_C_STALLED');
    await sessions.appendEvent(id, 'gate_c_stalled', { round: outcome.round });
    log.warn(`${s.slug}: 闸C 到 ${outcome.round} 轮本地 CI/验收仍未全绿 → 停泊交 M 裁决`);
    await notify('needs_gatec_arbitration', (await sessions.get(id))!);
  }
}

// 跑闸C 实现循环并据结论转移；失败统一走 parkFailure（瞬时退避自动重试 / 永久停泊 GATE_C_FAILED）。
async function runGateCLoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateCLoop((await sessions.get(id))!);
    await afterGateC(id, outcome);
    await clearRetry(id);
  } catch (e) {
    await parkFailure(id, 'GATE_C_FAILED', { event: stage, label: '闸C 实现' }, e);
  }
}

// 闸D PR 对抗循环跑到下一停顿点，据结论转移：
// LGTM→GATE_D_HARDENING（补内环测试，M4）；升级→等 M 答复；到上限→停泊裁决；每-tick 上限/重试→留循环态。
async function afterGateD(id: string, outcome: ReviewFixOutcome): Promise<void> {
  const s = (await sessions.get(id))!;
  if (outcome.paused) {
    await sessions.appendEvent(id, 'gated_loop_paused', { round: outcome.round });
    log.info(`${s.slug}: 闸D PR 复审第${outcome.round}轮暂停（每-tick 上限/重试）→ 下个 tick 续`);
    return;
  }
  if (outcome.resolved) {
    // **pin 绿态**：此刻 worktree HEAD = 被 codex LGTM 的那个提交（loop 最后一次推的绿态 / 闸C 终态）。
    // 持久化它作补强基线——补强只 reset 到这个不可变 sha，绝不用移动 ref origin/<branch>（否则 harden/CI/push 的
    // 对象可能 ≠ 被 codex 审过的对象，Codex M4 Blocker）。取不到 → **当场抛错停泊 GATE_D_FAILED**，绝不进 HARDENING
    // （把诊断钉在 pin 点，免「LGTM→hardening→缺 sha」反复绕，Codex 二审 SF）。runGateDLoopStep 的 catch 接住转 park。
    const greenSha = s.worktree_path ? worktreeHeadSha(s.worktree_path) : null;
    if (!greenSha) throw new Error('闸D LGTM 但取不到 worktree 绿态 HEAD（无法 pin 补强基线）→ 停泊，不进补强');
    await sessions.patch(id, { gate_d_residual: null, gate_d_green_sha: greenSha });
    await sessions.transition(id, 'GATE_D_HARDENING');
    await sessions.appendEvent(id, 'gate_d_done', { round: outcome.round, verdict: outcome.verdict, green_sha: greenSha.slice(0, 12) });
    log.ok(`${s.slug}: 闸D codex 审 diff⇄claude 修 第${outcome.round}轮通过 → 进测试补强（GATE_D_HARDENING）`);
    return; // 下个 tick step(GATE_D_HARDENING) 跑补强（poller 驱动）
  }
  if (outcome.needsHuman) {
    await sessions.patch(id, { gate_d_human_asks: JSON.stringify(outcome.needsHuman) });
    await sessions.transition(id, 'AWAITING_GATE_D_INPUT');
    await sessions.appendEvent(id, 'gate_d_needs_human', { round: outcome.round, count: outcome.needsHuman.length });
    log.warn(`${s.slug}: 闸D 改方第${outcome.round}轮升级 ${outcome.needsHuman.length} 个问题 → 待 M 答复`);
    await notify('needs_gated_input', (await sessions.get(id))!);
    return;
  }
  if (outcome.stalled) {
    await sessions.transition(id, 'GATE_D_STALLED');
    await sessions.appendEvent(id, 'gate_d_stalled', { round: outcome.round, findings: outcome.unresolvedFindings.length });
    log.warn(`${s.slug}: 闸D 对抗到 ${outcome.round} 轮仍有 ${outcome.unresolvedFindings.length} 条未决 → 停泊交 M 裁决`);
    await notify('needs_gated_arbitration', (await sessions.get(id))!);
  }
}

// 跑闸D PR 对抗循环并据结论转移；失败统一走 parkFailure（瞬时退避自动重试 / 永久停泊 GATE_D_FAILED）。
async function runGateDLoopStep(id: string, stage: string): Promise<void> {
  try {
    const outcome = await runGateDLoop((await sessions.get(id))!);
    await afterGateD(id, outcome);
    await clearRetry(id);
  } catch (e) {
    await parkFailure(id, 'GATE_D_FAILED', { event: stage, label: '闸D PR 复审' }, e);
  }
}

// 跑闸D 测试补强（补内环测试 + CI 绿 + 出 merge-readiness + 推分支）。
// 多仓顺序驱动：当前 leg 补强完 → 把其闸D 终态（绿态/已验证 sha/报告/PR）持久化回 leg；还有未审 leg → 切下一条回
// GATE_D_LOOP 复审（留在闸D，不进合并就绪）；全部 leg 补强完才 AWAITING_HUMAN_MERGE（**永不自动 merge**）。
// 单仓 = 恰 1 腿 → 直接合并就绪（行为不变）；无 legs（旧 in-flight）→ activeLeg null，同样直接合并就绪。
// 失败统一 parkFailure GATE_D_FAILED（planRetry 据 gate_d_harden_round>0 回 HARDENING 续补，重入幂等；session 级字段=活跃 leg）。
async function runGateDHardenStep(id: string, stage: string): Promise<void> {
  try {
    await runGateDHarden((await sessions.get(id))!);
    const sNow = (await sessions.get(id))!;
    const active = activeLeg(sNow);
    // 持久化当前 leg 的闸D 终态回 leg（gate_d_harden_verified_sha 非空 = 该 leg 过闸D；ackMerged 据各 leg pr_url 核验）。
    if (active) {
      await patchLeg(sNow, active.repo, {
        gate_d_round: sNow.gate_d_round,
        gate_d_green_sha: sNow.gate_d_green_sha,
        gate_d_harden_verified_sha: sNow.gate_d_harden_verified_sha,
        merge_readiness_path: sNow.merge_readiness_path,
        pr_url: sNow.pr_url,
        pr_number: sNow.pr_number,
      });
    }
    const { nextRepo } = planGateDAdvance(getLegs((await sessions.get(id))!), active?.repo ?? null);
    if (nextRepo) {
      const next = getLegs((await sessions.get(id))!).find((l) => l.repo === nextRepo);
      if (next) await activateLeg((await sessions.get(id))!, next); // 重指下一条 leg：worktree/信封/PR + 闸D 循环态全对齐它
      await sessions.appendEvent(id, 'gate_d_leg_done', { repo: active?.repo ?? null, next: nextRepo });
      await enterRunning(id, 'GATE_D_LOOP'); // 下条 leg 从头审（activateLeg 已重置其闸D 轮次/会话）
      await clearRetry(id);
      log.ok(`${(await sessions.get(id))!.slug}: 闸D 仓 ${active?.repo} 补强+本地 CI 绿 → 切下一仓 ${nextRepo} 开 PR 复审（GATE_D_LOOP）`);
      return; // 留闸D，下个 tick 审 next leg
    }
    await sessions.transition(id, 'AWAITING_HUMAN_MERGE');
    await sessions.appendEvent(id, 'gate_d_hardened', { round: (await sessions.get(id))!.gate_d_harden_round ?? 1, repos: getLegs((await sessions.get(id))!).map((l) => l.repo) });
    await clearRetry(id);
    // 下游交付文档归档（config 门控 delivery_doc_commit，默认关，**绝不 push**）：此刻全部目标仓的 merge-readiness*.md
    // 已写盘 docs/delivery/<slug>/，一并提交到目标项目当前分支。best-effort——内部已吞异常，绝不挡合并就绪。
    const dc = await maybeCommitDeliveryDocs((await sessions.get(id))!);
    if (dc.committed) await sessions.appendEvent(id, 'delivery_docs_committed', { slug: (await sessions.get(id))!.slug });
    log.ok(`${(await sessions.get(id))!.slug}: 闸D 全部目标仓测试补强 + 本地 CI 全绿 → 合并就绪（AWAITING_HUMAN_MERGE，永不自动合并）`);
    await notify('needs_merge', (await sessions.get(id))!);
  } catch (e) {
    await parkFailure(id, 'GATE_D_FAILED', { event: stage, label: '闸D 测试补强' }, e);
  }
}

// 进运行态：转移 + 刷新群卡，让团队看到「评审中/设计中/AI 复审中」而非滞后的入账「排队」文案。
// syncGroupCard best-effort（内部 try/catch，仅群来源生效），不阻断也不会拖垮跑闸。
async function enterRunning(id: string, to: State): Promise<void> {
  await sessions.transition(id, to);
  await syncGroupCard((await sessions.get(id))!);
}

// 执行一个 ready session 的下一步。失败停泊到 *_FAILED，不抛出。
export async function step(s: Session): Promise<void> {
  if (s.state === 'INTAKE') {
    await enterRunning(s.id, 'GATE_A_RUNNING');
    try {
      const outcome = await runGateA((await sessions.get(s.id))!);
      await afterGateA(s.id, outcome);
      await clearRetry(s.id);
    } catch (e) {
      await parkFailure(s.id, 'GATE_A_FAILED', { event: 'gate_a', label: '闸A' }, e);
    }
    return;
  }

  // 闸A 复评（PM 答复后）：同会话 resume 续评 → 再回 PM / 确认 / 停泊裁决。
  if (s.state === 'GATE_A_REVISION_REQUESTED') {
    await enterRunning(s.id, 'GATE_A_RUNNING');
    try {
      const outcome = await runGateARevision((await sessions.get(s.id))!);
      await afterGateA(s.id, outcome);
      await clearRetry(s.id);
    } catch (e) {
      await parkFailure(s.id, 'GATE_A_FAILED', { event: 'gate_a_revision', label: '闸A 复评' }, e);
    }
    return;
  }

  // 闸A 对抗复审：PM loop 无开放问题后，codex审⇄claude改 跑到停顿点（poller 驱动，每-tick 上限后续跑）。
  if (s.state === 'GATE_A_ADVERSARIAL') {
    await runGateALoopStep(s.id, '闸A 对抗');
    return;
  }

  // 闸B：出初稿 → 进 codex审⇄claude改 对抗循环（同一 step 内一气跑到首个停顿点）。
  if (s.state === 'GATE_B_REQUESTED') {
    await enterRunning(s.id, 'GATE_B_RUNNING');
    try {
      await runGateB((await sessions.get(s.id))!);
    } catch (e) {
      await parkFailure(s.id, 'GATE_B_FAILED', { event: 'gate_b', label: '闸B' }, e);
      return;
    }
    await enterRunning(s.id, 'ADVERSARIAL_LOOP');
    await runGateBLoopStep(s.id, '闸B 对抗');
    return;
  }

  // 对抗循环续跑：每-tick 上限后下个 tick / tick 中断后 poller 自愈拾起（draft+轮次+会话已持久化，原地续）。
  if (s.state === 'ADVERSARIAL_LOOP') {
    await runGateBLoopStep(s.id, '闸B 对抗');
    return;
  }

  // 续修：M 答复升级问题后，resume 续修 → 回循环再评。
  if (s.state === 'GATE_B_REVISION_REQUESTED') {
    await enterRunning(s.id, 'ADVERSARIAL_LOOP');
    await runGateBLoopStep(s.id, '闸B 续修');
    return;
  }

  // 闸C：建隔离 worktree → 进实现⇄CI 循环（同一 step 内一气跑到首个停顿点）。
  if (s.state === 'GATE_C_REQUESTED') {
    await enterRunning(s.id, 'GATE_C_RUNNING');
    try {
      await runGateCSetup((await sessions.get(s.id))!);
    } catch (e) {
      await parkFailure(s.id, 'GATE_C_FAILED', { event: 'gate_c_setup', label: '闸C 建树' }, e);
      return;
    }
    await enterRunning(s.id, 'GATE_C_LOOP');
    await runGateCLoopStep(s.id, '闸C 实现');
    return;
  }

  // 实现循环续跑：每-tick 上限后下个 tick / tick 中断后 poller 自愈拾起（信封+轮次+会话已持久化）。
  if (s.state === 'GATE_C_LOOP') {
    await runGateCLoopStep(s.id, '闸C 实现');
    return;
  }

  // 续做：M 答复实现升级问题后，resume 续做 → 回循环再跑 CI。
  if (s.state === 'GATE_C_REVISION_REQUESTED') {
    await enterRunning(s.id, 'GATE_C_LOOP');
    await runGateCLoopStep(s.id, '闸C 续做');
    return;
  }

  // 闸D 开 PR：委托 forge-create-pr.sh 推分支 + 建 PR（绝不自动 merge；脚本幂等，tick 中断下个 tick 重入安全）。
  // 成功 → 进 GATE_D_LOOP 跑 codex 审 diff⇄claude 修；失败 → 停泊 GATE_D_FAILED。
  if (s.state === 'GATE_D_REQUESTED') {
    try {
      await openReviewPr((await sessions.get(s.id))!);
    } catch (e) {
      await parkFailure(s.id, 'GATE_D_FAILED', { event: 'gate_d_open_pr', label: '闸D 开 PR' }, e);
      return;
    }
    // 多仓：openReviewPr 开完 N 个 PR 后 session 仍停在最后一条 gate-C leg；进闸D 前**重指 primary leg**
    // （activateLeg 把 worktree/信封/pr_url + 闸D 循环态全对齐到 primary），否则闸D 会审「最后那条 leg 的树」却挂着
    // primary 的 PR（错审 + 后续误判 SHIPPED，Codex 2c Blocker）。单仓/无 legs 不动——session 本就指向唯一 leg（行为不变）。
    {
      const legs = getLegs((await sessions.get(s.id))!);
      if (legs.length > 1) {
        await activateLeg((await sessions.get(s.id))!, legs[0]);
        await sessions.appendEvent(s.id, 'gate_d_leg_active', { repo: legs[0].repo, pr: legs[0].pr_url });
      }
    }
    await enterRunning(s.id, 'GATE_D_LOOP');
    await runGateDLoopStep(s.id, '闸D PR 复审');
    return;
  }

  // PR 对抗循环续跑：每-tick 上限后下个 tick / tick 中断后 poller 自愈拾起（信封+轮次+双侧会话已持久化）。
  if (s.state === 'GATE_D_LOOP') {
    await runGateDLoopStep(s.id, '闸D PR 复审');
    return;
  }

  // 续修：M 答复 PR 复审升级问题后，resume 续修 → 回循环再审。
  // 回 loop 前清补强标记：任何从「补强/合并就绪」退回对抗续修的路径，都不能让陈旧 harden_round/绿态/已验证 sha 残留，
  // 否则下次失败 planRetry 会据旧 harden_round 误回 HARDENING、跳过 PR 对抗续修（Codex M4 SF）。正常 loop 续修时这些本就 null，清=no-op。
  if (s.state === 'GATE_D_REVISION_REQUESTED') {
    await sessions.patch(s.id, { gate_d_harden_round: null, gate_d_green_sha: null, gate_d_harden_verified_sha: null, merge_readiness_path: null });
    await enterRunning(s.id, 'GATE_D_LOOP');
    await runGateDLoopStep(s.id, '闸D 续修');
    return;
  }

  // 测试补强：codex LGTM 后补内环测试 + CI 绿 + 出 merge-readiness → 合并就绪（poller 驱动，tick 中断下个 tick 幂等重入）。
  if (s.state === 'GATE_D_HARDENING') {
    await runGateDHardenStep(s.id, '闸D 测试补强');
    return;
  }
}

// ── tick 锁：防 launchd 定时器重叠触发（闸A 可跑数分钟，新 tick 不能撞进来）──
// FORGE_LOCK 可覆盖锁路径（对齐 root.ts 的 FORGE_HEARTBEAT/FORGE_WATCHDOG_STATE 测试隔离约定）：
// tick.lock 是 STATE_DIR 下的**磁盘文件**、不随 FORGE_DB=:memory: 隔离，故并行测试进程会共享同一锁文件
// 而互相误判「已有 tick 在跑」。调 tick() 的测试设一个独立 FORGE_LOCK 即可彻底脱离共享。
const LOCK = process.env.FORGE_LOCK || resolve(STATE_DIR, 'tick.lock');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // 存在但无权限 = 仍活着
  }
}

// tick 锁陈旧判定（P2-I）：锁记 `pid\nts`。进程已死 → 失效；进程活着但持锁超 maxHoldMs（疑似卡死的
// 手动 tick——daemon 卡死由看门狗 SIGKILL→pid 死兜底，此处补手动 tick 挂死永久占锁的洞）→ 视为陈旧可接管。
export function lockActive(raw: string, now: number, maxHoldMs: number, alive: (pid: number) => boolean): boolean {
  const [pidStr, tsStr] = raw.trim().split(/\s+/);
  const pid = Number(pidStr);
  if (!pid || !alive(pid)) return false; // 进程已死 → 锁失效
  const ts = Number(tsStr) || now; // 老格式无时间戳 → 视为此刻（保守：算仍活）
  return now - ts < maxHoldMs; // 仍在 max-hold 内 → 活锁（跳过本次 tick）；超期 → 视为卡死可接管
}

// max-hold 取「单 tick 最长合法时长」的宽松上界，避免误判正常长 tick 卡死、又不让真卡死的锁永久霸占。
// 上游闸（审文档）：claude_timeout × 6。下游闸C/D（隔离 worktree 实现/改方 + 本地 CI）一个 tick 可跑很久——
// 必须把它真正的最长合法时长估全，否则长下游 tick 超过宽限会被误判卡死、被下一个 tick 接管 → 同一 worktree
// 双跑（烧钱 + 互踩 git）。取上游/下游较大值，且不少于 1h。
// （注：daemon 真卡死由看门狗 SIGKILL→pid 死兜底；本上界只为「手动 tick 挂死却未退」留接管口，宁松勿紧。）
//
// 下游单 tick 最坏路径，逐一数清 drv.fix / drv.review 调用（N = 有效 per-tick 轮数 = min(max_rounds, max_rounds_per_tick)）：
//   · 续答预修(reviewFixLoop 顶部)：1 个 fix 块；主循环至多 N 轮、且 for(;;) 至少跑一轮 ⇒ fix 块/review 各 ≤ N+1
//   · 每个 fix 块 = parseFixWithRepair：1 次 drv.fix + parse-repair 至多 P 次 ⇒ (1+P) 次 drv.fix；review 同理 (1+P) 次
//   · 每次 drv.fix（闸D 内含 CI 自修循环）≤ (claude+CI) × (1 + MAX_CI_FIX_ATTEMPTS=K)；每次 review ≤ (claude+CI)
//   合计 = (N+1)·(1+P)·(claude+CI)·(K+2)。P=parse_repair_retries。两闸取各自较大量。纯函数，导出供单测。
export function lockMaxHoldSec(rt: RuntimeConfig): number {
  const upstream = rt.claude_timeout_sec * 6;
  // 仅当配置了下游闸时才把下游预算纳入（未配下游 → 不会有下游 tick，无需放宽接管窗）。
  let downstream = 0;
  if (rt.gate_c || rt.gate_d) {
    const dsClaude = Math.max(rt.gate_c?.claude_timeout_sec ?? rt.claude_timeout_sec, rt.gate_d?.claude_timeout_sec ?? rt.claude_timeout_sec);
    const dsCi = Math.max(rt.gate_c?.ci_timeout_sec ?? 1800, rt.gate_d?.ci_timeout_sec ?? 1800);
    const p = Math.max(0, rt.parse_repair_retries ?? 2); // 每次 fix/review 解析失败回喂重出上限
    // 有效 per-tick 轮数（口径同 gateC/DLoop：min(max_rounds, max_rounds_per_tick ?? 1)）；两闸取大。
    // 调大下游 max_rounds_per_tick 会让单 tick 跑更多轮，此处随配置同步放大上界，绝不再回到固定 1 的低估。
    const perTickOf = (g: { max_rounds?: number; max_rounds_per_tick?: number } | undefined, defMax: number): number =>
      g ? Math.max(1, Math.min(Math.max(1, g.max_rounds ?? defMax), g.max_rounds_per_tick ?? 1)) : 0;
    const perTick = Math.max(perTickOf(rt.gate_c, 4), perTickOf(rt.gate_d, 3));
    downstream = (perTick + 1) * (1 + p) * (dsClaude + dsCi) * (MAX_CI_FIX_ATTEMPTS + 2);
  }
  return Math.max(upstream, downstream, 3600);
}
function lockMaxHoldMs(): number {
  return lockMaxHoldSec(loadConfig().runtime) * 1000;
}

// 接管 claim 若超此久未清 = 上次接管中途崩溃残留（接管本身是 write+unlink 亚毫秒级，崩在中间极罕见）→ 回收。
const CLAIM_STALE_MS = 30_000;

// 拿 tick 锁。原子性是关键（防两个进程同时跑 step → 双花钱 + 同一 worktree 互踩 git）：
//  1) 常态——原子独占创建（`wx`）：锁不存在时一步拿下，杜绝旧版「existsSync→writeFileSync」之间两个 fresh
//     acquire 都判「不存在」而都写入的竞态。
//  2) 锁已存在且活锁（持有者活着且未超 maxHold）→ 让路。
//  3) 陈旧/卡死（持有者已死，或超 maxHold 上界）→ 接管，但接管必须原子：旧版「读-判陈旧-直接覆写」会让两个
//     进程同判陈旧而都覆写、都继续。改用独占 `wx` 的 .claim 文件做接管权仲裁——只有抢到 claim 的进程能替换锁。
// 参数化锁路径供单测（默认 LOCK）。
export function acquireLock(lockPath: string = LOCK): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  const stamp = (): string => `${process.pid}\n${Date.now()}`;
  try {
    writeFileSync(lockPath, stamp(), { flag: 'wx' }); // 原子独占创建
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    /* 刚被释放/读不到 → 按陈旧处理，走 claim 仲裁 */
  }
  if (raw && lockActive(raw, Date.now(), lockMaxHoldMs(), pidAlive)) return false; // 活锁让路
  const claim = `${lockPath}.claim`;
  if (!acquireClaim(claim)) return false; // 没抢到接管权（另一个进程正接管）→ 让路
  try {
    log.warn(`发现陈旧/卡死 tick 锁（${raw.trim().replace(/\s+/g, ' ') || '空/已释放'}），接管`);
    writeFileSync(lockPath, stamp()); // 持 claim 期间安全替换
    return true;
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      /* ignore */
    }
  }
}

// 独占抢「接管权」：`wx` 创建成功=抢到；已存在且新鲜=别人正接管，让路；已存在但陈旧（上次接管崩溃残留）→ 回收后再抢一次。导出供单测。
export function acquireClaim(claim: string): boolean {
  try {
    writeFileSync(claim, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let ts = 0;
  try {
    ts = Number(readFileSync(claim, 'utf8').trim().split(/\s+/)[1]) || 0;
  } catch {
    /* 竞争者已删 → 当陈旧回收 */
  }
  if (ts && Date.now() - ts <= CLAIM_STALE_MS) return false; // 别人正接管，让路
  try {
    unlinkSync(claim); // 回收崩溃残留的陈旧 claim
    writeFileSync(claim, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
    return true;
  } catch {
    return false; // 回收/再创建被别人抢先 → 让路
  }
}

export function releaseLock(lockPath: string = LOCK): void {
  try {
    if (!existsSync(lockPath)) return;
    const pid = Number(readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0]); // 容忍 `pid\nts` 新格式
    if (pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// 孤儿态自愈：持锁后，仍卡在瞬态 RUNNING 的 session = 上一个 tick 中途死了 → 顺合法边复位重跑。
// 注：ADVERSARIAL_LOOP / GATE_B_REVISION_REQUESTED 已是 poller 驱动态，tick 中断后由正常 poller 拾起原地续跑
// （draft+轮次+会话每轮持久化，最多丢一轮），无需在此 reclaim——否则每次「每-tick 暂停」都误报 recovered。
const RECLAIM: { from: State; fail: State; back: State }[] = [
  { from: 'GATE_B_RUNNING', fail: 'GATE_B_FAILED', back: 'GATE_B_REQUESTED' }, // 初稿中途死，无 draft → 干净重跑
];

// 复位一个孤儿：累加 reclaim_count；达上限/已死信 → 判毒丸转死信（不再复活，告警交人工），否则正常复位重跑。
async function reclaimOne(s: Session, from: State, fail: State, back: State): Promise<void> {
  const rc = (s.reclaim_count ?? 0) + 1;
  if (s.dead_letter || rc > maxReclaims()) {
    // 毒丸：反复跑 gate 中途死（疑似确定性崩溃 daemon）→ 死信停泊，斩断崩溃-重启-烧 token 无限环。
    await sessions.transition(s.id, fail, { error: `孤儿复位 ${rc - 1} 次仍中途死，疑似毒丸 → 转死信待人工`, dead_letter: 1, next_retry_at: null });
    await sessions.appendEvent(s.id, 'dead_letter', { from, reason: 'max_reclaims', reclaim_count: rc - 1 });
    log.err(`${s.slug}: 孤儿态 ${from} 复位达上限(${maxReclaims()}) → 死信（疑似毒丸），停泊待人工 retry`);
    await notify('failed', (await sessions.get(s.id))!, { stage: '孤儿复位', error: `复位 ${rc - 1} 次仍中途死，疑似毒丸，已转死信（人工 retry 清）` });
    return;
  }
  await sessions.transition(s.id, fail, { error: 'orphaned RUNNING reclaimed（tick 中断残留）', reclaim_count: rc });
  await sessions.transition(s.id, back, { error: null });
  await sessions.appendEvent(s.id, 'recover', { from, to: back, reclaim_count: rc });
  log.warn(`${s.slug}: 孤儿态 ${from} → ${back}（自愈第${rc}次，将重跑）`);
  await notify('recovered', (await sessions.get(s.id))!, { from, to: back });
}

async function reclaimOrphans(): Promise<void> {
  // 闸A RUNNING 孤儿：复评中途死（仍有 pending_input）→ 回复评点不丢轮次；否则首轮孤儿 → 回 INTAKE 重跑。
  for (const s of await sessions.listByStates(['GATE_A_RUNNING'])) {
    const back: State = s.gate_a_pending_input ? 'GATE_A_REVISION_REQUESTED' : 'INTAKE';
    await reclaimOne(s, 'GATE_A_RUNNING', 'GATE_A_FAILED', back);
  }
  // 闸C 建树（GATE_C_RUNNING，非 poller 驱动的瞬态）孤儿：已建树 → 续跑实现循环；未建树 → 干净重 setup。
  // GATE_C_LOOP 是 poller 驱动态，tick 中断由正常 poller 拾起原地续跑（信封+轮次+会话已持久化），不在此 reclaim。
  for (const s of await sessions.listByStates(['GATE_C_RUNNING'])) {
    const back: State = s.worktree_path ? 'GATE_C_LOOP' : 'GATE_C_REQUESTED';
    await reclaimOne(s, 'GATE_C_RUNNING', 'GATE_C_FAILED', back);
  }
  for (const { from, fail, back } of RECLAIM) {
    for (const s of await sessions.listByStates([from])) {
      await reclaimOne(s, from, fail, back);
    }
  }
}

const SWEEP_MIN_AGE_MS = 60 * 60 * 1000; // 年龄保护窗 1h：绝不清可能正在建（worktree_path 尚未落库）的 worktree

// 孤儿 worktree 清扫：删 SHIPPED 终态遗留（ackMerged 清理失败/漏跑）+ 无 owner 的 forge 命名孤儿，年龄过保护窗才清。
// 此前 cleanup 全压在 ackMerged best-effort 上、注释假设有「孤儿清扫」却没人实现——长跑 daemon 下隔离 worktree
// （各带整套 node_modules）会无界堆积。决策纯函数 planWorktreeSweep 守安全（在用/太新/非 forge 一律不碰）。
// best-effort：任何失败只告警、绝不打断 gate 推进。清理用裸 git worktree remove（移除不需项目脚本/pnpm）。
async function sweepOrphanWorktrees(): Promise<void> {
  try {
    // 多仓：一个 session 的 worktree 散在各 leg（+ 兼容旧 session 级 worktree_path）。全收齐再分桶，绝不漏保护非 primary leg 的活树。
    const pathsOf = (s: Session): string[] => [s.worktree_path, ...getLegs(s).map((l) => l.worktree_path)].filter((p): p is string => !!p);
    const withWt = (await sessions.listAll()).filter((s) => pathsOf(s).length > 0);
    const shippedPaths = new Set(withWt.filter((s) => s.state === 'SHIPPED').flatMap(pathsOf));
    const livePaths = new Set(withWt.filter((s) => s.state !== 'SHIPPED').flatMap(pathsOf));
    // 要扫的主仓集：所有有 worktree 的 session 各自项目主仓 + 默认项目主仓（兜「无 session 的孤儿」）。
    const repoDirs = new Set<string>();
    const addRepo = (p: ReturnType<typeof project>): void => {
      for (const r of p.repos) repoDirs.add(p.repoPath(r)); // 遍历全 repos：worktree 锚在各自目标仓，孤儿可能在任一仓下（非只 repos[0]）
    };
    try {
      addRepo(project(defaultProjectId()));
    } catch {
      /* 默认项目缺省 → 跳过 */
    }
    for (const s of withWt) {
      try {
        addRepo(projectForSession(s));
      } catch {
        /* 项目缺失 → 跳过 */
      }
    }
    const now = Date.now();
    for (const repoDir of repoDirs) {
      const main = resolve(repoDir);
      const onDisk = listWorktrees(repoDir)
        .filter((p) => resolve(p) !== main) // 绝不碰主 checkout
        .map((p) => {
          let ageMs = Number.POSITIVE_INFINITY; // 路径已不在（登记残留）→ 视为很老，可清登记
          try {
            ageMs = now - statSync(p).mtimeMs;
          } catch {
            /* 目录已没 → 留 Infinity */
          }
          return { path: p, ageMs };
        });
      const toSweep = planWorktreeSweep({ onDisk, shippedPaths, livePaths, minAgeMs: SWEEP_MIN_AGE_MS });
      for (const path of toSweep) {
        const rm = await removeWorktree({ repoDir, path }); // 裸 git worktree remove --force + prune
        const owner = withWt.find((s) => pathsOf(s).includes(path));
        // 删残留 forge/<...> 分支：legs 各仓同名分支（基于 id 哈希），取 owner 任一已知分支名即可（同名）。
        const branch = owner?.impl_branch ?? getLegs(owner ?? ({} as Session)).find((l) => l.impl_branch)?.impl_branch ?? null;
        if (branch) deleteBranch(repoDir, branch);
        log.warn(`孤儿清扫：移除 worktree ${path}（${rm.ok ? 'ok' : `fail: ${rm.output.slice(0, 80)}`}）`);
      }
    }
  } catch (e) {
    log.warn(`孤儿 worktree 清扫本轮异常（不影响 gate 推进）：${String(e).slice(0, 140)}`);
  }
}

// 退避到点的瞬时失败 → 自动翻回可重跑态（与 forge retry 同口径），同 tick 被下面 ready 扫描拾起重跑。
// 死信 / 未到点 / 无重试路径(如 WRITE_FAILED) 跳过。retry_count 不清——耗尽时 parkFailure 会转死信。
async function reconcileRetries(now: number): Promise<void> {
  // 所有有自动重试路径的 *_FAILED 都纳入扫描：parkFailure 排 next_retry_at + planRetry 支持，
  // 漏扫就会「排了重试却永不触发」= 静默卡死（Codex Should-Fix#1）。
  for (const s of await sessions.listByStates(['GATE_A_FAILED', 'GATE_B_FAILED', 'GATE_C_FAILED', 'GATE_D_FAILED'])) {
    if (s.dead_letter) continue;
    if (s.next_retry_at == null || now < s.next_retry_at) continue;
    const plan = planRetry(s);
    if (!plan) continue;
    await sessions.transition(s.id, plan.to, { ...plan.fields, next_retry_at: null });
    await sessions.appendEvent(s.id, 'auto_retry', { from: s.state, to: plan.to, attempt: s.retry_count ?? 0 });
    log.warn(`${s.slug}: 退避窗已过 → 自动重试（已第${s.retry_count ?? 0}次）${s.state} → ${plan.to}`);
  }
}

// 停泊态业务对账（P2-F）：停在「等人处理」态过久 + 近期没提醒过 → 重发一次对应卡片，去抖。
// 补「单张失败/裁决卡若那一刻飞书挂了就永久没人知道」的洞——看门狗管进程存活，这里管业务存活。
const STUCK_AFTER_MS = hours(6); // 停泊超 6h 未动 → 视为可能被遗忘
const REMIND_EVERY_MS = hours(12); // 同一 session 最多每 12h 提醒一次（去抖）
// 等人处理的停泊态 → 重发哪类卡（与首次通知同卡，含可点按钮/CLI 提示）。
const STUCK_KIND: Partial<Record<State, NotifyKind>> = {
  GATE_A_FAILED: 'failed',
  GATE_B_FAILED: 'failed',
  WRITE_FAILED: 'failed',
  GATE_A_STALLED: 'needs_arbitration',
  GATE_B_STALLED: 'needs_gateb_arbitration',
  AWAITING_GATE_B_INPUT: 'needs_gateb_input',
  AWAITING_GO: 'needs_go',
  CONFIRMED: 'needs_gateb',
};

export async function remindStuck(now: number): Promise<void> {
  const states = Object.keys(STUCK_KIND) as State[];
  for (const s of await sessions.listByStates(states)) {
    if (now - s.updated_at < STUCK_AFTER_MS) continue;
    // *_FAILED 若已排程自动重试（未死信且 next_retry_at 在）→ 不是「等人」，不提醒。
    if (s.state.endsWith('FAILED') && !s.dead_letter && s.next_retry_at != null) continue;
    const last = await sessions.lastEventTs(s.id, 'stuck_reminded');
    if (last != null && now - last < REMIND_EVERY_MS) continue;
    const kind = STUCK_KIND[s.state];
    if (!kind) continue;
    await sessions.appendEvent(s.id, 'stuck_reminded', { state: s.state, idle_h: Math.round((now - s.updated_at) / 3600000), dead_letter: s.dead_letter ?? 0 });
    log.warn(`${s.slug}: 停泊 ${s.state} 已 ${Math.round((now - s.updated_at) / 3600000)}h 未处理 → 重发提醒`);
    await notify(kind, (await sessions.get(s.id))!, { stage: '停泊提醒', error: s.error ?? undefined });
  }
}

// 把某个自治动作派到对应 action（绝不带 --force：lint/指派/确定性闸不过 → action 自身 !ok，session 老实留停泊）。
function runAutoAction(idOrSlug: string, action: AutoAction, by: string): Promise<ActionResult> {
  switch (action) {
    case 'requestGateB':
      return requestGateB(idOrSlug, by);
    case 'go':
      return go(idOrSlug, by);
    case 'requestGateC':
      return Promise.resolve(requestGateC(idOrSlug, by));
    case 'requestReviewPr':
      return Promise.resolve(requestReviewPr(idOrSlug, by));
  }
}

// 渐进自治：停泊在「纯授权停泊点」（CONFIRMED/AWAITING_GO/DONE/AWAITING_GATE_D）的 session，若其**项目**自治等级允许，
// 自动触发对应动作（as 配置 actor，落审计事件）。默认 level 0 → 全跳过（零行为变更）。动作内部的权限/确定性闸
// （go 的 lint+指派、never-merge、CI 绿前置）仍是最后防线——未过即返回 !ok，留人工。永不自动触发 *_STALLED/*_INPUT/merge。
export async function applyAutonomy(): Promise<void> {
  for (const s of await sessions.listByStates([...AUTONOMY_GATES])) {
    // 单 session 全流程（含项目解析）都包进 try：某条解析/动作抛错只记该条、继续下一条，绝不中断整个 pass（Codex SF）。
    try {
      const { level, actor } = projectForSession(s).autonomy;
      if (level <= 0 || !actor) continue;
      const action = autoActionFor(s.state, level);
      if (!action) continue;
      // 去抖：同一停泊态只尝试一次——上次尝试后 session 未变（updated_at ≤ 上次尝试 ts；appendEvent 不 bump updated_at）则跳过，
      // 免 !ok（权限/lint/指派不过）留停泊时每 tick 重试刷事件。人改了 session（patch/transition bump updated_at）才重试（Codex SF）。
      const lastTry = await sessions.lastEventTs(s.id, 'autonomy_auto_triggered');
      if (lastTry != null && s.updated_at <= lastTry) continue;
      // 审计**先于**副作用：auto-GO 的 go() 可能已建 Epic/子 issue、发方案后才在 label/approve 失败（→WRITE_FAILED）返回 !ok，
      // 这条真外向写绝不能无痕——故先落「已尝试」，再调动作，调完追记结果（Codex Blocker）。
      await sessions.appendEvent(s.id, 'autonomy_auto_triggered', { level, action, from: s.state, by: actor });
      const r = await runAutoAction(s.id, action, actor);
      const to = (await sessions.get(s.id))?.state ?? s.state;
      await sessions.appendEvent(s.id, 'autonomy_auto_result', { action, ok: r.ok, to, msg: r.ok ? undefined : r.msg.slice(0, 160) });
      if (r.ok) log.ok(`${s.slug}: 自治 L${level} 自动 ${action}（${s.state}→${to}，as ${actor}）`);
      else log.info(`${s.slug}: 自治 L${level} ${action} 未过 → 留人工（${r.msg.slice(0, 120)}）`);
    } catch (e) {
      await sessions.appendEvent(s.id, 'autonomy_auto_result', { ok: false, error: String(e).slice(0, 160) });
      log.warn(`${s.slug}: 自治自动触发异常（不影响其它 session）：${String(e).slice(0, 140)}`);
    }
  }
}

// 跑一轮：拾取所有 ready session，按并发上限推进。持 tick 锁，先自愈孤儿态、拾起退避到点的瞬时失败、提醒久停泊。
export async function tick(): Promise<number> {
  if (!acquireLock()) {
    log.info('tick：已有一个 tick 在跑，跳过本次');
    return 0;
  }
  try {
    const cfg = loadConfig();
    const now = Date.now();
    // ── 控制面编排策略（reclaim/retry/autonomy/remind/sweep/drift）：**只在控制面 / all-in-one 跑** ──
    // 纯 runner（设了 FORGE_CONTROL_URL）**跳过**：否则多 runner 各自 tick 会并发跑这些控制面写动作（孤儿复位/退避
    // 重试/自治触发/停泊提醒/worktree 清扫/漂移对账），而 lease 只护 job loop、管不到它们——多 runner 下会重复触发
    // （重复 retry/重复自治建 issue/重复清扫互踩）。这些是「控制面」职责：分离部署里由控制面进程跑，runner 只跑 job。
    // 默认（未设 FORGE_CONTROL_URL）= all-in-one，全跑，**行为零变更**。
    const pureRunner = !!process.env.FORGE_CONTROL_URL;
    if (!pureRunner) {
      await reclaimOrphans();
      await reconcileRetries(now);
      // 渐进自治先于 remindStuck：自治覆盖的授权点（CONFIRMED/AWAITING_GO 等）本就要自动推进，别先催人「请处理」又同 tick 自动走掉（Codex Nit）。
      // 转入的 poller 态本 tick 即被下面 claimDueJobs 拾起；默认 L0 全跳过（零行为变更）。
      await applyAutonomy();
      await remindStuck(now);
      await sweepOrphanWorktrees(); // 孤儿 worktree 清扫（best-effort，自带 try/catch；不打断 gate）
      // 立项后漂移闭环（opt-in，默认关）：DONE 需求 issue 全合并后对账实现 vs 验收契约，漂移私聊告警 M。
      // 独立子系统，包 try/catch——任何异常绝不打断核心 gate 推进。
      if (cfg.runtime.drift?.enabled) {
        try {
          await reconcileDrift(now);
        } catch (e) {
          log.warn(`漂移闭环本轮异常（不影响 gate 推进）：${String(e).slice(0, 160)}`);
        }
      }
    }
    // ── runner job 循环：经 JobSource 接缝**原子认领**至多 max_parallel 条到期 job（lease 防多 runner 重领）→ 对每个跑 step。
    // 认领量 = 本轮并发容量：只领这一轮就开跑的量，绝不一次占租整个 backlog（见 store leaseClaim：防排队 job 倒 TTL 被重领双跑）。
    const ready = await jobSource.claimDueJobs(cfg.runtime.max_parallel);
    if (ready.length === 0) {
      log.info('tick：无待处理 session');
      return 0;
    }
    log.info(`tick：${ready.length} 个待处理（并发上限 ${cfg.runtime.max_parallel}）`);
    await runLimited(ready, cfg.runtime.max_parallel, step);
    return ready.length;
  } finally {
    releaseLock();
  }
}
