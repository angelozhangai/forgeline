// 「完整目标项目」解析：把 Stage 1 的路径 Project（src/project.ts）与运行期配置
// （repos / branches / 发布开关）合成一个对象，供按 session.project_id 解析。
//
// Stage 2a（本提交）：只有默认项目，配置取自 runtime.yaml，root 来自 defaultProject()；
//   project(id) 对任何 id 都回默认项目 —— 行为与改造前完全一致（所有 session 的 project_id 都是 'demo'）。
// Stage 2b：引入 config/projects.yaml 注册表，非默认项目从注册表解析 root/repos/branches/发布。
import { resolve } from 'node:path';
import { defaultProject, makeProject, DEFAULT_PROJECT_ID, type Project } from './project.ts';
import { loadConfig } from './config.ts';
import type { ProjectScripts, Config, ProjectEntry, PermissionsConfig, RoutingConfig, AssignmentConfig } from './config.ts';

// 路径 Project + 该项目的运行期配置 + 仓身份方案。
export interface ProjectFull extends Project {
  repos: string[]; // 本地 repo key/path（读代码真源）；monorepo 用 '.'
  repoSlugs: Record<string, string>; // 本地 repo key → GitHub repo slug（gh -R owner/<slug>）；缺省空=key 即 slug
  owner: string; // GitHub org（建 issue / 查标签 / 漂移对账）；缺省 DEFAULT_OWNER
  actions: 'demo' | 'native'; // 机械动作 adapter（缺省 demo 主仓脚本）；见 src/project/index.ts 选择点
  branches: { prod: string; dev: string };
  defaultBranch: 'prod' | 'dev';
  techDesignPublish?: { enabled: boolean; base: string };
  repoMap: Record<string, string>; // 闸B 信封里的仓字母 → 仓名（建 issue 用）
  umbrella: string; // 多仓 Epic 本体所在仓
  scripts: ProjectScripts; // 下游机械动作委托脚本（项目级覆盖 runtime.yaml 兜底，逐键合并）
  autonomy: { level: number; actor: string }; // 渐进自治：等级（0=全人工）+ 自动动作署名（缺省 routing.lead）。项目级覆盖 runtime。
}

// 默认项目（demo）的仓身份：字母 C/U/A/E → 仓名 + 伞仓（E=example-engine AIGC 引擎，与 demo 后端同属后端侧）。
// Stage 2b 注册表引入后，非默认项目从 config/projects.yaml 各自定义；这里是默认兜底。
const DEFAULT_REPO_MAP: Record<string, string> = { C: 'demo', U: 'example-web', A: 'example-admin', E: 'example-engine' };
const DEFAULT_UMBRELLA = 'example-project';
// 默认项目 GitHub org。非默认项目（如 your-monorepo，很可能在别的 org）须在 projects.yaml 显式 owner。
export const DEFAULT_OWNER = 'your-org';

// 按 id 解析「该用哪个项目条目」：注册表命中 → (id, entry)；未注册（含无注册表、未知 id）→ 防御性退回默认项目。
// project() 与 configForProject() 共用，确保「未注册退默认」口径一致。
function resolveEntry(cfg: Config, id?: string): { pid: string; entry?: ProjectEntry } {
  const reg = cfg.projects;
  const defaultId = reg?.default_project ?? DEFAULT_PROJECT_ID;
  let pid = id || defaultId;
  let entry = reg?.projects?.[pid];
  if (!entry && pid !== defaultId) {
    // 未注册的 id（理论上 intake 只产合法 id）→ 防御性退回默认项目，绝不对着空配置跑。
    pid = defaultId;
    entry = reg?.projects?.[defaultId];
  }
  return { pid, entry };
}

// 三类策略合并：项目级覆盖 > 全局兜底。两种语义——
//   ① **策略名单**（allow-lists / pool / 阈值）：字段级**替换**（项目要自己的授权集，不与全局混淆；项目只改一个时其余仍回退全局）。
//   ② **身份映射**（reviewers 短码→login、operators open_id→短码）：map 级**合并** `{...全局, ...项目}`——绝不整表替换，
//      否则项目从全局**继承**来的名单短码（如继承的 go_approvers=[M]）在项目自己的 reviewers/operators 表里查不到映射，
//      令 `inAllowList` 的 login 比对 / 卡片 open_id 解析对继承短码静默失效（Codex SF/Blocker）。
// 缺省（无覆盖）→ 直接返回全局引用（引用相等，省构造、便于「无 projects.yaml 即原样」判定）。
function mergePermissions(g: PermissionsConfig, o?: Partial<PermissionsConfig>): PermissionsConfig {
  if (!o) return g;
  return {
    gate_b_allowed: o.gate_b_allowed ?? g.gate_b_allowed,
    go_approvers: o.go_approvers ?? g.go_approvers,
    gate_c_allowed: o.gate_c_allowed ?? g.gate_c_allowed,
    pr_create_approvers: o.pr_create_approvers ?? g.pr_create_approvers,
    merge_ack_allowed: o.merge_ack_allowed ?? g.merge_ack_allowed,
    operators: o.operators ? { ...(g.operators ?? {}), ...o.operators } : g.operators, // 身份映射：map 合并
  };
}
function mergeRouting(g: RoutingConfig, o?: Partial<RoutingConfig>): RoutingConfig {
  if (!o) return g;
  return {
    min_confidence: o.min_confidence ?? g.min_confidence,
    sensitive_areas: o.sensitive_areas ?? g.sensitive_areas,
    reviewers: o.reviewers ? { ...g.reviewers, ...o.reviewers } : g.reviewers, // 身份映射：map 合并（继承短码仍可解析 login）
    lead: o.lead ?? g.lead,
  };
}
function mergeAssignment(g: AssignmentConfig, o?: Partial<AssignmentConfig>): AssignmentConfig {
  if (!o) return g;
  return {
    pool: o.pool ?? g.pool,
    wip_limit: o.wip_limit ?? g.wip_limit,
    in_progress_statuses: o.in_progress_statuses ?? g.in_progress_statuses,
  };
}

// 按 id 解析完整目标项目。
// 注册表（config/projects.yaml）给了此 id 的条目 → 用条目（缺字段回退 runtime.yaml/默认仓身份）；
// 没条目（含无注册表、未知 id）→ 落默认项目：路径自动解析兄弟 ../example-project，配置取 runtime.yaml。
export function project(id?: string): ProjectFull {
  const cfg = loadConfig();
  const rt = cfg.runtime;
  const { pid, entry } = resolveEntry(cfg, id);
  // 路径：注册表给 root 用它；否则默认项目自动解析（FORGE_PROJECT_ROOT/兄弟 ../example-project）。
  const root = entry?.root ? resolve(entry.root) : defaultProject().root;
  const base = makeProject(pid, root);
  const repos = entry?.repos ?? rt.repos;
  // demo 默认仓身份（DEFAULT_REPO_MAP/DEFAULT_UMBRELLA）**只兜底默认项目**——非默认项目绝不继承 demo 的仓字母/伞仓
  // （0.3：your-monorepo 等若省略，旧逻辑会拿到 {C:demo,...}/example-project，指错仓）。非默认缺省：repoMap 空（用字母
  // 编码 Epic 的项目须在 projects.yaml 自带）、umbrella 取自身 repos[0]。
  const isDefault = pid === DEFAULT_PROJECT_ID;
  return {
    ...base,
    repos,
    repoSlugs: entry?.repoSlugs ?? {},
    owner: entry?.owner ?? DEFAULT_OWNER,
    actions: entry?.actions ?? 'demo',
    branches: entry?.branches ?? rt.branches,
    defaultBranch: entry?.default_branch ?? rt.default_branch,
    techDesignPublish: entry?.tech_design_publish ?? rt.tech_design_publish,
    repoMap: entry?.repoMap ?? (isDefault ? DEFAULT_REPO_MAP : {}),
    umbrella: entry?.umbrella ?? (isDefault ? DEFAULT_UMBRELLA : (repos[0] ?? DEFAULT_UMBRELLA)),
    // 逐键合并：项目级覆盖运行期兜底（任一缺省 → 空对象，消费方按需判空）。
    scripts: { ...(rt.scripts ?? {}), ...(entry?.scripts ?? {}) },
    // 自治**字段级**合并：项目级覆盖 > runtime 兜底，逐字段独立——项目只想调 level 时绝不连带把 runtime 的 actor 丢掉
    // 而回退到更高权限的 lead（Codex SF）。actor 缺省最终回退**项目级 lead**（routing 覆盖后的 lead），
    // 须在该项目权限名单里，否则动作 !ok 留人工。
    autonomy: {
      level: entry?.autonomy?.level ?? rt.autonomy?.level ?? 0,
      actor: entry?.autonomy?.actor ?? rt.autonomy?.actor ?? mergeRouting(cfg.routing, entry?.routing).lead,
    },
  };
}

// 按项目把 permissions/routing/assignment **字段级**合并到全局 Config 上（runtime/projects/env 原样）。
// 这是「配置分化」的单一入口：消费方把 loadConfig() 换成 configForProject(session.project_id)，
// inAllowList/resolveLogin/cfg.permissions/cfg.routing/cfg.assignment 全部自动用项目级口径。
// 无覆盖（无 projects.yaml / 该项目三类皆未覆盖）→ 直接返回全局 Config 引用，单项目零行为变更。
export function configForProject(id?: string): Config {
  const cfg = loadConfig();
  const { entry } = resolveEntry(cfg, id);
  if (!entry?.permissions && !entry?.routing && !entry?.assignment) return cfg;
  return {
    ...cfg,
    permissions: mergePermissions(cfg.permissions, entry.permissions),
    routing: mergeRouting(cfg.routing, entry.routing),
    assignment: mergeAssignment(cfg.assignment, entry.assignment),
  };
}

// 便捷：按 session 解析其项目级 Config。
export function configForSession(s: { project_id?: string }): Config {
  return configForProject(s.project_id);
}

// 便捷：按 session 解析其目标项目。
export function projectForSession(s: { project_id?: string }): ProjectFull {
  return project(s.project_id);
}

// 默认项目 id（注册表的 default_project，缺省 'demo'）。
export function defaultProjectId(): string {
  return loadConfig().projects?.default_project ?? DEFAULT_PROJECT_ID;
}

// 群 → 项目路由：哪个项目把该 chat_id 列进了 chats。无注册表/未命中 → undefined。
export function projectForChat(chatId?: string | null): string | undefined {
  if (!chatId) return undefined;
  const reg = loadConfig().projects;
  if (!reg) return undefined;
  for (const [pid, e] of Object.entries(reg.projects)) {
    if (e.chats?.includes(chatId)) return pid;
  }
  return undefined;
}
