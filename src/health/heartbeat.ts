// 心跳文件：守护(listen)进程周期性写，看门狗/状态页读。原子写(临时文件+rename)避免读到半截。
//
// 为何要独立 liveness：runCycle() 会 await tick()，一个 10 分钟的 gate 会让「上次周期完成」自然变旧，
// 不能用它判活。而 claude/codex 是 async spawn（不堵 event loop），所以一个每 10s 的快 ping 能稳定
// 更新——liveness 过期 ⇒ event loop 真卡死/进程已死，这才是看门狗的判活依据。
import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { HEARTBEAT_PATH } from '../root.ts';

export interface Heartbeat {
  pid: number;
  port: number;
  startedAt: number; // 守护启动时刻(毫秒)
  livenessPingAt: number; // 最近一次 liveness ping（真·判活）
  lastCycleAt: number | null; // 最近一次 runCycle 完成（业务进度；长 gate 期间会偏旧，仅展示用）
  lastCycleOk: boolean | null;
  cycleCount: number;
  wsConfigured: boolean; // 是否配了 FEISHU_BOT_APP_*（未配=仅周期 tick，长连接 n/a）
  wsConnected: boolean;
  wsLastEventAt: number | null;
  activeGates: number; // 当前 GATE_*_RUNNING / ADVERSARIAL_LOOP 的 session 数
}

let current: Heartbeat | null = null;

function persist(): void {
  if (!current) return;
  const dir = dirname(HEARTBEAT_PATH);
  mkdirSync(dir, { recursive: true });
  const tmp = `${HEARTBEAT_PATH}.tmp.${current.pid}`;
  writeFileSync(tmp, JSON.stringify(current), 'utf8');
  renameSync(tmp, HEARTBEAT_PATH); // rename 在同盘是原子的
}

// 守护启动时调一次：建立内存心跳并落盘。
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

// 快 ping：event loop 活着的证明。activeGates 由调用方算好传入（避免本模块依赖 store）。
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

// 从文件读（看门狗/CLI 等独立进程，或守护内统一口径）。缺失/损坏 → null。
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

// 测试用：清掉内存态，避免跨用例串味。
export function _resetForTest(): void {
  current = null;
}
