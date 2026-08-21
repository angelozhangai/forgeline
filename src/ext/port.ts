// 扩展接缝——**ExtensionPack**：Forgeline 与「构建在它之上的下游产品」之间的唯一接口。
//
// 照本仓既有范式：接口（本文件）+ 单一选择点（ext/index.ts `loadExtensions`/`hooks`/`commands`）+
// adapter（下游自己的 `$FORGE_HOME/ext/index.ts`）。与 MessagingPort / SessionStore / JobSource 同构。
//
// **为什么存在**：核心把「PRD 评审 → 技术方案 → 实现 → PR」这条治理流水线做成通用能力；下游（自建部署、
// 商业产品、团队定制）需要在不 fork、不改核心文件的前提下往上叠东西——加自己的 CLI 命令、把状态流转同步
// 到自己的系统、在 tick 前后跑自己的对账。没有这层接缝，这些需求只能靠打补丁改核心文件，两边就会永久分叉
// （GitLab CE/EE 的旧账）。有了这层，下游是核心的**消费者**而非分支。
//
// ── 装载 ──
// 见 ext/index.ts：`FORGE_EXT_DIR` 显式指定 → 否则 `$FORGE_HOME/ext/index.ts` 自动发现 → 都没有则**空包**
// （纯 OSS 行为逐字节不变）。扩展包默认导出一个 ExtensionPack。
//
// ── ⛔ 跨边界只传纯数据与函数 ──
// 扩展包住在**另一个仓库、另一份 node_modules**里（peer checkout）。同一个库（zod / yaml / SDK）两侧各有
// 一份独立实例，`instanceof`、`Symbol` 私有标记、原型链判定**全部失效**，且失效是静默的——不抛错，只是
// 分支走错。所以本接口的每个字段都必须是 JSON 可序列化的纯数据或普通函数：
//   ✅ string / number / boolean / null / 纯对象 / 数组 / 函数
//   ❌ zod schema、class 实例、Error 子类、Date 以外的库对象、带原型语义的任何东西
// 传错的代价不是崩溃而是错判，比崩溃更难查。这条是硬约束，不是建议。
//
// ── 非目标（刻意不做，别加）──
// · **不提供 MessagingPort 覆盖**：messaging 的选择点在模块加载期同步求值（messaging/index.ts），而扩展包是
//   异步 `import()` 装入的，时序上根本接不上。要换 IM provider，正确做法是在 messaging/ 下写一个实现
//   MessagingPort 的 adapter——那本来就一行不用改核心。硬塞一个「有时生效」的覆盖比没有更糟。
// · **不提供状态机改写**：状态与合法转移表（statemachine/）是这套治理流水线的公开契约与安全红线
//   （例：GATE_C_STALLED 只能回到 GATE_C_REVISION_REQUESTED——CI 没绿绝不放行开 PR）。允许下游改它
//   等于允许下游拆掉护栏。要新增闸门请到上游提 issue。
import type { State } from '../statemachine/states.ts';

// 扩展命令的执行上下文：核心已解析好的参数，不含任何核心内部对象（见上「只传纯数据」）。
export interface ExtCommandContext {
  argv: string[]; // 命令名之后的原始参数（未解析，扩展想自己解析时用）
  pos: string[]; // 位置参数
  flags: Record<string, string | boolean>; // `--k v` → string；`--k` → true
}

// 一条扩展 CLI 命令。名字不得与核心命令冲突（冲突时核心永远优先，见 ext/index.ts 的去重）。
export interface ExtCommand {
  name: string;
  summary: string; // `forge help` 里显示的一行说明
  run(ctx: ExtCommandContext): Promise<void> | void;
}

// 一次状态流转。核心在 **SessionStore.transition() 成功之后**发出（失败的转移不发）。
export interface TransitionEvent {
  id: string; // session id
  from: State | null; // 转移前的状态；库里查不到旧态时为 null（并发/首次建单）
  to: State;
  at: number; // epoch ms
}

export interface TickEvent {
  at: number; // epoch ms
  processed?: number; // onTickEnd 才有：本轮实际推进的 session 数
  ok?: boolean; // onTickEnd 才有：本轮 tick 是否正常结束（抛错时为 false）
}

// 生命周期钩子。**全部是通知，不是拦截**——返回值被忽略，抛错被吞掉并记 warn，永远不改变核心行为。
// 这是刻意的：钩子能否决核心动作的那一刻，下游就能把治理护栏关掉，接缝也就失去了意义。
// 每个钩子有独立超时（见 ext/index.ts HOOK_TIMEOUT_MS），卡住的钩子不会拖住 gate 推进。
export interface LifecycleHooks {
  onTransition?(e: TransitionEvent): Promise<void> | void;
  onTickStart?(e: TickEvent): Promise<void> | void;
  onTickEnd?(e: TickEvent): Promise<void> | void;
}

// 下游扩展包的默认导出。
export interface ExtensionPack {
  name: string; // 出现在 `forge doctor` 里，便于确认「到底装上了没有」
  commands?: ExtCommand[];
  hooks?: LifecycleHooks;
}
