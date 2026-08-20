// 路径锚点。两类：
//   ① Forge 服务自身（与项目无关）：SVC_DIR / config / prompts / state / logs / db / 心跳。定义在这里。
//   ② 目标项目相关：ROOT / scripts / docs-delivery / 子仓。源自 src/project.ts 的 defaultProject()。
// Stage 1：项目相关锚点改为委托 defaultProject()（默认项目），行为与旧实现完全一致；
// Stage 2 起，需要按 session 解析的调用点改用 project(s.project_id)，这些全局默认锚点保留给非 session 场景。
import { resolve } from 'node:path';
import { SVC_DIR, defaultProject } from './project.ts';

export { SVC_DIR } from './project.ts';

const _proj = defaultProject();

// ── ② 目标项目相关（默认项目）──
export const ROOT = _proj.root;
export const SCRIPTS_DIR = _proj.scriptsDir;
export const DELIVERY_DIR = _proj.deliveryDir;
export function repoPath(repo: string): string {
  return _proj.repoPath(repo);
}
// ── ① Forge 服务自身（与项目无关）──
export const CONFIG_DIR = resolve(SVC_DIR, 'config'); // 服务配置 yaml（服务仓内）
export const PROMPTS_DIR = resolve(SVC_DIR, 'prompts');
export const STATE_DIR = resolve(SVC_DIR, 'state');
export const LOGS_DIR = resolve(SVC_DIR, 'logs');
// FORGE_DB 覆盖便于测试隔离（:memory: 或临时文件）。
export const DB_PATH = process.env.FORGE_DB || resolve(STATE_DIR, 'service.db');
export const ENV_FILE = resolve(SVC_DIR, 'config', 'forge.env'); // 服务仓内（gitignore）
// 健康/保活：守护写心跳、看门狗读心跳。FORGE_* 覆盖便于测试隔离。
export const HEARTBEAT_PATH = process.env.FORGE_HEARTBEAT || resolve(STATE_DIR, 'heartbeat.json');
export const WATCHDOG_STATE_PATH = process.env.FORGE_WATCHDOG_STATE || resolve(STATE_DIR, 'watchdog.json');
export const LAUNCHD_LOG = resolve(LOGS_DIR, 'launchd.log'); // forge-daemon 落盘的合并日志（看门狗轮转它）
