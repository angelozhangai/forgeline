import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLogin,
  inAllowList,
  loadConfig,
  RuntimeSchema,
  RoutingSchema,
  PermissionsSchema,
  ProjectsSchema,
} from '../src/config.ts';
import type { Config } from '../src/config.ts';

// Permissions and short-code resolution: short codes are case-insensitive, and either a short code or a
// login matches an allow list.
const cfg = {
  routing: { reviewers: { M: 'alice-lead', CC: 'carol-codes', EO: 'erin-ops' }, lead: 'M', min_confidence: 0.7, sensitive_areas: [] },
  permissions: { gate_b_allowed: ['M', 'BD'], go_approvers: ['M'] },
} as unknown as Config;

test('resolveLogin: a short code becomes a login, case-insensitively', () => {
  assert.equal(resolveLogin(cfg, 'M'), 'alice-lead');
  assert.equal(resolveLogin(cfg, 'm'), 'alice-lead');
  assert.equal(resolveLogin(cfg, 'cc'), 'carol-codes');
  assert.equal(resolveLogin(cfg, 'unknown'), null);
});

test('inAllowList: a short code matches', () => {
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'M'), true);
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'm'), true);
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'CC'), false); // not in go_approvers
});

test('inAllowList: passing a login matches too, by resolving it back to the short code', () => {
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'alice-lead'), true);
  assert.equal(inAllowList(cfg, cfg.permissions.gate_b_allowed, 'alice-lead'), true);
});

test('inAllowList: not on the list -> refused', () => {
  assert.equal(inAllowList(cfg, cfg.permissions.gate_b_allowed, 'CC'), false);
  assert.equal(inAllowList(cfg, cfg.permissions.gate_b_allowed, 'carol-codes'), false);
});

// -- Config schema validation (zod) ------------------------
// The real on-disk config must always validate: this catches drift such as the yaml changing while the
// schema did not keep up.
test('the repo\'s real runtime.yaml: the plaintext document source is off by default (turning it on makes "@bot plus a paragraph" cost a gate A run)', () => {
  assert.equal(loadConfig().runtime.doc_sources?.plaintext?.enabled ?? false, false);
});

test('loadConfig: every real yaml file in the repo validates', () => {
  const c = loadConfig();
  assert.ok(c.runtime.poll_interval_sec > 0);
  assert.ok(c.runtime.repos.length >= 1);
  assert.ok(['prod', 'dev'].includes(c.runtime.default_branch));
  assert.ok(['codex', 'claude'].includes(c.runtime.adversarial.reviewer));
  assert.ok(c.routing.min_confidence >= 0 && c.routing.min_confidence <= 1);
  assert.ok(Array.isArray(c.permissions.go_approvers));
});

// A valid runtime baseline; each test below breaks exactly one thing in it.
const validRuntime = {
  poll_interval_sec: 180,
  max_parallel: 2,
  branches: { prod: 'main', dev: 'dev' },
  default_branch: 'dev',
  repos: ['demo', 'example-web'],
  adversarial: { reviewer: 'codex', on_missing: 'claude', max_rounds: 3 },
  claude_bin: 'claude',
  codex_bin: 'codex',
  claude_allowed_tools: 'Read,Grep',
  claude_timeout_sec: 1200,
};

test('RuntimeSchema: the valid baseline passes', () => {
  assert.equal(RuntimeSchema.safeParse(validRuntime).success, true);
});

test('RuntimeSchema: a misspelled key is caught by strict', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, poll_intervall_sec: 180 });
  assert.equal(r.success, false);
});

test('RuntimeSchema: health.contract_check and contract_interval_hours are valid and pass', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, health: { contract_check: true, contract_interval_hours: 24 } });
  assert.equal(r.success, true);
});

test('RuntimeSchema: an unknown key inside the health block is still caught by strict', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, health: { contract_chek: true } });
  assert.equal(r.success, false);
});

test('RuntimeSchema: a wrong type (max_parallel not a number) is caught', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, max_parallel: 'two' });
  assert.equal(r.success, false);
});

test('RuntimeSchema: a value outside the enum (default_branch, reviewer) is caught', () => {
  assert.equal(RuntimeSchema.safeParse({ ...validRuntime, default_branch: 'stage' }).success, false);
  assert.equal(
    RuntimeSchema.safeParse({ ...validRuntime, adversarial: { reviewer: 'gpt', on_missing: 'claude', max_rounds: 3 } }).success,
    false,
  );
});

test('RuntimeSchema: a missing required field (an empty repos) is caught', () => {
  assert.equal(RuntimeSchema.safeParse({ ...validRuntime, repos: [] }).success, false);
});

test('RoutingSchema: a min_confidence out of range is caught', () => {
  const base = { min_confidence: 0.7, sensitive_areas: [], reviewers: { M: 'alice-lead' }, lead: 'M' };
  assert.equal(RoutingSchema.safeParse(base).success, true);
  assert.equal(RoutingSchema.safeParse({ ...base, min_confidence: 1.5 }).success, false);
});

test('PermissionsSchema: a missing allow-list field is caught', () => {
  assert.equal(PermissionsSchema.safeParse({ gate_b_allowed: ['M'], go_approvers: ['M'] }).success, true);
  assert.equal(PermissionsSchema.safeParse({ gate_b_allowed: ['M'] }).success, false);
});

test('ProjectsSchema: the default project may omit root, and a sibling checkout is found automatically', () => {
  const r = ProjectsSchema.safeParse({ default_project: 'demo', projects: { demo: { chats: ['oc_x'] } } });
  assert.equal(r.success, true);
});

test('ProjectsSchema: a non-default project missing root is blocked at startup', () => {
  const r = ProjectsSchema.safeParse({
    default_project: 'demo',
    projects: { demo: {}, acme: { repos: ['acme-web'] } }, // acme has no root
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues.some((i) => i.path.join('.') === 'projects.acme.root'), true);
  }
});

test('ProjectsSchema: a non-default project that gives a root passes', () => {
  const r = ProjectsSchema.safeParse({
    default_project: 'demo',
    projects: { demo: {}, acme: { root: '/abs/acme', repos: ['acme-web'] } },
  });
  assert.equal(r.success, true);
});

test('ProjectsSchema (SF2): naming something other than demo as default_project while omitting root is still blocked -- only the built-in demo may omit it', () => {
  // Otherwise the schema waves it through and the runtime silently falls back to demo's ../example-project
  // root, pointing at the wrong checkout.
  const r = ProjectsSchema.safeParse({
    default_project: 'your-monorepo',
    projects: { demo: {}, 'your-monorepo': { repos: ['.'] } }, // your-monorepo is the default but has no root
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues.some((i) => i.path.join('.') === 'projects.your-monorepo.root'), true);
  }
});
