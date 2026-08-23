// PRD quality scoring, produced by the Gate A AI review. ⚠️ Private, management-facing: it is persisted and
// queried through the internal `forge show` / `forge scores` only, and must never be written into a delivery
// document (req-review.md), a Feishu comment, or any other surface an engineer or an outsider can see — the
// same discipline as the private size report (see `workload` in index.ts).
// It is orthogonal to the complexity tier (sizing.ts): size measures "how big is this requirement", score
// measures "is this PRD written well enough for the team to build from".

export const SCORE_DIMS = ['clarity', 'completeness', 'feasibility', 'testability'] as const;
export type ScoreDim = (typeof SCORE_DIMS)[number];
export const DIM_MAX = 25; // 4 dimensions x 25 = 100 in total
export const SCORE_MAX = SCORE_DIMS.length * DIM_MAX;

export interface ScoreDims {
  clarity: number;
  completeness: number;
  feasibility: number;
  testability: number;
}

export const DIM_LABEL: Record<ScoreDim, string> = {
  clarity: 'clarity',
  completeness: 'completeness',
  feasibility: 'feasibility',
  testability: 'testability',
};

// The anchor for each dimension, in plain language: the criteria the AI scores against, and the terms the
// report uses to explain "why this score".
export const DIM_ANCHOR: Record<ScoreDim, string> = {
  clarity: 'are goals / scope / terminology unambiguous — after reading, do you know exactly what to build',
  completeness: 'are boundaries / errors / permissions / data migration / compatibility covered — any obvious holes',
  feasibility: 'any conflicts with the current code / cross-repo contracts — are the plan and timeline realistic',
  testability: 'does it give verifiable acceptance criteria / metrics rather than "just make it good"',
};

const clampInt = (x: unknown, hi: number): number => {
  const n = Math.round(Number(x));
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(0, n));
};

// Pull the model's total into a 0-100 integer (a model may hand back a fraction or go out of range, and a
// dirty value must never reach the database).
export function normScore(x: unknown): number {
  return clampInt(x, SCORE_MAX);
}

// Pull each of the model's per-dimension scores into a 0-25 integer, filling a missing dimension with 0.
export function normDims(x: Partial<ScoreDims> | null | undefined): ScoreDims {
  const d = x ?? {};
  return {
    clarity: clampInt(d.clarity, DIM_MAX),
    completeness: clampInt(d.completeness, DIM_MAX),
    feasibility: clampInt(d.feasibility, DIM_MAX),
    testability: clampInt(d.testability, DIM_MAX),
  };
}

// The grade band (private reports only — never shown on the outside).
export function scoreBand(score: number): string {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}

// The badge: "PRD score 72/100 (good) · clarity 18/completeness 15/feasibility 22/testability 17"
export function scoreBadge(score: number | null, dims?: ScoreDims | null): string {
  if (score == null) return 'PRD score not yet rated';
  const dimStr = dims
    ? ` · ${SCORE_DIMS.map((d) => `${DIM_LABEL[d]} ${dims[d]}`).join('/')}`
    : '';
  return `PRD score ${score}/${SCORE_MAX} (${scoreBand(score)})${dimStr}`;
}

// The rubric injected into the Gate A prompt (aligned with the prd_score* fields of GateASchema in
// envelopes.ts).
export const SCORE_RUBRIC = [
  '## PRD quality scoring (prd_score / prd_score_dims)',
  'Score the **quality of the PRD itself** — note: this is **not** requirement size (that is size), **nor** your analysis confidence (that is confidence).',
  'It measures "is this PRD written clearly and completely enough for the team to build from directly". 4 dimensions, 0–25 each, summing to a 0–100 total:',
  ...SCORE_DIMS.map((d) => `- **${d}** (\`${d}\`, 0-25): ${DIM_ANCHOR[d]}`),
  'Be honest and strict — no mercy points: missing acceptance criteria / missed boundaries / no migration plan all deduct. Condense the main deduction into one line in `prd_score_reason`.',
].join('\n');
