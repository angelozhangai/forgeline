// The resolved keep-alive and health configuration: runtime.yaml's health block layered over the defaults,
// with the port overridable by the FORGE_HEALTH_PORT env var.
// Everything has a fallback default, so an older config or a test with no health block still runs.
import { loadConfig } from '../config.ts';

export interface HealthCfg {
  port: number;
  livenessPingSec: number;
  wedgedAfterSec: number;
  wedgedGraceSec: number;
  probeFailThreshold: number;
  sampleIntervalSec: number;
  historyRetainHours: number;
  logRotateMb: number;
  contractCheckEnabled: boolean;
  contractIntervalHours: number;
}

export const HEALTH_DEFAULTS: HealthCfg = {
  port: 4319,
  livenessPingSec: 10,
  wedgedAfterSec: 90,
  wedgedGraceSec: 300,
  probeFailThreshold: 3,
  sampleIntervalSec: 60,
  historyRetainHours: 72,
  logRotateMb: 20,
  contractCheckEnabled: true,
  contractIntervalHours: 24,
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number | undefined);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function healthConfig(): HealthCfg {
  const cfg = loadConfig();
  const h = cfg.runtime.health ?? {};
  const d = HEALTH_DEFAULTS;
  // Port precedence: the FORGE_HEALTH_PORT env var (the forge wrapper exports it from forge.env) >
  // runtime.yaml > the default.
  const envPort = cfg.env.FORGE_HEALTH_PORT;
  return {
    port: num(envPort, num(h.port, d.port)),
    livenessPingSec: num(h.liveness_ping_sec, d.livenessPingSec),
    wedgedAfterSec: num(h.wedged_after_sec, d.wedgedAfterSec),
    wedgedGraceSec: num(h.wedged_grace_sec, d.wedgedGraceSec),
    probeFailThreshold: num(h.probe_fail_threshold, d.probeFailThreshold),
    sampleIntervalSec: num(h.sample_interval_sec, d.sampleIntervalSec),
    historyRetainHours: num(h.history_retain_hours, d.historyRetainHours),
    logRotateMb: num(h.log_rotate_mb, d.logRotateMb),
    contractCheckEnabled: h.contract_check ?? d.contractCheckEnabled, // a boolean: ?? for the fallback (num() does not apply)
    contractIntervalHours: num(h.contract_interval_hours, d.contractIntervalHours),
  };
}
