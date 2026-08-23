import { readFileSync, existsSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { configFile, loadEnvFile as readEnvFile } from './root.ts';
import { DEFAULT_PROJECT_ID } from './project.ts';
import { AUTONOMY_MAX_LEVEL } from './statemachine/autonomyPolicy.ts';

// 机械动作委托脚本：forge 只编排，调目标项目现有脚本，不在本仓重造、不写死 pnpm/nx/prisma。
// 项目级（ProjectEntry.scripts）覆盖运行期兜底（RuntimeConfig.scripts）。路径相对目标项目根解析。
export interface ProjectScripts {
  worktree_add?: string; // 建隔离工作树（your-monorepo 必走 tools/scripts/wt.sh，处理 node_modules/.envrc/密钥）
  worktree_remove?: string; // 清理工作树（缺省回退 git worktree remove）
  ci?: string; // 本地 CI（绝不裸 nx run-many；your-monorepo 走 pnpm ci:local）
  diff?: string; // 出 baseSha..HEAD diff（供 PR 描述 + codex 审）
  create_pr?: string; // 建 PR（绝不自动 merge）
  checks?: string; // 预合并体检（Prisma 漂移 / docs lint 等）
}

export interface RuntimeConfig {
  poll_interval_sec: number;
  max_parallel: number;
  parse_repair_retries?: number; // LLM 坏 JSON 时 resume 回喂重出的最多次数（缺省 2，见 llm/structured.ts）
  max_fix_failures?: number; // 连续 fix(claude) 调用失败的断路器阈值，到顶 → gate STALLED 交人（缺省 5，见 review/reviewFixLoop.ts）
  branches: { prod: string; dev: string };
  default_branch: 'prod' | 'dev';
  repos: string[];
  tech_design_publish?: {
    enabled: boolean; // GO 立项时自动发布技术方案 doc 到主仓（提交+PR+merge）
    base: string; // PR 目标分支（main/dev）
  };
  delivery_doc_commit?: {
    enabled: boolean; // GO 后把 docs/delivery/<slug>/ 自动提交到目标项目「当前分支」（仅 doc 路径、不切分支、**绝不 push**）；默认关，人工提交
  };
  doc_sources?: {
    // 把「@机器人 + 一段话」本身当成需求正文（无需任何文档服务，见 src/docs/plaintext.ts）。
    // **默认关**：开了之后这类消息会真的建需求、跑闸A = 自动花钱；今天它们只会被忽略。
    plaintext?: { enabled: boolean };
  };
  adversarial: {
    reviewer: 'codex' | 'claude';
    on_missing: 'claude' | 'skip' | 'error';
    max_rounds: number;
  };
  gate_a?: {
    max_pm_rounds: number; // PM 多轮评审上限，到顶停泊交 M 裁决
  };
  gate_c?: {
    max_rounds: number; // 实现⇄CI 修复硬上限：到顶仍不绿 → GATE_C_STALLED 交 M 裁决
    max_rounds_per_tick?: number; // 每 tick 最多跑几轮（CI 重，缺省 1，防霸占 tick 锁）
    ci_timeout_sec?: number; // 单次本地 CI 超时
    claude_timeout_sec?: number; // claude 实现单调用超时（缺省回退全局 claude_timeout_sec；下游整写代码远重于上游审文档）
  };
  gate_d?: {
    max_rounds: number; // codex审diff⇄claude改 硬上限：到顶 → GATE_D_STALLED 交 M 裁决
    max_rounds_per_tick?: number;
    ci_timeout_sec?: number;
    claude_timeout_sec?: number; // claude 改方/补强单调用超时（缺省回退全局；PR 级修复/补强同样重）
    harden?: {
      forbid_mirror_tests: boolean; // 杜绝镜像测试
      require_failure_path: boolean; // 必覆盖失败路径
      require_auth_path: boolean; // 必覆盖权限路径
    };
  };
  scripts?: ProjectScripts; // 机械动作委托脚本（项目级 ProjectEntry.scripts 覆盖此兜底）
  autonomy?: {
    level: number; // 自治等级 0..AUTONOMY_MAX_LEVEL：0=处处人工（默认）；1 自动出方案 / 2 自动GO / 3 自动实现 / 4 自动开PR（merge 永不自动，见 autonomyPolicy）。
    actor?: string; // 自治自动动作的署名短码（须在相应权限名单里，否则动作 !ok 留人工）；缺省回退 routing.lead。审计事件标 auto。
  };
  web_actor?: string; // Web 操作面板写动作的署名短码（须在相应权限名单里）；缺省回退 routing.lead。面板绑 127.0.0.1，动作走同一权限闸。
  gates?: {
    // 闸A/闸B 评审前，本地 checkout 未锚定 origin/<branch>（HEAD 偏移/脏树）时的处置：
    // 'warn'（默认）= 把偏移披露进 prompt 让模型知情后继续；'block' = 停泊（绝不对非锚定代码下结论，严格场景用）。
    checkout_anchor?: 'warn' | 'block';
  };
  drift?: {
    enabled: boolean; // 立项后漂移闭环：DONE 需求 issue 全关闭后，audit「实现 vs 闸B 验收契约」，漂移私聊告警 M（默认关）
    poll_every_hours?: number; // 同一需求两次漂移轮询的最小间隔（缺省 24h，控 gh/claude 频率）
    max_polls?: number; // 同一需求漂移审计最多尝试几次（issue 久未合 / 审计反复失败的退避上限，缺省 8）→ 耗尽放弃并告警
  };
  retry?: {
    max_auto_retries: number; // 瞬时错(超时/限流/网络/fetch)自动退避重试上限，耗尽 → 死信（缺省 3）
    max_reclaims: number; // 孤儿态(进程中途死)自动复位上限，耗尽 → 死信防崩溃-重启无限环（缺省 3）
  };
  claude_bin: string;
  codex_bin: string;
  claude_allowed_tools: string;
  claude_timeout_sec: number;
  health?: HealthRuntime; // 保活/健康（缺省时 src/health/config.ts 兜默认值）
}

// 保活/健康可调项。全部可选——src/health/config.ts 的 healthConfig() 用默认值兜底。
export interface HealthRuntime {
  port?: number; // 本地健康服务端口（仅 127.0.0.1）。可被 env FORGE_HEALTH_PORT 覆盖
  liveness_ping_sec?: number; // 守护内 liveness ping 间隔（证明 event loop 活着）
  wedged_after_sec?: number; // liveness 超过此久没更新 → 判卡死
  wedged_grace_sec?: number; // 有 gate 在跑时，卡死后再宽限此久才强杀（避免白烧 token）
  probe_fail_threshold?: number; // 看门狗 /healthz 连续失败多少次才判故障
  sample_interval_sec?: number; // 健康采样落库间隔（滚动历史）
  history_retain_hours?: number; // 采样保留时长
  log_rotate_mb?: number; // launchd.log 超过此大小则轮转
  contract_check?: boolean; // 是否每日主动探测外部 CLI/API 输出契约（缺省 true）
  contract_interval_hours?: number; // 契约探测间隔小时（缺省 24）
}

export interface RoutingConfig {
  min_confidence: number;
  sensitive_areas: string[];
  reviewers: Record<string, string>; // 短码 → login
  lead: string; // 短码
}

export interface PermissionsConfig {
  gate_b_allowed: string[];
  go_approvers: string[];
  gate_c_allowed?: string[]; // 谁能触发闸C（实现）；缺省回退 go_approvers
  pr_create_approvers?: string[]; // 谁能触发开 PR + 闸D；缺省回退 go_approvers
  merge_ack_allowed?: string[]; // 谁能确认已人工合并（→ SHIPPED）；缺省回退 go_approvers
  operators?: Record<string, string>; // IM 用户 id（飞书 open_id / Slack user id）→ 短码（多人用：卡片回调按真实点击人裁决；缺省=单人，一律当 M）
}

export interface AssignmentConfig {
  pool: string[]; // 可指派 DRI 短码池
  wip_limit: { default: number; [code: string]: number }; // 每人在研需求并发上限（default 兜底）
  in_progress_statuses: number[]; // 「当前在研」的 rollup 状态序（其余不计入当前负载）
}

export interface Env {
  FORGE_PROJECT_ROOT?: string; // 目标项目仓根（缺省自动找兄弟 ../example-project）
  FEISHU_REVIEW_WEBHOOK?: string;
  FEISHU_REVIEW_WEBHOOK_SECRET?: string;
  FEISHU_REVIEW_CHAT_ID?: string;
  FEISHU_WATCH_CHATS?: string; // 逗号分隔的群 chat_id：开机/重连补拉这些群的离线消息（缺省回退 FEISHU_REVIEW_CHAT_ID）
  // 飞书 bot（私聊推送 + 后续按钮回调）。复用 lark-mcp 应用须先在飞书后台授 im:message 权限。
  FEISHU_BOT_APP_ID?: string;
  FEISHU_BOT_APP_SECRET?: string;
  FEISHU_BOT_OPEN_ID?: string; // bot 自身 open_id：群消息入口闸判「是否 @ 了本机器人」用（缺省自动问 bot/v3/info）
  FEISHU_DM_OPEN_ID?: string; // 推送目标：你本人的 open_id（私聊）
  FEISHU_DM_UNION_ID?: string; // 或 union_id（同企业跨应用一致，feishu-doc.js 用户身份可一次性取得，绕开 contact 审批）
  FEISHU_DM_CHAT_ID?: string; // 或 p2p chat_id
  FEISHU_DM_EMAIL?: string; // 或飞书工作邮箱（receive_id_type=email）
  // 传输层 provider 选择（见 src/messaging/index.ts）。'feishu'（缺省）| 'slack'；认不出的值硬抛，绝不静默回退。
  FORGE_MESSAGING_PROVIDER?: string;
  // Slack（provider=slack 时必配）
  SLACK_BOT_TOKEN?: string; // xoxb-…：Web API（发卡/改卡/读历史）
  SLACK_APP_TOKEN?: string; // xapp-…：Socket Mode 建连（apps.connections.open 只认它）
  SLACK_BOT_USER_ID?: string; // bot 自身 user id：群消息入口闸判「是否 @ 了本机器人」；未配则保守忽略群消息
  SLACK_DM_USER_ID?: string; // 私聊推送目标（你本人的 user id，可直接当 channel 用）
  SLACK_WATCH_CHANNELS?: string; // 逗号分隔的 channel id：开机/重连补拉这些频道的离线消息
  SLACK_WEBHOOK_URL?: string; // 群 webhook 兜底（bot 私聊未送达时的降级）
  SLACK_API_BASE?: string; // Web API 根地址覆写（缺省 https://slack.com/api）：企业代理 / 本地验收回路用
  NOTIFY_DESKTOP?: string; // '0' 关闭 macOS 本地桌面通知兜底（默认开）
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  [k: string]: string | undefined;
}

// 多项目注册表（config/projects.yaml，可选）。缺省=单默认项目，配置取自 runtime.yaml。
// 各字段省略则回退默认项目/runtime.yaml（见 src/projects.ts project()）。
export interface ProjectEntry {
  root?: string; // 项目仓根（非默认项目必填；默认项目缺省自动找兄弟）
  owner?: string; // GitHub org/owner（建 issue/查标签/漂移对账）；缺省 DEFAULT_OWNER（your-org）。your-monorepo 很可能是不同 org，必显式声明
  actions?: 'demo' | 'native'; // 机械动作 adapter：demo=主仓脚本（默认）；native=直调 gh（开源/无脚本项目）
  repos?: string[]; // **本地** repo key/path（`<root>/<repo>` 读代码真源；monorepo 用 '.'）。≠ GitHub slug（见 repoSlugs）
  repoSlugs?: Record<string, string>; // 本地 repo key → GitHub repo slug（gh -R owner/<slug>）。缺省=key 本身（demo 仓名即 slug）；monorepo 必配 { '.': 'your-monorepo' }
  branches?: { prod: string; dev: string };
  default_branch?: 'prod' | 'dev';
  tech_design_publish?: { enabled: boolean; base: string };
  repoMap?: Record<string, string>; // 仓字母→仓名
  umbrella?: string; // 伞仓
  chats?: string[]; // 哪些飞书群的 PRD 归此项目（群→项目路由）
  scripts?: ProjectScripts; // 下游机械动作委托脚本（覆盖 runtime.yaml scripts 兜底）
  autonomy?: { level: number; actor?: string }; // 按项目覆盖自治等级/署名（缺省回退 runtime.autonomy）——可在低风险项目先开自治
  // 策略「部分覆盖」：按项目分化审批人/路由/指派池，逐字段回退全局（缺省=全局，单项目零行为变更）。见 projects.ts configForProject。
  permissions?: Partial<PermissionsConfig>;
  routing?: Partial<RoutingConfig>;
  assignment?: Partial<AssignmentConfig>;
}
export interface ProjectsConfig {
  default_project: string;
  projects: Record<string, ProjectEntry>;
}

export interface Config {
  runtime: RuntimeConfig;
  routing: RoutingConfig;
  permissions: PermissionsConfig;
  assignment: AssignmentConfig;
  projects: ProjectsConfig | null; // 无 projects.yaml 时为 null（单默认项目）
  env: Env;
}

// ── 运行期配置校验（zod）─────────────────────────────────
// 三份 yaml 启动即过 schema：字段拼错/类型错/漏填 → 抛人能看懂的错并指出位置，
// 而非以后在某调用点以诡异方式炸。`.strict()` 顺手逮未知键（典型 typo）。
// schema 输出经下方 loadConfig 装进 Config，与上面接口的漂移由 tsc 在装配处兜住。
// 委托脚本映射（全可选；项目级覆盖运行期兜底）。
const ScriptsSchema = z
  .object({
    worktree_add: z.string().min(1).optional(),
    worktree_remove: z.string().min(1).optional(),
    ci: z.string().min(1).optional(),
    diff: z.string().min(1).optional(),
    create_pr: z.string().min(1).optional(),
    checks: z.string().min(1).optional(),
  })
  .strict();

const HealthRuntimeSchema = z
  .object({
    port: z.number().int().positive().optional(),
    liveness_ping_sec: z.number().positive().optional(),
    wedged_after_sec: z.number().positive().optional(),
    wedged_grace_sec: z.number().nonnegative().optional(),
    probe_fail_threshold: z.number().int().positive().optional(),
    sample_interval_sec: z.number().positive().optional(),
    history_retain_hours: z.number().positive().optional(),
    log_rotate_mb: z.number().positive().optional(),
    contract_check: z.boolean().optional(),
    contract_interval_hours: z.number().positive().optional(),
  })
  .strict();

export const RuntimeSchema = z
  .object({
    poll_interval_sec: z.number().int().positive(),
    max_parallel: z.number().int().positive(),
    parse_repair_retries: z.number().int().nonnegative().optional(),
    max_fix_failures: z.number().int().positive().optional(),
    branches: z.object({ prod: z.string().min(1), dev: z.string().min(1) }).strict(),
    default_branch: z.enum(['prod', 'dev']),
    repos: z.array(z.string().min(1)).min(1),
    tech_design_publish: z
      .object({ enabled: z.boolean(), base: z.string().min(1) })
      .strict()
      .optional(),
    delivery_doc_commit: z.object({ enabled: z.boolean() }).strict().optional(),
    // 文档源开关。plaintext（把一段 IM 文本本身当需求）**默认关**：开了等于「@机器人 + 一段话」
    // 就会真跑闸A（花钱），对既有部署是行为变化，必须显式打开。
    doc_sources: z
      .object({ plaintext: z.object({ enabled: z.boolean() }).strict().optional() })
      .strict()
      .optional(),
    adversarial: z
      .object({
        reviewer: z.enum(['codex', 'claude']),
        on_missing: z.enum(['claude', 'skip', 'error']),
        max_rounds: z.number().int().positive(),
      })
      .strict(),
    gate_a: z.object({ max_pm_rounds: z.number().int().positive() }).strict().optional(),
    gate_c: z
      .object({
        max_rounds: z.number().int().positive(),
        max_rounds_per_tick: z.number().int().positive().optional(),
        ci_timeout_sec: z.number().int().positive().optional(),
        claude_timeout_sec: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    gate_d: z
      .object({
        max_rounds: z.number().int().positive(),
        max_rounds_per_tick: z.number().int().positive().optional(),
        ci_timeout_sec: z.number().int().positive().optional(),
        claude_timeout_sec: z.number().int().positive().optional(),
        harden: z
          .object({
            forbid_mirror_tests: z.boolean(),
            require_failure_path: z.boolean(),
            require_auth_path: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    scripts: ScriptsSchema.optional(),
    autonomy: z.object({ level: z.number().int().min(0).max(AUTONOMY_MAX_LEVEL), actor: z.string().min(1).optional() }).strict().optional(),
    web_actor: z.string().min(1).optional(),
    gates: z.object({ checkout_anchor: z.enum(['warn', 'block']).optional() }).strict().optional(),
    drift: z
      .object({
        enabled: z.boolean(),
        poll_every_hours: z.number().positive().optional(),
        max_polls: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    retry: z
      .object({
        max_auto_retries: z.number().int().nonnegative(),
        max_reclaims: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    claude_bin: z.string().min(1),
    codex_bin: z.string().min(1),
    claude_allowed_tools: z.string(),
    claude_timeout_sec: z.number().int().positive(),
    health: HealthRuntimeSchema.optional(),
  })
  .strict();

export const RoutingSchema = z
  .object({
    min_confidence: z.number().min(0).max(1),
    sensitive_areas: z.array(z.string()),
    reviewers: z.record(z.string(), z.string()),
    lead: z.string().min(1),
  })
  .strict();

export const PermissionsSchema = z
  .object({
    gate_b_allowed: z.array(z.string()),
    go_approvers: z.array(z.string()),
    gate_c_allowed: z.array(z.string()).optional(),
    pr_create_approvers: z.array(z.string()).optional(),
    merge_ack_allowed: z.array(z.string()).optional(),
    operators: z.record(z.string(), z.string()).optional(), // open_id → 短码
  })
  .strict();

// wip_limit：必含 default，其余键为各短码上限（catchall 收）。
export const AssignmentSchema = z
  .object({
    pool: z.array(z.string().min(1)).min(1),
    wip_limit: z
      .object({ default: z.number().int().positive() })
      .catchall(z.number().int().positive()),
    in_progress_statuses: z.array(z.number().int().nonnegative()).min(1),
  })
  .strict();

// 项目级策略「部分覆盖」：只列要改的字段，缺省字段级回退全局（见 projects.ts configForProject）。
// 各与全局同名 schema 同约束，但全字段可选（覆盖一两个即可，不必整份重述）。
export const PermissionsOverrideSchema = z
  .object({
    gate_b_allowed: z.array(z.string()).optional(),
    go_approvers: z.array(z.string()).optional(),
    gate_c_allowed: z.array(z.string()).optional(),
    pr_create_approvers: z.array(z.string()).optional(),
    merge_ack_allowed: z.array(z.string()).optional(),
    operators: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export const RoutingOverrideSchema = z
  .object({
    min_confidence: z.number().min(0).max(1).optional(),
    sensitive_areas: z.array(z.string()).optional(),
    reviewers: z.record(z.string(), z.string()).optional(),
    lead: z.string().min(1).optional(),
  })
  .strict();
export const AssignmentOverrideSchema = z
  .object({
    pool: z.array(z.string().min(1)).min(1).optional(),
    wip_limit: z.object({ default: z.number().int().positive() }).catchall(z.number().int().positive()).optional(),
    in_progress_statuses: z.array(z.number().int().nonnegative()).min(1).optional(),
  })
  .strict();

export const ProjectsSchema = z
  .object({
    default_project: z.string().min(1),
    projects: z.record(
      z.string(),
      z
        .object({
          root: z.string().min(1).optional(),
          owner: z.string().min(1).optional(),
          actions: z.enum(['demo', 'native']).optional(),
          repos: z.array(z.string().min(1)).min(1).optional(),
          repoSlugs: z.record(z.string(), z.string().min(1)).optional(),
          branches: z.object({ prod: z.string().min(1), dev: z.string().min(1) }).strict().optional(),
          default_branch: z.enum(['prod', 'dev']).optional(),
          tech_design_publish: z.object({ enabled: z.boolean(), base: z.string().min(1) }).strict().optional(),
          repoMap: z.record(z.string(), z.string().min(1)).optional(),
          umbrella: z.string().min(1).optional(),
          chats: z.array(z.string().min(1)).optional(),
          scripts: ScriptsSchema.optional(),
          autonomy: z.object({ level: z.number().int().min(0).max(AUTONOMY_MAX_LEVEL), actor: z.string().min(1).optional() }).strict().optional(),
          permissions: PermissionsOverrideSchema.optional(),
          routing: RoutingOverrideSchema.optional(),
          assignment: AssignmentOverrideSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict()
  // 只有**硬编码的 demo 默认项目**可省略 root（它才有兄弟 ../example-project 解析）。绝不按「配置里的 default_project」豁免——
  // 否则把非 demo 设成 default_project 又漏 root 时，schema 放过、运行时却静默回落到 demo root（指错 checkout）。
  .superRefine((cfg, ctx) => {
    for (const [id, entry] of Object.entries(cfg.projects)) {
      if (id !== DEFAULT_PROJECT_ID && !entry.root) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', id, 'root'],
          message: `项目 "${id}" 必须声明 root（绝对路径）；只有内建默认项目 "${DEFAULT_PROJECT_ID}" 可省略（自动找兄弟 ../example-project）。把非 demo 设为 default_project 也必须自带 root`,
        });
      }
    }
  });

function loadYaml<T>(name: string, schema: z.ZodType<T>): T {
  const p = configFile(name);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`配置 ${name} 读取/解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `  - ${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`)
      .join('\n');
    throw new Error(`配置 ${name} 校验失败（修正后重启）：\n${issues}`);
  }
  return r.data;
}

// forge.env 的解析器住在 root.ts（传输层选择点也要用它，那里不能拖 zod 进来）。这里只做类型收窄。
function loadEnvFile(): Env {
  return readEnvFile() as Env;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const fileEnv = loadEnvFile();
  // process.env 优先于文件（便于临时覆盖）
  const env: Env = { ...fileEnv };
  for (const k of Object.keys(fileEnv)) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // projects.yaml 可选：有则启用多项目注册表，无则单默认项目（配置取自 runtime.yaml）。
  const projectsPath = configFile('projects.yaml');
  const projects = existsSync(projectsPath) ? loadYaml('projects.yaml', ProjectsSchema) : null;
  cached = {
    runtime: loadYaml('runtime.yaml', RuntimeSchema),
    routing: loadYaml('routing.yaml', RoutingSchema),
    permissions: loadYaml('permissions.yaml', PermissionsSchema),
    assignment: loadYaml('assignment.yaml', AssignmentSchema),
    projects,
    env,
  };
  return cached;
}

// 短码大小写不敏感解析为 login
export function resolveLogin(cfg: Config, code: string): string | null {
  const reviewers = cfg.routing.reviewers;
  const up = code.toUpperCase();
  for (const [k, v] of Object.entries(reviewers)) {
    if (k.toUpperCase() === up) return v;
  }
  return null;
}

// 用户是否在某允许名单内（名单是短码；传入可以是短码或 login）
export function inAllowList(cfg: Config, list: string[], who: string): boolean {
  const up = who.toUpperCase();
  for (const code of list) {
    if (code.toUpperCase() === up) return true;
    const login = resolveLogin(cfg, code);
    if (login && login.toLowerCase() === who.toLowerCase()) return true;
  }
  return false;
}
