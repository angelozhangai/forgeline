// 立项后漂移闭环（poll 式，复用 tick 节奏，不上 webhook）——直接打到核心痛点：
// 需求 DONE（issue 全合并进 main）后，跑一次 claude 对账「已合并实现 vs 闸B 验收契约」，漂移则私聊告警 M。
//
// 设计纪律：
// - **不污染主 gate 流**：DONE 是终态；漂移进度全用 events（drift_polled / drift_detected / drift_clean /
//   drift_reconciled）记，不加 gate 态、不加 session 列。`drift_reconciled` 一旦落即终态、绝不复跑。
// - **默认关 + 有界**：`runtime.drift.enabled` 默认 false（tick 处 gate）。开后每条需求审计一次；issue 未全合 /
//   审计反复失败 → 受 poll_every_hours 去抖 + max_polls 封顶，耗尽放弃并告警，绝不无限烧 token。
// - **失败不静默**：代码真源取不到 / claude 失败 / 输出解析失败 → 抛错，由本轮 per-session try/catch 记日志并
//   留待下个轮询窗口重试（不写 drift_reconciled），到 max_polls 才放弃告警。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hours } from '../util/time.ts';
import { resolve } from 'node:path';
import { z } from 'zod';
import { store as sessions } from '../store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { projectForSession } from '../projects.ts';
import { loadPrompt, render, sessionLogDir } from '../util/render.ts';
import { runClaude } from '../llm/runClaude.ts';
import { strictParse } from '../llm/structured.ts';
import { refresh, assertFresh } from '../gates/repoFreshness.ts';
import { reposOffRef } from '../gates/repoAnchor.ts';
import { GateBSchema } from '../gates/envelopes.ts';
import type { Acceptance } from '../gates/envelopes.ts';
import { acceptanceMarkdown } from '../util/acceptance.ts';
import { issueStates } from '../workspace.ts';
import type { IssueStateRow } from '../workspace.ts';
import { port } from '../messaging/index.ts';
import { reqRef } from '../util/display.ts';
import type { Session, CreatedIssue } from '../types.ts';

// ── 漂移对账输出契约 ──────────────────────────────────────
export const DriftFindingSchema = z.object({
  ac: z.string().default(''), // 契约/场景标识：AC1 / 端点签名
  status: z.enum(['ok', 'drift', 'unknown']).default('unknown'),
  detail: z.string().default(''), // 判断说明
  evidence: z.string().default(''), // repo path:line
});
export const DriftSchema = z.object({
  drifted: z.boolean().default(false),
  summary: z.string().default(''),
  findings: z.array(DriftFindingSchema).default([]),
});
export type DriftVerdict = z.infer<typeof DriftSchema>;

// 喂给 claude 的输出契约串（也用于将来 parse-repair；当前 v1 单发，解析失败靠下个轮询窗口重试）。
export const DRIFT_CONTRACT = `\`\`\`json
{
  "drifted": false,
  "summary": "one-line overview: which contracts/scenarios drifted (or state that all are aligned)",
  "findings": [
    { "ac": "AC1, or the endpoint/function signature", "status": "ok|drift|unknown", "detail": "reasoning", "evidence": "repo path:line" }
  ]
}
\`\`\``;

// ── 纯函数（便于单测）──────────────────────────────────────

// created_issues JSON → CreatedIssue[]（坏数据 → 空，调用方据空跳过，不崩）。
export function parseCreatedIssues(json: string | null): CreatedIssue[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as CreatedIssue[];
    return Array.isArray(arr) ? arr.filter((i) => i && typeof i.repo === 'string' && typeof i.number === 'number') : [];
  } catch {
    return [];
  }
}

// 全部 issue 都 CLOSED 才算「已离开 OPEN」。空集 / 任一 OPEN / 任一 UNKNOWN → 还不能对账。
// 注：CLOSED ≠ 一定合并进 main——「废弃关闭(NOT_PLANNED/DUPLICATE)」由 reconcileDrift 另行识别跳过；
// 「正常关闭但实现其实没进 main」由对账时锚定 origin/<prod> 的真实代码兜住（读不到→如实报 drift/unknown）。
export function allClosed(states: { state: 'OPEN' | 'CLOSED' | 'UNKNOWN' }[]): boolean {
  return states.length > 0 && states.every((s) => s.state === 'CLOSED');
}

// 关闭原因为「废弃」（需求被丢弃，不该当作落地去对账）。
export function isDropped(reason: string): boolean {
  return reason === 'NOT_PLANNED' || reason === 'DUPLICATE';
}

// LLM 顶层 drifted 与逐条 findings 偶尔可能自相矛盾。生产上以更保守的口径为准：
// 只要任一验收项被逐条判 drift，就不能把本轮记成 clean。
export function hasDrift(v: DriftVerdict): boolean {
  return v.drifted || v.findings.some((f) => f.status === 'drift');
}

// 校验各 fetch 过的仓 working-tree 是否「正停在该 origin/<prod> sha 且干净」。返回未对齐的仓名（空=全部可信）。
// 漂移对账据此确保 claude 读到的就是「已合并进 <prod> 的真实代码」，而非错分支(dev)/落后/脏工作树——
// 否则会给出「对着错代码的自信 clean」，是最危险的漂移误报。Forge 绝不动 checkout，只读不出就如实判不对齐。
// reposOffRef 已上移到 gates/repoAnchor.ts（闸A/B 评审锚定 + drift 对账共用一份），此处直接 import 使用。

// 漂移告警 DM 文案（纯函数）：标题 + 逐条漂移 + 小结 + 复核入口。
export function driftDm(s: Session, v: DriftVerdict): { title: string; lines: string[] } {
  const drifts = v.findings.filter((f) => f.status === 'drift');
  const unknowns = v.findings.filter((f) => f.status === 'unknown');
  return {
    title: `⚠️ 实现漂移 · ${reqRef(s)}`,
    lines: [
      `「${s.title}」已 DONE，但已合并实现与闸B 验收契约出现 **${drifts.length}** 处漂移${unknowns.length ? `（另有 ${unknowns.length} 处无法判断）` : ''}：`,
      ...drifts.slice(0, 8).map((f, i) => `${i + 1}. [${f.ac || '契约'}] ${f.detail}${f.evidence ? `（${f.evidence}）` : ''}`),
      v.summary ? `小结：${v.summary}` : '',
      `复核：\`./forge show ${s.slug}\` ｜ 需改则人工开跟进 issue`,
    ].filter(Boolean),
  };
}

// ── 单需求对账 ────────────────────────────────────────────

// 验收契约来源：闸B 草稿信封（gate_b_draft_path）。缺/坏 → null（调用方记 skipped 终态，不硬失败——漂移审计是事后尽力而为）。
function readAcceptance(s: Session): Acceptance | null {
  if (!s.gate_b_draft_path || !existsSync(s.gate_b_draft_path)) return null;
  try {
    return GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8'))).acceptance;
  } catch {
    return null;
  }
}

// 把「被废弃的子 issue」渲染成 prompt 片段：让 claude 知道这些仓的验收项未实现属合理（标 unknown，别误报 drift）。
function droppedNote(dropped: IssueStateRow[]): string {
  if (dropped.length === 0) return '(none: all issues completed normally)';
  return (
    dropped.map((d) => `- ${d.repo}#${d.number} (${d.reason})`).join('\n') +
    "\n(These repos' issues were closed as **duplicate/descoped** during delivery: their acceptance items being unimplemented is **legitimate** — mark them `unknown`, note \"issue dropped for this repo\" in detail, and **do not report drift for them**.)"
  );
}

// 对一条「主体已交付」的 DONE 需求做漂移对账。dropped=被废弃的子 issue（带进 prompt 供 claude 区分）。
// 落 drift_detected/clean + drift_reconciled（终态）。失败（freshness/checkout/claude/解析）抛出 →
// 由 reconcileDrift 的 per-session try/catch 接住、留待下轮重试。
export async function auditSession(s: Session, dropped: IssueStateRow[] = []): Promise<void> {
  const acc = readAcceptance(s);
  if (!acc || (acc.contracts.length === 0 && acc.scenarios.length === 0)) {
    await sessions.appendEvent(s.id, 'drift_reconciled', { skipped: 'no_acceptance' });
    log.info(`${s.slug}: 无验收契约可对账 → 跳过漂移审计（记终态）`);
    return;
  }
  const proj = projectForSession(s);
  // 漂移一律对账 **prod（=main）**——已合并交付在 main，不用 s.branch（可能是 dev/dev，会读到错代码）。
  const prod = proj.branches.prod;
  const fresh = await refresh(prod, proj);
  assertFresh(fresh); // 取不到代码真源 → 抛（外层退避重试），绝不对着陈旧/ERROR 对账
  // 锚定：各仓 checkout 必须正停在刚 fetch 的 origin/<prod> sha 且干净，否则 claude 会读到错分支/落后/脏树代码，
  // 给出「对着非 main 代码的自信结论」。不对齐 → 抛错延后重试（受 max_polls 封顶），绝不出错误对账。
  const off = reposOffRef(proj, fresh.shas);
  if (off.length) {
    throw new Error(`漂移对账锚定失败：${off.join(', ')} 的 checkout 未对齐 origin/${prod}（错分支/落后/脏工作树）— 拒绝对着非 ${prod} 代码下结论`);
  }
  const prompt = render(loadPrompt('drift-audit.md', proj.id), {
    SLUG: s.slug,
    REPO_FRESHNESS: render(loadPrompt('partials/repo-freshness.md', proj.id), { FETCHED_AT: fresh.fetchedAt, REPO_REFS: fresh.refsText }),
    ACCEPTANCE: acceptanceMarkdown(acc),
    DROPPED: droppedNote(dropped),
    DRIFT_CONTRACT,
  });
  const dir = sessionLogDir(s.id);
  try { writeFileSync(resolve(dir, 'drift-audit.prompt.txt'), prompt); } catch { /* 落盘失败不阻断 */ }

  const res = await runClaude(prompt, { label: '漂移对账', cwd: proj.root });
  try { writeFileSync(resolve(dir, 'drift-audit.raw.txt'), res.raw ?? ''); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`漂移对账 claude 失败：${res.error}`);

  let v: DriftVerdict;
  try {
    v = strictParse(DriftSchema, res.result);
  } catch (e) {
    try { writeFileSync(resolve(dir, 'drift-audit.result.txt'), res.result); } catch { /* ignore */ }
    throw new Error(`漂移对账输出解析失败（绝不静默放过）：${String(e).slice(0, 160)}`);
  }

  const drifted = hasDrift(v);
  if (drifted) {
    const dm = driftDm(s, v);
    log.warn(`${s.slug}: 检出实现漂移 ${v.findings.filter((f) => f.status === 'drift').length} 处 → 私聊告警 M`);
    await port.sendDmText(dm.title, dm.lines, 'red').catch((e) => log.warn(`漂移告警 DM 未送达（已记日志）：${String(e).slice(0, 120)}`));
    await sessions.appendEvent(s.id, 'drift_detected', { drifts: v.findings.filter((f) => f.status === 'drift').length, summary: v.summary });
  } else {
    log.ok(`${s.slug}: 漂移对账通过——实现与验收契约对齐`);
    await sessions.appendEvent(s.id, 'drift_clean', { findings: v.findings.length });
  }
  await sessions.appendEvent(s.id, 'drift_reconciled', { drifted }); // 终态：不再复跑
}

// ── 轮询入口（tick 在 drift.enabled 时调）──────────────────
// 扫 DONE 且未对账过的需求：去抖 → 查 issue 是否全关闭 → 全关则对账一次。失败留待下轮（受 max_polls 封顶）。
export async function reconcileDrift(now: number): Promise<void> {
  const d = loadConfig().runtime.drift;
  const everyMs = hours(d?.poll_every_hours ?? 24);
  const maxPolls = d?.max_polls ?? 8;

  for (const s of await sessions.listByStates(['DONE'])) {
    if ((await sessions.lastEventTs(s.id, 'drift_reconciled')) != null) continue; // 已对账（终态）
    const issues = parseCreatedIssues(s.created_issues);
    if (issues.length === 0) continue; // 没建 issue → 无可对账
    const last = await sessions.lastEventTs(s.id, 'drift_polled');
    if (last != null && now - last < everyMs) continue; // 轮询去抖

    const polls = (await sessions.events(s.id)).filter((e) => e.kind === 'drift_polled').length;
    if (polls >= maxPolls) {
      // 退避耗尽：issue 久未全关 / 审计反复失败 → 放弃自动对账（终态）并告警 M 人工核对，不无限烧 token。
      await sessions.appendEvent(s.id, 'drift_reconciled', { gave_up: true, polls });
      await port.sendDmText(
        `⚠️ 漂移对账放弃 · ${reqRef(s)}`,
        [`「${s.title}」轮询 ${polls} 次仍无法对账（issue 未全合并，或审计反复失败）。已停止自动对账，请人工核对实现 vs 验收契约。`],
        'orange',
      ).catch(() => undefined);
      log.warn(`${s.slug}: 漂移对账退避耗尽（${polls} 次）→ 放弃 + 告警 M`);
      continue;
    }
    await sessions.appendEvent(s.id, 'drift_polled', { attempt: polls + 1 });

    try {
      const states = await issueStates(issues, projectForSession(s).owner);
      if (states.some((st) => st.state === 'UNKNOWN')) {
        log.warn(`${s.slug}: 漂移轮询取不到部分 issue 态（gh 失败/超时）→ 下个窗口再试`);
        continue; // 取不到 → 不当「已合并」，下轮再说
      }
      if (!allClosed(states)) continue; // 还有 OPEN → 等下个窗口
      // 全 CLOSED。区分「废弃关闭(NOT_PLANNED/DUPLICATE)」与「正常完成」：
      // - 整条废弃（全部 issue 废弃 / 伞仓 Epic 本体废弃）→ 需求丢弃，记终态跳过（不烧 claude）。
      // - 仅部分子 issue 废弃（去重/降范围）而主体仍交付 → 仍对账已交付部分，把废弃信息带进 prompt
      //   （让 claude 别把被降范围的仓误判 drift）——绝不因一个子 issue 被去重就丢掉整条 Phase 4 保障。
      const dropped = states.filter((st) => isDropped(st.reason));
      if (dropped.length) {
        const umbrella = projectForSession(s).umbrella;
        const allDropped = dropped.length === states.length;
        const umbrellaDropped = dropped.some((st) => st.repo === umbrella);
        if (allDropped || umbrellaDropped) {
          await sessions.appendEvent(s.id, 'drift_reconciled', { skipped: allDropped ? 'all_dropped' : 'umbrella_dropped', issues: dropped.map((d) => `${d.repo}#${d.number}(${d.reason})`) });
          log.info(`${s.slug}: 需求整体废弃（${allDropped ? '全部 issue' : '伞仓 Epic'}）→ 不对账（记终态）`);
          continue;
        }
        log.info(`${s.slug}: ${dropped.length} 个子 issue 废弃（去重/降范围），主体仍交付 → 对账已交付部分（废弃信息入 prompt）`);
      }
      await auditSession(s, dropped); // 主体交付 → 对账（锚定 origin/prod 真实代码；废弃子 issue 入 prompt 供区分）
    } catch (e) {
      // 不写 drift_reconciled → 下个轮询窗口重试（受 max_polls 封顶）。绝不让单条失败打断整轮扫描。
      log.warn(`${s.slug}: 漂移对账本轮失败（下个窗口重试）— ${String(e).slice(0, 160)}`);
    }
  }

  // 下游 SHIPPED：forge 自实现的 PR 已**人工合并**（forge merged 确认）→ 合并是确定事实，跳过 DONE 那套 issue 关闭判定，
  // 直接对账「已合并实现 vs 闸B 验收契约」（与闸D 的 pre-merge 互补）。同样受 poll 去抖 + max_polls 封顶。
  // standalone（无 gate_b 验收契约）→ auditSession 记 skipped 终态（如实：无契约可对账，不假装对齐）。
  for (const s of await sessions.listByStates(['SHIPPED'])) {
    if ((await sessions.lastEventTs(s.id, 'drift_reconciled')) != null) continue; // 已对账（终态）
    const last = await sessions.lastEventTs(s.id, 'drift_polled');
    if (last != null && now - last < everyMs) continue; // 轮询去抖
    const polls = (await sessions.events(s.id)).filter((e) => e.kind === 'drift_polled').length;
    if (polls >= maxPolls) {
      await sessions.appendEvent(s.id, 'drift_reconciled', { gave_up: true, polls });
      log.warn(`${s.slug}: 漂移对账（SHIPPED）退避耗尽（${polls} 次）→ 放弃自动对账`);
      continue;
    }
    await sessions.appendEvent(s.id, 'drift_polled', { attempt: polls + 1 });
    try {
      await auditSession(s); // 已人工合并 → 直接对账（锚定 origin/prod 真实代码；无 issue 关闭判定）
    } catch (e) {
      log.warn(`${s.slug}: 漂移对账（SHIPPED）本轮失败（下个窗口重试）— ${String(e).slice(0, 160)}`);
    }
  }
}
