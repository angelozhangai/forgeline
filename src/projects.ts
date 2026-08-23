// Resolving the "full target project": it composes stage 1's path-only Project (src/project.ts) with the
// runtime configuration (repos, branches, the publish switch) into one object, resolved by
// session.project_id.
//
// Stage 2a: the default project only, with its configuration from runtime.yaml and its root from
// defaultProject(); project(id) returns the default project for any id — behaviour identical to before the
// change (every session's project_id is 'demo').
// Stage 2b: the config/projects.yaml registry arrives, and a non-default project resolves its root, repos,
// branches and publish settings from it.
import { resolve } from 'node:path';
import { defaultProject, makeProject, DEFAULT_PROJECT_ID, type Project } from './project.ts';
import { loadConfig } from './config.ts';
import type { ProjectScripts, Config, ProjectEntry, PermissionsConfig, RoutingConfig, AssignmentConfig } from './config.ts';

// The path-only Project, plus that project's runtime configuration, plus how its repos are identified.
export interface ProjectFull extends Project {
  repos: string[]; // the local repo keys/paths (where the code source of truth is read); a monorepo uses '.'
  repoSlugs: Record<string, string>; // local repo key -> GitHub repo slug (gh -R owner/<slug>); empty by default, meaning the key is the slug
  owner: string; // the GitHub org (creating issues, reading labels, drift reconciliation); DEFAULT_OWNER by default
  actions: 'demo' | 'native'; // the mechanical-action adapter (the demo main-repo scripts by default); see the selection point in src/project/index.ts
  branches: { prod: string; dev: string };
  defaultBranch: 'prod' | 'dev';
  techDesignPublish?: { enabled: boolean; base: string };
  repoMap: Record<string, string>; // the repo letters in Gate B's envelope -> repo names (used when creating issues)
  umbrella: string; // the repo a multi-repo Epic itself lives in
  scripts: ProjectScripts; // the scripts the downstream mechanical actions delegate to (a project-level override over runtime.yaml's fallback, merged key by key)
  autonomy: { level: number; actor: string }; // progressive autonomy: the level (0 = entirely manual) plus who an automatic action is signed as (routing.lead by default). A project-level override over runtime.
}

// The default project's (demo's) repo identity: the letters C/U/A/E mapped to repo names, plus the umbrella
// repo (E = example-engine, which sits on the backend side alongside demo).
// Once stage 2b's registry arrives, a non-default project defines its own in config/projects.yaml; this is
// only the default fallback.
const DEFAULT_REPO_MAP: Record<string, string> = { C: 'demo', U: 'example-web', A: 'example-admin', E: 'example-engine' };
const DEFAULT_UMBRELLA = 'example-project';
// The default project's GitHub org. A non-default project (your-monorepo, say, which is very likely in a
// different org) has to set owner explicitly in projects.yaml.
export const DEFAULT_OWNER = 'your-org';

// Resolve "which project entry applies" from an id: a registry hit gives (id, entry); unregistered (including
// no registry at all, or an unknown id) defensively falls back to the default project.
// project() and configForProject() share this, so "unregistered falls back to the default" means the same
// thing in both.
function resolveEntry(cfg: Config, id?: string): { pid: string; entry?: ProjectEntry } {
  const reg = cfg.projects;
  const defaultId = reg?.default_project ?? DEFAULT_PROJECT_ID;
  let pid = id || defaultId;
  let entry = reg?.projects?.[pid];
  if (!entry && pid !== defaultId) {
    // An unregistered id (in theory intake only produces valid ones) defensively falls back to the default
    // project — it never runs against an empty configuration.
    pid = defaultId;
    entry = reg?.projects?.[defaultId];
  }
  return { pid, entry };
}

// Merging the three kinds of policy: a project-level override wins over the global fallback. There are two
// distinct semantics —
//   (1) **Policy lists** (allow-lists, the pool, thresholds) are **replaced** field by field: a project wants
//       its own authorised set and must not blend it with the global one, and overriding one field still
//       leaves the rest falling back to global.
//   (2) **Identity mappings** (reviewers: short code -> login; operators: open_id -> short code) are
//       **merged** at the map level, `{...global, ...project}` — never replaced wholesale. Replacing them
//       would leave a short code the project **inherited** from the global lists (an inherited
//       go_approvers=[M], say) with no entry in the project's own reviewers/operators table, silently
//       breaking `inAllowList`'s login comparison and the card's open_id resolution for every inherited code
//       (the blocker Codex raised).
// With no override at all, the global reference is returned directly (reference-equal, which saves
// constructing anything and makes "no projects.yaml means unchanged" easy to assert).
function mergePermissions(g: PermissionsConfig, o?: Partial<PermissionsConfig>): PermissionsConfig {
  if (!o) return g;
  return {
    gate_b_allowed: o.gate_b_allowed ?? g.gate_b_allowed,
    go_approvers: o.go_approvers ?? g.go_approvers,
    gate_c_allowed: o.gate_c_allowed ?? g.gate_c_allowed,
    pr_create_approvers: o.pr_create_approvers ?? g.pr_create_approvers,
    merge_ack_allowed: o.merge_ack_allowed ?? g.merge_ack_allowed,
    operators: o.operators ? { ...(g.operators ?? {}), ...o.operators } : g.operators, // an identity mapping: merged at the map level
  };
}
function mergeRouting(g: RoutingConfig, o?: Partial<RoutingConfig>): RoutingConfig {
  if (!o) return g;
  return {
    min_confidence: o.min_confidence ?? g.min_confidence,
    sensitive_areas: o.sensitive_areas ?? g.sensitive_areas,
    reviewers: o.reviewers ? { ...g.reviewers, ...o.reviewers } : g.reviewers, // an identity mapping: merged at the map level, so an inherited short code still resolves to a login
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

// Resolve the full target project from an id.
// If the registry (config/projects.yaml) has an entry for this id, the entry is used (a missing field falls
// back to runtime.yaml, or to the default repo identity).
// With no entry (including no registry at all, or an unknown id) it lands on the default project: the path
// resolves automatically to the sibling ../example-project, and the configuration comes from runtime.yaml.
export function project(id?: string): ProjectFull {
  const cfg = loadConfig();
  const rt = cfg.runtime;
  const { pid, entry } = resolveEntry(cfg, id);
  // The path: the registry's root if it gives one; otherwise the default project resolves it automatically
  // (FORGE_PROJECT_ROOT, or the sibling ../example-project).
  const root = entry?.root ? resolve(entry.root) : defaultProject().root;
  const base = makeProject(pid, root);
  const repos = entry?.repos ?? rt.repos;
  // demo's default repo identity (DEFAULT_REPO_MAP / DEFAULT_UMBRELLA) is **the fallback for the default
  // project only** — a non-default project never inherits demo's repo letters or umbrella (in 0.3, if
  // your-monorepo omitted them the old logic handed it {C:demo,...} and example-project, pointing at the
  // wrong repos). A non-default project's defaults are: an empty repoMap (a project that encodes its Epics
  // with letters has to bring its own in projects.yaml), and umbrella taken from its own repos[0].
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
    // Merged key by key: a project-level override over the runtime fallback (either being absent gives an
    // empty object, and consumers check for that themselves).
    scripts: { ...(rt.scripts ?? {}), ...(entry?.scripts ?? {}) },
    // Autonomy is merged **field by field**: a project-level override over the runtime fallback, each field
    // independently — a project that only wants to change the level must not also drop runtime's actor and
    // fall back to the higher-privileged lead (the surprising-failure Codex raised). The actor's final
    // fallback is **the project-level lead** (the lead after routing's override), which has to be on that
    // project's permission list, or the action returns !ok and is left to a human.
    autonomy: {
      level: entry?.autonomy?.level ?? rt.autonomy?.level ?? 0,
      actor: entry?.autonomy?.actor ?? rt.autonomy?.actor ?? mergeRouting(cfg.routing, entry?.routing).lead,
    },
  };
}

// Merge a project's permissions, routing and assignment onto the global Config **field by field** (runtime,
// projects and env pass through unchanged).
// This is the single entry point for "configuration diverges per project": a consumer swaps loadConfig() for
// configForProject(session.project_id), and inAllowList, resolveLogin, cfg.permissions, cfg.routing and
// cfg.assignment all follow the project's own settings automatically.
// With no override (no projects.yaml, or that project overriding none of the three) the global Config
// reference is returned directly, so a single-project setup behaves exactly as before.
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

// A convenience: resolve a session's project-level Config.
export function configForSession(s: { project_id?: string }): Config {
  return configForProject(s.project_id);
}

// A convenience: resolve a session's target project.
export function projectForSession(s: { project_id?: string }): ProjectFull {
  return project(s.project_id);
}

// The default project id (the registry's default_project, or 'demo').
export function defaultProjectId(): string {
  return loadConfig().projects?.default_project ?? DEFAULT_PROJECT_ID;
}

// Channel-to-project routing: which project lists this chat_id under its chats. No registry, or no match ->
// undefined.
export function projectForChat(chatId?: string | null): string | undefined {
  if (!chatId) return undefined;
  const reg = loadConfig().projects;
  if (!reg) return undefined;
  for (const [pid, e] of Object.entries(reg.projects)) {
    if (e.chats?.includes(chatId)) return pid;
  }
  return undefined;
}
