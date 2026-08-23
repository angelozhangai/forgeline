// Unit tests for multi-project resolution: project(id) composing paths, config and repo identity; routing a
// chat to a project; and the fallbacks for the default and for an unknown id.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.FORGE_PROJECT_ROOT = '/tmp/forge-default-proj'; // pin the default project root (resolveDefaultRoot reads it)

const RUNTIME = {
  repos: ['demo', 'example-web', 'example-admin'],
  branches: { prod: 'main', dev: 'dev' },
  default_branch: 'dev',
  tech_design_publish: { enabled: true, base: 'main' },
};
// The global policy, to compare the per-field overrides against.
const ROUTING = { min_confidence: 0.7, sensitive_areas: ['auth', 'billing'], reviewers: { M: 'ming' }, lead: 'M' };
const PERMISSIONS = { gate_b_allowed: ['M', 'BD'], go_approvers: ['M'], gate_c_allowed: ['M'], pr_create_approvers: ['M'], merge_ack_allowed: ['M'], operators: { ou_m: 'M' } };
const ASSIGNMENT = { pool: ['M', 'BD'], wip_limit: { default: 2 }, in_progress_statuses: [3] };
const REGISTRY = {
  default_project: 'demo',
  projects: {
    demo: { chats: ['oc_demo'] }, // the default project: declares chats only, so config falls back to runtime, the default repo identity and the global policy
    acme: {
      root: '/tmp/acme-proj',
      repos: ['acme-web', 'acme-api'],
      branches: { prod: 'main', dev: 'dev' },
      default_branch: 'dev',
      repoMap: { W: 'acme-web', A: 'acme-api' },
      umbrella: 'acme',
      chats: ['oc_acme'],
      autonomy: { level: 3, actor: 'EO' }, // a project-level autonomy override
      // Config divergence: a partial override that lists only the fields it changes, with the rest falling
      // back to the global value field by field.
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

test('the default project: with no entry.root it resolves one, config falls back to runtime, and demo gets the default repo identity', () => {
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

test('a registered non-default project: uses the entry\'s root/repos/repoMap/umbrella and derives its paths from them', () => {
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

test('0.3: a non-default project that omits repoMap/umbrella does not inherit demo\'s defaults (repoMap={}, umbrella=repos[0])', () => {
  projectsCfg = { default_project: 'demo', projects: { demo: {}, mono: { root: '/tmp/mono', repos: ['.'] } } };
  const p = project('mono');
  assert.deepEqual(p.repoMap, {}, 'a non-default project does not inherit demo\'s DEFAULT_REPO_MAP');
  assert.equal(p.umbrella, '.', 'a non-default umbrella comes from its own repos[0], not example-project');
  assert.deepEqual(p.repoSlugs, {}, 'repoSlugs defaults to empty (the key is the slug)');
  // The default project keeps demo's defaults -- behaviour unchanged.
  assert.equal(project('demo').umbrella, 'example-project');
  assert.equal(project('demo').repoMap.C, 'demo');
  projectsCfg = REGISTRY; // restore
});

test('an unknown id falls back defensively to the default project (its id, root and config)', () => {
  const p = project('does-not-exist');
  assert.equal(p.id, 'demo');
  assert.equal(p.root, '/tmp/forge-default-proj');
  assert.deepEqual(p.repos, RUNTIME.repos);
});

test('autonomy resolves per project: a project-level override beats the runtime fallback, and a missing actor falls back to routing.lead', () => {
  // acme declares level 3 and actor EO at the project level.
  assert.deepEqual(project('acme').autonomy, { level: 3, actor: 'EO' });
  // demo has no project-level autonomy -> falls back to runtime (which has none, so level 0) with the actor
  // falling back to routing.lead.
  assert.deepEqual(project('demo').autonomy, { level: 0, actor: 'M' });
  // runtime configures autonomy but the project does not -> take runtime's, with the actor still falling
  // back to the lead.
  runtimeCfg = { ...(RUNTIME as object), autonomy: { level: 2 } };
  assert.deepEqual(project('demo').autonomy, { level: 2, actor: 'M' });
  runtimeCfg = RUNTIME; // restore
});

test('autonomy merges field by field (SF2): a project that overrides only the level keeps runtime\'s actor and never falls back to the lead', () => {
  runtimeCfg = { ...(RUNTIME as object), autonomy: { level: 1, actor: 'BOT' } }; // runtime configures a dedicated low-privilege actor
  projectsCfg = { default_project: 'demo', projects: { demo: {}, lvlonly: { root: '/tmp/x', autonomy: { level: 3 } } } };
  // The project only wants to raise the level, so the actor stays runtime's BOT -- a whole-block override
  // must never lose it and fall back to the more privileged routing.lead.
  assert.deepEqual(project('lvlonly').autonomy, { level: 3, actor: 'BOT' });
  assert.deepEqual(project('demo').autonomy, { level: 1, actor: 'BOT' }); // no project override -> take all of runtime's
  runtimeCfg = RUNTIME; projectsCfg = REGISTRY; // restore
});

test('routing a chat to a project, plus the default project id', () => {
  assert.equal(projectForChat('oc_acme'), 'acme');
  assert.equal(projectForChat('oc_demo'), 'demo');
  assert.equal(projectForChat('oc_unknown'), undefined);
  assert.equal(projectForChat(null), undefined);
  assert.equal(defaultProjectId(), 'demo');
});

test('with no registry (projects=null) there is a single default project, and chat routing always returns undefined', () => {
  projectsCfg = null;
  assert.equal(defaultProjectId(), 'demo');
  assert.equal(projectForChat('oc_acme'), undefined);
  const p = project();
  assert.equal(p.id, 'demo');
  assert.equal(p.umbrella, 'example-project');
  assert.deepEqual(p.repos, RUNTIME.repos);
  projectsCfg = REGISTRY; // restore, so the other tests are unaffected
});

// -- Config divergence: configForProject / configForSession --
test('configForProject: a project with no policy override returns the global Config by reference (no divergence, and reference-equal)', () => {
  const c = configForProject('demo'); // demo's entry has chats only, and no permissions/routing/assignment override
  assert.equal(c.permissions, PERMISSIONS); // reference-equal: no new object was built
  assert.equal(c.routing, ROUTING);
  assert.equal(c.assignment, ASSIGNMENT);
});

test('configForProject: a partial permissions override (go_approvers only) merges field by field, leaving the other lists global', () => {
  const c = configForProject('acme');
  assert.deepEqual(c.permissions.go_approvers, ['EO']); // overridden: acme's own approvers
  assert.deepEqual(c.permissions.gate_b_allowed, ['M', 'BD']); // not overridden -> global
  assert.deepEqual(c.permissions.merge_ack_allowed, ['M']); // not overridden -> global
});

test('configForProject: routing and assignment override field by field, with everything else falling back to global', () => {
  const c = configForProject('acme');
  assert.equal(c.routing.lead, 'EO'); // overridden
  assert.deepEqual(c.routing.sensitive_areas, ['payments']); // overridden
  assert.equal(c.routing.min_confidence, 0.7); // not overridden -> global
  assert.deepEqual(c.routing.reviewers, { M: 'ming' }); // reviewers not overridden -> global, unchanged
  assert.deepEqual(c.assignment.pool, ['EO', 'CC']); // overridden
  assert.deepEqual(c.assignment.in_progress_statuses, [3]); // not overridden -> global
});

test('configForProject: the identity maps reviewers/operators **merge as maps** -- a project adds its own without losing the inherited global entries (the fix for a blocker codex found)', () => {
  projectsCfg = {
    default_project: 'demo',
    projects: { demo: {}, p: { root: '/tmp/p', routing: { reviewers: { EO: 'xw-login' } }, permissions: { gate_b_allowed: ['EO'], operators: { ou_xw: 'EO' } } } },
  };
  const c = configForProject('p');
  // The reviewers map merges: the global M->ming survives alongside the project's EO->xw-login. Otherwise a
  // global short code the project inherits (go_approvers=[M], say) resolves to no login and inAllowList
  // silently stops working.
  assert.deepEqual(c.routing.reviewers, { M: 'ming', EO: 'xw-login' });
  // The operators map merges too: the global ou_m->M survives alongside the project's ou_xw->EO. Otherwise
  // resolving whoever pressed a button on an inherited card is lost.
  assert.deepEqual(c.permissions.operators, { ou_m: 'M', ou_xw: 'EO' });
  // Policy lists are still **replaced field by field**: gate_b_allowed takes the project's, while the
  // un-overridden go_approvers falls back to global.
  assert.deepEqual(c.permissions.gate_b_allowed, ['EO']);
  assert.deepEqual(c.permissions.go_approvers, ['M']);
  projectsCfg = REGISTRY;
});

test('configForProject: an unknown id falls back to the default project (which has no override, so global); with no registry, global unchanged', () => {
  assert.deepEqual(configForProject('ghost').permissions.go_approvers, ['M']); // falls back to demo, which overrides nothing
  projectsCfg = null;
  assert.deepEqual(configForProject('anything').permissions.go_approvers, ['M']); // no registry -> global
  assert.equal(configForProject('anything').routing, ROUTING); // reference-equal
  projectsCfg = REGISTRY;
});

test('configForSession: routes by session.project_id to that project\'s diverged config', () => {
  assert.deepEqual(configForSession({ project_id: 'acme' }).permissions.go_approvers, ['EO']);
  assert.deepEqual(configForSession({ project_id: 'demo' }).permissions.go_approvers, ['M']);
  assert.deepEqual(configForSession({}).permissions.go_approvers, ['M']); // no project_id -> the default project
});

test('a missing autonomy actor falls back to the **project-level** lead -- the lead after routing\'s override, not the global one', () => {
  projectsCfg = { default_project: 'demo', projects: { demo: {}, proj2: { root: '/tmp/p2', routing: { lead: 'EO' }, autonomy: { level: 2 } } } };
  // proj2 overrides routing.lead=EO and gives autonomy a level only, so the actor falls back to the
  // **project-level** lead EO, never the global M.
  assert.deepEqual(project('proj2').autonomy, { level: 2, actor: 'EO' });
  projectsCfg = REGISTRY; // restore
});
