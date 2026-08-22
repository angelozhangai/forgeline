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

// 权限/简称解析：短码大小写不敏感、短码与 login 均可命中名单。
const cfg = {
  routing: { reviewers: { M: 'alice-lead', CC: 'carol-codes', EO: 'erin-ops' }, lead: 'M', min_confidence: 0.7, sensitive_areas: [] },
  permissions: { gate_b_allowed: ['M', 'BD'], go_approvers: ['M'] },
} as unknown as Config;

test('resolveLogin：短码→login，大小写不敏感', () => {
  assert.equal(resolveLogin(cfg, 'M'), 'alice-lead');
  assert.equal(resolveLogin(cfg, 'm'), 'alice-lead');
  assert.equal(resolveLogin(cfg, 'cc'), 'carol-codes');
  assert.equal(resolveLogin(cfg, '未知'), null);
});

test('inAllowList：短码命中', () => {
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'M'), true);
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'm'), true);
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'CC'), false); // 不在 go_approvers
});

test('inAllowList：传 login 也能命中（解析回短码）', () => {
  assert.equal(inAllowList(cfg, cfg.permissions.go_approvers, 'alice-lead'), true);
  assert.equal(inAllowList(cfg, cfg.permissions.gate_b_allowed, 'alice-lead'), true);
});

test('inAllowList：不在名单 → 拒绝', () => {
  assert.equal(inAllowList(cfg, cfg.permissions.gate_b_allowed, 'CC'), false);
  assert.equal(inAllowList(cfg, cfg.permissions.gate_b_allowed, 'carol-codes'), false);
});

// ── 配置 schema 校验（zod）────────────────────────────────
// 真实 on-disk 配置必须始终过校验：这条把「yaml 改了但 schema 没跟上」之类漂移当场逮住。
test('仓内真实 runtime.yaml：plaintext 文档源默认关（开=「@机器人+一段话」就自动跑闸A 花钱）', () => {
  assert.equal(loadConfig().runtime.doc_sources?.plaintext?.enabled ?? false, false);
});

test('loadConfig：仓内真实 yaml 全部通过校验', () => {
  const c = loadConfig();
  assert.ok(c.runtime.poll_interval_sec > 0);
  assert.ok(c.runtime.repos.length >= 1);
  assert.ok(['prod', 'dev'].includes(c.runtime.default_branch));
  assert.ok(['codex', 'claude'].includes(c.runtime.adversarial.reviewer));
  assert.ok(c.routing.min_confidence >= 0 && c.routing.min_confidence <= 1);
  assert.ok(Array.isArray(c.permissions.go_approvers));
});

// 一份合法 runtime 基线，下面各用例只破坏其中一处。
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

test('RuntimeSchema：合法基线通过', () => {
  assert.equal(RuntimeSchema.safeParse(validRuntime).success, true);
});

test('RuntimeSchema：拼错键（typo）被 strict 逮住', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, poll_intervall_sec: 180 });
  assert.equal(r.success, false);
});

test('RuntimeSchema：health.contract_check / contract_interval_hours 合法通过', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, health: { contract_check: true, contract_interval_hours: 24 } });
  assert.equal(r.success, true);
});

test('RuntimeSchema：health 块里未知键仍被 strict 逮住', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, health: { contract_chek: true } });
  assert.equal(r.success, false);
});

test('RuntimeSchema：类型错（max_parallel 非数字）被逮', () => {
  const r = RuntimeSchema.safeParse({ ...validRuntime, max_parallel: 'two' });
  assert.equal(r.success, false);
});

test('RuntimeSchema：枚举越界（default_branch / reviewer）被逮', () => {
  assert.equal(RuntimeSchema.safeParse({ ...validRuntime, default_branch: 'stage' }).success, false);
  assert.equal(
    RuntimeSchema.safeParse({ ...validRuntime, adversarial: { reviewer: 'gpt', on_missing: 'claude', max_rounds: 3 } }).success,
    false,
  );
});

test('RuntimeSchema：漏必填（repos 空）被逮', () => {
  assert.equal(RuntimeSchema.safeParse({ ...validRuntime, repos: [] }).success, false);
});

test('RoutingSchema：min_confidence 越界被逮', () => {
  const base = { min_confidence: 0.7, sensitive_areas: [], reviewers: { M: 'alice-lead' }, lead: 'M' };
  assert.equal(RoutingSchema.safeParse(base).success, true);
  assert.equal(RoutingSchema.safeParse({ ...base, min_confidence: 1.5 }).success, false);
});

test('PermissionsSchema：缺名单字段被逮', () => {
  assert.equal(PermissionsSchema.safeParse({ gate_b_allowed: ['M'], go_approvers: ['M'] }).success, true);
  assert.equal(PermissionsSchema.safeParse({ gate_b_allowed: ['M'] }).success, false);
});

test('ProjectsSchema：默认项目可省略 root（自动找兄弟）', () => {
  const r = ProjectsSchema.safeParse({ default_project: 'demo', projects: { demo: { chats: ['oc_x'] } } });
  assert.equal(r.success, true);
});

test('ProjectsSchema：非默认项目漏 root → 启动即拦', () => {
  const r = ProjectsSchema.safeParse({
    default_project: 'demo',
    projects: { demo: {}, acme: { repos: ['acme-web'] } }, // acme 漏 root
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues.some((i) => i.path.join('.') === 'projects.acme.root'), true);
  }
});

test('ProjectsSchema：非默认项目给了 root → 通过', () => {
  const r = ProjectsSchema.safeParse({
    default_project: 'demo',
    projects: { demo: {}, acme: { root: '/abs/acme', repos: ['acme-web'] } },
  });
  assert.equal(r.success, true);
});

test('ProjectsSchema（SF2）：把非 demo 设成 default_project 又漏 root → 仍拦（只有内建 demo 可省略 root）', () => {
  // 否则 schema 放过、运行时却静默回落到 demo 的 ../example-project root，指错 checkout。
  const r = ProjectsSchema.safeParse({
    default_project: 'your-monorepo',
    projects: { demo: {}, 'your-monorepo': { repos: ['.'] } }, // your-monorepo 是 default 但漏 root
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues.some((i) => i.path.join('.') === 'projects.your-monorepo.root'), true);
  }
});
