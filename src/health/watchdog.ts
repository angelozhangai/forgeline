// 看门狗：独立进程（launchd StartInterval=60s 调 `forge watchdog`），探活 → 判定 → 自愈 → 告警 → 去抖。
// 为何独立：卡死/已死的守护无法自我监控，监控者必须在守护之外（launchd 只管退出，卡死交外部探针）。
// 决策抽成纯函数 decideWatchdogAction 便于单测；runWatchdog 负责 IO（探针/launchctl/飞书/日志轮转）。
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

export const LABEL = 'com.forge.daemon'; // 主守护的 launchd 标签（看门狗 kickstart 它）

export type WatchdogClass = 'ok' | 'process-down' | 'wedged' | 'wedged-deferred' | 'http-degraded';

export type WatchdogAction =
  | { kind: 'none' }
  | { kind: 'restart'; force: boolean; reason: string }
  | { kind: 'defer'; reason: string; activeGates: number }
  | { kind: 'alert'; reason: string };

export interface WatchdogInput {
  running: boolean; // launchd 主任务有 PID 在跑
  healthzOk: boolean; // 本次 /healthz 探针
  consecutiveFails: number; // /healthz 连续失败次数（含本次）
  hb: Heartbeat | null;
  now: number;
  cfg: HealthCfg;
  wedgedSince: number | null; // 持久化：首次判卡死的时刻（宽限窗起点）
}

export interface WatchdogDecision {
  action: WatchdogAction;
  klass: WatchdogClass;
  wedgedSince: number | null;
  livenessAgeSec: number | null;
}

// ── 纯决策（单测目标）─────────────────────────────────────────────
export function decideWatchdogAction(i: WatchdogInput): WatchdogDecision {
  const ageSec = i.hb ? Math.max(0, Math.round((i.now - i.hb.livenessPingAt) / 1000)) : null;

  // 1) 进程根本没在跑 → 拉起（KeepAlive 通常也会，但 kickstart 幂等兜底）。
  if (!i.running) {
    return { action: { kind: 'restart', force: false, reason: '守护进程未在运行' }, klass: 'process-down', wedgedSince: null, livenessAgeSec: ageSec };
  }

  const fresh = ageSec != null && ageSec <= i.cfg.wedgedAfterSec;
  // 2) 探针通且 liveness 新鲜 → 正常。
  if (i.healthzOk && fresh) {
    return { action: { kind: 'none' }, klass: 'ok', wedgedSince: null, livenessAgeSec: ageSec };
  }

  // 卡死判定：liveness 过期（event loop 真停了）+ 探针连续失败到阈值（去抖瞬时抖动）。
  // 注：event loop 活着时 ping 定时器与 http 都会动；二者同时哑 ⇒ 真卡死。
  const wedged = ageSec != null && ageSec > i.cfg.wedgedAfterSec && i.consecutiveFails >= i.cfg.probeFailThreshold;

  if (!wedged) {
    // liveness 还新鲜但 /healthz 连续失败 = http 服务挂了而主循环还活着 → 降级告警，不强杀（别打断 gate）。
    if (!i.healthzOk && i.consecutiveFails >= i.cfg.probeFailThreshold && fresh) {
      return { action: { kind: 'alert', reason: '健康端口无响应，但守护主循环仍活（liveness 新鲜）' }, klass: 'http-degraded', wedgedSince: null, livenessAgeSec: ageSec };
    }
    // 单次/未到阈值的抖动 → 观望。
    return { action: { kind: 'none' }, klass: 'ok', wedgedSince: i.wedgedSince, livenessAgeSec: ageSec };
  }

  // 3) 确认卡死。
  const activeGates = i.hb?.activeGates ?? 0;
  if (activeGates > 0) {
    // 有 gate 在跑：先暂缓强杀，过宽限窗仍卡死才动手（避免白烧 claude/codex token）。
    const since = i.wedgedSince ?? i.now;
    if (i.now - since >= i.cfg.wedgedGraceSec * 1000) {
      return { action: { kind: 'restart', force: true, reason: `卡死且宽限窗(${i.cfg.wedgedGraceSec}s)已过，强制重启` }, klass: 'wedged', wedgedSince: null, livenessAgeSec: ageSec };
    }
    return { action: { kind: 'defer', reason: '卡死但有 gate 在跑，暂缓强杀', activeGates }, klass: 'wedged-deferred', wedgedSince: since, livenessAgeSec: ageSec };
  }
  // 无 gate 在跑 → 立即强制重启。
  return { action: { kind: 'restart', force: true, reason: '卡死且无 gate 在跑，立即强制重启' }, klass: 'wedged', wedgedSince: null, livenessAgeSec: ageSec };
}

// ── IO（runWatchdog 用，不单测）────────────────────────────────────

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
    /* 损坏 → 重置 */
  }
  return { consecutiveFails: 0, wedgedSince: null, klass: 'ok' };
}

function writeState(s: WatchdogState): void {
  try {
    mkdirSync(dirname(WATCHDOG_STATE_PATH), { recursive: true });
    writeFileSync(WATCHDOG_STATE_PATH, JSON.stringify(s), 'utf8');
  } catch (e) {
    log.warn(`看门狗状态写盘失败：${String(e).slice(0, 120)}`);
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
    return { ok: r.status === 0, detail: r.status === 0 ? `launchctl ${args.join(' ')}` : `kickstart 失败(${r.status})：${(r.stderr || '').slice(0, 160)}` };
  } catch (e) {
    return { ok: false, detail: `kickstart 异常：${String(e).slice(0, 160)}` };
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
    log.info(`launchd.log 达 ${mb.toFixed(0)}MB → 已轮转`);
  } catch (e) {
    log.warn(`日志轮转失败：${String(e).slice(0, 120)}`);
  }
}

// 一次性运行：探活 + 自愈 + 去抖告警。供 launchd StartInterval 每 60s 调一次。
export async function runWatchdog(now: number = Date.now()): Promise<WatchdogDecision> {
  const cfg = healthConfig();
  const prev = readState();
  const healthzOk = await probeHealthz(cfg.port);
  const consecutiveFails = healthzOk ? 0 : prev.consecutiveFails + 1;
  const hb = readHeartbeat();
  const running = mainJobRunning();

  const decision = decideWatchdogAction({ running, healthzOk, consecutiveFails, hb, now, cfg, wedgedSince: prev.wedgedSince });
  const a = decision.action;

  // 执行动作（每次都执行，kickstart 幂等）。
  if (a.kind === 'restart') {
    const k = kickstart(a.force);
    log.warn(`看门狗：${a.reason} → ${k.detail}`);
  } else if (a.kind === 'defer') {
    log.warn(`看门狗：${a.reason}（活跃 gate ${a.activeGates}）`);
  }

  // 去抖告警：仅在状态类翻转时发。
  if (decision.klass !== prev.klass) {
    if (decision.klass === 'ok') {
      if (prev.klass !== 'ok') await sendHealthAlert('recovered', '服务已恢复', ['守护进程已恢复响应（/healthz 通、liveness 新鲜）。'], now);
    } else if (a.kind === 'restart') {
      const sev = 'down' as const;
      const what = decision.klass === 'process-down' ? '守护进程已退出' : '守护进程卡死';
      await sendHealthAlert(sev, `${what} · 已自动重启`, [
        `**原因**：${a.reason}`,
        hb ? `PID ${hb.pid} · liveness ${decision.livenessAgeSec ?? '—'}s 未更新 · 活跃 gate ${hb.activeGates}` : '心跳缺失',
        '已执行 `launchctl kickstart`，重启后 orphan 会被自动回收。',
      ], now);
    } else if (a.kind === 'defer') {
      await sendHealthAlert('down', '守护卡死 · 暂缓强杀', [
        `检测到卡死，但有 **${a.activeGates}** 个 gate 在跑——先告警，过宽限窗(${cfg.wedgedGraceSec}s)仍卡死才强制重启，避免白烧 token。`,
        hb ? `liveness ${decision.livenessAgeSec ?? '—'}s 未更新。` : '',
      ], now);
    } else if (a.kind === 'alert') {
      await sendHealthAlert('degraded', '健康端口无响应', [a.reason, '主循环仍在跑（liveness 新鲜），未强杀。建议查 logs/launchd.log。'], now);
    }
  }

  rotateLogIfBig(cfg.logRotateMb);
  writeState({ consecutiveFails, wedgedSince: decision.wedgedSince, klass: decision.klass });
  return decision;
}
