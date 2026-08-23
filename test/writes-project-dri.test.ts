// Unit tests closing a nit from codex's second review of config divergence: doWrites resolves the session
// DRI's short code to a login through **the reviewers of the project that session belongs to** (an SF1
// regression).
// config is mocked (the registry plus the same resolveLogin production uses) along with workspace (capturing
// the assignee an issue is created with); projects.ts is **real**, because configForSession's merging is the
// logic under test.
// What is pinned: in the second project, acme, the DRI short code EO resolves to acme's own login
// 'xw-login', which is what newReqSingle receives; the same short code in the default project, which
// overrides nothing, falls back to the bare short code -- proving the resolution really is per project.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// The global reviewers hold only M -> ming; acme's override adds EO -> xw-login, and the map merge keeps the
// global entry. The short-code-to-login resolution is the same one production uses.
function resolveLogin(cfg: { routing: { reviewers: Record<string, string> } }, code: string): string | null {
  const up = code.toUpperCase();
  for (const [k, v] of Object.entries(cfg.routing.reviewers)) if (k.toUpperCase() === up) return v;
  return null;
}
mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: () => ({
      runtime: { repos: ['demo'], scripts: {} }, // no tech_design_publish or delivery_doc_commit, so publishing and committing are skipped
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
// biome-ignore lint/suspicious/noExplicitAny: a test fixture holding a partial session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, ...over };
}

test('the session DRI\'s short code resolves to a login through the **project-level** reviewers (acme\'s EO -> xw-login), and newReqSingle receives that project login', async () => {
  lastSingleAssignee = undefined;
  await doWrites(sess({ project_id: 'acme', assignee: 'EO', gate_b_draft_path: singleDraft() }));
  assert.equal(lastSingleAssignee, 'xw-login'); // resolved through acme's reviewers -- never the bare 'EO', and never a failed global lookup
});

test('the same short code EO in the default project demo, which overrides no reviewers, has no global mapping and falls back to the bare short code -- proving the resolution really does diverge per project', async () => {
  lastSingleAssignee = undefined;
  await doWrites(sess({ project_id: 'demo', assignee: 'EO', gate_b_draft_path: singleDraft() }));
  assert.equal(lastSingleAssignee, 'EO'); // demo has no EO mapping, so resolveLogin returns null and sessionDri falls back to the bare short code
});
