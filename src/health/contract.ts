// Layer 3 — the daily scheduled out-of-band check on the external dependencies' contracts, and its alerting.
//  · runContractProbes: run every probe and persist the results (expensive; only the daily schedule runs it).
//  · maybeAlertContractDrift: debounced on each dependency flipping — a new drift sends a degraded card to
//    the maintainer's direct message, and a recovery sends a recovered one.
//  · contractCheck: read the last probe state out of the database and roll it into one health Check, folded
//    into evaluateHealth — so the health sample every 60 seconds stays cheap (it runs no probes), and a
//    drift shows up on the status page and in `forge health` on its own.
import { log } from '../util/log.ts';
import { runAllProbes, type ProbeResult } from '../llm/probes.ts';
import { getProbe, upsertProbe, allProbes } from '../store/contract.ts';
import { sendHealthAlert } from './alert.ts';
import type { Check } from './check.ts';
import { port } from '../messaging/index.ts';

// The 'im' entry is displayed as **the provider currently in effect** (feishu API / slack API) — hardcode
// one of them and a deployment that switched provider sees a name on its status page that has nothing to do
// with it.
function depLabel(dep: string): string {
  if (dep === 'im') return `${port.id} API`;
  return DEP_LABEL[dep] ?? dep;
}
const DEP_LABEL: Record<string, string> = { codex: 'codex', claude: 'claude', gh: 'gh' };
// The "log in again" guidance for each tool when authentication has lapsed (kind='auth') — as opposed to a
// schema drift, which means editing contract.ts.
// It goes straight at "the token expired and the pipeline silently seized": it gives the operator something
// they can act on directly, rather than misleading them into editing the envelope definition.
// The IM entry is **not here**: how to fix it is provider knowledge, which the adapter reports for itself
// alongside the probe result (ProbeResult.authFix).
const AUTH_FIX: Record<string, string> = {
  codex: 'log in to codex again (codex non-interactive auth, or run the login again)',
  claude: 'log in to claude again (/login, or swap CLAUDE_CODE_OAUTH_TOKEN / setup-token)',
  gh: 'gh auth login (it needs write access to the target project\'s GitHub org)',
};

// Run every probe and persist the results (only the available ones). It returns the results for the caller
// to alert on. Expensive — only the daily interval and `forge contract-check` call it.
export async function runContractProbes(now: number): Promise<ProbeResult[]> {
  const results = await runAllProbes(now);
  // Note the order: alert first (reading the previous state), then persist — maybeAlertContractDrift does
  // getProbe then upsert internally, in that order.
  await maybeAlertContractDrift(results);
  return results;
}

// Debounced on the flip: compared against the previous ok in the database, it sends degraded only the first
// time it goes from fine to drifted, and recovered when it goes back.
// A persistent drift does not spam every day. Anything with available=false (skipped) is neither persisted
// nor alerted on.
export async function maybeAlertContractDrift(results: ProbeResult[], now: number = results[0]?.at ?? 0): Promise<void> {
  for (const r of results) {
    if (!r.available) continue;
    const prev = getProbe(r.dep);
    const wasOk = prev ? prev.ok : true; // the first time it is seen, assume it was fine before, so it only alerts on getting worse
    upsertProbe(r);
    if (wasOk && !r.ok) {
      const label = depLabel(r.dep);
      const body =
        r.kind === 'auth'
          ? [
              `**${label}** exited non-zero, which looks like **a lapsed login or an expired token** — the gates and issue creation that depend on it will park (a failure is never silent).`,
              `- What happened: ${r.detail}`,
              `- What to do: ${r.authFix ?? AUTH_FIX[r.dep] ?? "check that tool's login state"}, then \`forge retry <slug>\` to clear the parked session.`,
              ...(r.raw ? ['```', r.raw.slice(0, 600), '```'] : []),
            ]
          : [
              `**${label}** looks to have changed its output shape after an upgrade — the envelope fields our parsing depends on did not appear.`,
              `- What happened: ${r.detail}`,
              `- The impact: the gates and the backfill parsing could degrade silently, so they now **park** instead (a failure is never silent).`,
              `- What to do: check ${r.dep}'s new output, then update the envelope definition in \`src/llm/contract.ts\` (the single place).`,
              ...(r.raw ? ['```', r.raw.slice(0, 600), '```'] : []),
            ];
      await sendHealthAlert('degraded', r.kind === 'auth' ? `🔑 ${label} authentication looks to have lapsed` : `an external tool's contract has drifted: ${label}`, body, now);
    } else if (!wasOk && r.ok) {
      await sendHealthAlert('recovered', `an external tool's contract has recovered: ${depLabel(r.dep)}`, [`${depLabel(r.dep)}'s envelope fields parse correctly again.`], now);
    }
  }
}

// Read the last probe state out of the database into one health Check (it never triggers a probe). Folded
// into checks[] by evaluateHealth.
export function contractCheck(now: number): Check {
  let rows: ReturnType<typeof allProbes>;
  try {
    rows = allProbes();
  } catch {
    return { name: "external tools' contracts", status: 'na', detail: 'the probe records cannot be read' };
  }
  if (rows.length === 0) return { name: "external tools' contracts", status: 'na', detail: 'not probed yet (it runs once a day)' };
  const drifted = rows.filter((r) => !r.ok);
  const newest = Math.max(...rows.map((r) => r.checkedAt));
  const ageMin = Math.max(0, Math.round((now - newest) / 60000));
  if (drifted.length) {
    return { name: "external tools' contracts", status: 'degraded', detail: `the contract has drifted: ${drifted.map((d) => depLabel(d.dep)).join(', ')} (probed ${ageMin} minutes ago)` };
  }
  return { name: "external tools' contracts", status: 'healthy', detail: `${rows.map((r) => depLabel(r.dep)).join('/')} contracts are fine (${ageMin} minutes ago)` };
}

// For the `forge contract-check` CLI: run the probes, alert, and print the results line by line.
export async function runContractCheckCli(now: number): Promise<ProbeResult[]> {
  const results = await runContractProbes(now);
  for (const r of results) {
    const mark = !r.available ? '·' : r.ok ? '✓' : '✗';
    log.info(`${mark} ${depLabel(r.dep)}: ${r.detail}`);
  }
  return results;
}
