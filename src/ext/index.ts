// 扩展接缝——**装载点（唯一接线处）**。
// 核心只 `import { fireTransition, extCommands, ... } from './ext/index.ts'`，永不直接 import 下游代码。
//
// 装载顺序（见 root.ts EXT_DIR）：
//   · `FORGE_EXT_DIR` 显式指定 → 用它
//   · 否则 `$FORGE_HOME/ext`   → 下游部署根下的约定位置（自动发现）
//   · 都没有                   → **空包**，纯 OSS 行为逐字节不变
//
// ── 存在即必须装成功 ──
// 目录里没有 `index.ts` = 「本来就没有扩展」，静默按空包处理，这是纯 OSS 的正常路径。
// 但**文件存在却装不起来（语法错 / 导出形状不对 / import 解析失败）一律抛错，绝不静默回落**。
// 理由是本架构的头号风险就是静默回落：叠加文件名打错时核心不报错、跑的是通用默认版、毫无症状。
// 扩展包比提示词更严重——一个没装上的计费钩子不会有任何迹象，直到对账时发现半个月的数据是空的。
//
// ── 钩子只通知、不拦截 ──
// 每个钩子独立 try/catch + 独立超时（FORGE_EXT_HOOK_TIMEOUT_MS，缺省 5s）。抛错/超时只记 warn，
// 核心该干什么还干什么。照 worker.tick 里漂移闭环的先例：**子系统异常绝不打断 gate 推进**。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT_DIR } from '../root.ts';
import { log } from '../util/log.ts';
import type { ExtensionPack, ExtCommand, LifecycleHooks, TransitionEvent, TickEvent } from './port.ts';

const HOOK_TIMEOUT_MS = Number(process.env.FORGE_EXT_HOOK_TIMEOUT_MS) || 5000;

const EMPTY: ExtensionPack = { name: '(none)' };

let active: ExtensionPack = EMPTY;
let loaded = false;

/** 已装载的扩展包名；没装扩展时是 `(none)`。doctor / 启动日志用它回答「到底装上了没有」。 */
export function activePackName(): string {
  return active.name;
}

/** 已装载扩展提供的 CLI 命令（未装载或空包 → 空数组）。 */
export function extCommands(): ExtCommand[] {
  return active.commands ?? [];
}

/** 已装载扩展提供的生命周期钩子（未装载或空包 → undefined）。 */
export function hooks(): LifecycleHooks | undefined {
  return active.hooks;
}

// 形状校验：扩展包来自另一个仓库，形状错了要在装载时就炸掉，而不是等到某个钩子第一次被调用。
// 只校验「核心会去碰的部分」，不管下游在包里还放了什么别的字段。
function validate(pack: unknown, from: string): ExtensionPack {
  const bad = (why: string): never => {
    throw new Error(`扩展包形状不合法（${from}）：${why}——见 src/ext/port.ts 的 ExtensionPack`);
  };
  if (typeof pack !== 'object' || pack === null) bad('默认导出不是对象');
  const p = pack as Partial<ExtensionPack>;
  if (typeof p.name !== 'string' || p.name.trim() === '') bad('缺少非空的 name');
  if (p.commands !== undefined) {
    if (!Array.isArray(p.commands)) bad('commands 不是数组');
    for (const [i, c] of p.commands.entries()) {
      if (typeof c?.name !== 'string' || c.name.trim() === '') bad(`commands[${i}] 缺少非空 name`);
      if (typeof c?.summary !== 'string') bad(`commands[${i}].summary 不是字符串`);
      if (typeof c?.run !== 'function') bad(`commands[${i}].run 不是函数`);
    }
  }
  if (p.hooks !== undefined && (typeof p.hooks !== 'object' || p.hooks === null)) bad('hooks 不是对象');
  return p as ExtensionPack;
}

/**
 * 装载扩展包。**幂等**：只在第一次真正装载，之后直接返回已装的包。
 * 由 CLI 入口与守护启动各调一次；`dir` 参数只给测试用，生产永远走 EXT_DIR。
 */
export async function loadExtensions(dir: string = EXT_DIR): Promise<ExtensionPack> {
  if (loaded) return active;
  loaded = true;
  const entry = resolve(dir, 'index.ts');
  if (!existsSync(entry)) return active; // 没有扩展——纯 OSS 正常路径，静默
  // 到这里文件是存在的：装不起来就是真出事了，抛给 main().catch 退非零，绝不静默降级成空包。
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  active = validate(mod.default, entry);
  log.info(`扩展包已装载：${active.name}（${entry}）`);
  return active;
}

/** 仅供测试：把装载状态复位，让同一进程内能换目录重装。生产代码不要调。 */
export function resetExtensionsForTest(): void {
  active = EMPTY;
  loaded = false;
}

// 钩子调用的统一包壳：同步抛错、异步 reject、卡住不返回——三种都只变成一条 warn。
async function safely<E>(label: string, fn: ((e: E) => Promise<void> | void) | undefined, e: E): Promise<void> {
  if (!fn) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = (async () => fn(e))(); // 包一层：fn 同步抛错也变成 rejected promise，不会逃出 race
  // 超时判负之后钩子仍在跑，它稍后 reject 时已经没人 await 了 → 会变成 unhandledRejection 打死整个进程。
  // 先挂一个空 catch 兜住。race 拿的仍是原 promise，正常的失败路径照样进下面的 catch。
  running.catch(() => {});
  try {
    await Promise.race([
      running,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`超时 ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log.warn(`扩展钩子 ${label} 异常（已忽略，不影响核心）：${String(err).slice(0, 200)}`);
  } finally {
    if (timer) clearTimeout(timer); // 钩子先完成时清掉定时器，否则进程会被吊住到超时才退
  }
}

/** 状态流转成功后发出。装在 SessionStore 接缝的装饰器上，覆盖全部 transition 调用点。 */
export async function fireTransition(e: TransitionEvent): Promise<void> {
  await safely('onTransition', hooks()?.onTransition, e);
}

export async function fireTickStart(e: TickEvent): Promise<void> {
  await safely('onTickStart', hooks()?.onTickStart, e);
}

export async function fireTickEnd(e: TickEvent): Promise<void> {
  await safely('onTickEnd', hooks()?.onTickEnd, e);
}

export type { ExtensionPack, ExtCommand, ExtCommandContext, LifecycleHooks, TransitionEvent, TickEvent } from './port.ts';
