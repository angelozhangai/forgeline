// 单测：多项目解析 —— project(id) 合成路径+配置+仓身份；群→项目路由；默认/未知 id 兜底。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.FORGE_PROJECT_ROOT = '/tmp/forge-default-proj'; // 默认项目 root 确定化（resolveDefaultRoot 读它）

const RUNTIME = {
  repos: ['demo', 'example-web', 'example-admin'],
  branches: { prod: 'main', dev: 'dev' },
  default_branch: 'dev',
  tech_design_publish: { enabled: true, base: 'main' },
};
// 全局策略（供配置分化「字段级覆盖」对照）。
const ROUTING = { min_confidence: 0.7, sensitive_areas: ['auth', 'billing'], reviewers: { M: 'ming' }, lead: 'M' };
const PERMISSIONS = { gate_b_allowed: ['M', 'BD'], go_approvers: ['M'], gate_c_allowed: ['M'], pr_create_approvers: ['M'], merge_ack_allowed: ['M'], operators: { ou_m: 'M' } };
const ASSIGNMENT = { pool: ['M', 'BD'], wip_limit: { default: 2 }, in_progress_statuses: [3] };
const REGISTRY = {
  default_project: 'demo',
  projects: {
    demo: { chats: ['oc_demo'] }, // 默认项目：仅声明群，配置全回退 runtime + 默认仓身份 + 全局策略
    acme: {
      root: '/tmp/acme-proj',
      repos: ['acme-web', 'acme-api'],
      branches: { prod: 'main', dev: 'dev' },
      default_branch: 'dev',
      repoMap: { W: 'acme-web', A: 'acme-api' },
      umbrella: 'acme',
      chats: ['oc_acme'],
      autonomy: { level: 3, actor: 'EO' }, // 项目级覆盖自治
      // 配置分化：部分覆盖（仅列要改的字段，其余字段级回退全局）。
      permissions: { go_approvers: ['EO'] },
      routing: { lead: 'EO', sensitive_areas: ['payments'] },
      assignment: { pool: ['EO', 'CC'] },
    },
  },
};

let projectsCfg: unknown = REGISTRY;
let runtimeCfg: unknown = RUNTIME;
mock.module('../src/config.ts', {
  namedExports: { loadConfig: () => ({ runtime: runtimeCfg, routing: ROUTING, permissions: PERMISSIONS, assignment: ASSIGNMENT, projects: projectsCfg }) },
});

const { project, projectForChat, defaultProjectId, configForProject, configForSession } = await import('../src/projects.ts');

test('默认项目：无 entry.root → 自动解析；配置回退 runtime；demo 默认仓身份', () => {
  const p = project('demo');
  assert.equal(p.id, 'demo');
  assert.equal(p.root, '/tmp/forge-default-proj');
  assert.deepEqual(p.repos, RUNTIME.repos);
  assert.equal(p.defaultBranch, 'dev');
  assert.equal(p.branches.prod, 'main');
  assert.equal(p.umbrella, 'example-project');
  assert.equal(p.repoMap.C, 'demo');
  assert.equal(p.scriptsDir, '/tmp/forge-default-proj/scripts');
});

test('注册的非默认项目：用 entry 的 root/repos/repoMap/umbrella + 派生路径', () => {
  const p = project('acme');
  assert.equal(p.id, 'acme');
  assert.equal(p.root, '/tmp/acme-proj');
  assert.deepEqual(p.repos, ['acme-web', 'acme-api']);
  assert.equal(p.umbrella, 'acme');
  assert.equal(p.repoMap.W, 'acme-web');
  assert.equal(p.scriptsDir, '/tmp/acme-proj/scripts');
  assert.equal(p.deliveryDir, '/tmp/acme-proj/docs/delivery');
  assert.equal(p.repoPath('acme-web'), '/tmp/acme-proj/acme-web');
});

test('0.3：非默认项目省略 repoMap/umbrella → 不继承 demo 默认（repoMap={}、umbrella=repos[0]）', () => {
  projectsCfg = { default_project: 'demo', projects: { demo: {}, mono: { root: '/tmp/mono', repos: ['.'] } } };
  const p = project('mono');
  assert.deepEqual(p.repoMap, {}, '非默认不继承 demo DEFAULT_REPO_MAP');
  assert.equal(p.umbrella, '.', '非默认 umbrella 取自身 repos[0]，非 example-project');
  assert.deepEqual(p.repoSlugs, {}, '缺省 repoSlugs 空（key 即 slug）');
  // 默认项目仍保留 demo 默认（行为不变）
  assert.equal(project('demo').umbrella, 'example-project');
  assert.equal(project('demo').repoMap.C, 'demo');
  projectsCfg = REGISTRY; // 还原
});

test('未知 id → 防御性退回默认项目（id=默认、root/配置默认）', () => {
  const p = project('does-not-exist');
  assert.equal(p.id, 'demo');
  assert.equal(p.root, '/tmp/forge-default-proj');
  assert.deepEqual(p.repos, RUNTIME.repos);
});

test('autonomy 按项目解析：项目级覆盖 > runtime 兜底；actor 缺省回退 routing.lead', () => {
  // acme 项目级声明 level 3 + actor EO
  assert.deepEqual(project('acme').autonomy, { level: 3, actor: 'EO' });
  // demo 无项目级 autonomy → 回退 runtime（RUNTIME 无 autonomy → level 0）+ actor 回退 routing.lead
  assert.deepEqual(project('demo').autonomy, { level: 0, actor: 'M' });
  // runtime 配了 autonomy 但项目没配 → 取 runtime 的，actor 仍回退 lead
  runtimeCfg = { ...(RUNTIME as object), autonomy: { level: 2 } };
  assert.deepEqual(project('demo').autonomy, { level: 2, actor: 'M' });
  runtimeCfg = RUNTIME; // 还原
});

test('autonomy 字段级合并（SF2）：项目只覆盖 level → 保留 runtime 的 actor，绝不回退 lead', () => {
  runtimeCfg = { ...(RUNTIME as object), autonomy: { level: 1, actor: 'BOT' } }; // runtime 配了低权限专用 actor
  projectsCfg = { default_project: 'demo', projects: { demo: {}, lvlonly: { root: '/tmp/x', autonomy: { level: 3 } } } };
  // 项目只想调高 level → actor 仍取 runtime 的 BOT，绝不因整块覆盖丢失而回退到更高权限的 routing.lead
  assert.deepEqual(project('lvlonly').autonomy, { level: 3, actor: 'BOT' });
  assert.deepEqual(project('demo').autonomy, { level: 1, actor: 'BOT' }); // 无项目覆盖 → 全取 runtime
  runtimeCfg = RUNTIME; projectsCfg = REGISTRY; // 还原
});

test('群→项目路由 + 默认项目 id', () => {
  assert.equal(projectForChat('oc_acme'), 'acme');
  assert.equal(projectForChat('oc_demo'), 'demo');
  assert.equal(projectForChat('oc_unknown'), undefined);
  assert.equal(projectForChat(null), undefined);
  assert.equal(defaultProjectId(), 'demo');
});

test('无注册表（projects=null）→ 单默认项目；群路由一律 undefined', () => {
  projectsCfg = null;
  assert.equal(defaultProjectId(), 'demo');
  assert.equal(projectForChat('oc_acme'), undefined);
  const p = project();
  assert.equal(p.id, 'demo');
  assert.equal(p.umbrella, 'example-project');
  assert.deepEqual(p.repos, RUNTIME.repos);
  projectsCfg = REGISTRY; // 还原（别影响其他用例）
});

// ── 配置分化：configForProject / configForSession ──
test('configForProject：无策略覆盖的项目 → 直接返回全局 Config 引用（零分化、引用相等）', () => {
  const c = configForProject('demo'); // demo entry 仅 chats，无 permissions/routing/assignment 覆盖
  assert.equal(c.permissions, PERMISSIONS); // 引用相等：未构造新对象
  assert.equal(c.routing, ROUTING);
  assert.equal(c.assignment, ASSIGNMENT);
});

test('configForProject：permissions 部分覆盖（仅 go_approvers）→ 字段级合并，其余名单仍全局', () => {
  const c = configForProject('acme');
  assert.deepEqual(c.permissions.go_approvers, ['EO']); // 覆盖：acme 自己的审批人
  assert.deepEqual(c.permissions.gate_b_allowed, ['M', 'BD']); // 未覆盖 → 全局
  assert.deepEqual(c.permissions.merge_ack_allowed, ['M']); // 未覆盖 → 全局
});

test('configForProject：routing/assignment 字段级覆盖（覆盖项目级、其余回退全局）', () => {
  const c = configForProject('acme');
  assert.equal(c.routing.lead, 'EO'); // 覆盖
  assert.deepEqual(c.routing.sensitive_areas, ['payments']); // 覆盖
  assert.equal(c.routing.min_confidence, 0.7); // 未覆盖 → 全局
  assert.deepEqual(c.routing.reviewers, { M: 'ming' }); // 未覆盖 reviewers → 全局原样
  assert.deepEqual(c.assignment.pool, ['EO', 'CC']); // 覆盖
  assert.deepEqual(c.assignment.in_progress_statuses, [3]); // 未覆盖 → 全局
});

test('configForProject：身份映射 reviewers/operators 是 **map 合并**（项目加自己的，继承全局映射不丢——Codex SF/Blocker 修复）', () => {
  projectsCfg = {
    default_project: 'demo',
    projects: { demo: {}, p: { root: '/tmp/p', routing: { reviewers: { EO: 'xw-login' } }, permissions: { gate_b_allowed: ['EO'], operators: { ou_xw: 'EO' } } } },
  };
  const c = configForProject('p');
  // reviewers map 合并：全局 M→ming 保留 + 项目 EO→xw-login。否则项目继承的全局短码（如 go_approvers=[M]）查不到 login，inAllowList 静默失效。
  assert.deepEqual(c.routing.reviewers, { M: 'ming', EO: 'xw-login' });
  // operators map 合并：全局 ou_m→M 保留 + 项目 ou_xw→EO。否则卡片继承的全局点击人解析丢失。
  assert.deepEqual(c.permissions.operators, { ou_m: 'M', ou_xw: 'EO' });
  // 但策略名单仍**字段级替换**：gate_b_allowed 覆盖为项目的、go_approvers 未覆盖回退全局。
  assert.deepEqual(c.permissions.gate_b_allowed, ['EO']);
  assert.deepEqual(c.permissions.go_approvers, ['M']);
  projectsCfg = REGISTRY;
});

test('configForProject：未知 id → 退默认项目（默认无覆盖 → 全局）；无注册表 → 全局原样', () => {
  assert.deepEqual(configForProject('ghost').permissions.go_approvers, ['M']); // 退默认 demo（无覆盖）
  projectsCfg = null;
  assert.deepEqual(configForProject('anything').permissions.go_approvers, ['M']); // 无注册表 → 全局
  assert.equal(configForProject('anything').routing, ROUTING); // 引用相等
  projectsCfg = REGISTRY;
});

test('configForSession：按 session.project_id 路由到该项目的分化配置', () => {
  assert.deepEqual(configForSession({ project_id: 'acme' }).permissions.go_approvers, ['EO']);
  assert.deepEqual(configForSession({ project_id: 'demo' }).permissions.go_approvers, ['M']);
  assert.deepEqual(configForSession({}).permissions.go_approvers, ['M']); // 缺 project_id → 默认项目
});

test('autonomy actor 缺省 → 回退**项目级** lead（routing 覆盖后的 lead，非全局 lead）', () => {
  projectsCfg = { default_project: 'demo', projects: { demo: {}, proj2: { root: '/tmp/p2', routing: { lead: 'EO' }, autonomy: { level: 2 } } } };
  // proj2 覆盖 routing.lead=EO、autonomy 只给 level → actor 回退**项目级** lead EO（绝非全局 M）
  assert.deepEqual(project('proj2').autonomy, { level: 2, actor: 'EO' });
  projectsCfg = REGISTRY; // 还原
});
