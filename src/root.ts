// 路径锚点。两类：
//   ① Forge 服务自身（与项目无关）：SVC_DIR / config / prompts / state / logs / db / 心跳。定义在这里。
//   ② 目标项目相关：ROOT / scripts / docs-delivery / 子仓。源自 src/project.ts 的 defaultProject()。
// Stage 1：项目相关锚点改为委托 defaultProject()（默认项目），行为与旧实现完全一致；
// Stage 2 起，需要按 session 解析的调用点改用 project(s.project_id)，这些全局默认锚点保留给非 session 场景。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SVC_DIR, defaultProject } from './project.ts';

export { SVC_DIR } from './project.ts';

const _proj = defaultProject();

// 环境变量当目录用：空串/纯空格视同未设置。少了这层，`FORGE_HOME=` 这种
// "导出了但没值" 的写法会把所有路径锚到进程 cwd，症状极难追。
function envDir(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? resolve(v) : undefined;
}

// 部署接缝：把「服务自身的可变状态」整体搬出检出目录。
// FORGE_HOME 一次性搬走 config/state/logs 三者；单项 FORGE_CONFIG_DIR /
// FORGE_STATE_DIR / FORGE_LOGS_DIR 优先级更高。三者都不设时，全部落回检出
// 目录内 —— 与从前逐字节一致，所以这是纯增量的向后兼容改动。
//
// 为什么需要：私有部署要用自己的 assignment.yaml / routing.yaml，而这两个文件
// 在本仓是**被追踪**的。就地改会让检出变脏、git pull 冲突；指到仓外就干净了，
// 核心检出可以只读、可以随时删掉重新 clone。
const HOME = envDir('FORGE_HOME');
const svcDir = (env: string, name: string): string =>
  envDir(env) ?? (HOME ? resolve(HOME, name) : resolve(SVC_DIR, name));

// ── ② 目标项目相关（默认项目）──
export const ROOT = _proj.root;
export const SCRIPTS_DIR = _proj.scriptsDir;
export const DELIVERY_DIR = _proj.deliveryDir;
export function repoPath(repo: string): string {
  return _proj.repoPath(repo);
}
// ── ① Forge 服务自身（与项目无关）──
/** 仓内自带的默认配置目录。叠加目录缺某个文件时逐文件回落到这里。 */
export const CONFIG_REPO_DIR = resolve(SVC_DIR, 'config');
/** 生效的配置目录。未设叠加时 === CONFIG_REPO_DIR。 */
export const CONFIG_DIR = svcDir('FORGE_CONFIG_DIR', 'config');
export const PROMPTS_DIR = resolve(SVC_DIR, 'prompts');
export const STATE_DIR = svcDir('FORGE_STATE_DIR', 'state');
export const LOGS_DIR = svcDir('FORGE_LOGS_DIR', 'logs');
/**
 * 扩展包目录（见 src/ext/）。下游产品在这里放 `index.ts` 默认导出一个 ExtensionPack，
 * 就能加自己的 CLI 命令与生命周期钩子，**不必 fork、不必改核心任何文件**。
 *
 * 与 config/state/logs 同一套接缝规则：`FORGE_EXT_DIR` 显式指定 > `$FORGE_HOME/ext` >
 * 检出目录内 `ext/`（本仓不自带，所以缺省就是「没有扩展」= 纯 OSS 行为逐字节不变）。
 * 复用 FORGE_HOME 而不发明新约定：下游的部署根本来就已经用它搬走 config/state/logs。
 */
export const EXT_DIR = svcDir('FORGE_EXT_DIR', 'ext');

/**
 * 配置文件的实际路径：叠加目录里有就用叠加的，没有就回落到仓内默认。
 * 解析规则与 loadPrompt 一致（见 src/util/render.ts）—— 私有部署只覆盖它在乎的
 * 那几个文件，其余跟着仓库一起升级，不必为了改一个 yaml 而 fork 整个 config/。
 *
 * ⚠️ 回落是静默的：叠加目录里把文件名打错，跑起来用的是仓内默认版而不会报错。
 * 私有叠加仓应当自带一个「叠加文件名 vs 仓内 config/ + prompts/」的对账检查。
 */
export function configFile(name: string): string {
  if (CONFIG_DIR !== CONFIG_REPO_DIR) {
    const p = resolve(CONFIG_DIR, name);
    if (existsSync(p)) return p;
  }
  return resolve(CONFIG_REPO_DIR, name);
}

// FORGE_DB 覆盖便于测试隔离（:memory: 或临时文件）。
export const DB_PATH = process.env.FORGE_DB || resolve(STATE_DIR, 'service.db');
export const ENV_FILE = configFile('forge.env'); // 两侧都 gitignore
// 健康/保活：守护写心跳、看门狗读心跳。FORGE_* 覆盖便于测试隔离。
export const HEARTBEAT_PATH = process.env.FORGE_HEARTBEAT || resolve(STATE_DIR, 'heartbeat.json');
export const WATCHDOG_STATE_PATH = process.env.FORGE_WATCHDOG_STATE || resolve(STATE_DIR, 'watchdog.json');
export const LAUNCHD_LOG = resolve(LOGS_DIR, 'launchd.log'); // forge-daemon 落盘的合并日志（看门狗轮转它）
