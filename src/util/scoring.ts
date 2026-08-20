// PRD 质量评分（闸A·AI 评审时产出）。⚠️ 私有·管理面：只落库 + 内部 `forge show`/`forge scores` 查询，
// 绝不写进交付文档（req-review.md）、飞书评论或任何工程师/对外可见的面——和 size 私有报表同一纪律（见 index.ts workload）。
// 与复杂度档（sizing.ts）正交：size 量「这需求多大」，score 量「这份 PRD 写得够不够让团队照着开干」。

export const SCORE_DIMS = ['clarity', 'completeness', 'feasibility', 'testability'] as const;
export type ScoreDim = (typeof SCORE_DIMS)[number];
export const DIM_MAX = 25; // 4 维 × 25 = 100 总分
export const SCORE_MAX = SCORE_DIMS.length * DIM_MAX;

export interface ScoreDims {
  clarity: number;
  completeness: number;
  feasibility: number;
  testability: number;
}

export const DIM_LABEL: Record<ScoreDim, string> = {
  clarity: '清晰度',
  completeness: '完整度',
  feasibility: '可行性',
  testability: '可测性',
};

// 各维度锚点（人话）：给 AI 打分的判据，也是报表里「为什么这个分」的口径。
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

// 把模型给的总分收敛到 0–100 整数（模型可能给小数 / 越界，绝不让脏值落库）。
export function normScore(x: unknown): number {
  return clampInt(x, SCORE_MAX);
}

// 把模型给的维度分各自收敛到 0–25 整数，缺维补 0。
export function normDims(x: Partial<ScoreDims> | null | undefined): ScoreDims {
  const d = x ?? {};
  return {
    clarity: clampInt(d.clarity, DIM_MAX),
    completeness: clampInt(d.completeness, DIM_MAX),
    feasibility: clampInt(d.feasibility, DIM_MAX),
    testability: clampInt(d.testability, DIM_MAX),
  };
}

// 评级带（仅私有报表用，对外永不显示）。
export function scoreBand(score: number): string {
  if (score >= 85) return '优';
  if (score >= 70) return '良';
  if (score >= 55) return '中';
  return '差';
}

// 徽章："PRD 评分 72/100（良）· 清晰度18/完整度15/可行性22/可测性17"
export function scoreBadge(score: number | null, dims?: ScoreDims | null): string {
  if (score == null) return 'PRD 评分 待评';
  const dimStr = dims
    ? ` · ${SCORE_DIMS.map((d) => `${DIM_LABEL[d]}${dims[d]}`).join('/')}`
    : '';
  return `PRD 评分 ${score}/${SCORE_MAX}（${scoreBand(score)}）${dimStr}`;
}

// 给闸A prompt 注入的评分指南（与 envelopes.ts GateASchema 的 prd_score* 字段对齐）。
export const SCORE_RUBRIC = [
  '## PRD quality scoring (prd_score / prd_score_dims)',
  'Score the **quality of the PRD itself** — note: this is **not** requirement size (that is size), **nor** your analysis confidence (that is confidence).',
  'It measures "is this PRD written clearly and completely enough for the team to build from directly". 4 dimensions, 0–25 each, summing to a 0–100 total:',
  ...SCORE_DIMS.map((d) => `- **${d}** (\`${d}\`, 0-25): ${DIM_ANCHOR[d]}`),
  'Be honest and strict — no mercy points: missing acceptance criteria / missed boundaries / no migration plan all deduct. Condense the main deduction into one line in `prd_score_reason`.',
].join('\n');
