import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectForSession, configForSession } from './projects.ts';
import { loadConfig, inAllowList } from './config.ts';
import { store as sessions } from './store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { doWrites } from './writes.ts';
import { prMergeState } from './workspace.ts';
import { commentDoc } from './docs/index.ts';
import { notify, syncGroupCard } from './notify.ts';
import { normSize, SIZES, sizeBadge } from './util/sizing.ts';
import { probeLoad } from './util/load.ts';
import { recommend, inPool, type Recommendation } from './util/assign.ts';
import { removeWorktree, deleteBranch } from './util/worktree.ts';
import { reqRef } from './util/display.ts';
import { log } from './util/log.ts';
import { lintAcceptance } from './util/acceptance.ts';
import { GateBSchema, humanAsksToDecisions, composeDecisionAnswer } from './gates/envelopes.ts';
import { resolveTargetRepos, primaryTargetRepo } from './util/targetRepos.ts';
import { getLegs, patchLeg } from './gates/legs.ts';
import { readGateAEnvelope } from './gates/gateALoop.ts';
import { writePrdTruth } from './gates/prdTruth.ts';
import { planRetry } from './orchestrator/retry.ts';
import type { GateBEnvelope, HumanAsk } from './gates/envelopes.ts';
import type { Session } from './types.ts';
import type { Config } from './config.ts';
import type { State } from './statemachine/states.ts';

// 手动/自动重试都清的重试簿记复位（人工 retry 视为强制覆盖，清死信 + 重试/复位计数从零）。
const RETRY_BOOKKEEPING_RESET: Partial<Session> = {
  retry_count: null,
  next_retry_at: null,
  reclaim_count: null,
  dead_letter: null,
  // 人工 retry = 断路器手动复位：清各闸连续 fix 失败计数，给「修了底层问题再重试」一个全新预算（否则上次到顶的 streak 残留会一失败就立刻再 STALLED）。
  gate_a_fix_fail_streak: null,
  gate_b_fix_fail_streak: null,
  gate_c_fix_fail_streak: null,
  gate_d_fix_fail_streak: null,
};

// 把飞书升级答复表单的选择 + 补充说明，拼成结构化答复（回喂同一 claude 会话续修）。
// fv 形如 { ask_H1: '退到余额' | '__other__', ask_H2: '…', notes: '…' }。
// id 纯按位置（askId(i)=H{n}），与 notify 渲染同一份 asks、同序，保证选项↔问题对得上（不信 LLM 的 id）。
export function composeHumanAnswer(asks: HumanAsk[], fv: Record<string, string>): string {
  return composeDecisionAnswer(humanAsksToDecisions(asks), fv);
}

export interface ActionResult {
  ok: boolean;
  msg: string;
}

export function markReviewActive(deliveryDir: string, slug: string): void {
  const doc = resolve(deliveryDir, slug, 'req-review.md');
  if (!existsSync(doc)) return;
  const t = readFileSync(doc, 'utf8').replace(
    /^status: draft.*$/m,
    'status: active           # 已拍板（闸A 通过，机器服务确认）',
  );
  writeFileSync(doc, t);
}

// 评审人定/调复杂度档（AI 提议后的人工确认；档位全程流转、写进 issue、可加总工作量）。
export async function setSize(idOrSlug: string, sizeRaw: string, by: string, reason?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  const size = normSize(sizeRaw);
  if (!size) return { ok: false, msg: `非法档位 ${sizeRaw}，取值 ${SIZES.join('/')}` };
  await sessions.patch(s.id, { size, size_source: 'human', ...(reason ? { size_reason: reason } : {}) });
  await sessions.appendEvent(s.id, 'size_set', { size, by, reason: reason ?? null });
  void syncGroupCard((await sessions.get(s.id))!).catch(() => undefined); // 刷新群卡上的复杂度展示
  return { ok: true, msg: `✓ ${reqRef(s)} 复杂度 → ${sizeBadge(size)}（${by} 确认）` };
}

// 探测人选池负载 + 算自动指派推荐（async IO：每人每仓一发 gh）。规模取会话定档。
async function computeReco(s: Session): Promise<Recommendation> {
  const cfg = configForSession(s); // 配置分化：人选池/负载口径按该 session 的项目（assignment 覆盖）
  const proj = projectForSession(s); // org/扫仓/伞仓均按该 session 的项目（your-monorepo 可不同 org / 自己的 repos）
  const loads = await probeLoad(cfg, proj); // proj 结构化子集喂 probeLoad：owner/repos/umbrella/repoSlugs/repoMap（含跨栈字母口径）

  return recommend(normSize(s.size ?? ''), loads, cfg.assignment);
}

// 推荐理由表（CLI/卡兜底展示）：每行 在研 wip/上限 · 负载 → 投影，标推荐人与超 WIP 者。
export function formatRecoTable(reco: Recommendation): string {
  return reco.table
    .map((r) => {
      const mark = r.code === reco.pick ? '→' : ' ';
      if (r.ok === false) return `  ${mark} ${r.code.padEnd(3)} 负载未知（探测失败，已排除）`;
      const cap = r.eligible ? '' : ' ✗超WIP';
      return `  ${mark} ${r.code.padEnd(3)} 在研 ${r.wip}/${r.wipLimit} · 负载 ${r.loadPoints.toFixed(1)} → 投影 ${r.projected.toFixed(1)}${cap}`;
    })
    .join('\n');
}

// 进入 AWAITING_GO 时算自动推荐并落库（best-effort，绝不抛——指派算不出不该挡立项）。
// 落库自动推荐结果。有 pick → 采纳(source='auto')。无 pick(全探测失败/池空)→ 强制人工：
// 清掉「上一条 auto 指派」防陈旧 DRI 蒙混过 GO 闸；但保留人工指派(source='human'，M 的明确决定不被失败探针抹掉)。
// 返回是否清掉了陈旧 auto（供调用方提示/审计）。
async function persistReco(s: Session, reco: Recommendation, by: string): Promise<boolean> {
  if (reco.pick) {
    await sessions.patch(s.id, {
      assign_snapshot: JSON.stringify(reco),
      assignee: reco.pick,
      assignee_source: 'auto',
      assigned_by: by,
      assigned_at: Date.now(),
    });
    return false;
  }
  const clearStale = s.assignee_source === 'auto';
  await sessions.patch(s.id, {
    assign_snapshot: JSON.stringify(reco),
    ...(clearStale ? { assignee: null, assignee_source: null, assigned_by: null, assigned_at: null } : {}),
  });
  return clearStale;
}

// 默认采纳推荐人（source='auto'）；M 可在 GO 卡/CLI 改派。探测失败 → 清陈旧 auto/留空 assignee，GO 卡降级为手动选。
export async function autoAssignOnGo(idOrSlug: string): Promise<void> {
  try {
    const s = await sessions.resolve(idOrSlug);
    if (!s) return;
    const reco = await computeReco(s);
    const cleared = await persistReco(s, reco, 'auto');
    await sessions.appendEvent(s.id, 'assign_auto', { pick: reco.pick, allOverWip: reco.allOverWip, probeIncomplete: reco.probeIncomplete, clearedStaleAuto: cleared });
  } catch (e) {
    log.warn(`自动指派推荐失败(不影响立项流程)：${String(e).slice(0, 140)}`);
  }
}

// 指派 DRI：手动指定（--to）或重算自动推荐。权限同 GO（go_approvers，管理决策）。
export async function assign(
  idOrSlug: string,
  by: string,
  opts: { to?: string; auto?: boolean } = {},
): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'assign', by });
    return { ok: false, msg: `✗ ${by} 无指派权限（go_approvers=${cfg.permissions.go_approvers.join(',')}）` };
  }
  // 手动指定
  if (opts.to) {
    const code = inPool(cfg.assignment, opts.to);
    if (!code) return { ok: false, msg: `非法指派 ${opts.to}，取值 ${cfg.assignment.pool.join('/')}` };
    await sessions.patch(s.id, { assignee: code, assignee_source: 'human', assigned_by: by, assigned_at: Date.now() });
    await sessions.appendEvent(s.id, 'assign', { to: code, by, source: 'human' });
    void syncGroupCard((await sessions.get(s.id))!).catch(() => undefined);
    return { ok: true, msg: `✓ ${reqRef(s)} 指派 → ${code}（${by} 手动）` };
  }
  // 自动：探测负载 + 推荐
  const reco = await computeReco(s);
  const cleared = await persistReco(s, reco, by);
  await sessions.appendEvent(s.id, 'assign_auto', { pick: reco.pick, allOverWip: reco.allOverWip, probeIncomplete: reco.probeIncomplete, by, clearedStaleAuto: cleared });
  void syncGroupCard((await sessions.get(s.id))!).catch(() => undefined);
  if (!reco.pick) {
    const note = cleared ? '（已清除上一条自动指派）' : '';
    return { ok: false, msg: `未算出推荐（人选池负载全部探测失败或池为空）${note}。请手动：./forge assign ${s.slug} <${cfg.assignment.pool.join('|')}> --user ${by}\n${formatRecoTable(reco)}` };
  }
  const warn =
    (reco.allOverWip ? '（⚠ 已知者全达 WIP 上限，回退择优）' : '') +
    (reco.probeIncomplete ? '（⚠ 部分负载探测失败，已排除未知者）' : '');
  return { ok: true, msg: `✓ ${reqRef(s)} 自动指派 → ${reco.pick}${warn}\n${formatRecoTable(reco)}` };
}

// 确认评论文案（纯函数便于单测）：PM 群卡的「选择 + 批注」/ 总监强制通过 → 写到 PRD 飞书文档的下一条评论。
export function confirmCommentText(round: number, opts: { who: string; verdict?: string; notes?: string }): string {
  const pick =
    opts.verdict === 'partial' ? '部分采纳（见批注）'
      : opts.verdict === 'force' ? '强制通过 · 结束评审'
        : opts.verdict === 'accept' ? '采纳建议，确认通过'
          : null;
  const head = opts.verdict === 'force' ? `【技术总监确认 · 第${round}轮】` : `【PM确认 · 第${round}轮】`;
  const lines = [head, `确认人：${opts.who}`];
  if (pick) lines.push(`选择：${pick}`);
  lines.push(`批注：${(opts.notes ?? '').trim() || '（无）'}`);
  return lines.join('\n');
}

// 把确认评论发到 PRD 飞书文档（顶层评论，落在问题评论之后；best-effort，绝不阻断流程）。
export function postConfirmComment(s: Session, opts: { who: string; verdict?: string; notes?: string }): void {
  if (!s.doc_ref) return;
  void commentDoc(s.doc_ref, confirmCommentText(s.gate_a_round ?? 1, opts));
}

// PM 群卡提交答复：不直接定案，而是回喂同一 claude 会话做下一轮复评（闸A 多轮循环）。
// PM 只「答复」，终止权归 claude（无剩余开放问题）或 M（强制结束，见 confirm）。
export async function submitPmAnswers(idOrSlug: string, by: string, answers?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (s.state === 'GATE_A_REVISION_REQUESTED') return { ok: true, msg: '已提交，复评排队中（幂等）' };
  if (s.state !== 'AWAITING_PM_CONFIRM') {
    return { ok: false, msg: `当前状态 ${s.state}，不能提交答复（需 AWAITING_PM_CONFIRM）` };
  }
  const round = s.gate_a_round ?? 1;
  const ans = (answers ?? '').trim();
  // 累计各轮 PM 答复，保留人读的决议留痕（confirmed_notes）。
  const history = s.confirmed_notes ? `${s.confirmed_notes}\n` : '';
  const merged = `${history}[第${round}轮答复] ${ans || '（无批注）'}`;
  await sessions.transition(s.id, 'GATE_A_REVISION_REQUESTED', {
    gate_a_pending_input: ans,
    confirmed_notes: merged,
  });
  await sessions.appendEvent(s.id, 'pm_answer', { by, round, answers: ans || null });
  return { ok: true, msg: `✓ ${reqRef(s)} 已收到第${round}轮答复，进入复评` };
}

// M 强制结束/裁决评审 → CONFIRMED（PM 无此权）。可在等 PM（AWAITING_PM_CONFIRM）或停泊裁决（GATE_A_STALLED）时调。
export async function confirm(idOrSlug: string, by: string, notes?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  // 强制结束/裁决评审是管理级决策（仿 forceGateBGo）：须 go_approvers 鉴权。卡片入口约定「PM 无此按钮」，
  // 但 #2 把真实点击人接进来后，陌生 open_id 也会走到这里——CLI/API 层同样得防，绝不冒充 M 放行。
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'confirm', by });
    return { ok: false, msg: `✗ ${by} 无确认权限（go_approvers=${cfg.permissions.go_approvers.join(',')}）` };
  }
  if (s.state === 'CONFIRMED') return { ok: true, msg: '已确认（幂等）' };
  if (s.state !== 'AWAITING_PM_CONFIRM' && s.state !== 'GATE_A_STALLED') {
    return { ok: false, msg: `当前状态 ${s.state}，不能确认（需 AWAITING_PM_CONFIRM / GATE_A_STALLED）` };
  }
  markReviewActive(projectForSession(s).deliveryDir, s.slug);
  // 保留多轮 PM 答复历史（闸B 会读 confirmed_notes）：有 notes 则追加，不覆盖。
  const merged = notes ? (s.confirmed_notes ? `${s.confirmed_notes}\n${notes}` : notes) : (s.confirmed_notes ?? null);
  await sessions.transition(s.id, 'CONFIRMED', {
    confirmed_by: by,
    confirmed_at: Date.now(),
    confirmed_notes: merged,
  });
  await sessions.appendEvent(s.id, 'pm_confirm', { by, notes: notes ?? null });
  postConfirmComment(s, { who: by, verdict: 'force', notes }); // 总监强制通过 → 文档留痕
  // 封口：M 强制确认这条路也合成 PRD 真源（绕过对抗复审，但闸B 仍需单一需求输入）。best-effort。
  try {
    writePrdTruth((await sessions.get(s.id))!);
  } catch (e) {
    log.warn(`${s.slug}: PRD 真源封口写盘失败（闸B 会兜底重建）— ${String(e).slice(0, 120)}`);
  }
  return {
    ok: true,
    msg: `✓ ${s.slug} → CONFIRMED。下一步：./forge gateb ${s.slug} --user <有闸B权限者>`,
  };
}

// 触发闸B（权限名单内才可）
export async function requestGateB(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (s.state === 'GATE_B_REQUESTED') return { ok: true, msg: '已请求闸B（幂等），等下次 tick' };
  if (s.state !== 'CONFIRMED') {
    return { ok: false, msg: `当前状态 ${s.state}，需先 CONFIRMED` };
  }
  if (!inAllowList(cfg, cfg.permissions.gate_b_allowed, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gateb', by });
    return { ok: false, msg: `✗ ${by} 无闸B 权限（gate_b_allowed=${cfg.permissions.gate_b_allowed.join(',')}）` };
  }
  await sessions.transition(s.id, 'GATE_B_REQUESTED', { gate_b_requested_by: by });
  return { ok: true, msg: `✓ 已请求闸B（${by}）。下次 ./forge tick 自动跑闸B + 对抗复审。` };
}

// 触发闸C（实现 + 本地CI）：链式从 DONE（issue 已建）起。standalone 裸 issue 走 intake.addImplementTask（直起 GATE_C_REQUESTED）。
// 权限 gate_c_allowed（缺省回退 go_approvers）。
export async function requestGateC(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (s.state === 'GATE_C_REQUESTED') return { ok: true, msg: '已请求闸C（幂等），等下次 tick' };
  if (s.state !== 'DONE') {
    return { ok: false, msg: `当前状态 ${s.state}，需先 DONE（issue 已建）才能进闸C；裸 issue 单跑用 ./forge implement --issue <ref>` };
  }
  const allow = cfg.permissions.gate_c_allowed ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gatec', by });
    return { ok: false, msg: `✗ ${by} 无闸C 权限（gate_c_allowed=${allow.join(',')}）` };
  }
  // 链式：从 gate A repos_touched ∩ proj.repos 定目标仓（实现锚到需求真正动的仓，绝不再写死 repos[0]）。
  // 信封缺/坏 → 回退 proj.repos[0]（resolveTargetRepos 内兜底），绝不卡住立项。
  let touched: string[] = [];
  try {
    touched = readGateAEnvelope(s).repos_touched ?? [];
  } catch {
    touched = [];
  }
  const proj = projectForSession(s);
  const targetRepos = resolveTargetRepos(touched, proj.repos, proj.repoMap); // repoMap：闸A 字母 C/U/A/E → 仓名（绝非拿字母比仓名空落回退首仓）
  await sessions.transition(s.id, 'GATE_C_REQUESTED', {
    gate_c_requested_by: by,
    source_kind: s.source_kind ?? 'prd',
    target_repos: JSON.stringify(targetRepos),
  });
  return { ok: true, msg: `✓ 已请求闸C（${by}）→ 目标仓 ${targetRepos.join('、') || '（首仓）'}。下次 ./forge tick 自动建 worktree + 实现 + 本地 CI。` };
}

// M 答复闸C 实现的升级问题（needs_human）/ 裁决停泊 → 回喂同一 claude 会话续做。权限 gate_c_allowed（回退 go_approvers）。
export async function submitGateCAnswers(idOrSlug: string, by: string, answer?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  const allow = cfg.permissions.gate_c_allowed ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gatec_answer', by });
    return { ok: false, msg: `✗ ${by} 无闸C 答复权限（gate_c_allowed=${allow.join(',')}）` };
  }
  if (s.state === 'GATE_C_REVISION_REQUESTED') return { ok: true, msg: '已提交，续做排队中（幂等）' };
  if (s.state !== 'AWAITING_GATE_C_INPUT' && s.state !== 'GATE_C_STALLED') {
    return { ok: false, msg: `当前状态 ${s.state}，不能答复（需 AWAITING_GATE_C_INPUT / GATE_C_STALLED）` };
  }
  const round = s.gate_c_round ?? 1;
  const ans = (answer ?? '').trim();
  await sessions.transition(s.id, 'GATE_C_REVISION_REQUESTED', {
    gate_c_pending_input: ans || '（M 未填具体决定，按再修一轮处理）',
  });
  await sessions.appendEvent(s.id, 'gatec_answer', { by, round, answer: ans || null, from: s.state });
  return { ok: true, msg: `✓ ${reqRef(s)} 已收到决定，进入续做（第${round}轮后）` };
}

// 触发闸D（开 PR + PR 对抗 review）：闸C 绿后从 AWAITING_GATE_D 起。权限 pr_create_approvers（缺省回退 go_approvers）。
// 只置 GATE_D_REQUESTED——真正开 PR（委托 forge-create-pr.sh，绝不自动 merge）由 worker 下个 tick 做。
export async function requestReviewPr(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (s.state === 'GATE_D_REQUESTED') return { ok: true, msg: '已请求闸D（幂等），等下次 tick 开 PR' };
  if (s.state !== 'AWAITING_GATE_D') {
    return { ok: false, msg: `当前状态 ${s.state}，需先闸C 绿（AWAITING_GATE_D）才能开 PR 进闸D` };
  }
  const allow = cfg.permissions.pr_create_approvers ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'review_pr', by });
    return { ok: false, msg: `✗ ${by} 无开 PR 权限（pr_create_approvers=${allow.join(',')}）` };
  }
  await sessions.transition(s.id, 'GATE_D_REQUESTED', { gate_d_requested_by: by });
  return { ok: true, msg: `✓ 已请求闸D（${by}）。下次 ./forge tick 委托开 PR（不自动 merge）+ codex 审 diff⇄claude 修。` };
}

// M 答复闸D PR 复审的升级问题（needs_human）/ 裁决停泊 → 回喂同一 claude 会话续修。权限 pr_create_approvers（回退 go_approvers）。
export async function submitGateDAnswers(idOrSlug: string, by: string, answer?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  const allow = cfg.permissions.pr_create_approvers ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gated_answer', by });
    return { ok: false, msg: `✗ ${by} 无闸D 答复权限（pr_create_approvers=${allow.join(',')}）` };
  }
  if (s.state === 'GATE_D_REVISION_REQUESTED') return { ok: true, msg: '已提交，续修排队中（幂等）' };
  if (s.state !== 'AWAITING_GATE_D_INPUT' && s.state !== 'GATE_D_STALLED') {
    return { ok: false, msg: `当前状态 ${s.state}，不能答复（需 AWAITING_GATE_D_INPUT / GATE_D_STALLED）` };
  }
  const round = s.gate_d_round ?? 1;
  const ans = (answer ?? '').trim();
  await sessions.transition(s.id, 'GATE_D_REVISION_REQUESTED', {
    gate_d_pending_input: ans || '（M 未填具体决定，按再修一轮处理）',
  });
  await sessions.appendEvent(s.id, 'gated_answer', { by, round, answer: ans || null, from: s.state });
  return { ok: true, msg: `✓ ${reqRef(s)} 已收到决定，进入续修（第${round}轮后）` };
}

// 确认合并前的核验决策（纯函数，供单测）。verify=gh pr 合并态查询；force=人工越过。
// 已核验合并 → 放行（不可逆清理 + SHIPPED）；未合并/查不到 → 拒绝（取不到绝不当已合并），force 可越过但留审计。
export function mergeAckDecision(
  verify: { ok: boolean; merged: boolean; state: string; error?: string },
  force: boolean,
): { proceed: boolean; forced: boolean; reason: string } {
  if (verify.ok && verify.merged) return { proceed: true, forced: false, reason: `已核验合并（${verify.state}）` };
  if (force) {
    return { proceed: true, forced: true, reason: verify.ok ? `PR 未合并（${verify.state}）但 --force 越过` : `合并态查不到（${verify.error ?? 'gh 失败'}）但 --force 越过` };
  }
  return {
    proceed: false,
    forced: false,
    reason: verify.ok
      ? `PR 尚未合并（当前 ${verify.state}）——forge 不替你合，请先在 GitHub 合并；确已合并可加 --force`
      : `无法核验 PR 合并态（${verify.error ?? 'gh 失败'}）——保守拒绝（取不到绝不当已合并）；确已合并可加 --force`,
  };
}

// 人工合并 PR 后确认 → SHIPPED（清隔离 worktree；接漂移闭环）。权限 merge_ack_allowed（回退 go_approvers）。
// 这是人对「已合并」的**确认**动作——forge 永不自动 merge（红线#2），只在人合并后据此收尾 + 清理。
// 不可逆清理前**先用 gh 核验 PR 真的合并了**（红线：取不到绝不当已合并）；未合并/查不到 → 拒绝，--force 可越过。
export async function ackMerged(idOrSlug: string, by: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (s.state === 'SHIPPED') return { ok: true, msg: '已确认合并（幂等）' };
  if (s.state !== 'AWAITING_HUMAN_MERGE') {
    return { ok: false, msg: `当前状态 ${s.state}，不能确认合并（需 AWAITING_HUMAN_MERGE）` };
  }
  const allow = cfg.permissions.merge_ack_allowed ?? cfg.permissions.go_approvers;
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'merged', by });
    return { ok: false, msg: `✗ ${by} 无确认合并权限（merge_ack_allowed=${allow.join(',')}）` };
  }
  const driftNote = cfg.runtime.drift?.enabled ? '将接漂移闭环对账「已合并实现 vs 闸B 验收契约」。' : '';

  // 多仓（每仓一树一PR）：逐 leg 核验各自 PR 合并态——**全部合并（或 --force）才**做不可逆清理 + SHIPPED；
  // 任一 leg 未合并/查不到即拒绝，绝不在有 leg 未合并时把整条需求宣告 shipped（Codex 2c Blocker）。无 legs（旧 in-flight）→ 走下面单 PR 路径。
  const legs = getLegs(s).filter((l) => l.worktree_path);
  if (legs.length) {
    const checks = [];
    for (const leg of legs) {
      const v = leg.pr_url ? await prMergeState(leg.pr_url) : { ok: false, merged: false, state: 'NO_PR_URL', error: `${leg.repo} 无 pr_url` };
      checks.push({ leg, verify: v, decision: mergeAckDecision(v, !!opts.force) });
    }
    const blocked = checks.filter((c) => !c.decision.proceed);
    if (blocked.length) {
      await sessions.appendEvent(s.id, 'merge_ack_refused', { by, blocked: blocked.map((c) => ({ repo: c.leg.repo, state: c.verify.state })) });
      return {
        ok: false,
        msg: `✗ ${blocked.length}/${legs.length} 个仓 PR 未合并/查不到：${blocked.map((c) => `${c.leg.repo}(${c.verify.state})`).join('、')}——forge 不替你合，请先在 GitHub 合并；确已合并可加 --force`,
      };
    }
    const forced = checks.filter((c) => c.decision.forced);
    if (forced.length) await sessions.appendEvent(s.id, 'merge_ack_forced', { by, repos: forced.map((c) => c.leg.repo), states: forced.map((c) => c.verify.state) });
    // 清**所有** leg 的隔离 worktree + 分支（各在各自仓；best-effort——清理失败绝不挡 SHIPPED，残留由孤儿清扫兜底）。
    const proj = projectForSession(s);
    const removeScript = proj.scripts.worktree_remove ? resolve(proj.root, proj.scripts.worktree_remove) : undefined;
    for (const leg of legs) {
      try {
        const repoDir = proj.repoPath(leg.repo); // worktree 锚在各自仓，逐仓定位清理（绝非写死 repos[0]）
        if (leg.worktree_path) {
          const rm = await removeWorktree({ repoDir, path: leg.worktree_path, removeScript });
          if (leg.impl_branch) deleteBranch(repoDir, leg.impl_branch);
          await sessions.appendEvent(s.id, 'worktree_cleaned', { repo: leg.repo, path: leg.worktree_path, ok: rm.ok, output: rm.output.slice(0, 160) });
        }
        await patchLeg(s, leg.repo, { merged: true });
      } catch (e) {
        log.warn(`${s.slug}: 合并后清理 ${leg.repo} worktree 失败（不挡 SHIPPED）— ${String(e).slice(0, 140)}`);
      }
    }
    await sessions.transition(s.id, 'SHIPPED', { merged_by: by, merged_at: Date.now() });
    await sessions.appendEvent(s.id, 'merged', { by, prs: legs.map((l) => l.pr_url) });
    return { ok: true, msg: `✓ ${reqRef(s)} → SHIPPED（${by} 确认合并 ${legs.length} 个仓 PR）。${driftNote}` };
  }

  // 核验 PR 真的合并了，再做不可逆清理（删 worktree/分支）+ SHIPPED。无 pr_url 视为查不到。
  const verify = s.pr_url ? await prMergeState(s.pr_url) : { ok: false, merged: false, state: 'NO_PR_URL', error: '无 pr_url' };
  const decision = mergeAckDecision(verify, !!opts.force);
  if (!decision.proceed) {
    await sessions.appendEvent(s.id, 'merge_ack_refused', { by, state: verify.state, reason: decision.reason });
    return { ok: false, msg: `✗ ${decision.reason}` };
  }
  if (decision.forced) await sessions.appendEvent(s.id, 'merge_ack_forced', { by, state: verify.state, reason: decision.reason });
  // 清隔离 worktree + 实现分支（best-effort——清理失败绝不挡 SHIPPED；残留由孤儿清扫兜底）。
  try {
    const proj = projectForSession(s);
    const repo = primaryTargetRepo(s, proj.repos); // worktree 锚在该 session 的目标仓，清理须定位同一仓（绝非写死 repos[0]）
    const repoDir = proj.repoPath(repo);
    const removeScript = proj.scripts.worktree_remove ? resolve(proj.root, proj.scripts.worktree_remove) : undefined;
    if (s.worktree_path) {
      const rm = await removeWorktree({ repoDir, path: s.worktree_path, removeScript });
      if (s.impl_branch) deleteBranch(repoDir, s.impl_branch);
      await sessions.appendEvent(s.id, 'worktree_cleaned', { path: s.worktree_path, ok: rm.ok, output: rm.output.slice(0, 160) });
    }
  } catch (e) {
    log.warn(`${s.slug}: 合并后清理 worktree 失败（不挡 SHIPPED）— ${String(e).slice(0, 140)}`);
  }
  await sessions.transition(s.id, 'SHIPPED', { merged_by: by, merged_at: Date.now() });
  await sessions.appendEvent(s.id, 'merged', { by, pr_url: s.pr_url ?? null });
  return { ok: true, msg: `✓ ${reqRef(s)} → SHIPPED（${by} 确认合并）。${driftNote}` };
}

// M 答复闸B 改方的升级问题（needs_human）→ 回喂同一 claude 会话续修（闸B 多轮人在环循环）。
// 可在等答复（AWAITING_GATE_B_INPUT）或停泊裁决（GATE_B_STALLED·M 选「再修一轮」）时调。
// 这是**架构/产品/风险**级决策（非 PM 答复）→ 须 gate_b_allowed 鉴权（卡片入口硬编码 M 只是约定，CLI/API 层也得防）。
export async function submitGateBAnswers(idOrSlug: string, by: string, answer?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (!inAllowList(cfg, cfg.permissions.gate_b_allowed, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gateb_answer', by });
    return { ok: false, msg: `✗ ${by} 无闸B 答复权限（gate_b_allowed=${cfg.permissions.gate_b_allowed.join(',')}）` };
  }
  if (s.state === 'GATE_B_REVISION_REQUESTED') return { ok: true, msg: '已提交，续修排队中（幂等）' };
  if (s.state !== 'AWAITING_GATE_B_INPUT' && s.state !== 'GATE_B_STALLED') {
    return { ok: false, msg: `当前状态 ${s.state}，不能答复（需 AWAITING_GATE_B_INPUT / GATE_B_STALLED）` };
  }
  const round = s.gate_b_round ?? 1;
  const ans = (answer ?? '').trim();
  // 注：**不在此清 adversarial_residual**——若续修/解析随后失败转 GATE_B_FAILED，旧未决意见仍是审计证据，
  // 须保留到一次成功修订复审产生新结论才清（resolved 时在 worker.afterGateB 清，见那里）。
  await sessions.transition(s.id, 'GATE_B_REVISION_REQUESTED', {
    gate_b_pending_input: ans || '（M 未填具体决定，按再修一轮处理）',
  });
  await sessions.appendEvent(s.id, 'gateb_answer', { by, round, answer: ans || null, from: s.state });
  return { ok: true, msg: `✓ ${reqRef(s)} 已收到决定，进入续修（第${round}轮后）` };
}

// M 在「方案待裁决」停泊态强制立项 → AWAITING_GO（保留残留供 GO 卡展示）。需 go_approvers 权限。仿 confirm。
export async function forceGateBGo(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (s.state === 'AWAITING_GO') return { ok: true, msg: '已放行待立项（幂等）' };
  if (s.state !== 'GATE_B_STALLED') {
    return { ok: false, msg: `当前状态 ${s.state}，不能强制立项（需 GATE_B_STALLED）` };
  }
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'gateb_force_go', by });
    return { ok: false, msg: `✗ ${by} 无 GO 权限（go_approvers=${cfg.permissions.go_approvers.join(',')}）` };
  }
  // 保留 adversarial_residual：GO 卡仍显「N 条待裁决」，落实「放行前须人工裁决」契约（绝不静默丢残留）。
  await sessions.transition(s.id, 'AWAITING_GO');
  await sessions.appendEvent(s.id, 'gateb_force_go', { by });
  await autoAssignOnGo(s.id); // 同正常路径：进 AWAITING_GO 即算自动指派推荐供 GO 卡展示
  return { ok: true, msg: `✓ ${reqRef(s)} → 待立项（${by} 强制放行，残留意见已留档供 GO 前裁决）` };
}

// 闸B 草稿读取（GO 前 lint 用；解析失败/缺失 → null，lint 跳过不误挡）。
function loadGateBEnv(s: Session): GateBEnvelope | null {
  if (!s.gate_b_draft_path || !existsSync(s.gate_b_draft_path)) return null;
  try {
    return GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8')));
  } catch {
    return null;
  }
}

// 一键 GO：建 issue + 放行（权限名单内才可）。dryRun=只打印不创建；force=越过外环验收 lint（记录原因）。
export async function go(
  idOrSlug: string,
  by: string,
  opts: { dryRun?: boolean; force?: boolean; assignee?: string } = {},
): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  if (!['AWAITING_GO', 'GO_DENIED', 'WRITE_FAILED'].includes(s.state)) {
    return { ok: false, msg: `当前状态 ${s.state}，不能 go（需 AWAITING_GO）` };
  }
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'go', by });
    return { ok: false, msg: `✗ ${by} 无 GO 权限（go_approvers=${cfg.permissions.go_approvers.join(',')}）` };
  }
  // 指派覆盖：GO 卡下拉/--assignee 选定的人优先于会话既有 assignee（自动推荐）。非法码挡 GO。
  let assigneeCode = s.assignee;
  if (opts.assignee) {
    const code = inPool(cfg.assignment, opts.assignee);
    if (!code) return { ok: false, msg: `非法指派 ${opts.assignee}，取值 ${cfg.assignment.pool.join('/')}` };
    assigneeCode = code;
  }
  const reassigned = !!opts.assignee && assigneeCode !== s.assignee;
  // 轻校验：外环验收 lint（确定性，建 issue 前）。空/不声明式/漏仓 → 挡 GO，除非 --force。
  const env = loadGateBEnv(s);
  const lint = env ? lintAcceptance(env) : { ok: true, problems: [] as string[] };
  if (opts.dryRun) {
    const r = await doWrites({ ...s, assignee: assigneeCode }, { dryRun: true });
    const warn = lint.ok
      ? ''
      : `⚠ 外环验收 lint 未过（真 GO 会被挡，除非 --force）：\n- ${lint.problems.join('\n- ')}\n\n`;
    return { ok: true, msg: `${warn}(dry-run) 将创建：\n${r.stdout}` };
  }
  if (!lint.ok && !opts.force) {
    await sessions.appendEvent(s.id, 'acceptance_lint_blocked', { problems: lint.problems });
    return {
      ok: false,
      msg: `✗ 外环验收未达标，GO 受阻：\n- ${lint.problems.join('\n- ')}\n（修方案重跑闸B，或 ./forge go ${s.slug} --user ${by} --force 越过并记录原因）`,
    };
  }
  if (!lint.ok && opts.force) {
    await sessions.appendEvent(s.id, 'acceptance_lint_forced', { by, problems: lint.problems });
  }
  // 指派层闸：立项必须有 DRI（自动推荐失败/快照缺失也绝不留空建需求）。dry-run 上面已返回，不挡预览。
  if (!assigneeCode) {
    await sessions.appendEvent(s.id, 'go_blocked_no_assignee', { by });
    return {
      ok: false,
      msg: `✗ 未指派 DRI，不能立项。先指派：./forge assign ${s.slug} <${cfg.assignment.pool.join('|')}> --user ${by}（或在 GO 卡下拉选人后提交）`,
    };
  }
  if (s.state === 'GO_DENIED') await sessions.transition(s.id, 'AWAITING_GO');
  await sessions.transition(s.id, 'WRITING', {
    go_by: by,
    go_at: Date.now(),
    // 改派则随 WRITING 一并落库（覆盖自动推荐），doWrites 据 sFresh.assignee 写进 issue。
    ...(reassigned ? { assignee: assigneeCode, assignee_source: 'human', assigned_by: by, assigned_at: Date.now() } : {}),
  });
  if (reassigned) await sessions.appendEvent(s.id, 'assign', { to: assigneeCode, by, source: 'human', via: 'go' });
  const sFresh = (await sessions.get(s.id))!;
  try {
    // onCreated：issue 一建成立即落库，故即便随后 labels/approve 失败转 WRITE_FAILED，retry go 也据此跳过重建（绝不重复建 issue）。
    const r = await doWrites(sFresh, { onCreated: (issues) => sessions.patch(s.id, { created_issues: JSON.stringify(issues) }) });
    await sessions.patch(s.id, { created_issues: JSON.stringify(r.issues) });
    await sessions.transition(s.id, 'DONE');
    await sessions.appendEvent(s.id, 'done', { issues: r.issues });
    const links = r.issues.map((i) => `${i.repo}#${i.number} ${i.url}`).join('\n');
    await notify('done', (await sessions.get(s.id))!, { issues: r.issues });
    // 文案据**真实发布结果**（doWrites 回报），不再据 config 开关——否则 native(publish=no-op)会谎称「PR 已自动合」。
    const docNote = r.published
      ? `（技术方案已发布主仓 ${projectForSession(s).techDesignPublish?.base}：PR 已自动合）`
      : `（技术方案文档已落 docs/delivery/${s.slug}/，请人工 review + 提交主仓）`;
    return { ok: true, msg: `✓ ${s.slug} → DONE。已建：\n${links}\n${docNote}` };
  } catch (e) {
    await sessions.transition(s.id, 'WRITE_FAILED', { error: String(e).slice(0, 500) });
    await sessions.appendEvent(s.id, 'error', { stage: 'writing', msg: String(e) });
    await notify('failed', (await sessions.get(s.id))!, { stage: '建需求', error: String(e) });
    return { ok: false, msg: `✗ 建需求失败：${String(e).slice(0, 300)}（已记 WRITE_FAILED，修复后可重跑 go）` };
  }
}

export async function deny(idOrSlug: string, by: string, reason?: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  // 打回是 GO 的反动作（go 用 go_approvers）：须同名单鉴权，否则陌生点击人能把「待立项」打回 GO_DENIED。
  if (!inAllowList(cfg, cfg.permissions.go_approvers, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'deny', by });
    return { ok: false, msg: `✗ ${by} 无打回权限（go_approvers=${cfg.permissions.go_approvers.join(',')}）` };
  }
  if (s.state !== 'AWAITING_GO') return { ok: false, msg: `当前状态 ${s.state}，不能 deny` };
  await sessions.transition(s.id, 'GO_DENIED', { error: `denied by ${by}: ${reason ?? ''}` });
  await sessions.appendEvent(s.id, 'go_denied', { by, reason: reason ?? null });
  return { ok: true, msg: `已拒绝 ${s.slug}（修订后可重新 go）` };
}

// 重试鉴权口径：重跑某失败闸 = 与「正向触发该闸」同等权限（绝不让无权者借 retry 重新点燃付费闸链/外向写）。
//   GATE_B_FAILED→gate_b_allowed；GATE_C_FAILED→gate_c_allowed；GATE_D_FAILED→pr_create_approvers；
//   GATE_A_FAILED 及其它→go_approvers（管理级，与 confirm/forceGateBGo 同口径，缺省回退也落这里）。
function retryAllowList(cfg: Config, state: State): string[] {
  switch (state) {
    case 'GATE_B_FAILED':
      return cfg.permissions.gate_b_allowed;
    case 'GATE_C_FAILED':
      return cfg.permissions.gate_c_allowed ?? cfg.permissions.go_approvers;
    case 'GATE_D_FAILED':
      return cfg.permissions.pr_create_approvers ?? cfg.permissions.go_approvers;
    default:
      return cfg.permissions.go_approvers;
  }
}

export async function retry(idOrSlug: string, by: string): Promise<ActionResult> {
  const s = await sessions.resolve(idOrSlug);
  const cfg = s ? configForSession(s) : loadConfig(); // 配置分化：按 session 项目解析权限/路由/指派（s 为空时下一行即返）
  if (!s) return { ok: false, msg: `找不到 session：${idOrSlug}` };
  // 重试是把失败闸重新点燃（下次 tick 会重跑 claude/codex/外向写等副作用），绝不能无鉴权：陌生点击人/面板缺省
  // actor 不在对应闸名单 → 拒，状态不动。按失败态分派名单（retryAllowList）。
  const allow = retryAllowList(cfg, s.state);
  if (!inAllowList(cfg, allow, by)) {
    await sessions.appendEvent(s.id, 'permission_denied', { action: 'retry', by });
    return { ok: false, msg: `✗ ${by} 无重试权限（${s.state} 需 ${allow.join(',')}）` };
  }
  // 复用与自动重试同口径的 planRetry：GATE_A_FAILED→复评点/INTAKE；GATE_B_FAILED→续跑/干净重跑。
  // 人工 retry 额外清重试簿记（含 dead_letter）——把 automation 放弃的死信也强制拉回。
  const plan = planRetry(s);
  if (!plan) return { ok: false, msg: `状态 ${s.state} 无需 retry` };
  await sessions.transition(s.id, plan.to, { ...plan.fields, ...RETRY_BOOKKEEPING_RESET });
  const wasDead = s.dead_letter ? '（已清死信）' : '';
  return { ok: true, msg: `已重置 ${s.slug} → ${plan.to}${wasDead}，下次 tick 重跑` };
}
