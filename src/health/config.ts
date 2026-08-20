// 解析后的保活/健康配置：runtime.yaml › health 块叠默认值，端口可被 env FORGE_HEALTH_PORT 覆盖。
// 全部给了兜底默认，所以旧配置/测试不带 health 块也能跑。
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
  // 端口优先级：env FORGE_HEALTH_PORT（forge 包装器从 forge.env 导出）> runtime.yaml > 默认。
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
    contractCheckEnabled: h.contract_check ?? d.contractCheckEnabled, // boolean：?? 兜底（num() 不适用）
    contractIntervalHours: num(h.contract_interval_hours, d.contractIntervalHours),
  };
}
