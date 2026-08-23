import { z } from 'zod';
import { SIZES } from '../util/sizing.ts';

// A decision option: what a PM or a director signs off on, question by question — a readable label, whether
// it is recommended, and the consequence of choosing it.
// Gate A's open_questions and Gate B's HumanAsk share this one primitive (the decision card).
// Backward compatibility: older data and older models may give a bare string option -> preprocess
// normalises it to {label, recommended:false, impact:''} so the old JSON of an in-flight session still
// parses (see the DB migration discipline).
export const DecisionOptionSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { label: v } : v),
  z.object({
    label: z.string().default(''), // the option's wording (understandable to a PM or a director)
    recommended: z.boolean().default(false), // whether this is the recommended value (starred on the card)
    impact: z.string().default(''), // the impact or consequence of choosing it (the card's sub-line)
  }),
);
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

// Gate A's output contract (aligned with prompts/partials/output-contract.md)
export const GateASchema = z.object({
  summary: z.string().default(''),
  repos_touched: z.array(z.string()).default([]),
  size: z.enum(SIZES).default('M'), // the whole requirement's complexity tier (the AI proposes, a human confirms)
  size_reason: z.string().default(''), // one sentence justifying the tier
  open_questions: z
    .array(
      z.object({
        q: z.string(),
        suggestion: z.string().default(''),
        severity: z.string().default('med'),
        options: z.array(DecisionOptionSchema).default([]), // per-question options (with recommendation and impact); empty = free-text answer only
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
  // PRD quality score (private, queried internally only). Parsed leniently with no boundary enforcement —
  // dirty values are normalised by scoring.normScore/normDims before gateA persists them.
  prd_score: z.number().default(0), // total, 0-100
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

// Gate B's output contract (aligned with prompts/gate-b.md)
export const IssueSpecSchema = z.object({
  repo: z.string(),
  title: z.string(),
  type: z.string().default('feat'),
  prio: z.string().default('P2'),
  area: z.string().optional(),
  assignee: z.string().optional(),
  body: z.string().optional(),
  size: z.enum(SIZES).optional(), // this repo's slice of the complexity (a multi-repo requirement gets a tier per repo; private, used only to sum per-person workload, never written into the issue)
});
export type IssueSpec = z.infer<typeof IssueSpecSchema>;

// The acceptance contract (outer loop / ATDD, BDD): writable at design time — it binds the **contract and
// its boundary** (an endpoint plus schema, or an exported signature) and **never an internal method**.
// It should all be red at this point; that is the definition of "done". Unit and integration tests (the
// inner loop) are added by the engineer during development, TDD-style, and are **not produced by Gate B**.
export const AcceptanceSchema = z.object({
  contracts: z
    .array(
      z.object({
        repo: z.string().default(''), // C/U/A/E; empty = a general constraint
        surface: z.string().default(''), // the fixed boundary: an HTTP endpoint + method + req/resp schema + status codes, or an exported function signature
      }),
    )
    .default([]),
  scenarios: z
    .array(
      z.object({
        id: z.string().default(''), // AC1/AC2…
        repo: z.string().default(''),
        gherkin: z.string().default(''), // declarative Given/When/Then (describing a business outcome, not button clicks); currently red
      }),
    )
    .default([]),
});
export type Acceptance = z.infer<typeof AcceptanceSchema>;

export const GateBSchema = z.object({
  summary: z.string().default(''),
  key_decisions: z.record(z.unknown()).default({}),
  tech_design_markdown: z.string().default(''),
  // Outer-loop acceptance: contracts plus declarative BDD scenarios (all red at this point). The issue
  // body and the tech-design document are rendered from this field by the service.
  acceptance: AcceptanceSchema.default({ contracts: [], scenarios: [] }),
  multi_repo: z.boolean().default(false),
  epic_title: z.string().optional(),
  epic_doc_type: z.string().default('feat'),
  issue_specs: z.array(IssueSpecSchema).default([]),
  confidence: z.number().default(0),
});
export type GateBEnvelope = z.infer<typeof GateBSchema>;

// The reviewer's verdict vocabulary follows code-review convention: LGTM = approved,
// CHANGES_REQUESTED = changes needed.
// Older values clean/needs_revision are normalised automatically; an unknown value is passed through so the
// enum fails, which triggers the self-healing re-ask.
function normalizeVerdict(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (t === 'LGTM' || t === 'CLEAN' || t === 'APPROVE' || t === 'APPROVED') return 'LGTM';
  if (t === 'CHANGES_REQUESTED' || t === 'NEEDS_REVISION' || t === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED';
  return v;
}

export const VerdictSchema = z
  .object({
    // No default: a missing verdict fails validation and triggers a self-healing re-ask. It must never
    // default to letting something through.
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
  // Consistency between verdict and findings: LGTM <=> zero findings, CHANGES_REQUESTED <=> at least one.
  // A contradiction triggers a self-healing re-ask.
  .superRefine((v, ctx) => {
    if (v.verdict === 'LGTM' && v.findings.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verdict'], message: 'verdict=LGTM but findings is non-empty: self-contradictory (either switch to CHANGES_REQUESTED or empty the findings)' });
    }
    if (v.verdict === 'CHANGES_REQUESTED' && v.findings.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['findings'], message: 'verdict=CHANGES_REQUESTED but findings is empty: at least one finding is required' });
    }
  });
export type Verdict = z.infer<typeof VerdictSchema>;

// Verdict findings -> the {{FINDINGS}} markdown of a fix prompt (identical for Gate A and Gate B, a single
// source of truth; Gate B also uses it to carry Codex's residual opinions into the resume context).
// Empty findings degrade to "see the findings you raised last round that remain unresolved".
// The parameter is unknown[] (matching the reviewFixLoop engine's product-agnostic findings) and is
// rendered internally against the Verdict shape.
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

// A point claude escalates during a revision that needs the maintainer's call (deadlocked with codex, or
// requiring a product, architecture, risk or priority decision).
export const HumanAskSchema = z.object({
  id: z.string().default(''), // an id stable within this round (H1/H2…), matched up when the answer is fed back
  question: z.string(), // the question in one sentence
  options: z.array(DecisionOptionSchema).default([]), // decision options (with recommendation and impact; the maintainer may still answer freely). preprocess keeps older string[] working
  context: z.string().default(''), // the codex finding or disagreement it came from (briefly)
  severity: z.string().default('med'),
});
export type HumanAsk = z.infer<typeof HumanAskSchema>;

// The stable id of an escalated question — **purely positional**, H{n}, shared by the card's dropdown
// (name=ask_<id>) and the answer reassembly (composeHumanAnswer).
// The crucial part: **never trust the needs_human[].id the LLM supplies**. A model may give duplicate or
// empty ids, and once two escalation points share an id, two dropdowns share one name, the callback carries
// back only one value, and the same decision gets attached to several questions (feeding the wrong
// architecture or product call back in).
// A positional index is inherently unique, and render and compose iterate the same stored asks in the same
// order -> they always line up.
// It lives here (with no Feishu dependency) so both ends can reuse it and it can be unit-tested.
export function askId(i: number): string {
  return `H${i + 1}`;
}

// Parse the escalated question list out of persisted JSON, normalising options through the schema (an older
// string[] or a missing field becomes a DecisionOption).
// Every boundary that reads gate_b_human_asks goes through this, which protects the old JSON of in-flight
// sessions (so o.label can never blow up on legacy data).
export function parseHumanAsks(json: string | null | undefined): HumanAsk[] {
  if (!json) return [];
  try {
    const r = z.array(HumanAskSchema).safeParse(JSON.parse(json));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

// -- The decision card primitive (shared by Gate A's open_questions and Gate B's HumanAsk) --------------
// A unified view of one open question: the question as a PM or director sees it, its options (with
// recommendation and impact), and a hint.
export type OpenQuestion = z.infer<typeof GateASchema>['open_questions'][number];
export interface DecisionItem {
  prompt: string; // the question (from a PM or director's perspective, not in technical language)
  options: DecisionOption[]; // the options
  severity: string;
  hint: string; // the hint (Gate A: suggestion, Gate B: context)
}
export function openQuestionsToDecisions(qs: OpenQuestion[]): DecisionItem[] {
  return qs.map((q) => ({ prompt: q.q, options: q.options, severity: q.severity, hint: q.suggestion }));
}
export function humanAsksToDecisions(asks: HumanAsk[]): DecisionItem[] {
  return asks.map((a) => ({ prompt: a.question, options: a.options, severity: a.severity, hint: a.context }));
}
// The maximum number of open questions one card displays and can accept answers for. **The body markdown,
// the form dropdowns and the answer reassembly must all use the same cap**, or you get the inconsistency of
// "items 6-8 are shown but have no dropdown, and choosing one is ignored" (breaking the "every item has a
// dropdown" contract).
export const DECISION_CAP = 8;

// The answerable items (those with options) plus their stable positional ids (H{n}). **render and compose
// must share this** so the indices always line up (never trust the LLM's ids; a positional index is
// inherently unique — see the crossed-questions note above). The cap matches the card's render limit.
export function answerableDecisions(items: DecisionItem[], cap = DECISION_CAP): { id: string; index: number; item: DecisionItem }[] {
  return items
    .slice(0, cap)
    .map((item, index) => ({ id: askId(index), index, item }))
    .filter((x) => x.item.options.length > 0);
}
// Assemble the answer in a structured way: one "H{n} (question): chosen value" line per item, followed by
// the global notes. With verdict='partial', a "partially accepted" prefix is added (used by Gate A).
export function composeDecisionAnswer(items: DecisionItem[], fv: Record<string, string>, verdict?: string): string {
  const lines: string[] = [];
  for (const { id, item } of answerableDecisions(items)) {
    const picked = (fv[`ask_${id}`] ?? '').trim();
    if (!picked || picked === '__other__') continue; // unanswered, or "other" was chosen -> left to the notes box
    lines.push(`${id} (${item.prompt}): ${picked}`);
  }
  const notes = (fv.notes ?? '').trim();
  if (notes) lines.push(`Notes: ${notes}`);
  const body = lines.join('\n');
  if (verdict === 'partial') return body ? `Partially accepted:\n${body}` : 'Partially accepted';
  return body;
}
// Parse open_questions out of the raw gate-a.json (normalising options through the schema, so drafts
// without options still work).
export function parseOpenQuestions(rawJson: string | null | undefined): OpenQuestion[] {
  if (!rawJson) return [];
  try {
    const r = z.object({ open_questions: GateASchema.shape.open_questions }).safeParse(JSON.parse(rawJson));
    return r.success ? r.data.open_questions : [];
  } catch {
    return [];
  }
}

// The output of one claude revision round: the full revised gate-b envelope plus any questions this round
// needs to escalate to the maintainer (possibly none).
export const FixResultSchema = z.object({
  artifact: GateBSchema, // the full revised tech-design envelope
  needs_human: z.array(HumanAskSchema).default([]),
});
export type FixResult = z.infer<typeof FixResultSchema>;

// The output of one Gate A revision round: after codex picks holes in the PRD review verdict, claude's
// fully revised gate-a envelope.
// needs_human is always empty (Gate A never escalates to a human — uncertain PRD points go through the PM
// loop); the field exists only so reviewFixLoop can be reused symmetrically.
export const GateAFixResultSchema = z.object({
  artifact: GateASchema,
  needs_human: z.array(HumanAskSchema).default([]),
});
export type GateAFixResult = z.infer<typeof GateAFixResultSchema>;

// -- Downstream Gate C: implementation + local CI ---------------------------
// What gets adversarially reviewed here is not text but worktree state: claude edits files (a side effect)
// and forge rebuilds the diff and CI on the spot.
// This envelope is a snapshot of "the isolated worktree + the current diff + CI status"
// (loadArtifact/persistArtifact go through it).
export const ImplEnvelopeSchema = z.object({
  worktree_path: z.string().default(''),
  impl_branch: z.string().default(''),
  base_ref: z.string().default(''), // origin/main
  base_sha: z.string().default(''),
  implemented: z.boolean().default(false), // whether base..HEAD already has commits
  diff_stat: z.string().default(''), // git diff --stat base..HEAD (for display)
  files_changed: z.array(z.string()).default([]),
  ci_ok: z.boolean().default(false), // whether the last CI run was fully green
  ci_summary: z.string().default(''), // the last CI run's summary
  last_summary: z.string().default(''), // what claude did last round (in its own words)
});
export type ImplEnvelope = z.infer<typeof ImplEnvelopeSchema>;

// The output of one claude implement/resume round: a self-report plus escalations only (**no code is
// returned** — the code is already in the worktree files, and forge rebuilds the diff).
export const GateCFixResultSchema = z.object({
  summary: z.string().default(''), // what this round implemented or fixed
  needs_human: z.array(HumanAskSchema).default([]),
});
export type GateCFixResult = z.infer<typeof GateCFixResultSchema>;

// -- Contract hint strings (single source of truth) -------------------------
// Pasted into {{CONTRACT}} in prompts/partials/parse-repair.md when a parse failure is fed back for
// self-healing, telling the model what the shape should be.
// Maintained in the same file as the schemas above; change a schema and change this alongside it.

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

// Gate A's adversarial review contract (the `where` vocabulary is Gate A's envelope fields, unlike Gate B's
// key_decisions/acceptance/…).
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

// Gate C's revision contract: claude returns **only a self-report and escalations**, never code (the code is
// already in the worktree files).
export const GATE_C_FIX_CONTRACT = `{
  "summary": "what this round implemented/fixed (one line)",
  "needs_human": [{ "id": "H1", "question": "implementation/architecture/trade-off point needing the owner's decision", "options": [{ "label": "Option A", "recommended": true, "impact": "" }], "context": "", "severity": "high|med|low" }]
}
// Code changes go directly into the worktree files — do NOT stuff code into the JSON. If nothing needs escalation, "needs_human": [].`;

// -- Downstream Gate D: adversarial PR review -------------------------------
// The artefact model is reused: what is reviewed is still worktree state (the same ImplEnvelope as Gate C),
// with the reviewer being codex reading the base..HEAD diff and the fixer being claude editing the worktree
// (CI must stay green). Codex's verdict reuses VerdictSchema; claude's revision output reuses
// GateCFixResultSchema (a self-report plus escalations, with the code landing in files).
// All that is added here are two contract hint strings for parse-repair's self-healing (the `where`
// vocabulary is file:line within the diff).

// Gate D's contract for codex reviewing the diff (`where` points at file:line inside the diff, unlike Gate
// B's envelope fields).
export const GATE_D_VERDICT_CONTRACT = `{
  "verdict": "LGTM | CHANGES_REQUESTED",
  "findings": [{ "severity": "high|med|low", "issue": "problem the diff introduces (bug/contract violation/security/mirror tests/missing failure or permission paths)", "where": "file:line (within the base..HEAD diff)", "fix": "suggested change", "evidence": "code evidence" }]
}
// LGTM ⇔ findings must be empty; CHANGES_REQUESTED ⇔ findings must have at least one entry.`;

// Gate D's contract for claude editing the worktree per codex's findings: a self-report plus escalations
// only, with the code landing in files, and the changes must leave local CI green.
export const GATE_D_FIX_CONTRACT = `{
  "summary": "what this round changed per codex's findings (one line)",
  "needs_human": [{ "id": "H1", "question": "trade-off point needing the owner's decision (deadlocked with codex / needs a product·architecture call)", "options": [{ "label": "Option A", "recommended": true, "impact": "" }], "context": "", "severity": "high|med|low" }]
}
// Code changes go directly into the worktree files — do NOT stuff code into the JSON; local CI must stay green afterwards. If nothing needs escalation, "needs_human": [].`;
