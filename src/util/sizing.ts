// 需求复杂度（相对估点）。⚠️ 真源是主仓 docs/workspace/load-eval.md + sync-labels.sh 的 size:* 标签
// （4 档 S/M/L/XL、分值 S1/M3/L8/XL20、闸B 打标签、weekly-load.sh 按「规模×跨栈×质量」加权）。
// 本文件只是 Forge 内的镜像，必须与目标项目真源一致——改标准去改项目真源，再同步这里。

export const SIZES = ['S', 'M', 'L', 'XL'] as const;
export type Size = (typeof SIZES)[number];

// 分值：与主仓 load-eval.md / weekly-load.sh 一致（超线性，难度非线性放大）。
export const POINTS: Record<Size, number> = { S: 1, M: 3, L: 8, XL: 20 };

export function isSize(x: unknown): x is Size {
  return typeof x === 'string' && (SIZES as readonly string[]).includes(x.toUpperCase());
}
export function normSize(x: string): Size | null {
  const u = x.trim().toUpperCase();
  return (SIZES as readonly string[]).includes(u) ? (u as Size) : null;
}
export function sizePoints(s: Size | null): number {
  return s ? POINTS[s] : 0;
}

// 点阵：4 格里点亮 tier 格（S→●○○○ … XL→●●●●）。
export function sizeMeter(s: Size): string {
  const i = SIZES.indexOf(s) + 1; // 1..4
  return '●'.repeat(i) + '○'.repeat(SIZES.length - i);
}

// 卡片徽章："复杂度 L · 8pt ●●●○"
export function sizeBadge(s: Size | null): string {
  if (!s) return '复杂度 待定';
  return `复杂度 ${s} · ${POINTS[s]}pt ${sizeMeter(s)}`;
}

// 锚点定义（人话）：与主仓 sync-labels.sh / load-eval.md 的 size 描述一致。
export const SIZE_ANCHOR: Record<Size, string> = {
  S: 'small: ≤half a day, single-point change',
  M: 'medium: 1-2 days, one feature in one repo',
  L: 'large: 3-5 days, or cross-repo / has a migration',
  XL: 'extra large: a week+, or multi-repo refactor / infrastructure',
};

// 给闸A/闸B prompt 注入的评分指南。
export const SIZE_RUBRIC = [
  '## Complexity tiering (size)',
  'Estimate one **relative complexity tier** for the whole requirement (not effort, not lines of code), 4 tiers (aligned with the team load-eval rubric):',
  ...SIZES.map((s) => `- **${s}** (${POINTS[s]}pt): ${SIZE_ANCHOR[s]}`),
  'Tiering dimensions: order-of-magnitude of change days + cross-repo breadth + migrations/contracts/sensitive domains (auth/pay/risk-control) + uncertainty.',
  'Be conservative and honest: when unsure, do not round down — uncertainty is itself a tier-up signal. Default to M.',
].join('\n');
