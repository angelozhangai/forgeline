// 单测（收 Codex 配置分化二审 Nit）：doWrites 的会话 DRI 短码→login 按**该 session 所属项目**的 reviewers 解析（SF1 回归）。
// mock config(注册表 + 生产同款 resolveLogin) + workspace(捕获建 issue 的 assignee)；projects.ts **真**（configForSession 合并是被测逻辑）。
// 固定：第二项目 acme 的 DRI 短码 EO → acme 自己的 login 'xw-login' → newReqSingle 收 'xw-login'；同短码在无覆盖的默认项目回退裸短码（证明确实按项目解析）。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// 全局 reviewers 仅 M→ming；acme 覆盖 reviewers 加 EO→xw-login（map 合并保留全局）。生产同款短码→login 解析。
function resolveLogin(cfg: { routing: { reviewers: Record<string, string> } }, code: string): string | null {
  const up = code.toUpperCase();
  for (const [k, v] of Object.entries(cfg.routing.reviewers)) if (k.toUpperCase() === up) return v;
  return null;
}
mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: () => ({
      runtime: { repos: ['demo'], scripts: {} }, // 无 tech_design_publish/delivery_doc_commit → 跳过发布/提交
      routing: { min_confidence: 0.7, sensitive_areas: [], reviewers: { M: 'ming' }, lead: 'M' },
      permissions: { gate_b_allowed: ['M'], go_approvers: ['M'] },
      assignment: { pool: ['M'], wip_limit: { default: 2 }, in_progress_statuses: [3] },
      projects: { default_project: 'demo', projects: { demo: {}, acme: { root: '/tmp/acme', routing: { reviewers: { EO: 'xw-login' } } } } },
      env: {},
    }),
    resolveLogin,
    inAllowList: () => true,
  },
});

let lastSingleAssignee: string | null | undefined;
mock.module('../src/workspace.ts', {
  namedExports: {
    publishTechDesign: async () => ({ ok: true, stdout: '', stderr: '' }),
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    newReqSingle: async (_repo: string, _title: string, o: { assignee?: string | null } = {}) => {
      lastSingleAssignee = o.assignee;
      return { ok: true, stdout: '→ https://x/issues/1', stderr: '', issues: [{ repo: 'example-admin', number: 1, url: 'https://x/issues/1' }] };
    },
    newReqEpic: async () => ({ ok: true, stdout: '', stderr: '', issues: [] }),
    techDesignApprove: async () => ({ ok: true, stdout: '', stderr: '' }),
    addLabel: async () => ({ ok: true, stderr: '' }),
    listEpicChildren: async () => ({ ok: true, issues: [], stderr: '' }),
  },
});

const { doWrites } = await import('../src/writes.ts');

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-writes-dri-'));
let seq = 0;
function singleDraft(): string {
  const p = resolve(DIR, `d-${seq++}.json`);
  writeFileSync(p, JSON.stringify({ issue_specs: [{ repo: 'A', title: 't' }], multi_repo: false }));
  return p;
}
// biome-ignore lint/suspicious/noExplicitAny: 测试夹具，部分 session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, ...over };
}

test('会话 DRI 短码→login 按**项目级** reviewers 解析（acme EO→xw-login）→ newReqSingle 收项目 login', async () => {
  lastSingleAssignee = undefined;
  await doWrites(sess({ project_id: 'acme', assignee: 'EO', gate_b_draft_path: singleDraft() }));
  assert.equal(lastSingleAssignee, 'xw-login'); // 经 acme reviewers，绝非裸短码 'EO' / 全局解析失败
});

test('同短码 EO 在默认项目 demo（无 reviewers 覆盖）→ 全局无该映射 → 回退裸短码（证明确实按项目分化）', async () => {
  lastSingleAssignee = undefined;
  await doWrites(sess({ project_id: 'demo', assignee: 'EO', gate_b_draft_path: singleDraft() }));
  assert.equal(lastSingleAssignee, 'EO'); // demo 无 EO 映射 → resolveLogin null → sessionDri 回退裸短码
});
