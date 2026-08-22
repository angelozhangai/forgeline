import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { configForSession } from './projects.ts';
import { log } from './util/log.ts';
import { store as sessions } from './store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { routingOf, readResidual, readGateBResidual, residualCount } from './store/readModel.ts';
import { port } from './messaging/index.ts';
import type { CardModel, CardBlock, CardButton, CardColor, FindingLine } from './messaging/index.ts';
import type { Session } from './types.ts';
import {
  parseHumanAsks,
  parseOpenQuestions,
  openQuestionsToDecisions,
  humanAsksToDecisions,
  type OpenQuestion,
  type HumanAsk,
} from './gates/envelopes.ts';
import type { State } from './statemachine/states.ts';
import { refTitle, stateLabel } from './util/display.ts';
import { FUN_ON, petStage, petAssetName, treeLine, finalForm, feedLine, easterEgg } from './util/pet.ts';
import { sizeBadge, type Size } from './util/sizing.ts';
import type { Recommendation } from './util/assign.ts';

export type NotifyKind =
  | 'needs_confirm'
  | 'needs_arbitration'
  | 'needs_gateb'
  | 'needs_gateb_input' // 闸B 改方升级，待 M 答复拿不准的点
  | 'needs_gateb_arbitration' // 闸B 对抗到上限仍未决，待 M 裁决
  | 'needs_go'
  // 下游闸C/闸D（均 M 私有决策；M2 起为文本卡 + CLI CTA，交互按钮后续补）
  | 'needs_review_pr' // 闸C 绿，待开 PR 进闸D
  | 'needs_gatec_input' // 闸C 实现升级，待 M 答复
  | 'needs_gatec_arbitration' // 闸C CI/验收多轮未过，待 M 裁决
  | 'needs_gated_input' // 闸D 改方升级，待 M 答复
  | 'needs_gated_arbitration' // 闸D 对抗多轮未决，待 M 裁决
  | 'needs_merge' // 闸D 完成，出 merge-readiness，待人工合并
  | 'failed'
  | 'done'
  | 'recovered';

export interface NotifyExtra {
  stage?: string;
  error?: string;
  issues?: { repo: string; number: number; url: string }[];
  from?: string;
  to?: string;
}

function costNum(s: Session): number {
  return (s.gate_a_cost_usd ?? 0) + (s.gate_b_cost_usd ?? 0) + (s.gate_c_cost_usd ?? 0) + (s.gate_d_cost_usd ?? 0);
}
function costOf(s: Session): string {
  const c = costNum(s);
  return c ? `$${c.toFixed(2)}` : '-';
}

interface GateARead {
  summary: string;
  open_questions: OpenQuestion[]; // 经 schema 归一：options 永远是数组（含推荐+影响）
  risks: unknown[];
}
function readGateA(path: string | null): GateARead {
  const empty: GateARead = { summary: '', open_questions: [], risks: [] };
  if (!path || !existsSync(path)) return empty;
  try {
    const raw = readFileSync(path, 'utf8');
    const j = JSON.parse(raw) as Partial<GateARead>;
    return {
      summary: j.summary ?? '',
      open_questions: parseOpenQuestions(raw), // 归一选项，缺 options 的旧稿默认 []
      risks: Array.isArray(j.risks) ? j.risks : [],
    };
  } catch {
    return empty;
  }
}
// 闸A PM 多轮评审：评审相关态展示当前轮次（PM/团队全程看到「第几轮」）。
function roundOf(s: Session): number | null {
  const inLoop =
    s.state === 'AWAITING_PM_CONFIRM' ||
    s.state === 'GATE_A_REVISION_REQUESTED' ||
    s.state === 'GATE_A_RUNNING' ||
    s.state === 'GATE_A_STALLED';
  return inLoop && s.gate_a_round && s.gate_a_round > 0 ? s.gate_a_round : null;
}
// 闸B 改方升级、待 M 答复的问题（needs_human）。经 schema 归一选项（兼容旧 string[]）。
function readHumanAsks(s: Session): HumanAsk[] {
  return parseHumanAsks(s.gate_b_human_asks);
}

// ── 文本行（webhook / 桌面 / 日志 兜底用）──
function buildLines(kind: NotifyKind, s: Session, x: NotifyExtra): { title: string; lines: string[]; color: CardColor } {
  switch (kind) {
    case 'needs_confirm': {
      const r = routingOf(s);
      const g = readGateA(s.gate_a_output_path);
      return {
        title: `${refTitle(s)} · 待产品确认`,
        color: r?.toLead ? 'red' : 'blue',
        lines: [
          g.summary,
          `路由：${r?.toLead ? `需 ${r.reviewer} 评审` : 'DRI 自评'}　开放问题 ${g.open_questions.length}　成本 ${costOf(s)}`,
          `确认：./forge confirm ${s.slug} --user M`,
        ],
      };
    }
    case 'needs_arbitration': {
      const res = readResidual(s.gate_a_residual);
      const n = res.source === 'codex' ? res.findings.length : res.open_questions.length;
      const why = res.source === 'codex' ? `AI 对抗复审到上限仍剩 ${n} 条意见` : `PM 多轮答复后仍剩 ${n} 条开放问题`;
      return {
        title: `${refTitle(s)} · 待裁决（评审多轮未消解）`,
        color: 'red',
        lines: [`${why}，已达轮次上限`, `强制通过：./forge confirm ${s.slug} --user M`],
      };
    }
    case 'needs_gateb':
      return {
        title: `${refTitle(s)} · 需求已确认`,
        color: 'blue',
        lines: [`已拍板（${s.confirmed_by ?? 'M'}）`, `出技术方案：./forge gateb ${s.slug} --user M`],
      };
    case 'needs_gateb_input': {
      const asks = readHumanAsks(s);
      return {
        title: `${refTitle(s)} · 方案待你拍板`,
        color: 'orange',
        lines: [`技术方案有 ${asks.length} 个拿不准的点需你拍板`, `答复：./forge gateb-answer ${s.slug} --notes "…"`],
      };
    }
    case 'needs_gateb_arbitration': {
      const r = readGateBResidual(s.adversarial_residual);
      return {
        title: `${refTitle(s)} · 方案待裁决（复审 ${r.round} 轮未决）`,
        color: 'red',
        lines: [`Codex⇄Claude 多轮后仍剩 ${r.findings.length} 条未消解`, `强制立项：./forge gateb-go ${s.slug} --user M`],
      };
    }
    case 'needs_go':
      return {
        title: `${refTitle(s)} · 待拍板立项`,
        color: 'orange',
        lines: [
          `待裁决意见 ${residualCount(s.adversarial_residual)} 条　成本 ${costOf(s)}`,
          s.assignee ? `建议 DRI：${s.assignee}（可改派）` : '',
          `立项：./forge go ${s.slug} --user M`,
        ],
      };
    case 'needs_review_pr':
      return {
        title: `${refTitle(s)} · 实现完成 · 待开 PR 复审`,
        color: 'blue',
        lines: [`本地 CI 已全绿　成本 ${costOf(s)}`, `开 PR + 闸D：./forge review-pr ${s.slug} --user M`],
      };
    case 'needs_gatec_input': {
      const asks = parseHumanAsks(s.gate_c_human_asks);
      return {
        title: `${refTitle(s)} · 实现有拿不准的点 · 待你拍板`,
        color: 'orange',
        lines: [`实现中有 ${asks.length} 个需你拍板的点`, `答复：./forge gatec-answer ${s.slug} --notes "…"`],
      };
    }
    case 'needs_gatec_arbitration':
      return {
        title: `${refTitle(s)} · 实现待裁决（本地校验多轮未过）`,
        color: 'red',
        lines: [`CI/验收到上限仍未全绿`, `裁决：./forge gatec-answer ${s.slug} --notes "再修一轮的指引"`],
      };
    case 'needs_gated_input': {
      const asks = parseHumanAsks(s.gate_d_human_asks);
      return {
        title: `${refTitle(s)} · PR 改动有拿不准的点 · 待你拍板`,
        color: 'orange',
        lines: [`PR 复审改方有 ${asks.length} 个需你拍板的点`, `答复：./forge gated-answer ${s.slug} --notes "…"`],
      };
    }
    case 'needs_gated_arbitration':
      return {
        title: `${refTitle(s)} · PR 复审待裁决（多轮未决）`,
        color: 'red',
        lines: [`Codex⇄Claude PR 复审到上限仍有未决`, `再修一轮：./forge gated-answer ${s.slug} --notes "…"`],
      };
    case 'needs_merge':
      return {
        title: `${refTitle(s)} · 合并就绪 · 待人工合并`,
        color: 'green',
        lines: [
          s.pr_url ? `PR：${s.pr_url}` : 'PR 已建',
          `合并就绪报告：${s.merge_readiness_path ?? '（见 docs/delivery）'}　成本 ${costOf(s)}`,
          `人工合并后确认：./forge merged ${s.slug} --user M`,
        ],
      };
    case 'failed':
      return { title: `${refTitle(s)} · 处理失败`, color: 'red', lines: [(x.error ?? s.error ?? '').slice(0, 300), `重试：./forge retry ${s.slug}`] };
    case 'done':
      return { title: `${refTitle(s)} · 已立项`, color: 'green', lines: [(x.issues ?? []).map((i) => `${i.repo}#${i.number} ${i.url}`).join('\n')] };
    case 'recovered':
      return { title: `${refTitle(s)} · 自动恢复`, color: 'grey', lines: [`${stateLabel(x.from as never)} → ${stateLabel(x.to as never)}，将重跑`] };
  }
}

// ── CardModel 语义块构造器（provider 无关；飞书 JSON/markup 由 messaging/feishu 渲染）──
const txt = (m: string): CardBlock => ({ kind: 'text', md: m });
const noteB = (m: string): CardBlock => ({ kind: 'note', md: m }); // 灰字（原 grey()）
const footB = (m: string): CardBlock => ({ kind: 'footnote', md: m }); // 小一号灰脚注（原 small()）
const quoteB = (t: string): CardBlock => ({ kind: 'quote', text: t });
const dividerB: CardBlock = { kind: 'divider' };
const btnB = (text: string, style: CardButton['style'], action: string, slug: string, value?: Record<string, unknown>): CardBlock => ({
  kind: 'button',
  button: { text, style, action, slug, value },
});
const model = (color: CardColor, title: string, subtitle: string, blocks: CardBlock[]): CardModel => ({ color, title, subtitle, blocks });

// 残留 findings/open_questions → 语义 FindingLine[]（位置/建议仅含已知项；严重度上色交给 adapter）。
const findingsFrom = (rows: { severity?: string; issue: string; where?: string; fix?: string }[]): FindingLine[] =>
  rows.map((f) => ({
    severity: f.severity,
    lead: f.issue,
    notes: [...(f.where ? [{ label: '位置', text: f.where }] : []), ...(f.fix ? [{ label: '建议', text: f.fix }] : [])],
  }));

// 自动指派推荐快照（autoAssignOnGo 落库的 json）。坏/缺 → null（GO 卡降级为纯手动选）。
function readReco(s: Session): Recommendation | null {
  if (!s.assign_snapshot) return null;
  try {
    return JSON.parse(s.assign_snapshot) as Recommendation;
  } catch {
    return null;
  }
}
// GO 卡上的「建议 DRI + 各人负载」理由块（纯展示，读库不发 IO）。
function assignReasonBlocks(s: Session): CardBlock[] {
  const reco = readReco(s);
  if (!reco) return s.assignee ? [txt(`**指派 DRI：${s.assignee}**`)] : [];
  const incomplete = reco.probeIncomplete ? '（部分负载探测失败，已排除未知者）' : '';
  const head = reco.pick
    ? `**建议 DRI：${reco.pick}**${reco.allOverWip ? '（⚠ 全员超 WIP，择优）' : '（当前在研负载最低）'}${incomplete}`
    : `未算出推荐${reco.probeIncomplete ? '（负载探测失败）' : ''}，请手动选`;
  const rows = reco.table.map((r) => {
    const mark = r.code === reco.pick ? '→ ' : '　 ';
    if (r.ok === false) return `${mark}${r.code} 负载未知（探测失败，已排除自动选）`;
    const cap = r.eligible ? '' : ' ✗超WIP';
    return `${mark}${r.code} 在研 ${r.wip}/${r.wipLimit} · 负载 ${r.loadPoints.toFixed(1)} → 投影 ${r.projected.toFixed(1)}${cap}`;
  });
  return [txt(head), footB(rows.join('\n'))];
}

// 状态 → 头部 emoji + 卡片色
const STATE_EMOJI: Partial<Record<State, string>> = {
  INTAKE: '📥 ', GATE_A_RUNNING: '🔍 ', AWAITING_PM_CONFIRM: '🔴 ', GATE_A_REVISION_REQUESTED: '🔁 ', GATE_A_ADVERSARIAL: '🔬 ', GATE_A_STALLED: '⚖️ ', CONFIRMED: '✅ ',
  GATE_B_REQUESTED: '📐 ', GATE_B_RUNNING: '📐 ', ADVERSARIAL_LOOP: '🔬 ', AWAITING_GATE_B_INPUT: '🙋 ', GATE_B_REVISION_REQUESTED: '🔁 ', GATE_B_STALLED: '⚖️ ', AWAITING_GO: '🟡 ',
  WRITING: '✍️ ', DONE: '🎉 ', GATE_A_FAILED: '⚠️ ', GATE_B_FAILED: '⚠️ ', GO_DENIED: '⛔ ', WRITE_FAILED: '⚠️ ',
};
function stateColor(st: State): CardColor {
  if (st === 'AWAITING_PM_CONFIRM' || st === 'GATE_A_STALLED' || st === 'GATE_B_STALLED') return 'red';
  if (st === 'DONE') return 'green';
  if (st === 'AWAITING_GO' || st === 'AWAITING_GATE_B_INPUT') return 'orange';
  if (st === 'GO_DENIED' || st.endsWith('FAILED')) return 'red';
  if (st === 'CONFIRMED') return 'blue';
  return 'grey';
}
const RUN_NOTE: Partial<Record<State, string>> = {
  INTAKE: '已收到，正在排队评审…',
  GATE_A_RUNNING: '正在对照代码真源评审需求…',
  GATE_A_REVISION_REQUESTED: '已收到你的答复，正在依答复复评…',
  GATE_A_ADVERSARIAL: '需求已澄清，正在做最后一道 AI 交叉复核…',
  GATE_A_STALLED: '评审已多轮仍有未决问题，待负责人裁决。',
  CONFIRMED: '需求已确认，等待负责人出技术方案。',
  GATE_B_REQUESTED: '已排队出技术方案…',
  GATE_B_RUNNING: '正在设计技术方案…',
  ADVERSARIAL_LOOP: '技术方案 AI 交叉复审中…',
  AWAITING_GATE_B_INPUT: '技术方案有拿不准的点，待负责人拍板。',
  GATE_B_REVISION_REQUESTED: '已收到负责人的决定，正依此修订方案…',
  GATE_B_STALLED: '方案复审已多轮仍有未决，待负责人裁决。',
  AWAITING_GO: '技术方案已完成，待负责人立项。',
  WRITING: '正在建需求…',
};
// 错误展示分流：*_FAILED 在群侧伪装成「该阶段仍在处理中」——绝不向团队暴露出错与具体原因。
const FAILED_AS_PROGRESS: Partial<Record<State, string>> = {
  GATE_A_FAILED: '正在对照代码真源评审需求…',
  GATE_B_FAILED: '正在设计技术方案…',
  WRITE_FAILED: '正在建需求…',
};

// ── 私聊(M)决策卡：返回 provider 无关 CardModel（含按钮/表单/宠物语义块）──
export function buildCard(kind: NotifyKind, s: Session, x: NotifyExtra = {}): CardModel {
  // 私聊(M)卡：保留真实 $（你的预算账本），同时也带上需求宠物彩蛋（你想完整看到群卡那套）。
  const pet = petStage(s.state);
  const emoji = (fallback: string): string => (FUN_ON ? `${pet.sprite} ` : fallback);
  // 「头像左 + 台词右」一行（无图则只剩台词文字）。done 等分支也复用 voiceEls。
  const voiceEls: CardBlock[] = FUN_ON ? [{ kind: 'petRow', asset: petAssetName(s.state), voice: pet.voice }] : [];

  switch (kind) {
    case 'needs_confirm': {
      const r = routingOf(s);
      const rd = roundOf(s);
      const g = readGateA(s.gate_a_output_path);
      const items = openQuestionsToDecisions(g.open_questions);
      return model(r?.toLead ? 'red' : 'blue', refTitle(s, emoji('🔴 ')), `需求评审${rd && rd > 1 ? `第${rd}轮` : '完成'} · ${r?.toLead ? `需 ${r.reviewer} 把关` : 'DRI 自评'}`, [
        { kind: 'stats', fields: [`**复杂度**\n${s.size ?? '待定'}`, `**置信**\n${r?.confidence ?? '-'}`, `**开放问题**\n${g.open_questions.length}`, `**风险**\n${g.risks.length}`, `**成本**\n${costOf(s)}`] },
        ...voiceEls,
        ...(g.summary ? [txt(`**概述**：${g.summary}`)] : []),
        dividerB,
        txt(`**待你拍板的开放问题**${rd ? ` · 第${rd}轮` : ''}`),
        { kind: 'decisionList', items },
        dividerB,
        { kind: 'decisionForm', slug: s.slug, items, action: 'confirm_submit', round: rd ?? 0, verdict: true, submitText: '提交决议', notesLabel: '整体补充说明（可空）', notesPlaceholder: '例：Q3 充值不做过期，列恒0并注明' },
      ]);
    }
    case 'needs_arbitration': {
      const res = readResidual(s.gate_a_residual);
      const isCodex = res.source === 'codex'; // codex 对抗未消解（findings）vs PM 多轮开放问题
      const n = isCodex ? res.findings.length : res.open_questions.length;
      const findings: FindingLine[] = isCodex
        ? findingsFrom(res.findings.slice(0, 8))
        : res.open_questions.slice(0, 8).map((q) => ({ severity: q.severity, lead: q.q, notes: q.suggestion ? [{ label: '建议', text: q.suggestion }] : [] }));
      const head = isCodex
        ? `AI 对抗复审到上限仍剩 **${n}** 条意见未消解。请你裁决：强制通过结束评审，或线下敲定后再放行。`
        : `PM 多轮答复后仍剩 **${n}** 条开放问题未消解，已达轮次上限。请你裁决：强制通过结束评审，或线下与 PM 敲定后再放行。`;
      return model('red', refTitle(s, emoji('⚖️ ')), '需求评审多轮仍有未决 · 待你裁决', [
        txt(head),
        ...voiceEls,
        dividerB,
        txt(isCodex ? '**仍未消解的复审意见**' : '**仍未消解的开放问题**'),
        { kind: 'findingList', findings },
        dividerB,
        btnB('✅ 强制通过 · 结束评审', 'primary', 'force_confirm', s.slug),
        noteB(`或 CLI：\`./forge confirm ${s.slug} --user M\``),
      ]);
    }
    case 'needs_gateb':
      return model('blue', refTitle(s, emoji('✅ ')), `${stateLabel('CONFIRMED')} · 待出技术方案`, [
        txt('需求已确认。下一步：出技术方案 + AI 交叉复审。'),
        ...voiceEls,
        ...(s.confirmed_notes ? [noteB(`决议批注：${s.confirmed_notes}`)] : []),
        dividerB,
        btnB('🛠 出技术方案', 'primary', 'gateb', s.slug),
        noteB('点击后系统自动出技术方案 + AI 交叉复审，约数分钟，完成后推「待拍板立项」卡。'),
      ]);
    case 'needs_gateb_input': {
      const asks = readHumanAsks(s);
      const items = humanAsksToDecisions(asks);
      return model('orange', refTitle(s, emoji('🙋 ')), '技术方案有拿不准的点 · 待你拍板', [
        txt(`Codex 审、Claude 改技术方案时，遇到 **${asks.length}** 个需要你拍板才能继续的点：`),
        ...voiceEls,
        dividerB,
        { kind: 'decisionList', items },
        dividerB,
        { kind: 'decisionForm', slug: s.slug, items, action: 'gateb_answer_submit', round: s.gate_b_round ?? 0, submitText: '提交决定', notesLabel: '补充说明（可空；选「其他」或要逐条细化时填）', notesPlaceholder: '例：H1 退到余额；接受该风险，开发期加幂等单测兜底' },
        noteB(`或 CLI：\`./forge gateb-answer ${s.slug} --notes "你的决定"\``),
      ]);
    }
    case 'needs_gateb_arbitration': {
      const r = readGateBResidual(s.adversarial_residual);
      const findings = findingsFrom(r.findings.slice(0, 8));
      return model('red', refTitle(s, emoji('⚖️ ')), `方案复审 ${r.round} 轮仍有未决 · 待你裁决`, [
        txt(`Codex⇄Claude 多轮对抗到上限第 **${r.round}** 轮，仍剩 **${r.findings.length}** 条意见未消解。请你裁决：强制立项放行，或再修一轮。`),
        ...voiceEls,
        dividerB,
        txt('**仍未消解的意见**'),
        { kind: 'findingList', findings },
        dividerB,
        {
          kind: 'buttonRow',
          buttons: [
            { text: '✅ 强制立项 · 跳过剩余', style: 'primary', action: 'gateb_force_go', slug: s.slug },
            { text: '🔁 再修一轮', style: 'default', action: 'gateb_send_back', slug: s.slug, value: { round: r.round } },
          ],
        },
        noteB(`或 CLI：\`./forge gateb-go ${s.slug} --user M\`（强制立项）／ \`./forge gateb-answer ${s.slug} --notes "…"\`（再修一轮）`),
      ]);
    }
    case 'needs_go': {
      const n = residualCount(s.adversarial_residual);
      const pool = configForSession(s).assignment.pool; // 配置分化：DRI 下拉用该项目的池
      return model('orange', refTitle(s, emoji('🟡 ')), '技术方案完成 · 待拍板立项', [
        { kind: 'stats', fields: [`**复杂度**\n${s.size ?? '待定'}`, `**待裁决意见**\n${n} 条${n ? '（须人工拍板）' : ''}`, `**成本**\n${costOf(s)}`] },
        txt(`技术方案已生成${n ? `；有 ${n} 条复审意见待你拍板` : ''}`),
        ...voiceEls,
        dividerB,
        txt('**指派 DRI 并立项**（默认采纳推荐，可下拉改人）'),
        ...assignReasonBlocks(s),
        { kind: 'goForm', slug: s.slug, pool, picked: s.assignee },
        btnB('❌ 打回', 'danger', 'deny', s.slug),
        noteB(`预览将建什么：\`./forge go ${s.slug} --user M --dry-run\``),
      ]);
    }
    case 'needs_review_pr':
      return model('blue', refTitle(s, emoji('🚦 ')), '实现完成 · 本地 CI 全绿 · 待开 PR 复审', [
        txt(`隔离工作树实现完成、本地 CI 全绿。下一步：开 PR 进闸D（Codex 审 diff ⇄ Claude 修）。`),
        ...voiceEls,
        ...(s.gate_c_draft_path ? [noteB(`改动摘要见 ${s.gate_c_draft_path}`)] : []),
        dividerB,
        noteB(`开 PR + 闸D：\`./forge review-pr ${s.slug} --user M\``),
      ]);
    case 'needs_gatec_input': {
      const asks = parseHumanAsks(s.gate_c_human_asks);
      return model('orange', refTitle(s, emoji('🙋 ')), '实现有拿不准的点 · 待你拍板', [
        txt(`实现时遇到 **${asks.length}** 个需你拍板的点：`),
        ...voiceEls,
        ...(asks.length ? [{ kind: 'findingList' as const, findings: asks.map((a) => ({ severity: a.severity, lead: a.question, notes: a.context ? [{ label: '背景', text: a.context }] : [] })) }] : []),
        dividerB,
        noteB(`答复：\`./forge gatec-answer ${s.slug} --notes "你的决定"\``),
      ]);
    }
    case 'needs_gatec_arbitration':
      return model('red', refTitle(s, emoji('⚖️ ')), '实现待裁决 · 本地校验多轮未过', [
        txt(`实现⇄CI 到上限仍未全绿。请你裁决：给指引再修一轮，或线下接手。`),
        ...voiceEls,
        ...(s.gate_c_residual ? [noteB('未过摘要已留档 gate_c_residual')] : []),
        dividerB,
        noteB(`再修一轮：\`./forge gatec-answer ${s.slug} --notes "修复指引"\``),
      ]);
    case 'needs_gated_input': {
      const asks = parseHumanAsks(s.gate_d_human_asks);
      return model('orange', refTitle(s, emoji('🙋 ')), 'PR 改动有拿不准的点 · 待你拍板', [
        txt(`PR 复审改方遇到 **${asks.length}** 个需你拍板的点：`),
        ...voiceEls,
        ...(asks.length ? [{ kind: 'findingList' as const, findings: asks.map((a) => ({ severity: a.severity, lead: a.question, notes: a.context ? [{ label: '背景', text: a.context }] : [] })) }] : []),
        dividerB,
        noteB(`答复：\`./forge gated-answer ${s.slug} --notes "你的决定"\``),
      ]);
    }
    case 'needs_gated_arbitration':
      return model('red', refTitle(s, emoji('⚖️ ')), 'PR 复审待裁决 · 多轮未决', [
        txt(`Codex⇄Claude PR 复审到上限仍有未决意见。请你裁决：再修一轮，或线下接手。`),
        ...voiceEls,
        dividerB,
        noteB(`再修一轮：\`./forge gated-answer ${s.slug} --notes "…"\``),
      ]);
    case 'needs_merge':
      return model('green', refTitle(s, emoji('🚀 ')), '合并就绪 · 待人工合并（绝不自动合并）', [
        txt(`PR 复审 LGTM + 测试补强完成 + 本地 CI 全绿。请人工 review 关键 diff 后合并。`),
        ...voiceEls,
        ...(s.pr_url ? [txt(`**PR**：${s.pr_url}`)] : []),
        ...(s.merge_readiness_path ? [noteB(`合并就绪报告：${s.merge_readiness_path}`)] : []),
        ...(FUN_ON && costNum(s) > 0 ? [noteB(feedLine(costNum(s), { showDollar: true }))] : []),
        dividerB,
        noteB(`合并后确认：\`./forge merged ${s.slug} --user M\``),
      ]);
    case 'failed':
      return model('red', refTitle(s, emoji('❌ ')), stateLabel(s.state), [
        txt(`**出错了**\n${(x.error ?? s.error ?? '未知').slice(0, 400)}`),
        ...voiceEls,
        dividerB,
        btnB('🔁 重试', 'primary', 'retry', s.slug),
      ]);
    case 'done': {
      const ff = FUN_ON ? finalForm(s) : '🎉';
      return model('green', refTitle(s, FUN_ON ? `${ff} ` : '🎉 '), FUN_ON ? '已立项 · 进化成完全体' : '已立项', [
        ...voiceEls,
        txt((x.issues ?? []).map((i) => `• ${i.repo}#${i.number}  ${i.url}`).join('\n') || '（无 issue 信息）'),
        ...(FUN_ON && costNum(s) > 0 ? [noteB(feedLine(costNum(s), { showDollar: true }))] : []),
        noteB('技术方案已归档，请人工 review 后提交主仓'),
      ]);
    }
    case 'recovered':
      return model('grey', refTitle(s, emoji('♻️ ')), '自动恢复', [txt('上次处理被中断，已自动复位，将重新处理'), ...voiceEls]);
  }
}

// ── 群状态卡（回复 PM 那条，全程原地编辑；「待产品确认」时 @PM + 表单）──
// 彩蛋(需求宠物·成长进化)：每条需求是一只随阶段进化的小宠物；群卡藏成本（PM 不看内部 $），
// 把它折成宠物「投喂算力粮」。FORGE_FUN=0 时整套关闭，回到正经模式。
export function buildStatusCard(s: Session, x: NotifyExtra = {}): CardModel {
  const pet = petStage(s.state);
  // DONE 头部用 finalForm（具体进化成果，与正文揭晓一致）；其余用进化树当前阶 sprite。
  const headEmoji = FUN_ON ? `${s.state === 'DONE' ? finalForm(s) : pet.sprite} ` : STATE_EMOJI[s.state] ?? '';
  const head = refTitle(s, headEmoji);
  // 副标题：状态 + 评审轮次（PM 多轮 loop 时）+ 复杂度档（PM/老板一眼可见）。
  const rd = roundOf(s);
  const subtitle = `${stateLabel(s.state)}${rd ? ` · 第${rd}轮评审` : ''}${s.size ? ` · 复杂度 ${s.size}` : ''}`;
  // 宠物动图资源名（按进化阶；DONE 用完全体那只）。petRow 把它做成「头像左 + 文字右」一行。
  const asset = petAssetName(s.state);
  const mentionId = s.poster_id || undefined; // @PM（adapter 渲染成 <at>）；无则用「产品同学」兜底
  // 底部小字脚注：① 复杂度徽章(始终显示，核心属性) ② 彩蛋(进化树/投喂/隐藏台词，FUN 时)。沉底不抢正文。
  const footer = (): CardBlock[] => {
    const lines: CardBlock[] = [];
    if (s.size) lines.push(footB(`${sizeBadge(s.size as Size)}${s.size_source === 'ai' ? '（AI 提议，可调）' : ''}`));
    if (FUN_ON) {
      const parts = [`进化树 ${treeLine(s.state)} · 第 ${pet.tier}/5 阶`];
      if (costNum(s) > 0) parts.push(feedLine(costNum(s), { showDollar: false }));
      const egg = easterEgg(s);
      if (egg) parts.push(egg);
      lines.push(footB(parts.join('　·　')));
    } else if (costOf(s) !== '-') {
      lines.push(footB(`成本 ${costOf(s)}`));
    }
    return lines;
  };

  if (s.state === 'AWAITING_PM_CONFIRM') {
    const g = readGateA(s.gate_a_output_path);
    const n = g.open_questions.length;
    const items = openQuestionsToDecisions(g.open_questions);
    // 复评轮（第2轮起）：与首轮表单正文几乎同形，仅靠副标题区分易被当成「没更新」。
    // 故顶部加醒目红横幅 + 回显你上轮答复，让原地更新一眼可辨（用户选「原地改卡但醒目可辨」）。
    const isReReview = !!(rd && rd > 1);
    const lastAns = ((s.confirmed_notes ?? '').split('\n').filter((l) => l.includes('轮答复]')).pop() ?? '').replace(/^.*轮答复\]\s*/, '').trim().slice(0, 50);
    const reReviewBanner: CardBlock[] = isReReview
      ? [
          {
            kind: 'callout',
            tone: 'danger',
            md:
              `🔁 **复评第 ${rd} 轮** — 你上轮答复已记录` +
              `${lastAns && !lastAns.includes('无批注') ? `（“${lastAns}”）` : '（上轮未填具体批注）'}` +
              `，复审后**以下问题仍未闭合**。请**逐条给出明确决定**（而非笼统「采纳」）再提交。`,
          },
          dividerB,
        ]
      : [];
    // 召唤行：@PM（adapter 加 <at>）+ 一句话 CTA；无 poster 时用「产品同学」兜底前缀。
    const lead = mentionId ? '' : '产品同学 ';
    const cta = isReReview
      ? `${lead}**第 ${rd} 轮复评**已出结果，仍有 **${n}** 个问题待你拍板 👇`
      : `${lead}这条需求有 **${n}** 个问题待你拍板，请在下方确认 👇`;
    return {
      color: stateColor(s.state),
      title: head,
      subtitle,
      blocks: [
        { kind: 'petRow', asset, voice: cta, mentionId },
        ...reReviewBanner,
        // 概述：引用块，低存在感。
        ...(g.summary ? [quoteB(g.summary)] : []),
        dividerB,
        // 焦点：待拍板问题（带条数 + 轮次）——逐条问句 + 选项（★推荐 + 影响）。
        txt(`**📌 待你拍板（${n}）${rd ? ` · 第${rd}轮` : ''}**`),
        { kind: 'decisionList', items },
        dividerB,
        // 行动：逐条选/填 + 整体结论/补充 表单。
        { kind: 'decisionForm', slug: s.slug, items, action: 'confirm_submit', round: rd ?? 0, verdict: true, submitText: '提交决议', notesLabel: '整体补充说明（可空）', notesPlaceholder: '例：Q3 充值不做过期，列恒0并注明' },
        ...footer(),
      ],
    };
  }
  if (s.state === 'DONE') {
    const ff = FUN_ON ? finalForm(s) : '🎉';
    const lead = FUN_ON ? `${ff} 需求蛋进化成「完全体」并上线啦！建出的需求：` : '🎉 已立项，建出的需求：';
    return {
      color: stateColor(s.state),
      title: head,
      subtitle,
      blocks: [
        { kind: 'petRow', asset, voice: lead },
        txt((x.issues ?? []).map((i) => `• ${i.repo}#${i.number}  ${i.url}`).join('\n') || '（详见负责人侧）'),
        ...footer(),
      ],
    };
  }
  if (s.state === 'GO_DENIED') {
    return {
      color: stateColor(s.state),
      title: head,
      subtitle,
      blocks: [{ kind: 'petRow', asset, voice: FUN_ON ? `${pet.voice}（技术方案被打回，待修订后重走）` : '技术方案被打回，待修订后重走。' }, ...footer()],
    };
  }
  if (s.state.endsWith('FAILED')) {
    // 错误展示分流：群侧（团队）只显示「处理中」，**绝不暴露具体错误**——中性灰头、进行中文案、不报红不报错。
    // 具体错误原因走机器人私聊负责人（buildCard 'failed' 保留 error + 重试按钮）。团队「用」机器人而非「看」内部。
    const progressNote = FAILED_AS_PROGRESS[s.state] ?? '正在处理中，请稍候…';
    return {
      color: 'grey',
      title: refTitle(s, FUN_ON ? `${pet.sprite} ` : '⏳ '),
      subtitle: `处理中${s.size ? ` · 复杂度 ${s.size}` : ''}`,
      blocks: [{ kind: 'petRow', asset, voice: progressNote }, ...footer()],
    };
  }
  const note = FUN_ON ? pet.voice : RUN_NOTE[s.state] ?? stateLabel(s.state);
  return { color: stateColor(s.state), title: head, subtitle, blocks: [{ kind: 'petRow', asset, voice: note }, ...footer()] };
}

// 同步群状态卡到当前状态：无则回复 PM 那条创建，有则原地编辑。仅群来源(有 chat_id)生效。
export async function syncGroupCard(s: Session, x: NotifyExtra = {}): Promise<void> {
  const cur = (await sessions.get(s.id)) ?? s; // 取最新 status_msg_id，避免陈旧重复发
  if (!cur.chat_id) return; // 非群来源(手动 add) → 不发群卡
  try {
    const card = buildStatusCard(cur, x);
    if (cur.status_msg_id) {
      await port.editGroupCard(cur.status_msg_id, card);
    } else {
      // intake 那条不一定还回得上去（消息被删、太久、或补拉登记时记下的 id 本就跨了一次重启）。
      // 回复失败**必须退回直接发到群**：把卡丢掉等于这条需求在群里全程没有任何反馈，而且
      // status_msg_id 一直是空，之后每次同步都重走同一条失败路径，永远出不来。
      const replied = cur.intake_msg_id ? await port.replyGroupCard(cur.intake_msg_id, card) : null;
      if (cur.intake_msg_id && !replied) log.warn(`群状态卡：回复原消息失败（${cur.intake_msg_id}）→ 改为直接发到群`);
      const mid = replied ?? (await port.sendGroupCard(cur.chat_id, card));
      if (mid) await sessions.patch(cur.id, { status_msg_id: mid });
    }
  } catch (e) {
    log.warn(`群状态卡同步失败(不影响流程)：${String(e).slice(0, 140)}`);
  }
}

function desktop(title: string, body: string): void {
  const { env } = loadConfig();
  if (env.NOTIFY_DESKTOP === '0' || process.platform !== 'darwin') return;
  const esc = (t: string) => t.replace(/["\\]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  try {
    spawn('osascript', ['-e', `display notification "${esc(body).slice(0, 200)}" with title "${esc(title).slice(0, 80)}"`], { stdio: 'ignore' }).unref();
  } catch {
    /* 桌面通知失败无所谓 */
  }
}

// 统一通知出口：bot 私聊卡片(2.0,带按钮) → webhook 兜底；本地桌面 + 日志永远兜底（绝不静默）。
export async function notify(kind: NotifyKind, s: Session, x: NotifyExtra = {}): Promise<void> {
  const { title, lines, color } = buildLines(kind, s, x);
  log.info(`📣 ${title} ｜ ${lines.filter(Boolean).join(' ｜ ')}`);
  desktop(title, lines.filter(Boolean).join(' ｜ '));
  // 群里：状态卡(回复 PM 那条 → 原地编辑) 始终同步到当前状态，PM/团队全程可见。
  await syncGroupCard(s, x);
  // 私聊：仅 M 专属决策卡(裁决/出技术方案/立项/失败重试/自愈)才发。
  // needs_confirm 在群里 @PM 完成、done 群里已展示 → 不再发私聊。
  const toM =
    kind === 'needs_arbitration' ||
    kind === 'needs_gateb' ||
    kind === 'needs_gateb_input' ||
    kind === 'needs_gateb_arbitration' ||
    kind === 'needs_go' ||
    kind === 'needs_review_pr' ||
    kind === 'needs_gatec_input' ||
    kind === 'needs_gatec_arbitration' ||
    kind === 'needs_gated_input' ||
    kind === 'needs_gated_arbitration' ||
    kind === 'needs_merge' ||
    kind === 'failed' ||
    kind === 'recovered';
  if (!toM) return;
  try {
    const sent = await port.sendDmCard(buildCard(kind, s, x));
    // 错误展示分流：'failed'/'recovered' 是 M 私有的错误/运维通知——bot 私聊失败也**不**外泄到群 webhook
    // （那会把具体错误发给团队）。仅靠桌面+日志兜底（上面 desktop()/log 已发）。其余 M 决策卡保留 webhook 兜底。
    if (!sent) {
      if (kind === 'failed' || kind === 'recovered') log.warn(`bot 私聊未送达（${kind}），按分流不外泄群，仅桌面+日志：${title}`);
      else await port.postWebhook(title, lines.filter(Boolean), color);
    }
  } catch (e) {
    log.warn(`通知推送失败(已记日志，不影响流程)：${String(e)}`);
  }
}
