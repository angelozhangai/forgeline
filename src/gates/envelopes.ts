import { z } from 'zod';
import { SIZES } from '../util/sizing.ts';

// 决策选项：给 PM/总监「逐条」拍板用——一个可读标签 + 是否推荐 + 选它的影响。
// 闸A 的 open_questions 与闸B 的 HumanAsk 共用同一原语（决策卡）。
// 向后兼容：旧数据/老模型可能给纯字符串选项 → preprocess 归一为 {label, recommended:false, impact:''}，
// 飞行中 session 的旧 JSON 解析不崩（见 db 迁移纪律）。
export const DecisionOptionSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { label: v } : v),
  z.object({
    label: z.string().default(''), // 选项文案（PM/总监能看懂）
    recommended: z.boolean().default(false), // 是否为推荐值（卡片标 ★）
    impact: z.string().default(''), // 选它的影响/后果（卡片副文案）
  }),
);
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

// 闸A 输出契约（与 prompts/partials/output-contract.md 对齐）
export const GateASchema = z.object({
  summary: z.string().default(''),
  repos_touched: z.array(z.string()).default([]),
  size: z.enum(SIZES).default('M'), // 整需求复杂度档（AI 提议，人确认）
  size_reason: z.string().default(''), // 定档一句理由
  open_questions: z
    .array(
      z.object({
        q: z.string(),
        suggestion: z.string().default(''),
        severity: z.string().default('med'),
        options: z.array(DecisionOptionSchema).default([]), // 逐条可选项（含推荐+影响）；空=仅自由作答
      }),
    )
    .default([]),
  risks: z
    .array(
      z.object({
        area: z.string().default(''),
        detail: z.string().default(''),
        evidence: z.string().default(''),
      }),
    )
    .default([]),
  confidence: z.number().default(0),
  needs_lead: z.boolean().default(false),
  // PRD 质量评分（私有，仅内部查询）。宽松解析、不卡边界——脏值在 gateA 落库前由 scoring.normScore/normDims 收敛。
  prd_score: z.number().default(0), // 0-100 总分
  prd_score_dims: z
    .object({
      clarity: z.number().default(0),
      completeness: z.number().default(0),
      feasibility: z.number().default(0),
      testability: z.number().default(0),
    })
    .default({ clarity: 0, completeness: 0, feasibility: 0, testability: 0 }),
  prd_score_reason: z.string().default(''),
});
export type GateAEnvelope = z.infer<typeof GateASchema>;

// 闸B 输出契约（与 prompts/gate-b.md 对齐）
export const IssueSpecSchema = z.object({
  repo: z.string(),
  title: z.string(),
  type: z.string().default('feat'),
  prio: z.string().default('P2'),
  area: z.string().optional(),
  assignee: z.string().optional(),
  body: z.string().optional(),
  size: z.enum(SIZES).optional(), // 该仓切片复杂度（多仓需求每仓各自档；私有，仅用于人均工作量加总，不写进 issue）
});
export type IssueSpec = z.infer<typeof IssueSpecSchema>;

// 验收契约（外环 / ATDD·BDD）：设计期可写——绑「契约/边界」(端点+schema 或导出签名)，**不绑内部方法**；
// 当前应全红，是「done」的定义。单元/集成（内环）由工程师开发期按 TDD 补，**不在闸B产出**。
export const AcceptanceSchema = z.object({
  contracts: z
    .array(
      z.object({
        repo: z.string().default(''), // C/U/A/E；空=通用约束
        surface: z.string().default(''), // 固定边界：HTTP 端点+方法+req/resp schema+状态码，或导出函数签名
      }),
    )
    .default([]),
  scenarios: z
    .array(
      z.object({
        id: z.string().default(''), // AC1/AC2…
        repo: z.string().default(''),
        gherkin: z.string().default(''), // 声明式 Given/When/Then（描述业务结果，非点按钮）；当前红
      }),
    )
    .default([]),
});
export type Acceptance = z.infer<typeof AcceptanceSchema>;

export const GateBSchema = z.object({
  summary: z.string().default(''),
  key_decisions: z.record(z.unknown()).default({}),
  tech_design_markdown: z.string().default(''),
  // 外环验收：契约 + 声明式 BDD 场景（当前全红）。issue 正文/技术方案文档由服务从此字段渲染。
  acceptance: AcceptanceSchema.default({ contracts: [], scenarios: [] }),
  multi_repo: z.boolean().default(false),
  epic_title: z.string().optional(),
  epic_doc_type: z.string().default('feat'),
  issue_specs: z.array(IssueSpecSchema).default([]),
  confidence: z.number().default(0),
});
export type GateBEnvelope = z.infer<typeof GateBSchema>;

// reviewer 通过约定（代码评审惯例）：LGTM=通过，CHANGES_REQUESTED=要改。
// 兼容旧值 clean/needs_revision（自动归一）；未知值原样传入让 enum 失败 → 触发自愈重问。
function normalizeVerdict(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (t === 'LGTM' || t === 'CLEAN' || t === 'APPROVE' || t === 'APPROVED') return 'LGTM';
  if (t === 'CHANGES_REQUESTED' || t === 'NEEDS_REVISION' || t === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED';
  return v;
}

export const VerdictSchema = z
  .object({
    // 去掉 default：缺失 verdict → 校验失败 → 自愈重问，绝不默认放行。
    verdict: z.preprocess(normalizeVerdict, z.enum(['LGTM', 'CHANGES_REQUESTED'])),
    findings: z
      .array(
        z.object({
          severity: z.string().default('med'),
          issue: z.string(),
          where: z.string().default(''),
          fix: z.string().default(''),
          evidence: z.string().default(''),
        }),
      )
      .default([]),
  })
  // verdict↔findings 一致性：LGTM⇔零 findings，CHANGES_REQUESTED⇔至少一条。矛盾 → 自愈重问。
  .superRefine((v, ctx) => {
    if (v.verdict === 'LGTM' && v.findings.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verdict'], message: 'verdict=LGTM but findings is non-empty: self-contradictory (either switch to CHANGES_REQUESTED or empty the findings)' });
    }
    if (v.verdict === 'CHANGES_REQUESTED' && v.findings.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['findings'], message: 'verdict=CHANGES_REQUESTED but findings is empty: at least one finding is required' });
    }
  });
export type Verdict = z.infer<typeof VerdictSchema>;

// Verdict findings → fix prompt 的 {{FINDINGS}} markdown（闸A/闸B 同形，单一真源；闸B 还用于把 Codex
// 残留意见带进续修上下文）。空 findings 退化成「见你上一轮提出、尚未消解的意见」。
// 入参用 unknown[]（对齐 reviewFixLoop 引擎的 product-agnostic findings），内部按 Verdict 形状渲染。
export function findingsToMd(findings: unknown[]): string {
  const fs = findings as Verdict['findings'];
  if (!fs.length) return '(see the findings you raised last round that remain unresolved)';
  return fs
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.issue}${f.where ? ` (where: ${f.where})` : ''} | fix: ${f.fix || '(none)'}${f.evidence ? ` | evidence: ${f.evidence}` : ''}`,
    )
    .join('\n');
}

// claude 改方时主动升级、需 M 拍板的点（与 codex 相持不下 / 需产品·架构·风险·优先级决策）。
export const HumanAskSchema = z.object({
  id: z.string().default(''), // 本轮内稳定 id（H1/H2…），答复回喂时对照
  question: z.string(), // 一句话问题
  options: z.array(DecisionOptionSchema).default([]), // 决策选项（含推荐+影响；M 仍可自由作答）。preprocess 兼容旧 string[]
  context: z.string().default(''), // 来源的 codex 意见 / 分歧（简述）
  severity: z.string().default('med'),
});
export type HumanAsk = z.infer<typeof HumanAskSchema>;

// 升级问题的稳定 id——**纯按位置** H{n}，卡片下拉(name=ask_<id>)与答复回拼(composeHumanAnswer)共用。
// 关键：**绝不信 LLM 给的 needs_human[].id**。模型可能给重复/空 id；一旦两条升级点 id 相同，
// 两个下拉会共用同一 name，飞书回调只带得回一个值 → 把同一个决定串到多道题上（喂错架构/产品决策）。
// 位置 index 天然唯一、且 render 与 compose 遍历同一份已存 asks（顺序一致）→ 永远对得上。
// 放这里（无 Feishu 依赖）便于两端复用 + 单测。
export function askId(i: number): string {
  return `H${i + 1}`;
}

// 从存库 JSON 解析升级问题列表，经 schema 归一选项（旧 string[] / 缺字段 → DecisionOption）。
// 所有「读 gate_b_human_asks」的边界统一走它，护住飞行中 session 的旧 JSON（绝不让 o.label 在旧数据上炸）。
export function parseHumanAsks(json: string | null | undefined): HumanAsk[] {
  if (!json) return [];
  try {
    const r = z.array(HumanAskSchema).safeParse(JSON.parse(json));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

// ── 决策卡原语（闸A open_questions / 闸B HumanAsk 共用）───────────────────────
// 一条「逐条待决项」的统一视图：给 PM/总监看的问句 + 选项（含推荐+影响）+ 副提示。
export type OpenQuestion = z.infer<typeof GateASchema>['open_questions'][number];
export interface DecisionItem {
  prompt: string; // 问句（PM/总监视角，非技术语言）
  options: DecisionOption[]; // 逐条选项
  severity: string;
  hint: string; // 副提示（闸A=suggestion，闸B=context）
}
export function openQuestionsToDecisions(qs: OpenQuestion[]): DecisionItem[] {
  return qs.map((q) => ({ prompt: q.q, options: q.options, severity: q.severity, hint: q.suggestion }));
}
export function humanAsksToDecisions(asks: HumanAsk[]): DecisionItem[] {
  return asks.map((a) => ({ prompt: a.question, options: a.options, severity: a.severity, hint: a.context }));
}
// 一张卡最多展示/可作答的待决项数。**正文 markdown、表单下拉、答复回拼必须用同一个 cap**，
// 否则会出现「显示了第 6-8 条但没下拉、选了也被忽略」的不一致（破坏「每条都有下拉」契约）。
export const DECISION_CAP = 8;

// 可作答项（有选项的）+ 稳定位置 id（H{n}）。**render 与 compose 必须共用它** → 索引永远对齐
// （绝不信 LLM 给的 id；位置 index 天然唯一，见上面串题事故注释）。cap 与卡片渲染上限一致。
export function answerableDecisions(items: DecisionItem[], cap = DECISION_CAP): { id: string; index: number; item: DecisionItem }[] {
  return items
    .slice(0, cap)
    .map((item, index) => ({ id: askId(index), index, item }))
    .filter((x) => x.item.options.length > 0);
}
// 结构化拼答复：逐条「H{n}（问句）：选中值」+ 末尾全局补充。verdict='partial' 时加「部分采纳」前缀（闸A 用）。
export function composeDecisionAnswer(items: DecisionItem[], fv: Record<string, string>, verdict?: string): string {
  const lines: string[] = [];
  for (const { id, item } of answerableDecisions(items)) {
    const picked = (fv[`ask_${id}`] ?? '').trim();
    if (!picked || picked === '__other__') continue; // 未选 / 选「其他」→ 留给补充说明
    lines.push(`${id}（${item.prompt}）：${picked}`);
  }
  const notes = (fv.notes ?? '').trim();
  if (notes) lines.push(`补充：${notes}`);
  const body = lines.join('\n');
  if (verdict === 'partial') return body ? `部分采纳：\n${body}` : '部分采纳';
  return body;
}
// 从 gate-a.json 原文解析 open_questions（经 schema 归一选项，兼容旧无 options 的稿）。
export function parseOpenQuestions(rawJson: string | null | undefined): OpenQuestion[] {
  if (!rawJson) return [];
  try {
    const r = z.object({ open_questions: GateASchema.shape.open_questions }).safeParse(JSON.parse(rawJson));
    return r.success ? r.data.open_questions : [];
  } catch {
    return [];
  }
}

// claude 改方一轮的产出：修订后的完整 gate-b envelope + 本轮需升级 M 的问题（可空）。
export const FixResultSchema = z.object({
  artifact: GateBSchema, // 修订后的完整技术方案 envelope
  needs_human: z.array(HumanAskSchema).default([]),
});
export type FixResult = z.infer<typeof FixResultSchema>;

// 闸A 改方一轮的产出：codex 对 PRD 评审结论挑刺后，claude 修订的完整 gate-a envelope。
// needs_human 恒空（闸A 不升级人在环——PRD 拿不准的点走 PM loop），留字段仅为对称复用 reviewFixLoop。
export const GateAFixResultSchema = z.object({
  artifact: GateASchema,
  needs_human: z.array(HumanAskSchema).default([]),
});
export type GateAFixResult = z.infer<typeof GateAFixResultSchema>;

// ── 下游闸C：实现 + 本地CI ─────────────────────────────────────────
// 被对抗的产物不是文本而是 worktree 状态：claude 改文件（副作用），diff/CI 由 forge 现场重建。
// 这个信封是「隔离工作树 + 当前 diff + CI 状态」的快照（loadArtifact/persistArtifact 走它）。
export const ImplEnvelopeSchema = z.object({
  worktree_path: z.string().default(''),
  impl_branch: z.string().default(''),
  base_ref: z.string().default(''), // origin/main
  base_sha: z.string().default(''),
  implemented: z.boolean().default(false), // base..HEAD 是否已有提交
  diff_stat: z.string().default(''), // git diff --stat base..HEAD（展示）
  files_changed: z.array(z.string()).default([]),
  ci_ok: z.boolean().default(false), // 最近一次 CI 是否全绿
  ci_summary: z.string().default(''), // 最近一次 CI 摘要
  last_summary: z.string().default(''), // claude 上一轮做了什么（自述）
});
export type ImplEnvelope = z.infer<typeof ImplEnvelopeSchema>;

// claude 实现/续做一轮的产出：仅自述 + 升级点（**不回传代码**，代码已落 worktree 文件，diff 由 forge 重建）。
export const GateCFixResultSchema = z.object({
  summary: z.string().default(''), // 这轮实现/修复了什么
  needs_human: z.array(HumanAskSchema).default([]),
});
export type GateCFixResult = z.infer<typeof GateCFixResultSchema>;

// ── 契约提示串（单一真源）──────────────────────────────────────────
// 解析失败自愈回喂时贴进 prompts/partials/parse-repair.md 的 {{CONTRACT}}，告诉模型该长什么样。
// 与上面 schema 同文件维护，改 schema 时顺手改这里。

export const GATE_A_CONTRACT = `{
  "summary": "one-line overview",
  "repos_touched": ["C"],
  "size": "${SIZES.join('|')}",
  "size_reason": "reason for the tier",
  "open_questions": [{ "q": "ask in non-technical language a PM understands", "suggestion": "one-line suggestion", "severity": "high|med|low", "options": [{ "label": "possible answer", "recommended": true, "impact": "consequence of choosing it" }] }],
  "risks": [{ "area": "", "detail": "", "evidence": "repo path:line" }],
  "confidence": 0.0,
  "needs_lead": false,
  "prd_score": 0,
  "prd_score_dims": { "clarity": 0, "completeness": 0, "feasibility": 0, "testability": 0 },
  "prd_score_reason": ""
}`;

export const GATE_B_CONTRACT = `{
  "summary": "",
  "key_decisions": {},
  "tech_design_markdown": "(do not nest \\\`\\\`\\\` fences)",
  "acceptance": { "contracts": [{ "repo": "", "surface": "" }], "scenarios": [{ "id": "AC1", "repo": "", "gherkin": "" }] },
  "multi_repo": false,
  "epic_title": "",
  "epic_doc_type": "feat",
  "issue_specs": [{ "repo": "", "title": "", "type": "feat", "prio": "P2" }],
  "confidence": 0.0
}`;

export const VERDICT_CONTRACT = `{
  "verdict": "LGTM | CHANGES_REQUESTED",
  "findings": [{ "severity": "high|med|low", "issue": "the problem", "where": "which part of key_decisions/acceptance/issue_specs/tech_design", "fix": "suggested change", "evidence": "repo path:line" }]
}
// LGTM ⇔ findings must be empty; CHANGES_REQUESTED ⇔ findings must have at least one entry.`;

export const FIX_CONTRACT = `{
  "artifact": { /* full gate-b envelope: summary/key_decisions/tech_design_markdown/acceptance/multi_repo/epic_title/epic_doc_type/issue_specs/confidence */ },
  "needs_human": [{ "id": "H1", "question": "ask in language a director understands", "options": [{ "label": "Option A", "recommended": true, "impact": "impact of choosing A" }, { "label": "Option B", "recommended": false, "impact": "impact of choosing B" }], "context": "", "severity": "high|med|low" }]
}
// If nothing needs escalating to M, "needs_human": [].`;

// 闸A 对抗复审契约（where 词汇是闸A 的 envelope 字段，区别于闸B 的 key_decisions/acceptance/…）。
export const GATE_A_VERDICT_CONTRACT = `{
  "verdict": "LGTM | CHANGES_REQUESTED",
  "findings": [{ "severity": "high|med|low", "issue": "gap/flaw in the PRD review verdict", "where": "which part of open_questions/risks/size/repos_touched/summary", "fix": "suggested change", "evidence": "repo path:line or PRD basis" }]
}
// LGTM ⇔ findings must be empty; CHANGES_REQUESTED ⇔ findings must have at least one entry.`;

export const GATE_A_FIX_CONTRACT = `{
  "artifact": { /* full gate-a envelope: summary/repos_touched/size/size_reason/open_questions/risks/confidence/needs_lead/prd_score/prd_score_dims/prd_score_reason */ },
  "needs_human": []
}
// Gate A never escalates to a human — needs_human is always [] (uncertain PRD points go through the PM loop, not here).`;

// 闸C 改方契约：claude **只回自述 + 升级点**，绝不回传代码（代码已落 worktree 文件）。
export const GATE_C_FIX_CONTRACT = `{
  "summary": "what this round implemented/fixed (one line)",
  "needs_human": [{ "id": "H1", "question": "implementation/architecture/trade-off point needing the owner's decision", "options": [{ "label": "Option A", "recommended": true, "impact": "" }], "context": "", "severity": "high|med|low" }]
}
// Code changes go directly into the worktree files — do NOT stuff code into the JSON. If nothing needs escalation, "needs_human": [].`;

// ── 下游闸D：PR 对抗 review ─────────────────────────────────────────
// 复用产物模型：被对抗的仍是 worktree 状态（同闸C 的 ImplEnvelope），reviewer = codex 审 base..HEAD 的 diff，
// fixer = claude 改 worktree（CI 须保持绿）。codex 判决复用 VerdictSchema；claude 改方输出复用 GateCFixResultSchema
// （只回自述 + 升级点，代码落文件）。这里只补两份「契约提示串」供解析自愈的 parse-repair 用（where 词汇是 diff 文件:行）。

// 闸D codex 审 diff 的判决契约（where 指向 diff 内的文件:行，区别于闸B 的 envelope 字段）。
export const GATE_D_VERDICT_CONTRACT = `{
  "verdict": "LGTM | CHANGES_REQUESTED",
  "findings": [{ "severity": "high|med|low", "issue": "problem the diff introduces (bug/contract violation/security/mirror tests/missing failure or permission paths)", "where": "file:line (within the base..HEAD diff)", "fix": "suggested change", "evidence": "code evidence" }]
}
// LGTM ⇔ findings must be empty; CHANGES_REQUESTED ⇔ findings must have at least one entry.`;

// 闸D claude 按 codex 意见改 worktree 的契约：只回自述 + 升级点，代码落文件，且改动须让本地 CI 保持绿。
export const GATE_D_FIX_CONTRACT = `{
  "summary": "what this round changed per codex's findings (one line)",
  "needs_human": [{ "id": "H1", "question": "trade-off point needing the owner's decision (deadlocked with codex / needs a product·architecture call)", "options": [{ "label": "Option A", "recommended": true, "impact": "" }], "context": "", "severity": "high|med|low" }]
}
// Code changes go directly into the worktree files — do NOT stuff code into the JSON; local CI must stay green afterwards. If nothing needs escalation, "needs_human": [].`;
