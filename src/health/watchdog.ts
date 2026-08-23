// The watchdog: a separate process (launchd's StartInterval=60s calls `forge watchdog`) that probes,
// classifies, self-heals, alerts, and debounces.
// Why it is separate: a daemon that is wedged or dead cannot monitor itself, so the monitor has to live
// outside it (launchd only handles the process exiting; a wedge is left to an external probe).
// The decision is pulled out into the pure function decideWatchdogAction so it can be unit-tested;
// runWatchdog does the IO (the probe, launchctl, the alert, log rotation).
import { spawnSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { statSync, renameSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../util/log.ts';
import { WATCHDOG_STATE_PATH, LAUNCHD_LOG } from '../root.ts';
import { healthConfig } from './config.ts';
import type { HealthCfg } from './config.ts';
import { readHeartbeat } from './heartbeat.ts';
import type { Heartbeat } from './heartbeat.ts';
import { sendHealthAlert } from './alert.ts';

export const LABEL = 'com.forge.daemon'; // the main daemon's launchd label (the watchdog kickstarts it)

export type WatchdogClass = 'ok' | 'process-down' | 'wedged' | 'wedged-deferred' | 'http-degraded';

export type WatchdogAction =
  | { kind: 'none' }
  | { kind: 'restart'; force: boolean; reason: string }
  | { kind: 'defer'; reason: string; activeGates: number }
  | { kind: 'alert'; reason: string };

export interface WatchdogInput {
  running: boolean; // launchd's main job has a PID running
  healthzOk: boolean; // this round's /healthz probe
  consecutiveFails: number; // how many /healthz probes have failed in a row (including this one)
  hb: Heartbeat | null;
  now: number;
  cfg: HealthCfg;
  wedgedSince: number | null; // persisted: when it was first judged wedged (the start of the grace window)
}

export interface WatchdogDecision {
  action: WatchdogAction;
  klass: WatchdogClass;
  wedgedSince: number | null;
  livenessAgeSec: number | null;
}

// ── The pure decision (what the unit tests target) ─────────────────────────────
export function decideWatchdogAction(i: WatchdogInput): WatchdogDecision {
  const ageSec = i.hb ? Math.max(0, Math.round((i.now - i.hb.livenessPingAt) / 1000)) : null;

  // 1) The process is not running at all -> start it (KeepAlive usually would too, but kickstart is
  // idempotent and covers the gap).
  if (!i.running) {
    return { action: { kind: 'restart', force: false, reason: 'the daemon is not running' }, klass: 'process-down', wedgedSince: null, livenessAgeSec: ageSec };
  }

  const fresh = ageSec != null && ageSec <= i.cfg.wedgedAfterSec;
  // 2) The probe answers and liveness is fresh -> everything is fine.
  if (i.healthzOk && fresh) {
    return { action: { kind: 'none' }, klass: 'ok', wedgedSince: null, livenessAgeSec: ageSec };
  }

  // Judging it wedged: liveness has gone stale (the event loop really has stopped) **and** the probe has
  // failed enough times in a row to clear the threshold (which debounces a momentary blip).
  // Note: while the event loop is alive both the ping timer and http keep moving; both going silent at once
  // means it really is wedged.
  const wedged = ageSec != null && ageSec > i.cfg.wedgedAfterSec && i.consecutiveFails >= i.cfg.probeFailThreshold;

  if (!wedged) {
    // Liveness still fresh but /healthz failing repeatedly means the http service died while the main loop is
    // still alive -> a degraded alert, not a kill (do not interrupt a running gate).
    if (!i.healthzOk && i.consecutiveFails >= i.cfg.probeFailThreshold && fresh) {
      return { action: { kind: 'alert', reason: 'the health port is not responding, but the daemon\'s main loop is still alive (liveness is fresh)' }, klass: 'http-degraded', wedgedSince: null, livenessAgeSec: ageSec };
    }
    // A single blip, or one that has not reached the threshold -> wait and see.
    return { action: { kind: 'none' }, klass: 'ok', wedgedSince: i.wedgedSince, livenessAgeSec: ageSec };
  }

  // 3) Confirmed wedged.
  const activeGates = i.hb?.activeGates ?? 0;
  if (activeGates > 0) {
    // A gate is running: hold off on the kill and only act if it is still wedged after the grace window
    // (so claude and codex tokens are not burned for nothing).
    const since = i.wedgedSince ?? i.now;
    if (i.now - since >= i.cfg.wedgedGraceSec * 1000) {
      return { action: { kind: 'restart', force: true, reason: `wedged, and the grace window (${i.cfg.wedgedGraceSec}s) has passed: forcing a restart` }, klass: 'wedged', wedgedSince: null, livenessAgeSec: ageSec };
    }
    return { action: { kind: 'defer', reason: 'wedged, but a gate is running, so the kill is held off', activeGates }, klass: 'wedged-deferred', wedgedSince: since, livenessAgeSec: ageSec };
  }
  // No gate is running -> force a restart immediately.
  return { action: { kind: 'restart', force: true, reason: 'wedged with no gate running: forcing a restart immediately' }, klass: 'wedged', wedgedSince: null, livenessAgeSec: ageSec };
}

// ── The IO (used by runWatchdog; not unit-tested) ────────────────────────────────

interface WatchdogState {
  consecutiveFails: number;
  wedgedSince: number | null;
  klass: WatchdogClass;
}

function readState(): WatchdogState {
  try {
    if (existsSync(WATCHDOG_STATE_PATH)) {
      const j = JSON.parse(readFileSync(WATCHDOG_STATE_PATH, 'utf8')) as Partial<WatchdogState>;
      return {
        consecutiveFails: j.consecutiveFails ?? 0,
        wedgedSince: j.wedgedSince ?? null,
        klass: (j.klass as WatchdogClass) ?? 'ok',
      };
    }
  } catch {
    /* corrupt -> reset */
  }
  return { consecutiveFails: 0, wedgedSince: null, klass: 'ok' };
}

function writeState(s: WatchdogState): void {
  try {
    mkdirSync(dirname(WATCHDOG_STATE_PATH), { recursive: true });
    writeFileSync(WATCHDOG_STATE_PATH, JSON.stringify(s), 'utf8');
  } catch (e) {
    log.warn(`writing the watchdog state to disk failed: ${String(e).slice(0, 120)}`);
  }
}

function probeHealthz(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function mainJobRunning(): boolean {
  try {
    const r = spawnSync('launchctl', ['list', LABEL], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return false;
    const m = /"PID"\s*=\s*(\d+)/.exec(r.stdout);
    return !!m && Number(m[1]) > 0;
  } catch {
    return false;
  }
}

function kickstart(force: boolean): { ok: boolean; detail: string } {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const domain = `gui/${uid}/${LABEL}`;
  const args = force ? ['kickstart', '-k', domain] : ['kickstart', domain];
  try {
    const r = spawnSync('launchctl', args, { encoding: 'utf8' });
    return { ok: r.status === 0, detail: r.status === 0 ? `launchctl ${args.join(' ')}` : `kickstart failed (${r.status}): ${(r.stderr || '').slice(0, 160)}` };
  } catch (e) {
    return { ok: false, detail: `kickstart threw: ${String(e).slice(0, 160)}` };
  }
}

function rotateLogIfBig(maxMb: number): void {
  try {
    if (!existsSync(LAUNCHD_LOG)) return;
    const mb = statSync(LAUNCHD_LOG).size / (1024 * 1024);
    if (mb < maxMb) return;
    for (let i = 3; i >= 1; i--) {
      const src = i === 1 ? LAUNCHD_LOG : `${LAUNCHD_LOG}.${i - 1}`;
      if (existsSync(src)) renameSync(src, `${LAUNCHD_LOG}.${i}`);
    }
    log.info(`launchd.log reached ${mb.toFixed(0)}MB and has been rotated`);
  } catch (e) {
    log.warn(`rotating the log failed: ${String(e).slice(0, 120)}`);
  }
}

// One run: probe, self-heal, and alert with debouncing. launchd's StartInterval calls it every 60 seconds.
export async function runWatchdog(now: number = Date.now()): Promise<WatchdogDecision> {
  const cfg = healthConfig();
  const prev = readState();
  const healthzOk = await probeHealthz(cfg.port);
  const consecutiveFails = healthzOk ? 0 : prev.consecutiveFails + 1;
  const hb = readHeartbeat();
  const running = mainJobRunning();

  const decision = decideWatchdogAction({ running, healthzOk, consecutiveFails, hb, now, cfg, wedgedSince: prev.wedgedSince });
  const a = decision.action;

  // Carry out the action (every round; kickstart is idempotent).
  if (a.kind === 'restart') {
    const k = kickstart(a.force);
    log.warn(`watchdog: ${a.reason} -> ${k.detail}`);
  } else if (a.kind === 'defer') {
    log.warn(`watchdog: ${a.reason} (${a.activeGates} active gates)`);
  }

  // Debounced alerting: it only sends when the classification flips.
  if (decision.klass !== prev.klass) {
    if (decision.klass === 'ok') {
      if (prev.klass !== 'ok') await sendHealthAlert('recovered', 'the service has recovered', ['the daemon is responding again (/healthz answers and liveness is fresh).'], now);
    } else if (a.kind === 'restart') {
      const sev = 'down' as const;
      const what = decision.klass === 'process-down' ? 'the daemon has exited' : 'the daemon is wedged';
      await sendHealthAlert(sev, `${what} · restarted automatically`, [
        `**Why**: ${a.reason}`,
        hb ? `PID ${hb.pid} · liveness has not updated for ${decision.livenessAgeSec ?? '—'}s · ${hb.activeGates} active gates` : 'no heartbeat',
        '`launchctl kickstart` has been run; any orphans are reclaimed automatically after the restart.',
      ], now);
    } else if (a.kind === 'defer') {
      await sendHealthAlert('down', 'the daemon is wedged · holding off on the kill', [
        `It looks wedged, but **${a.activeGates}** gates are running — so this is an alert first, and it only forces a restart if it is still wedged after the grace window (${cfg.wedgedGraceSec}s), rather than burning tokens for nothing.`,
        hb ? `liveness has not updated for ${decision.livenessAgeSec ?? '—'}s.` : '',
      ], now);
    } else if (a.kind === 'alert') {
      await sendHealthAlert('degraded', 'the health port is not responding', [a.reason, 'the main loop is still running (liveness is fresh), so nothing was killed. Check logs/launchd.log.'], now);
    }
  }

  rotateLogIfBig(cfg.logRotateMb);
  writeState({ consecutiveFails, wedgedSince: decision.wedgedSince, klass: decision.klass });
  return decision;
}
