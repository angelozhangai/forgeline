import { readFileSync, existsSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { configFile, loadEnvFile as readEnvFile } from './root.ts';
import { DEFAULT_PROJECT_ID } from './project.ts';
import { AUTONOMY_MAX_LEVEL } from './statemachine/autonomyPolicy.ts';

// The scripts the mechanical actions delegate to: forge only orchestrates, calling the target project's
// existing scripts rather than rebuilding them here or hardcoding pnpm/nx/prisma.
// A project-level entry (ProjectEntry.scripts) overrides the runtime fallback (RuntimeConfig.scripts). Paths
// resolve relative to the target project's root.
export interface ProjectScripts {
  worktree_add?: string; // create the isolated worktree (your-monorepo has to go through tools/scripts/wt.sh, which handles node_modules, .envrc and secrets)
  worktree_remove?: string; // clean up the worktree (falling back to git worktree remove)
  ci?: string; // local CI (never a bare nx run-many; your-monorepo uses pnpm ci:local)
  diff?: string; // produce the baseSha..HEAD diff (for the PR description and codex's review)
  create_pr?: string; // open the PR (never merging it automatically)
  checks?: string; // the pre-merge checks (Prisma drift, docs lint, and so on)
}

export interface RuntimeConfig {
  poll_interval_sec: number;
  max_parallel: number;
  parse_repair_retries?: number; // how many times malformed JSON from the LLM is fed back through a resume to be reproduced (2 by default; see llm/structured.ts)
  max_fix_failures?: number; // the circuit-breaker threshold for consecutive failed fix (claude) calls; at the cap the gate STALLS and a human takes over (5 by default; see review/reviewFixLoop.ts)
  branches: { prod: string; dev: string };
  default_branch: 'prod' | 'dev';
  repos: string[];
  tech_design_publish?: {
    enabled: boolean; // on GO, publish the technical-design document to the main repo automatically (commit, PR, merge)
    base: string; // the PR's target branch (main/dev)
  };
  delivery_doc_commit?: {
    enabled: boolean; // after GO, commit docs/delivery/<slug>/ onto the target project's *current* branch automatically (that path only, no branch switching, and it **never pushes**); off by default, so it is committed by hand
  };
  doc_sources?: {
    // Treat "@bot plus a paragraph" as the requirement body itself, with no document service involved (see
    // src/docs/plaintext.ts).
    // **Off by default**: once on, such a message really does create a requirement and run Gate A, which
    // spends money automatically; today it is simply ignored.
    plaintext?: { enabled: boolean };
  };
  adversarial: {
    reviewer: 'codex' | 'claude';
    on_missing: 'claude' | 'skip' | 'error';
    max_rounds: number;
  };
  gate_a?: {
    max_pm_rounds: number; // the cap on review rounds with product; at the cap it parks for the maintainer to decide
  };
  gate_c?: {
    max_rounds: number; // the hard cap on the implementation/CI fix loop: still not green at the cap -> GATE_C_STALLED for the maintainer to decide
    max_rounds_per_tick?: number; // how many rounds one tick may run (CI is heavy; 1 by default, so it does not hog the tick lock)
    ci_timeout_sec?: number; // the timeout for one local CI run
    claude_timeout_sec?: number; // the timeout for one claude implementation call (falling back to the global claude_timeout_sec; writing code downstream is far heavier than reviewing a document upstream)
  };
  gate_d?: {
    max_rounds: number; // the hard cap on the codex-reviews-diff / claude-revises loop: at the cap -> GATE_D_STALLED for the maintainer to decide
    max_rounds_per_tick?: number;
    ci_timeout_sec?: number;
    claude_timeout_sec?: number; // the timeout for one claude revision or hardening call (falling back to the global one; fixing and hardening at PR level is just as heavy)
    harden?: {
      forbid_mirror_tests: boolean; // no mirror tests
      require_failure_path: boolean; // the failure path has to be covered
      require_auth_path: boolean; // the permission path has to be covered
    };
  };
  scripts?: ProjectScripts; // the scripts the mechanical actions delegate to (a project-level ProjectEntry.scripts overrides this fallback)
  autonomy?: {
    level: number; // the autonomy level, 0..AUTONOMY_MAX_LEVEL: 0 = everything by hand (the default); 1 produces the plan automatically / 2 GOes automatically / 3 implements automatically / 4 opens the PR automatically (a merge is never automatic — see autonomyPolicy).
    actor?: string; // the short code an automatic action is signed as (it has to be on the relevant permission list, or the action returns !ok and is left to a human); it falls back to routing.lead, and the audit event is marked auto.
  };
  web_actor?: string; // the short code a web panel write action is signed as (it has to be on the relevant permission list); it falls back to routing.lead. The panel binds to 127.0.0.1, and its actions go through the same permission gate.
  gates?: {
    // What to do when, before a Gate A or Gate B review, the local checkout is not anchored to origin/<branch>
    // (HEAD has moved, or the tree is dirty):
    // 'warn' (the default) discloses the divergence in the prompt so the model knows and carries on; 'block'
    // parks it (never drawing a conclusion about unanchored code — for strict setups).
    checkout_anchor?: 'warn' | 'block';
  };
  drift?: {
    enabled: boolean; // the post-delivery drift loop: once a DONE requirement's issues are all closed, audit the implementation against Gate B's acceptance contract and alert the maintainer by direct message on drift (off by default)
    poll_every_hours?: number; // the minimum interval between two drift polls of the same requirement (24h by default, which controls how often gh and claude are called)
    max_polls?: number; // how many times one requirement's drift audit may be attempted (the backoff cap for issues that stay unmerged, or an audit that keeps failing; 8 by default) -> once exhausted it gives up and alerts
  };
  retry?: {
    max_auto_retries: number; // the cap on automatic backoff retries for a transient error (a timeout, a rate limit, the network, a fetch); once exhausted it becomes a dead letter (3 by default)
    max_reclaims: number; // the cap on automatically resetting an orphaned state (the process died mid-run); once exhausted it becomes a dead letter, so a crash-restart loop cannot run forever (3 by default)
  };
  claude_bin: string;
  codex_bin: string;
  claude_allowed_tools: string;
  claude_timeout_sec: number;
  health?: HealthRuntime; // keep-alive and health (when absent, src/health/config.ts fills in the defaults)
}

// The tunable keep-alive and health settings. All optional — healthConfig() in src/health/config.ts fills in
// the defaults.
export interface HealthRuntime {
  port?: number; // the local health service's port (127.0.0.1 only). Overridable by the FORGE_HEALTH_PORT env var
  liveness_ping_sec?: number; // how often the daemon's liveness ping runs (proving the event loop is alive)
  wedged_after_sec?: number; // liveness going this long without updating counts as wedged
  wedged_grace_sec?: number; // with a gate running, how long after being judged wedged to wait before killing it (so tokens are not burned for nothing)
  probe_fail_threshold?: number; // how many consecutive /healthz failures the watchdog needs before calling it a fault
  sample_interval_sec?: number; // how often a health sample is recorded (the rolling history)
  history_retain_hours?: number; // how long samples are kept
  log_rotate_mb?: number; // launchd.log is rotated once it exceeds this size
  contract_check?: boolean; // whether to actively probe the external CLI/API output contracts daily (true by default)
  contract_interval_hours?: number; // the interval between contract probes, in hours (24 by default)
}

export interface RoutingConfig {
  min_confidence: number;
  sensitive_areas: string[];
  reviewers: Record<string, string>; // short code -> login
  lead: string; // a short code
}

export interface PermissionsConfig {
  gate_b_allowed: string[];
  go_approvers: string[];
  gate_c_allowed?: string[]; // who may trigger Gate C (the implementation); falls back to go_approvers
  pr_create_approvers?: string[]; // who may trigger opening the PR and Gate D; falls back to go_approvers
  merge_ack_allowed?: string[]; // who may acknowledge a human merge (-> SHIPPED); falls back to go_approvers
  operators?: Record<string, string>; // IM user id (a Feishu open_id or a Slack user id) -> short code (for a team: a card callback is authorised against whoever really clicked; with none configured it is a single person, always treated as the maintainer)
}

export interface AssignmentConfig {
  pool: string[]; // the pool of short codes that can be assigned as DRI
  wip_limit: { default: number; [code: string]: number }; // the cap on how many requirements one person may have in progress (default is the fallback)
  in_progress_statuses: number[]; // the rollup status ordinals that count as "in progress right now" (everything else is excluded from the current load)
}

export interface Env {
  FORGE_PROJECT_ROOT?: string; // the target project's repo root (by default it finds the sibling ../example-project)
  FEISHU_REVIEW_WEBHOOK?: string;
  FEISHU_REVIEW_WEBHOOK_SECRET?: string;
  FEISHU_REVIEW_CHAT_ID?: string;
  FEISHU_WATCH_CHATS?: string; // a comma-separated list of chat_ids: on startup or a reconnect, the offline messages of these chats are backfilled (falling back to FEISHU_REVIEW_CHAT_ID)
  // The Feishu bot (direct-message notifications, and the button callbacks that follow). Reusing a lark-mcp
  // app requires granting it the im:message permission in the Feishu console first.
  FEISHU_BOT_APP_ID?: string;
  FEISHU_BOT_APP_SECRET?: string;
  FEISHU_BOT_OPEN_ID?: string; // the bot's own open_id, used by the channel-message gate to decide "was this bot mentioned" (by default it asks bot/v3/info)
  FEISHU_DM_OPEN_ID?: string; // the notification target: your own open_id (a direct message)
  FEISHU_DM_UNION_ID?: string; // or a union_id (consistent across apps within one company; feishu-doc.js can obtain the user identity in one go, avoiding the contact approval)
  FEISHU_DM_CHAT_ID?: string; // or a p2p chat_id
  FEISHU_DM_EMAIL?: string; // or a Feishu work email (receive_id_type=email)
  // Selecting the transport provider (see src/messaging/index.ts). 'feishu' (the default) or 'slack'; an
  // unrecognised value throws hard and never falls back silently.
  FORGE_MESSAGING_PROVIDER?: string;
  // Slack (required when provider=slack)
  SLACK_BOT_TOKEN?: string; // xoxb-...: the Web API (posting and editing cards, reading history)
  SLACK_APP_TOKEN?: string; // xapp-...: connecting in Socket Mode (apps.connections.open accepts only this)
  SLACK_BOT_USER_ID?: string; // the bot's own user id, used by the channel-message gate to decide "was this bot mentioned"; without it, channel messages are conservatively ignored
  SLACK_DM_USER_ID?: string; // the direct-message target (your own user id, which doubles as a channel)
  SLACK_WATCH_CHANNELS?: string; // a comma-separated list of channel ids: on startup or a reconnect, the offline messages of these channels are backfilled
  SLACK_WEBHOOK_URL?: string; // the channel webhook fallback (used when the bot's direct message was not delivered)
  SLACK_API_BASE?: string; // override the Web API's base address (https://slack.com/api by default): for a corporate proxy, or a local acceptance loop
  NOTIFY_DESKTOP?: string; // '0' turns off the local macOS desktop notification fallback (on by default)
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  [k: string]: string | undefined;
}

// The multi-project registry (config/projects.yaml, optional). Absent means a single default project, with
// its configuration from runtime.yaml.
// Any field omitted falls back to the default project or runtime.yaml (see project() in src/projects.ts).
export interface ProjectEntry {
  root?: string; // the project's repo root (required for a non-default project; the default project finds its sibling automatically)
  owner?: string; // the GitHub org/owner (creating issues, reading labels, drift reconciliation); DEFAULT_OWNER (your-org) by default. your-monorepo is very likely a different org and has to declare it explicitly
  actions?: 'demo' | 'native'; // the mechanical-action adapter: demo = the main repo's scripts (the default); native = calling gh directly (for an open-source project, or one with no scripts)
  repos?: string[]; // the **local** repo keys/paths (`<root>/<repo>`, where the code source of truth is read; a monorepo uses '.'). Not the same as a GitHub slug (see repoSlugs)
  repoSlugs?: Record<string, string>; // local repo key -> GitHub repo slug (gh -R owner/<slug>). By default the key itself (under demo the repo name is the slug); a monorepo has to set { '.': 'your-monorepo' }
  branches?: { prod: string; dev: string };
  default_branch?: 'prod' | 'dev';
  tech_design_publish?: { enabled: boolean; base: string };
  repoMap?: Record<string, string>; // repo letter -> repo name
  umbrella?: string; // the umbrella repo
  chats?: string[]; // which chats' PRDs belong to this project (channel-to-project routing)
  scripts?: ProjectScripts; // the scripts the downstream mechanical actions delegate to (overriding runtime.yaml's scripts fallback)
  autonomy?: { level: number; actor?: string }; // override the autonomy level and signing actor per project (falling back to runtime.autonomy) — so autonomy can be switched on in a low-risk project first
  // A "partial override" of policy: the approvers, routing and assignment pool diverge per project, with each
  // field falling back to global (with none configured it is global, so a single-project setup behaves
  // exactly as before). See configForProject in projects.ts.
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
  projects: ProjectsConfig | null; // null when there is no projects.yaml (a single default project)
  env: Env;
}

// ── Validating the runtime configuration (zod) ─────────────────────────────────
// The yaml files go through their schema at startup: a misspelled field, a wrong type or a missing one throws
// an error a human can read, pointing at where it is — rather than exploding in some strange way at a call
// site later. `.strict()` catches unknown keys along the way (the classic typo).
// The schema's output is assembled into Config by loadConfig below, and tsc catches any drift from the
// interfaces above at the point of assembly.
// The delegated-script mapping (all optional; a project-level entry overrides the runtime fallback).
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
    // The document-source switches. plaintext (treating a piece of IM text as the requirement itself) is
    // **off by default**: switching it on means "@bot plus a paragraph" really runs Gate A and costs money,
    // which is a behaviour change for an existing deployment, so it has to be enabled explicitly.
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
    operators: z.record(z.string(), z.string()).optional(), // open_id -> short code
  })
  .strict();

// wip_limit must contain default; every other key is one short code's cap (taken by the catchall).
export const AssignmentSchema = z
  .object({
    pool: z.array(z.string().min(1)).min(1),
    wip_limit: z
      .object({ default: z.number().int().positive() })
      .catchall(z.number().int().positive()),
    in_progress_statuses: z.array(z.number().int().nonnegative()).min(1),
  })
  .strict();

// A project-level "partial override" of policy: list only the fields being changed, and anything omitted
// falls back to global field by field (see configForProject in projects.ts).
// Each carries the same constraints as its global counterpart, but with every field optional — overriding one
// or two does not mean restating the whole thing.
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
  // Only the **hardcoded demo default project** may omit root, because it is the only one with the sibling
  // ../example-project to resolve to. The exemption is never based on whatever "default_project" the config
  // names — otherwise setting a non-demo project as default_project and forgetting its root would pass the
  // schema and then silently fall back to demo's root at runtime, pointing at the wrong checkout.
  .superRefine((cfg, ctx) => {
    for (const [id, entry] of Object.entries(cfg.projects)) {
      if (id !== DEFAULT_PROJECT_ID && !entry.root) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', id, 'root'],
          message: `the project "${id}" must declare a root (an absolute path); only the built-in default project "${DEFAULT_PROJECT_ID}" may omit it (it finds the sibling ../example-project automatically). Setting a non-demo project as default_project does not exempt it from bringing its own root`,
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
    throw new Error(`the configuration ${name} could not be read or parsed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`the configuration ${name} failed validation (fix it and restart):\n${issues}`);
  }
  return r.data;
}

// forge.env's parser lives in root.ts (the transport selection point needs it too, and zod cannot be dragged
// in there). This only narrows the type.
function loadEnvFile(): Env {
  return readEnvFile() as Env;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const fileEnv = loadEnvFile();
  // process.env wins over the file (which makes a temporary override easy)
  const env: Env = { ...fileEnv };
  for (const k of Object.keys(fileEnv)) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // projects.yaml is optional: with it the multi-project registry is enabled, and without it there is a single
  // default project whose configuration comes from runtime.yaml.
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

// Resolve a short code to a login, case-insensitively
export function resolveLogin(cfg: Config, code: string): string | null {
  const reviewers = cfg.routing.reviewers;
  const up = code.toUpperCase();
  for (const [k, v] of Object.entries(reviewers)) {
    if (k.toUpperCase() === up) return v;
  }
  return null;
}

// Whether a user is on an allow-list (the list holds short codes; what is passed in may be a short code or a
// login)
export function inAllowList(cfg: Config, list: string[], who: string): boolean {
  const up = who.toUpperCase();
  for (const code of list) {
    if (code.toUpperCase() === up) return true;
    const login = resolveLogin(cfg, code);
    if (login && login.toLowerCase() === who.toLowerCase()) return true;
  }
  return false;
}
