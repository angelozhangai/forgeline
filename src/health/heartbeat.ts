// The heartbeat file: the daemon (listen) process writes it periodically, and the watchdog and the status
// page read it. The write is atomic (a temporary file plus a rename) so nothing reads a half-written file.
//
// Why liveness is separate: runCycle() awaits tick(), and a gate that takes 10 minutes naturally makes "the
// last cycle finished" go stale, so it cannot be used to judge liveness. claude and codex are spawned
// asynchronously (they do not block the event loop), so a quick ping every 10 seconds updates reliably — a
// stale liveness means the event loop really is wedged or the process is dead, and that is what the watchdog
// judges on.
import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { HEARTBEAT_PATH } from '../root.ts';

export interface Heartbeat {
  pid: number;
  port: number;
  startedAt: number; // when the daemon started (milliseconds)
  livenessPingAt: number; // the most recent liveness ping (the real liveness signal)
  lastCycleAt: number | null; // when runCycle last finished (business progress; it goes stale during a long gate, and is for display only)
  lastCycleOk: boolean | null;
  cycleCount: number;
  wsConfigured: boolean; // whether the inbound transport is fully configured (port.inboundConfigured(); unconfigured = the periodic tick only, and the connection is n/a)
  wsConnected: boolean;
  wsLastEventAt: number | null;
  activeGates: number; // how many sessions are currently in GATE_*_RUNNING or ADVERSARIAL_LOOP
}

let current: Heartbeat | null = null;

function persist(): void {
  if (!current) return;
  const dir = dirname(HEARTBEAT_PATH);
  mkdirSync(dir, { recursive: true });
  const tmp = `${HEARTBEAT_PATH}.tmp.${current.pid}`;
  writeFileSync(tmp, JSON.stringify(current), 'utf8');
  renameSync(tmp, HEARTBEAT_PATH); // a rename within one filesystem is atomic
}

// Called once when the daemon starts: set up the in-memory heartbeat and write it out.
export function initHeartbeat(opts: { pid: number; port: number; wsConfigured: boolean; now: number }): Heartbeat {
  current = {
    pid: opts.pid,
    port: opts.port,
    startedAt: opts.now,
    livenessPingAt: opts.now,
    lastCycleAt: null,
    lastCycleOk: null,
    cycleCount: 0,
    wsConfigured: opts.wsConfigured,
    wsConnected: false,
    wsLastEventAt: null,
    activeGates: 0,
  };
  persist();
  return current;
}

// The quick ping: proof the event loop is alive. The caller works out activeGates and passes it in, so this
// module does not have to depend on the store.
export function pingLiveness(now: number, activeGates: number): void {
  if (!current) return;
  current.livenessPingAt = now;
  current.activeGates = activeGates;
  persist();
}

export function markCycle(now: number, ok: boolean): void {
  if (!current) return;
  current.lastCycleAt = now;
  current.lastCycleOk = ok;
  current.cycleCount += 1;
  persist();
}

export function markWs(connected: boolean, now: number | null): void {
  if (!current) return;
  current.wsConnected = connected;
  if (now != null) current.wsLastEventAt = now;
  persist();
}

// Read it from the file (for a separate process such as the watchdog or the CLI, or for one consistent view
// inside the daemon). Missing or corrupt -> null.
export function readHeartbeat(): Heartbeat | null {
  try {
    if (!existsSync(HEARTBEAT_PATH)) return null;
    const j = JSON.parse(readFileSync(HEARTBEAT_PATH, 'utf8')) as Partial<Heartbeat>;
    if (typeof j.pid !== 'number' || typeof j.livenessPingAt !== 'number') return null;
    return j as Heartbeat;
  } catch {
    return null;
  }
}

// For tests: clear the in-memory state so it does not bleed between cases.
export function _resetForTest(): void {
  current = null;
}
