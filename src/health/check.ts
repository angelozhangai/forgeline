// 健康评估：把心跳 + DB + 长连接 + 依赖 + 磁盘 + 备份 + 业务停泊聚合成一个总状态。
// 被 /health 端点、`forge health` CLI、采样器三处复用。分级逻辑抽成纯函数便于单测。
import { statfsSync, readdirSync, statSync } from 'node:fs';
import { minutes } from '../util/time.ts';
import { resolve } from 'node:path';
import { db } from '../store/db.ts';
import { store as sessions } from '../store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { commandExists } from '../util/proc.ts';
import { loadConfig } from '../config.ts';
import { STATE_DIR } from '../root.ts';
import { HUMAN_GATES } from '../statemachine/states.ts';
import { readHeartbeat } from './heartbeat.ts';
import type { Heartbeat } from './heartbeat.ts';
import { healthConfig } from './config.ts';
import type { HealthCfg } from './config.ts';
import { contractCheck } from './contract.ts';

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

// ── 纯函数（单测目标）──────────────────────────────────────────────

// 总状态 = 各 check 里最坏的那个（'na' 不计）。
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

// 守护活性分级：心跳缺失=down；liveness 过期=down(卡死)；否则 healthy。
export function classifyDaemon(hb: Heartbeat | null, now: number, cfg: HealthCfg): DaemonClass {
  if (!hb) {
    return {
      running: false,
      wedged: false,
      livenessAgeSec: null,
      check: { name: '守护进程', status: 'down', detail: '心跳缺失：守护未运行或未就绪' },
    };
  }
  const ageSec = Math.max(0, Math.round((now - hb.livenessPingAt) / 1000));
  const wedged = ageSec > cfg.wedgedAfterSec;
  if (wedged) {
    return {
      running: false,
      wedged: true,
      livenessAgeSec: ageSec,
      check: { name: '守护进程', status: 'down', detail: `卡死：liveness ${ageSec}s 未更新（阈值 ${cfg.wedgedAfterSec}s），PID ${hb.pid}` },
    };
  }
  return {
    running: true,
    wedged: false,
    livenessAgeSec: ageSec,
    check: { name: '守护进程', status: 'healthy', detail: `PID ${hb.pid}，liveness ${ageSec}s 前` },
  };
}

// 长连接分级：未配 bot 凭据 = n/a（不算故障，对齐 listen.ts 降级语义）；配了但断 = degraded。
export function classifyWs(hb: Heartbeat | null): Check {
  if (!hb?.wsConfigured) {
    return { name: '飞书长连接', status: 'na', detail: '未配 FEISHU_BOT_APP_*（仅周期 tick）' };
  }
  if (!hb.wsConnected) {
    return { name: '飞书长连接', status: 'degraded', detail: '已配但未连接（卡片按钮/群入口暂不可用，周期 tick 仍跑）' };
  }
  return { name: '飞书长连接', status: 'healthy', detail: '已建立' };
}

// ── 实时采信（IO）──────────────────────────────────────────────

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
  if (missing.length === 0) return { name: '外部依赖 CLI', status: 'healthy', detail: 'claude / codex / gh 均就位' };
  return { name: '外部依赖 CLI', status: 'degraded', detail: `缺失：${missing.join('、')}` };
}

function dbCheck(): { check: Check; ok: boolean } {
  try {
    db().prepare('SELECT 1').get();
    return { check: { name: 'SQLite 状态库', status: 'healthy', detail: '可读写' }, ok: true };
  } catch (e) {
    return { check: { name: 'SQLite 状态库', status: 'down', detail: `打不开：${String(e).slice(0, 120)}` }, ok: false };
  }
}

function backupCheck(now: number, hasSessions: boolean): Check {
  const dir = resolve(STATE_DIR, 'backups');
  try {
    const files = readdirSync(dir).filter((f) => f.startsWith('service-') && f.endsWith('.db'));
    if (files.length === 0) {
      return { name: '自动备份', status: hasSessions ? 'degraded' : 'na', detail: '尚无备份（守护启动后每小时一份）' };
    }
    const newest = Math.max(...files.map((f) => statSync(resolve(dir, f)).mtimeMs));
    const ageMin = Math.round((now - newest) / 60000);
    if (ageMin > 130) return { name: '自动备份', status: 'degraded', detail: `最近备份 ${ageMin} 分钟前（应每小时一份）` };
    return { name: '自动备份', status: 'healthy', detail: `${files.length} 份，最近 ${ageMin} 分钟前` };
  } catch {
    return { name: '自动备份', status: hasSessions ? 'degraded' : 'na', detail: '备份目录不可读' };
  }
}

function diskCheck(): Check {
  try {
    const s = statfsSync(STATE_DIR);
    const freeMb = Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    if (freeMb < 200) return { name: '磁盘空间', status: 'down', detail: `仅剩 ${freeMb} MB` };
    if (freeMb < 1024) return { name: '磁盘空间', status: 'degraded', detail: `仅剩 ${freeMb} MB` };
    return { name: '磁盘空间', status: 'healthy', detail: `剩余 ${(freeMb / 1024).toFixed(1)} GB` };
  } catch (e) {
    return { name: '磁盘空间', status: 'na', detail: `查不到：${String(e).slice(0, 80)}` };
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
  if (board.failed > 0) return { name: '业务停泊', status: 'degraded', detail: `${board.failed} 个 *_FAILED 待处理` };
  if (board.awaiting > 0) return { name: '业务停泊', status: 'healthy', detail: `${board.awaiting} 个等人决策（正常）` };
  return { name: '业务停泊', status: 'healthy', detail: '无停泊' };
}

// 聚合实时健康快照。now 可注入（测试/采样统一时钟）。
export async function evaluateHealth(now: number = Date.now()): Promise<HealthReport> {
  const cfg = healthConfig();
  const hb = readHeartbeat();
  const daemon = classifyDaemon(hb, now, cfg);
  const ws = classifyWs(hb);

  const { check: dbC, ok: dbOk } = dbCheck();
  let byState: Record<string, number> = {};
  if (dbOk) {
    try {
      byState = await sessions.countByState();
    } catch {
      /* 取不到看板不致命 */
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
