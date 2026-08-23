// Requirement complexity (a relative estimate). ⚠️ The source of truth is the main repo's
// docs/workspace/load-eval.md plus the size:* labels in sync-labels.sh (4 tiers S/M/L/XL, worth
// S1/M3/L8/XL20, applied as a label by Gate B, and weighted by weekly-load.sh as size x cross-repo breadth
// x quality). This file is only Forge's mirror of that and must agree with the target project's source of
// truth — to change the standard, change it there and then sync it here.

export const SIZES = ['S', 'M', 'L', 'XL'] as const;
export type Size = (typeof SIZES)[number];

// The point values, matching the main repo's load-eval.md and weekly-load.sh (superlinear: difficulty is
// amplified non-linearly).
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

// The dot meter: `tier` of the 4 cells lit (S -> ●○○○ … XL -> ●●●●).
export function sizeMeter(s: Size): string {
  const i = SIZES.indexOf(s) + 1; // 1..4
  return '●'.repeat(i) + '○'.repeat(SIZES.length - i);
}

// The card badge: "Complexity L · 8pt ●●●○"
export function sizeBadge(s: Size | null): string {
  if (!s) return 'Complexity TBD';
  return `Complexity ${s} · ${POINTS[s]}pt ${sizeMeter(s)}`;
}

// The anchor definitions in plain language, matching the size descriptions in the main repo's
// sync-labels.sh and load-eval.md.
export const SIZE_ANCHOR: Record<Size, string> = {
  S: 'small: ≤half a day, single-point change',
  M: 'medium: 1-2 days, one feature in one repo',
  L: 'large: 3-5 days, or cross-repo / has a migration',
  XL: 'extra large: a week+, or multi-repo refactor / infrastructure',
};

// The rubric injected into the Gate A and Gate B prompts.
export const SIZE_RUBRIC = [
  '## Complexity tiering (size)',
  'Estimate one **relative complexity tier** for the whole requirement (not effort, not lines of code), 4 tiers (aligned with the team load-eval rubric):',
  ...SIZES.map((s) => `- **${s}** (${POINTS[s]}pt): ${SIZE_ANCHOR[s]}`),
  'Tiering dimensions: order-of-magnitude of change days + cross-repo breadth + migrations/contracts/sensitive domains (auth/pay/risk-control) + uncertainty.',
  'Be conservative and honest: when unsure, do not round down — uncertainty is itself a tier-up signal. Default to M.',
].join('\n');
