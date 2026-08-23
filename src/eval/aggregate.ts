// Aggregating several eval samples, the report, and the trend comparison (pure logic, so it runs in CI).
// Several samples: an LLM is not deterministic, so one run is one sample. It runs N times and **only counts
// as passing if every run passes** (a golden case should be stable), and shows how much the key metrics
// jittered.
// The trend: compared against the previous persisted run, fixture by fixture — pass state plus how the key
// metrics moved (green to red, red to green, a metric up or down).
import type { FixtureResult } from './expectations.ts';
import { fixturePassed } from './expectations.ts';

// One fixture aggregated over N runs.
export interface AggregatedFixture {
  name: string;
  desc: string;
  runs: number;
  samples: FixtureResult[];
  pass: boolean; // it only passes if every run passed
  passedRuns: number;
  costUsd: number; // summed over the N runs
  jitter: Record<string, number[]>; // metric -> its value in each run (to see the jitter)
  error?: string; // the error from the first failing run (for display)
}

export interface EvalReport {
  ranAt?: string; // filled in when the CLI persists it (the pure logic never reads the clock)
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
    error: samples.find((s) => s.error)?.error, // the first **hard** error (claude, the schema, a degraded shape); a failed check is not an error and is shown check by check
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
    const runsNote = rep.runs > 1 ? `  [${f.passedRuns}/${f.runs} runs passed]` : '';
    lines.push(`${f.pass ? '✔' : '✖'} ${f.name}${f.desc ? ` — ${f.desc}` : ''}${runsNote}  ($${f.costUsd.toFixed(2)})`);
    // On failure, show the checks of the **first failing sample** — otherwise, if the last sample happens to
    // be green, you get the awkward "the whole line is red but every check is green", which makes jitter
    // hard to locate. On success, show the last.
    const shown = f.pass ? f.samples[f.samples.length - 1] : (f.samples.find((s) => !fixturePassed(s)) ?? f.samples[f.samples.length - 1]);
    if (f.error) lines.push(`    ✖ ${f.error}`);
    else if (shown) {
      if (!shown.schemaValid) lines.push('    ✖ the output does not match the gate contract (schema validation failed)');
      for (const c of shown.checks) lines.push(`    ${c.pass ? '✔' : '✖'} ${c.name} (${c.detail})`);
    }
    if (rep.runs > 1) for (const [k, vals] of Object.entries(f.jitter)) lines.push(`    · ${k} per run: [${vals.join(', ')}]`);
  }
  const passed = rep.fixtures.filter((f) => f.pass).length;
  lines.push('');
  lines.push(
    `${rep.allPass ? '✅ all passed' : '❌ a regression'}: ${passed}/${rep.fixtures.length} fixtures passed` +
      `${rep.runs > 1 ? ` (each run ${rep.runs} times; every run must pass)` : ''}   total cost $${rep.totalCost.toFixed(2)}`,
  );
  return lines.join('\n');
}

// ── The trend comparison ───────────────────────────────────────────────────
const mean = (v: number[]): number => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : 0);

export interface TrendLine {
  name: string;
  was: boolean | null; // whether it passed last time (null = this fixture did not exist last time)
  now: boolean;
  metricDelta: Record<string, { from: number | null; to: number }>; // how the mean of each key metric moved (only the ones that changed)
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
  const lines: string[] = ['── compared with last time ──'];
  for (const t of trend) {
    const status = t.was === null ? '🆕 new' : t.was === t.now ? (t.now ? '✔ still green' : '✖ still red') : t.was && !t.now ? '⚠️ green -> red (a regression)' : '✅ red -> green (fixed)';
    const metrics = Object.entries(t.metricDelta)
      .map(([k, d]) => `${k} ${d.from ?? '—'}->${d.to}`)
      .join(', ');
    lines.push(`  ${status} ${t.name}${metrics ? ` (${metrics})` : ''}`);
  }
  return lines.join('\n');
}
