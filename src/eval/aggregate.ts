// eval 多样本聚合 + 报告 + 趋势对比（纯逻辑，进 ci）。
// 多样本：LLM 非确定，单次跑是一个样本；跑 N 次、**全过才算过**（golden 该稳），并展示关键指标的抖动幅度。
// 趋势：与上一次落盘的 run 比，逐 fixture 看 pass 状态 + 关键指标变化（绿→红/红→绿/指标涨跌）。
import type { FixtureResult } from './expectations.ts';
import { fixturePassed } from './expectations.ts';

// 一个 fixture 跑 N 次后的聚合。
export interface AggregatedFixture {
  name: string;
  desc: string;
  runs: number;
  samples: FixtureResult[];
  pass: boolean; // 全部 run 通过才算过
  passedRuns: number;
  costUsd: number; // N 次累加
  jitter: Record<string, number[]>; // metric → 各 run 的值（看抖动）
  error?: string; // 第一个失败 run 的错（展示用）
}

export interface EvalReport {
  ranAt?: string; // CLI 落盘时填（纯逻辑不取时间）
  gitSha?: string | null;
  runs: number;
  fixtures: AggregatedFixture[];
  allPass: boolean;
  totalCost: number;
}

export function aggregateFixture(name: string, desc: string, samples: FixtureResult[]): AggregatedFixture {
  const passedRuns = samples.filter(fixturePassed).length;
  const costUsd = samples.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const jitter: Record<string, number[]> = {};
  for (const s of samples)
    for (const [k, v] of Object.entries(s.metrics ?? {})) {
      if (!jitter[k]) jitter[k] = [];
      jitter[k].push(v);
    }
  return {
    name,
    desc,
    runs: samples.length,
    samples,
    pass: samples.length > 0 && passedRuns === samples.length,
    passedRuns,
    costUsd,
    jitter,
    error: samples.find((s) => s.error)?.error, // 首个**硬错**（claude/schema/形状退化），check 失败不算 error（走逐条展示）
  };
}

export function summarize(fixtures: AggregatedFixture[], runs: number): EvalReport {
  return {
    runs,
    fixtures,
    allPass: fixtures.length > 0 && fixtures.every((f) => f.pass),
    totalCost: fixtures.reduce((a, f) => a + f.costUsd, 0),
  };
}

export function formatReport(rep: EvalReport): string {
  const lines: string[] = [];
  for (const f of rep.fixtures) {
    const runsNote = rep.runs > 1 ? `  [${f.passedRuns}/${f.runs} 次通过]` : '';
    lines.push(`${f.pass ? '✔' : '✖'} ${f.name}${f.desc ? ` — ${f.desc}` : ''}${runsNote}  ($${f.costUsd.toFixed(2)})`);
    // 失败 → 展示**首个失败样本**的 checks（否则末次样本恰好绿，会出现「整条红但逐条全绿」的别扭，定位抖动困难）；通过 → 展示末次。
    const shown = f.pass ? f.samples[f.samples.length - 1] : (f.samples.find((s) => !fixturePassed(s)) ?? f.samples[f.samples.length - 1]);
    if (f.error) lines.push(`    ✖ ${f.error}`);
    else if (shown) {
      if (!shown.schemaValid) lines.push('    ✖ 产出不符合闸合约（schema 校验失败）');
      for (const c of shown.checks) lines.push(`    ${c.pass ? '✔' : '✖'} ${c.name}（${c.detail}）`);
    }
    if (rep.runs > 1) for (const [k, vals] of Object.entries(f.jitter)) lines.push(`    · ${k} 各次：[${vals.join(', ')}]`);
  }
  const passed = rep.fixtures.filter((f) => f.pass).length;
  lines.push('');
  lines.push(
    `${rep.allPass ? '✅ 全部通过' : '❌ 有回归'}：${passed}/${rep.fixtures.length} fixtures 通过` +
      `${rep.runs > 1 ? `（每条跑 ${rep.runs} 次，全过才算过）` : ''}　总成本 $${rep.totalCost.toFixed(2)}`,
  );
  return lines.join('\n');
}

// ── 趋势对比 ───────────────────────────────────────────────────
const mean = (v: number[]): number => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : 0);

export interface TrendLine {
  name: string;
  was: boolean | null; // 上次 pass（null=上次没这条 fixture）
  now: boolean;
  metricDelta: Record<string, { from: number | null; to: number }>; // 关键指标均值变化（仅列有变化的）
}

export function diffRuns(prev: EvalReport | null, cur: EvalReport): TrendLine[] {
  return cur.fixtures.map((f) => {
    const p = prev?.fixtures.find((x) => x.name === f.name) ?? null;
    const metricDelta: Record<string, { from: number | null; to: number }> = {};
    for (const [k, vals] of Object.entries(f.jitter)) {
      const to = mean(vals);
      const from = p?.jitter[k] ? mean(p.jitter[k]) : null;
      if (from === null || from !== to) metricDelta[k] = { from, to };
    }
    return { name: f.name, was: p ? p.pass : null, now: f.pass, metricDelta };
  });
}

export function formatTrend(trend: TrendLine[]): string {
  const lines: string[] = ['── 与上次对比 ──'];
  for (const t of trend) {
    const status = t.was === null ? '🆕 新增' : t.was === t.now ? (t.now ? '✔ 仍绿' : '✖ 仍红') : t.was && !t.now ? '⚠️ 绿→红（回归）' : '✅ 红→绿（修复）';
    const metrics = Object.entries(t.metricDelta)
      .map(([k, d]) => `${k} ${d.from ?? '—'}→${d.to}`)
      .join('，');
    lines.push(`  ${status} ${t.name}${metrics ? `（${metrics}）` : ''}`);
  }
  return lines.join('\n');
}
