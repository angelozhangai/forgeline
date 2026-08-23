// The health assessment: the heartbeat, the database, the connection, the dependencies, disk, backups and
// parked sessions, rolled up into one overall status.
// It is reused in three places: the /health endpoint, the `forge health` CLI, and the sampler. The
// classification logic is pulled out into pure functions so it can be unit-tested.
import { statfsSync, readdirSync, statSync } from 'node:fs';
import { minutes } from '../util/time.ts';
import { resolve } from 'node:path';
import { db } from '../store/db.ts';
import { store as sessions } from '../store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { commandExists } from '../util/proc.ts';
import { loadConfig } from '../config.ts';
import { STATE_DIR } from '../root.ts';
import { HUMAN_GATES } from '../statemachine/states.ts';
import { readHeartbeat } from './heartbeat.ts';
import type { Heartbeat } from './heartbeat.ts';
import { healthConfig } from './config.ts';
import type { HealthCfg } from './config.ts';
import { contractCheck } from './contract.ts';
import { port } from '../messaging/index.ts';

export type Status = 'healthy' | 'degraded' | 'down';
export type CheckStatus = Status | 'na';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface HealthReport {
  status: Status;
  ts: number;
  uptimeSec: number | null;
  daemon: {
    running: boolean;
    wedged: boolean;
    pid: number | null;
    startedAt: number | null;
    livenessAgeSec: number | null;
    lastCycleAt: number | null;
    lastCycleOk: boolean | null;
    cycleCount: number;
    activeGates: number;
  };
  ws: { configured: boolean; connected: boolean; lastEventAt: number | null };
  checks: Check[];
  board: { byState: Record<string, number>; total: number; awaiting: number; failed: number; activeGates: number };
}

const FAILED_STATES = ['GATE_A_FAILED', 'GATE_B_FAILED', 'WRITE_FAILED', 'GO_DENIED'];

// ── The pure functions (what the unit tests target) ──────────────────────────────

// The overall status is the worst of the individual checks ('na' does not count).
export function rollupStatus(checks: Check[]): Status {
  let worst: Status = 'healthy';
  for (const c of checks) {
    if (c.status === 'down') return 'down';
    if (c.status === 'degraded') worst = 'degraded';
  }
  return worst;
}

export interface DaemonClass {
  running: boolean;
  wedged: boolean;
  livenessAgeSec: number | null;
  check: Check;
}

// Classifying the daemon's liveness: no heartbeat = down; a stale liveness ping = down (wedged); otherwise
// healthy.
export function classifyDaemon(hb: Heartbeat | null, now: number, cfg: HealthCfg): DaemonClass {
  if (!hb) {
    return {
      running: false,
      wedged: false,
      livenessAgeSec: null,
      check: { name: 'daemon', status: 'down', detail: 'no heartbeat: the daemon is not running, or not ready yet' },
    };
  }
  const ageSec = Math.max(0, Math.round((now - hb.livenessPingAt) / 1000));
  const wedged = ageSec > cfg.wedgedAfterSec;
  if (wedged) {
    return {
      running: false,
      wedged: true,
      livenessAgeSec: ageSec,
      check: { name: 'daemon', status: 'down', detail: `wedged: liveness has not updated for ${ageSec}s (the threshold is ${cfg.wedgedAfterSec}s), PID ${hb.pid}` },
    };
  }
  return {
    running: true,
    wedged: false,
    livenessAgeSec: ageSec,
    check: { name: 'daemon', status: 'healthy', detail: `PID ${hb.pid}, liveness ${ageSec}s ago` },
  };
}

// Classifying the connection: no bot credentials configured = n/a (not a fault, matching listen.ts's
// degradation semantics); configured but disconnected = degraded.
// The provider's name is **passed in from outside** (the caller supplies port.id) rather than importing
// messaging here — this module's classification functions are pure (a test feeds them a struct and touches
// neither the database nor the network), and pulling in a module-level singleton would destroy that.
export function classifyWs(hb: Heartbeat | null, provider = 'IM'): Check {
  const name = `${provider} connection`;
  if (!hb?.wsConfigured) {
    return { name, status: 'na', detail: 'no bot credentials configured (the periodic tick only)' };
  }
  if (!hb.wsConnected) {
    return { name, status: 'degraded', detail: 'configured but not connected (card buttons and the channel entry point are unavailable for now; the periodic tick still runs)' };
  }
  return { name, status: 'healthy', detail: 'established' };
}

// ── Read live (IO) ──────────────────────────────────────────────

let depsCache: { at: number; claude: boolean; codex: boolean; gh: boolean } | null = null;
const DEPS_TTL_MS = minutes(5);

function depsCheck(now: number): Check {
  const cfg = loadConfig();
  if (!depsCache || now - depsCache.at > DEPS_TTL_MS) {
    depsCache = {
      at: now,
      claude: commandExists(cfg.runtime.claude_bin),
      codex: commandExists(cfg.runtime.codex_bin),
      gh: commandExists('gh'),
    };
  }
  const missing: string[] = [];
  if (!depsCache.claude) missing.push('claude');
  if (!depsCache.codex) missing.push(`codex(on_missing=${cfg.runtime.adversarial.on_missing})`);
  if (!depsCache.gh) missing.push('gh');
  if (missing.length === 0) return { name: 'external CLIs', status: 'healthy', detail: 'claude / codex / gh are all present' };
  return { name: 'external CLIs', status: 'degraded', detail: `missing: ${missing.join(', ')}` };
}

function dbCheck(): { check: Check; ok: boolean } {
  try {
    db().prepare('SELECT 1').get();
    return { check: { name: 'SQLite state store', status: 'healthy', detail: 'readable and writable' }, ok: true };
  } catch (e) {
    return { check: { name: 'SQLite state store', status: 'down', detail: `cannot be opened: ${String(e).slice(0, 120)}` }, ok: false };
  }
}

function backupCheck(now: number, hasSessions: boolean): Check {
  const dir = resolve(STATE_DIR, 'backups');
  try {
    const files = readdirSync(dir).filter((f) => f.startsWith('service-') && f.endsWith('.db'));
    if (files.length === 0) {
      return { name: 'automatic backups', status: hasSessions ? 'degraded' : 'na', detail: 'no backup yet (one an hour once the daemon is up)' };
    }
    const newest = Math.max(...files.map((f) => statSync(resolve(dir, f)).mtimeMs));
    const ageMin = Math.round((now - newest) / 60000);
    if (ageMin > 130) return { name: 'automatic backups', status: 'degraded', detail: `the most recent backup was ${ageMin} minutes ago (there should be one an hour)` };
    return { name: 'automatic backups', status: 'healthy', detail: `${files.length} of them, the most recent ${ageMin} minutes ago` };
  } catch {
    return { name: 'automatic backups', status: hasSessions ? 'degraded' : 'na', detail: 'the backup directory cannot be read' };
  }
}

function diskCheck(): Check {
  try {
    const s = statfsSync(STATE_DIR);
    const freeMb = Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    if (freeMb < 200) return { name: 'disk space', status: 'down', detail: `only ${freeMb} MB left` };
    if (freeMb < 1024) return { name: 'disk space', status: 'degraded', detail: `only ${freeMb} MB left` };
    return { name: 'disk space', status: 'healthy', detail: `${(freeMb / 1024).toFixed(1)} GB left` };
  } catch (e) {
    return { name: 'disk space', status: 'na', detail: `cannot be determined: ${String(e).slice(0, 80)}` };
  }
}

function boardFrom(byState: Record<string, number>): HealthReport['board'] {
  let total = 0;
  let awaiting = 0;
  let failed = 0;
  let activeGates = 0;
  for (const [state, n] of Object.entries(byState)) {
    total += n;
    if (HUMAN_GATES.has(state as never)) awaiting += n;
    if (FAILED_STATES.includes(state)) failed += n;
    if (state === 'GATE_A_RUNNING' || state === 'GATE_B_RUNNING' || state === 'ADVERSARIAL_LOOP') activeGates += n;
  }
  return { byState, total, awaiting, failed, activeGates };
}

function businessCheck(board: HealthReport['board']): Check {
  if (board.failed > 0) return { name: 'parked sessions', status: 'degraded', detail: `${board.failed} in a *_FAILED state, waiting to be dealt with` };
  if (board.awaiting > 0) return { name: 'parked sessions', status: 'healthy', detail: `${board.awaiting} waiting on a human decision (normal)` };
  return { name: 'parked sessions', status: 'healthy', detail: 'nothing parked' };
}

// Aggregate a live health snapshot. `now` can be injected (so tests and the sampler share one clock).
export async function evaluateHealth(now: number = Date.now()): Promise<HealthReport> {
  const cfg = healthConfig();
  const hb = readHeartbeat();
  const daemon = classifyDaemon(hb, now, cfg);
  const ws = classifyWs(hb, port.id);

  const { check: dbC, ok: dbOk } = dbCheck();
  let byState: Record<string, number> = {};
  if (dbOk) {
    try {
      byState = await sessions.countByState();
    } catch {
      /* not being able to read the board is not fatal */
    }
  }
  const board = boardFrom(byState);
  const checks: Check[] = [
    daemon.check,
    ws,
    dbC,
    backupCheck(now, board.total > 0),
    depsCheck(now),
    contractCheck(now),
    diskCheck(),
    businessCheck(board),
  ];

  return {
    status: rollupStatus(checks),
    ts: now,
    uptimeSec: hb ? Math.max(0, Math.round((now - hb.startedAt) / 1000)) : null,
    daemon: {
      running: daemon.running,
      wedged: daemon.wedged,
      pid: hb?.pid ?? null,
      startedAt: hb?.startedAt ?? null,
      livenessAgeSec: daemon.livenessAgeSec,
      lastCycleAt: hb?.lastCycleAt ?? null,
      lastCycleOk: hb?.lastCycleOk ?? null,
      cycleCount: hb?.cycleCount ?? 0,
      activeGates: hb?.activeGates ?? board.activeGates,
    },
    ws: { configured: hb?.wsConfigured ?? false, connected: hb?.wsConnected ?? false, lastEventAt: hb?.wsLastEventAt ?? null },
    checks,
    board,
  };
}
