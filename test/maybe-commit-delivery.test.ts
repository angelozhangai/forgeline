// 单测：maybeCommitDeliveryDocs 的 config 门控 + enabled 真分支——开 → 委托 commitDeliveryDocs 跑 git（add→diff→commit）、
// **绝不 push**、返回 committed；关 → 直接 no-op 不碰 git。git 由 proc mock 截获（不起真 git）。门控读 mock config。
process.env.FORGE_DB = ':memory:';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let deliveryEnabled = true;
// 完整 cfg（满足 root.ts→project.ts 加载期 defaultProject 读 runtime）；delivery_doc_commit 由 deliveryEnabled 动态决定。
const base = {
  poll_interval_sec: 180, max_parallel: 2, branches: { prod: 'main', dev: 'dev' }, default_branch: 'prod',
  repos: ['demo'], adversarial: { reviewer: 'codex', on_missing: 'skip', max_rounds: 3 },
  claude_bin: 'claude', codex_bin: 'codex', claude_allowed_tools: '', claude_timeout_sec: 1,
};
function cfg() {
  return {
    runtime: { ...base, delivery_doc_commit: { enabled: deliveryEnabled } },
    routing: { min_confidence: 0.7, sensitive_areas: [], reviewers: {}, lead: 'M' },
    permissions: { gate_b_allowed: ['M'], go_approvers: ['M'], operators: {} },
    assignment: { pool: ['M'], wip_limit: { default: 2 }, in_progress_statuses: [3] },
    projects: null, env: {},
  };
}
mock.module('../src/config.ts', {
  namedExports: { loadConfig: cfg, resolveLogin: () => null, inAllowList: () => true },
});
// configForProject/Session 桩回退同一受控配置（writes.ts 导入了 configForSession，须提供桩否则链接报错）。
mock.module('../src/projects.ts', {
  namedExports: { projectForSession: () => ({ root: '/proj' }), project: () => ({ root: '/proj' }), defaultProjectId: () => 'p', configForProject: cfg, configForSession: cfg },
});
// git 截获：add 退 0；diff --cached --quiet 退 1（=有该路径变更 → 提交）；commit 退 0。可切 diffCode 测「无变更跳过」。
let calls: string[][] = [];
let diffCode = 1;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (_bin: string, args: string[]) => {
      calls.push(args);
      const code = args.includes('add') ? 0 : args.includes('diff') ? diffCode : 0;
      return { code, stdout: '', stderr: '', timedOut: false };
    },
    runSync: () => '',
    commandExists: () => true,
  },
});

const { maybeCommitDeliveryDocs } = await import('../src/writes.ts');

const S = { id: 's1', slug: 'feat-x', ref_num: 7 } as never;

beforeEach(() => { calls = []; diffCode = 1; deliveryEnabled = true; });

test('开 + 有变更：委托 git 提交 docs/delivery/<slug>、绝不 push → committed:true', async () => {
  const r = await maybeCommitDeliveryDocs(S);
  assert.deepEqual(r, { ok: true, committed: true });
  assert.ok(calls.some((c) => c.includes('commit') && c.includes('docs/delivery/feat-x')), '提交限定 doc pathspec');
  assert.ok(calls.every((c) => c.includes('-C') && c.includes('/proj')), '每条 git 都 -C 目标项目 root');
  assert.ok(!calls.some((c) => c.includes('push')), '绝不 push');
});

test('开 + 无变更（diff 退 0）：幂等跳过 → committed:false，不 commit', async () => {
  diffCode = 0;
  const r = await maybeCommitDeliveryDocs(S);
  assert.deepEqual(r, { ok: true, committed: false });
  assert.ok(!calls.some((c) => c.includes('commit')));
});

test('关（默认门控关）：直接 no-op → committed:false，根本不碰 git', async () => {
  deliveryEnabled = false;
  const r = await maybeCommitDeliveryDocs(S);
  assert.deepEqual(r, { ok: true, committed: false });
  assert.equal(calls.length, 0, '门控关 → 不调任何 git');
});
