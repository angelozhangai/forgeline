import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectForSession, configForSession } from '../projects.ts';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { parseStructured, strictParse } from '../llm/structured.ts';
import { runClaude } from '../llm/runClaude.ts';
import { refresh, assertFresh } from './repoFreshness.ts';
import { anchorCheck } from './repoAnchor.ts';
import { triage } from './triage.ts';
import { GateASchema, GATE_A_CONTRACT } from './envelopes.ts';
import type { GateAEnvelope } from './envelopes.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { store } from '../store/index.ts';
const { patch, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import { commentDoc } from '../docs/index.ts';
import { projectActions } from '../project/index.ts';
import { SIZE_RUBRIC, sizeBadge } from '../util/sizing.ts';
import { SCORE_RUBRIC, normScore, normDims } from '../util/scoring.ts';
import type { Session, Routing } from '../types.ts';

// 闸A 一轮（首轮或复评）跑完的结论：worker 据此决定状态转移。
export interface GateAOutcome {
  round: number;
  openQuestions: number;
  resolved: boolean; // 无剩余开放问题 → 评审完毕（→ CONFIRMED）
  stalled: boolean; // 到 PM 轮次上限仍未消解 → 停泊交 M 裁决（→ GATE_A_STALLED）
}

function findingsMd(env: GateAEnvelope, routing: Routing): string {
  const lines: string[] = [];
  lines.push(`**概述**：${env.summary || '（无）'}`);
  lines.push(`**涉及仓**：${(env.repos_touched ?? []).join(' / ') || '（未判定）'}`);
  lines.push(`**${sizeBadge(env.size)}**（AI 提议${env.size_reason ? `：${env.size_reason}` : ''}）`);
  lines.push(`**置信度**：${env.confidence} ｜ **路由**：${routing.toLead ? `需 ${routing.reviewer} 评审` : 'DRI 自评'}（${routing.reasons.join('；')}）`);
  lines.push('');
  lines.push('**待 PM 拍板的开放问题：**');
  if (env.open_questions.length === 0) lines.push('- （无）');
  env.open_questions.forEach((q, i) => {
    lines.push(`${i + 1}. [${q.severity}] ${q.q}`);
    if (q.suggestion) lines.push(`   - 建议：${q.suggestion}`);
  });
  lines.push('');
  lines.push('**风险 / 冲突：**');
  if (env.risks.length === 0) lines.push('- （无）');
  env.risks.forEach((r) => {
    lines.push(`- [${r.area}] ${r.detail}${r.evidence ? `（证据：${r.evidence}）` : ''}`);
  });
  return lines.join('\n');
}

// 文档是否已含某锚点小节（幂等去重：retry / 孤儿复位重跑 gateA 时不重复追加同一段）。
export function docHasSection(docPath: string, marker: string): boolean {
  if (!existsSync(docPath)) return false;
  try {
    return readFileSync(docPath, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

// 首轮：在评审文档追加「机器评审产出」整段。已追加过则跳过（幂等：retry/孤儿复位重跑不留重复段）。
function appendMachineSection(deliveryDir: string, slug: string, env: GateAEnvelope, routing: Routing): void {
  const doc = resolve(deliveryDir, slug, 'req-review.md');
  if (!existsSync(doc)) return;
  if (docHasSection(doc, '🤖 机器评审产出')) return; // 已有 → 不重复追加
  const block =
    `\n\n---\n\n## 🤖 机器评审产出（待人工核对）\n` +
    `> \`claude -p\` 对照代码真源自动生成。人需逐条确认后再与 PM loop；本段不替代「五、待 PM 拍板的开放问题」。\n\n` +
    findingsMd(env, routing) +
    '\n';
  appendFileSync(doc, block);
}

// 复评：每轮在评审文档追加「第 N 轮复评」小节，保留多轮 PM loop 的完整痕迹。同一轮已追加则跳过（幂等）。
function appendRevisionSection(deliveryDir: string, slug: string, round: number, env: GateAEnvelope, routing: Routing): void {
  const doc = resolve(deliveryDir, slug, 'req-review.md');
  if (!existsSync(doc)) return;
  if (docHasSection(doc, `第 ${round} 轮复评`)) return; // 本轮已有 → 不重复追加
  const head = env.open_questions.length === 0 ? '（无剩余开放问题，评审完毕）' : `（仍有 ${env.open_questions.length} 条待 PM 拍板）`;
  const block =
    `\n\n---\n\n## 🔁 第 ${round} 轮复评${head}\n` +
    `> 依 PM 答复在同一 \`claude\` 会话续评（resume）。\n\n` +
    findingsMd(env, routing) +
    '\n';
  appendFileSync(doc, block);
}

// 闸A 机器评审 → 发到 PRD 飞书文档的评论文案（顶层评论；纯函数便于单测）。
// 好格式：标题 + 概述 + 逐条「严重度 + 建议」+（可选）风险 + 路由。
export function machineComment(env: GateAEnvelope, routing: Routing, round: number): string {
  const sevTag = (s?: string) => (s === 'high' ? '〔高〕' : s === 'low' ? '〔低〕' : '〔中〕');
  const parts: string[] = [round > 1 ? `【Forge 闸A 评审 · 复评第 ${round} 轮】` : '【Forge 闸A 评审】'];
  if (env.summary) parts.push(`概述：${env.summary}`);
  parts.push('', `待产品确认的开放问题（${env.open_questions.length}）：`);
  parts.push(
    env.open_questions.length
      ? env.open_questions
          .map((q, i) => `${i + 1}.${sevTag(q.severity)}${q.q}${q.suggestion ? `\n   建议：${q.suggestion}` : ''}`)
          .join('\n')
      : '（无，已澄清）',
  );
  if (env.risks.length) {
    parts.push('', `风险（${env.risks.length}）：`);
    parts.push(env.risks.map((r, i) => `${i + 1}. ${r.area ? `[${r.area}] ` : ''}${r.detail}`).join('\n'));
  }
  const route = routing.toLead ? `需 ${routing.reviewer} 把关` : 'DRI 自评';
  parts.push('', `路由：${route}${routing.reasons.length ? `（${routing.reasons.join('；')}）` : ''}`);
  return parts.join('\n');
}

function maxPmRounds(): number {
  return loadConfig().runtime.gate_a?.max_pm_rounds ?? 5;
}

// 解析闸A 输出：失败则 resume 同会话回喂模型重出（自愈，见 llm/structured.ts），耗尽才抛。
// resumeSid：首轮=自钉会话号；复评=续接的会话号（两路都已确保 res.ok 时会话有效）。
async function parseGateA(s: Session, text: string, resumeSid: string, dir: string, dumpName: string): Promise<GateAEnvelope> {
  // 分级超时：修复重出只是「重发 JSON」，给更短超时（≤600s），避免挂死回喂霸占 tick 锁 1200s。
  const repairTimeout = Math.min(loadConfig().runtime.claude_timeout_sec, 600);
  let dumpN = 0; // 取证落盘按回喂次数编号，保留全链（不再互相覆盖）
  try {
    return await parseStructured<GateAEnvelope>({
      text,
      parse: (t) => strictParse(GateASchema, t),
      reEmit: async (instruction) => {
        const r = await runClaude(instruction, { label: '闸A·修复输出', resume: resumeSid, timeoutSec: repairTimeout, cwd: projectForSession(s).root });
        return r.ok ? r.result : null;
      },
      buildRepairInstruction: (error) =>
        render(loadPrompt('partials/parse-repair.md', projectForSession(s).id), { ERROR: error, CONTRACT: GATE_A_CONTRACT }),
      maxRetries: loadConfig().runtime.parse_repair_retries ?? 2,
      note: (kind, detail) => appendEvent(s.id, `gatea_${kind}`, detail),
      dump: (raw) => {
        try { writeFileSync(resolve(dir, dumpName.replace(/\.txt$/, `.repair${++dumpN}.txt`)), raw); } catch { /* 落盘失败不阻断 */ }
      },
    });
  } catch (e) {
    try { writeFileSync(resolve(dir, dumpName), text); } catch { /* 原始首版留底（与上面 repairN 互不覆盖）*/ }
    throw new Error(`闸A 输出解析失败（自愈重试仍失败）：${String(e).slice(0, 200)}（见 logs/${s.id}/${dumpName} 及 .repairN）`);
  }
}

// 执行闸A **首轮**：分析 → 解析 → 路由 → scaffold 评审文档 → 通知。失败抛错（worker 停泊）。
// 自钉会话号（--session-id）便于后续复评 --resume 续接（省 token）。返回结论交 worker 转移。
// 注：「待确认」推送由 worker 统一走 notify（bot 私聊→webhook→桌面），此处不再单独发卡片。
export async function runGateA(s: Session): Promise<GateAOutcome> {
  const proj = projectForSession(s);
  const prdText =
    s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';
  const fresh = await refresh(s.branch, proj);
  assertFresh(fresh); // 取不到代码真源 → 停泊（绝不对着 ERROR/陈旧 sha 评审）
  // checkout 锚定校验：claude 读的是活 checkout，若不在锚定 sha / 脏树 → 披露给模型（warn）或停泊（block）。
  const { off, disclosure } = anchorCheck(proj, fresh, loadConfig().runtime.gates?.checkout_anchor ?? 'warn');
  if (off.length) {
    log.warn(`闸A：${off.join(', ')} checkout 未锚定 origin/${s.branch}（已在 prompt 披露，继续评审）`);
    await appendEvent(s.id, 'checkout_off_anchor', { gate: 'A', off, branch: s.branch });
  }
  const freshnessBlock = render(loadPrompt('partials/repo-freshness.md', proj.id), {
    FETCHED_AT: fresh.fetchedAt,
    REPO_REFS: fresh.refsText + disclosure,
  });
  const prompt = render(loadPrompt('gate-a.md', proj.id), {
    REPO_FRESHNESS: freshnessBlock,
    SLUG: s.slug,
    PRD_TEXT: prdText,
    OUTPUT_CONTRACT: render(loadPrompt('partials/output-contract.md', proj.id), { SIZE_RUBRIC, SCORE_RUBRIC }),
  });

  const dir = sessionLogDir(s.id);
  writeFileSync(resolve(dir, 'gate-a.prompt.txt'), prompt);
  const sid = randomUUID(); // 自钉会话号 → 复评 --resume 续接
  const res = await runClaude(prompt, { label: '闸A', sessionId: sid, cwd: proj.root });
  writeFileSync(resolve(dir, 'gate-a.raw.txt'), res.raw ?? '');
  if (!res.ok) throw new Error(`闸A claude 失败：${res.error}`);

  const env = await parseGateA(s, res.result, sid, dir, 'gate-a.result.txt');

  const outPath = resolve(dir, 'gate-a.json');
  writeFileSync(outPath, JSON.stringify(env, null, 2));
  const routing = triage(env, configForSession(s));
  await patch(s.id, {
    gate_a_output_path: outPath,
    gate_a_session_id: sid,
    gate_a_round: 1,
    gate_a_cost_usd: res.costUsd,
    repo_shas_a: JSON.stringify(fresh.shas),
    routing: JSON.stringify(routing),
    // 复杂度：AI 提议档 + 理由（评审人后续可用 `forge size` 调整）。仅当人尚未定过时才覆盖。
    ...(s.size_source === 'human' ? {} : { size: env.size, size_reason: env.size_reason, size_source: 'ai' }),
    // PRD 质量评分：⚠️ 私有，只落库供内部查询，绝不进下面的 findingsMd / 飞书评论等对外面。仅首轮打分。
    prd_score: normScore(env.prd_score),
    prd_score_dims: JSON.stringify(normDims(env.prd_score_dims)),
    prd_score_reason: env.prd_score_reason,
  });

  await projectActions(proj).scaffoldReview({
    slug: s.slug,
    prd: s.prd_url,
    owner: routing.reviewerLogin ?? undefined, // 注：scaffold 的 --owner = 文档负责人(reviewer login)，非 GitHub org
    title: s.title,
    force: true,
  });
  appendMachineSection(proj.deliveryDir, s.slug, env, routing);
  if (s.doc_ref) {
    await commentDoc(s.doc_ref, machineComment(env, routing, 1));
  }
  const n = env.open_questions.length;
  return { round: 1, openQuestions: n, resolved: n === 0, stalled: false };
}

// 执行闸A **复评**（PM 答复后的第 round≥2 轮）：在首轮会话上 --resume 续评（不重发 PRD/代码/契约，省 token）。
// 失败抛错（worker 停泊）。返回结论交 worker 转移：无剩余→CONFIRMED；到上限→GATE_A_STALLED；否则→AWAITING_PM_CONFIRM。
export async function runGateARevision(s: Session): Promise<GateAOutcome> {
  const proj = projectForSession(s);
  const round = (s.gate_a_round ?? 1) + 1;
  const pmAnswers = (s.gate_a_pending_input ?? '').trim() || '(the PM submitted without writing a specific reply)';

  const dir = sessionLogDir(s.id);
  let res: Awaited<ReturnType<typeof runClaude>>;
  let resumeSid: string;
  if (s.gate_a_session_id) {
    // 正常路径：续接首轮会话，prompt 只带 PM 这轮答复 + 重评指令。
    const prompt = render(loadPrompt('gate-a-revision.md', proj.id), {
      ROUND: String(round),
      PM_ANSWERS: pmAnswers,
    });
    writeFileSync(resolve(dir, `gate-a.r${round}.prompt.txt`), prompt);
    res = await runClaude(prompt, { label: `闸A·复评#${round}`, resume: s.gate_a_session_id, cwd: proj.root });
    resumeSid = s.gate_a_session_id;
  } else {
    // 兜底：老 session 无会话号无法 resume → 退化为全量重跑（带 PRD/freshness/契约 + PM 答复），并自钉新会话号。
    const prdText =
      s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';
    const fresh = await refresh(s.branch, proj);
    assertFresh(fresh); // 同首轮：取不到代码真源 → 停泊（绝不静默降级评审）
    const freshnessBlock = render(loadPrompt('partials/repo-freshness.md', proj.id), {
      FETCHED_AT: fresh.fetchedAt,
      REPO_REFS: fresh.refsText,
    });
    const base = render(loadPrompt('gate-a.md', proj.id), {
      REPO_FRESHNESS: freshnessBlock,
      SLUG: s.slug,
      PRD_TEXT: prdText,
      OUTPUT_CONTRACT: render(loadPrompt('partials/output-contract.md', proj.id), { SIZE_RUBRIC, SCORE_RUBRIC }),
    });
    const prompt = `${base}\n\n---\n\n# This is PM review round ${round}. The PM replied to last round's open questions as follows; re-review based on the replies and list only the open questions that still need a PM decision (if all are resolved, return an empty array for open_questions):\n\n\`\`\`\n${pmAnswers}\n\`\`\`\n`;
    writeFileSync(resolve(dir, `gate-a.r${round}.prompt.txt`), prompt);
    const sid = randomUUID();
    res = await runClaude(prompt, { label: `闸A·复评#${round}`, sessionId: sid, cwd: proj.root });
    if (res.ok) await patch(s.id, { gate_a_session_id: sid });
    resumeSid = sid;
  }

  writeFileSync(resolve(dir, `gate-a.r${round}.raw.txt`), res.raw ?? '');
  if (!res.ok) throw new Error(`闸A 复评 claude 失败：${res.error}`);

  const env = await parseGateA(s, res.result, resumeSid, dir, `gate-a.r${round}.result.txt`);

  const outPath = resolve(dir, 'gate-a.json'); // 覆盖：最新一轮是卡片/通知的真源
  writeFileSync(outPath, JSON.stringify(env, null, 2));
  const routing = triage(env, configForSession(s));
  const n = env.open_questions.length;
  const resolved = n === 0;
  // PM 已答复轮数 = round - 1；达上限仍有开放问题 → 停泊交 M。
  const stalled = !resolved && round - 1 >= maxPmRounds();

  await patch(s.id, {
    gate_a_output_path: outPath,
    gate_a_round: round,
    gate_a_pending_input: null, // 本轮答复已消化
    gate_a_cost_usd: (s.gate_a_cost_usd ?? 0) + (res.costUsd ?? 0), // 多轮累计
    routing: JSON.stringify(routing),
    gate_a_residual: stalled
      ? JSON.stringify({ round, open_questions: env.open_questions, risks: env.risks })
      : null,
  });

  appendRevisionSection(proj.deliveryDir, s.slug, round, env, routing);
  if (s.doc_ref) {
    await commentDoc(s.doc_ref, machineComment(env, routing, round));
  }
  return { round, openQuestions: n, resolved, stalled };
}
