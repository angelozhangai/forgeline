// Layer 2/3 — the active contract probes: run the cheapest possible read-only round trip against the real
// binary or the real API and assert the envelope fields our parsing depends on are still there. Shared by
// test/contract.test.ts (which skips when they are absent) and health/contract.ts (a daily schedule).
// Interpretation: available = it can run (installed / fully configured); ok = the envelope is intact.
// A non-zero exit or a network error is available with ok:false (it may be an auth problem, not necessarily
// drift), and `detail` distinguishes them; a missing envelope field is genuine drift.
import { run, commandExists } from '../util/proc.ts';
import { minutes } from '../util/time.ts';
import { ROOT } from '../root.ts';
import { loadConfig } from '../config.ts';
import { parseCodexJsonl } from './runCodex.ts';
import { runClaude } from './runClaude.ts';
import { CODEX_ENVELOPE, assertCodexEnvelope } from './contract.ts';
import { port } from '../messaging/index.ts';

// 'im' rather than 'feishu': this row probes **whichever IM provider is in effect** (see the selection point
// in messaging/index.ts), not one particular vendor. Existing 'feishu' rows in the DB were renamed by store
// migration v2.
export type ProbeDep = 'codex' | 'claude' | 'gh' | 'im';

export interface ProbeResult {
  dep: ProbeDep;
  available: boolean; // the binary is installed / the API is configured -> a probe is possible
  ok: boolean; // the envelope is intact (available and not drifted)
  detail: string; // one plain-language line (for the alert, the status page, or a parked session's error text)
  raw?: string; // the truncated raw payload, attached to the alert
  at: number;
  // Attribution when !ok, which decides which remediation the alert suggests: auth = login or credentials
  // look to have expired (log in again, clear the parked session); drift = the output envelope drifted (edit
  // src/llm/contract.ts). When absent, or when ok, the drift wording is used (conservative, preserving the
  // old behaviour).
  kind?: 'auth' | 'drift';
  // Remediation guidance when kind='auth' (self-reported by the provider; when absent, health/contract falls
  // back to generic wording).
  authFix?: string;
}

// The cheapest possible round: it forces a complete envelope without letting the model loose on tools.
const TRIVIAL = 'Reply with the single word OK. Do not use any tools.';
const PROBE_TIMEOUT_MS = minutes(1); // probes use a short timeout, never a gate's 1200s — a hung probe should not block anything
// The default project's org, as a fallback. The probe only verifies "the default project is reachable"
// (not the session's project), so the default project's owner is read from the registry here rather than
// importing project() from projects.ts — that would blow up at import time in the many tests that mock
// projects.ts without a `project` export (the same lesson as writes.ts).
const DEFAULT_OWNER = 'your-org';

export async function probeCodex(now: number): Promise<ProbeResult> {
  const cfg = loadConfig();
  if (!commandExists(cfg.runtime.codex_bin)) {
    return { dep: 'codex', available: false, ok: false, detail: 'codex is not installed (skipped)', at: now };
  }
  const r = await run(cfg.runtime.codex_bin, [...CODEX_ENVELOPE.probeArgs], { cwd: ROOT, input: TRIVIAL, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.timedOut) return { dep: 'codex', available: true, ok: false, detail: 'the codex probe timed out', raw: r.stdout.slice(0, 1200), at: now };
  if (r.code !== 0) return { dep: 'codex', available: true, ok: false, kind: 'auth', detail: `codex exited non-zero (${r.code}; possibly credentials or the environment, not necessarily drift)`, raw: (r.stdout + r.stderr).slice(0, 1200), at: now };
  const p = parseCodexJsonl(r.stdout);
  const drift = assertCodexEnvelope({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted });
  return { dep: 'codex', available: true, ok: !drift.drifted, kind: drift.drifted ? 'drift' : undefined, detail: drift.detail, raw: drift.drifted ? r.stdout.slice(0, 1200) : undefined, at: now };
}

export async function probeClaude(now: number): Promise<ProbeResult> {
  const cfg = loadConfig();
  if (!commandExists(cfg.runtime.claude_bin)) {
    return { dep: 'claude', available: false, ok: false, detail: 'claude is not installed (skipped)', at: now };
  }
  // Reuses the production code path: runClaude already carries the Layer-1 envelope assertion, so drift
  // surfaces as an error carrying CLAUDE_CONTRACT_DRIFT.
  const res = await runClaude(TRIVIAL, { label: 'probe', timeoutSec: PROBE_TIMEOUT_MS / 1000 });
  if (res.ok) return { dep: 'claude', available: true, ok: true, detail: 'claude envelope intact', at: now };
  const drift = (res.error ?? '').startsWith('CLAUDE_CONTRACT_DRIFT');
  return { dep: 'claude', available: true, ok: false, kind: drift ? 'drift' : 'auth', detail: drift ? res.error! : `the claude probe failed (${(res.error ?? '').slice(0, 120)}; possibly credentials or a timeout, not necessarily drift)`, raw: drift ? res.raw.slice(0, 1200) : undefined, at: now };
}

export async function probeGh(now: number): Promise<ProbeResult> {
  if (!commandExists('gh')) return { dep: 'gh', available: false, ok: false, detail: 'gh is not installed (skipped)', at: now };
  const cfg = loadConfig();
  const repo = cfg.runtime.repos[0];
  const reg = cfg.projects; // the default project's owner from the registry, falling back to DEFAULT_OWNER
  const owner = reg?.projects?.[reg.default_project]?.owner ?? DEFAULT_OWNER;
  // Read-only, no side effects: what it verifies is exactly the `gh issue list --json number,url` field
  // projection that workspace.ts depends on.
  const r = await run('gh', ['issue', 'list', '-R', `${owner}/${repo}`, '--json', 'number,url', '-L', '1'], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.code !== 0) return { dep: 'gh', available: true, ok: false, kind: 'auth', detail: `gh exited non-zero (${r.code}; possibly not logged in, not necessarily drift)`, raw: r.stderr.slice(0, 600), at: now };
  try {
    const arr = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(arr)) return { dep: 'gh', available: true, ok: false, kind: 'drift', detail: 'gh --json did not return an array (the gh CLI output schema may have changed)', raw: r.stdout.slice(0, 600), at: now };
    const bad = arr.length > 0 && !(typeof (arr[0] as Record<string, unknown>).number === 'number' && typeof (arr[0] as Record<string, unknown>).url === 'string');
    return bad
      ? { dep: 'gh', available: true, ok: false, kind: 'drift', detail: 'a gh issue entry is missing the number/url fields (the gh --json projection may have changed)', raw: r.stdout.slice(0, 600), at: now }
      : { dep: 'gh', available: true, ok: true, detail: 'gh issue list --json fields intact', at: now };
  } catch {
    return { dep: 'gh', available: true, ok: false, kind: 'drift', detail: 'gh --json failed to parse (the gh CLI output schema may have changed)', raw: r.stdout.slice(0, 600), at: now };
  }
}

// The inbound transport probe: envelope validation is messaging-provider knowledge, so the logic lives in
// the adapter (port.probe) and this is only a thin mapping into the common ProbeResult, keeping the llm
// layer from importing any IM's raw layer directly.
export async function probeIm(now: number): Promise<ProbeResult> {
  const p = await port.probe();
  // `kind` must be passed through (auth/drift): losing it makes the health/contract alert fall back to the
  // drift wording (misdirecting someone into editing contract.ts) and miss expired tokens or a bot that was
  // never added to the chat — precisely the scenario this was built to catch.
  // `authFix` is passed through for the same reason: how to fix it is provider knowledge, and the core does
  // not speak on the provider's behalf.
  return { dep: 'im', available: p.available, ok: p.ok, kind: p.kind, authFix: p.authFix, detail: p.detail, raw: p.raw, at: now };
}

// Run every probe (codex/claude cost a trivial call; gh and IM are free and read-only). Ones with
// available=false are still returned (the layer above uses that to skip alerting).
export async function runAllProbes(now: number): Promise<ProbeResult[]> {
  return [await probeCodex(now), await probeClaude(now), await probeGh(now), await probeIm(now)];
}
