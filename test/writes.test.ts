// 单测：doWrites 写需求节点幂等（P1-D）+ 失败不静默（approve/label/子 issue 部分失败 → 抛 WRITE_FAILED）。
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// workspace 建 issue/标签/放行：计数 + 可注入失败（与真实 bash() wrapper 一致：返回 {ok:false} 而非 throw）。
let singleCalls = 0;
let epicCalls = 0;
let approveCalls = 0;
let labelCalls = 0;
let approveOk = true;
let labelOk = true;
let epicMissChild = false; // true → epic 输出缺一个子 issue 标记（模拟子 issue 建失败 continue）
let epicChildrenByRepo: Record<string, { number: number; url: string }[]> = {}; // listEpicChildren 按仓返回（模拟人工 add-child 补建）
let listChildrenCalls = 0;
let lastSingleAssignee: string | null | undefined; // 捕获传给建 issue 的 assignee（验证会话 DRI 覆盖）
let lastEpicAssignee: string | null | undefined;
let publishCalls = 0; // F3：技术方案发布主仓（须在建 issue 之前）
let lastPublishDryRun: boolean | undefined;
let publishFail = false;
const callOrder: string[] = []; // 断言 publish → newReq 顺序

// 真实 new-req.sh epic 输出：子 issue 只打印 `✓ C#n`（无完整 URL），仅 Epic 打印完整 URL。
function epicStdout(): string {
  const lines = ['═══ Epic ═══', '  ✓ Epic P#10', '  ── 子 issue ──', '    ✓ C#11  c'];
  if (!epicMissChild) lines.push('    ✓ U#12  u');
  lines.push('  → Epic: https://github.com/your-org/example-project/issues/10');
  return lines.join('\n');
}

mock.module('../src/workspace.ts', {
  namedExports: {
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
    publishTechDesign: async (_slug: string, o: { base: string; dryRun?: boolean }) => {
      publishCalls++;
      lastPublishDryRun = o.dryRun;
      callOrder.push('publish');
      return { ok: !publishFail, stdout: '', stderr: publishFail ? 'publish boom' : '' };
    },
    newReqSingle: async (_repo: string, _title: string, o: { assignee?: string | null } = {}) => {
      singleCalls++;
      lastSingleAssignee = o.assignee;
      callOrder.push('single');
      return { ok: true, stdout: 'created\n→ https://github.com/your-org/example-admin/issues/1', stderr: '', issues: [{ repo: 'example-admin', number: 1, url: 'https://github.com/your-org/example-admin/issues/1' }] };
    },
    newReqEpic: async (_slug: string, _title: string, _children: unknown[], o: { assignee?: string | null } = {}) => {
      epicCalls++;
      lastEpicAssignee = o.assignee;
      callOrder.push('epic');
      // 真实 wrapper 的 issues 来自 parseIssues(stdout) → 只含 Epic（子 issue 无 URL）。
      return { ok: true, stdout: epicStdout(), stderr: '', issues: [{ repo: 'example-project', number: 10, url: 'https://github.com/your-org/example-project/issues/10' }] };
    },
    techDesignApprove: async () => {
      approveCalls++;
      return { ok: approveOk, stdout: '', stderr: approveOk ? '' : 'approve 非零退出' };
    },
    addLabel: async () => {
      labelCalls++;
      return { ok: labelOk, stderr: labelOk ? '' : 'label 没同步' };
    },
    listEpicChildren: async (repo: string) => {
      listChildrenCalls++;
      return { ok: true, issues: (epicChildrenByRepo[repo] ?? []).map((x) => ({ repo, number: x.number, url: x.url })), stderr: '' };
    },
  },
});

const { doWrites } = await import('../src/writes.ts');

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-writes-'));
let seq = 0;
function draft(env: unknown): string {
  const p = resolve(DIR, `draft-${seq++}.json`);
  writeFileSync(p, JSON.stringify(env));
  return p;
}
// biome-ignore lint/suspicious/noExplicitAny: 测试夹具，故意用 any 造任意形状的部分 session
function sess(over: Record<string, unknown>): any {
  return { id: 'x', ref_num: 1, slug: 'feat-x', title: 'T', prd_url: null, size: 'M', created_issues: null, ...over };
}
const SINGLE = { issue_specs: [{ repo: 'A', title: 't' }], multi_repo: false };
const MULTI = { multi_repo: true, epic_title: 'E', issue_specs: [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }] };

beforeEach(() => {
  singleCalls = 0; epicCalls = 0; approveCalls = 0; labelCalls = 0; listChildrenCalls = 0;
  approveOk = true; labelOk = true; epicMissChild = false; epicChildrenByRepo = {};
  lastSingleAssignee = undefined; lastEpicAssignee = undefined;
  publishCalls = 0; lastPublishDryRun = undefined; publishFail = false; callOrder.length = 0;
});

// ── F3：技术方案先发布主仓，再建 issue ──
test('publish 在建 issue 之前（真跑）', async () => {
  await doWrites(sess({ gate_b_draft_path: draft(SINGLE) }));
  assert.equal(publishCalls, 1);
  assert.deepEqual(callOrder, ['publish', 'single']); // 先发布、后建
  assert.equal(lastPublishDryRun, undefined); // 真跑非 dry
});

test('publish 失败 → 抛 WRITE_FAILED，绝不建 issue', async () => {
  publishFail = true;
  await assert.rejects(() => doWrites(sess({ gate_b_draft_path: draft(SINGLE) })), /发布主仓失败/);
  assert.equal(singleCalls, 0); // 发布没成，不建 issue
});

test('dryRun → publish 走 --dry-run（不真发）', async () => {
  await doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), { dryRun: true });
  assert.equal(lastPublishDryRun, true);
});

// ── 会话 DRI 覆盖（指派层 → issue assignee；短码经 resolveLogin 解析）──
test('会话 assignee 覆盖单仓 issue 的 assignee（短码→login）', async () => {
  await doWrites(sess({ assignee: 'DE', gate_b_draft_path: draft(SINGLE) }));
  assert.equal(lastSingleAssignee, 'dave-eng'); // DE → login
});

test('会话 assignee 覆盖 Epic 的 DRI（盖过 issue_spec.assignee）', async () => {
  await doWrites(sess({ assignee: 'CC', gate_b_draft_path: draft({ ...MULTI, issue_specs: [{ repo: 'C', title: 'c', assignee: 'EO' }, { repo: 'U', title: 'u' }] }) }));
  assert.equal(lastEpicAssignee, 'carol-codes'); // 会话 CC 盖过 spec 的 EO
});

test('无会话 assignee → 回退 issue_spec.assignee（不破坏既有行为）', async () => {
  await doWrites(sess({ gate_b_draft_path: draft({ issue_specs: [{ repo: 'A', title: 't', assignee: 'bob-dev' }], multi_repo: false }) }));
  assert.equal(lastSingleAssignee, 'bob-dev');
});

// ── 幂等（P1-D）──
test('single 仓·首次：建 issue 一次 + onCreated 落库 + 跑 labels/approve', async () => {
  const created: unknown[] = [];
  const r = await doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), { onCreated: (iss) => created.push(...iss) });
  assert.equal(singleCalls, 1);
  assert.equal(approveCalls, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(created.length, 1);
});

test('single 仓·retry（created_issues 已有）：跳过重建，仅补跑 labels/approve', async () => {
  const _r = await doWrites(sess({
    gate_b_draft_path: draft(SINGLE),
    created_issues: JSON.stringify([{ repo: 'example-admin', number: 1, url: 'http://x/1' }]),
  }), {});
  assert.equal(singleCalls, 0);
  assert.equal(approveCalls, 1);
  assert.equal(labelCalls, 1);
});

test('多仓·首次建 Epic 一次 + 落 Epic+子 issue；retry 跳过重建', async () => {
  const created: CreatedIssueT[] = [];
  await doWrites(sess({ gate_b_draft_path: draft(MULTI) }), { onCreated: (iss) => created.push(...iss) });
  assert.equal(epicCalls, 1);
  assert.equal(created.length, 3); // Epic + 2 子 issue（从 ✓ C#/U# 解析）
  assert.deepEqual(created.map((c) => c.repo).sort(), ['demo', 'example-project', 'example-web']);

  epicCalls = 0;
  const r = await doWrites(sess({
    gate_b_draft_path: draft(MULTI),
    created_issues: JSON.stringify([{ repo: 'example-project', number: 10, url: 'http://x/10' }, { repo: 'demo', number: 11, url: 'http://x/11' }, { repo: 'example-web', number: 12, url: 'http://x/12' }]),
  }), {});
  assert.equal(epicCalls, 0);
  assert.equal(r.issues.length, 3);
});

test('dryRun：永远完整预演（即便 created_issues 有值也不当 retry 跳过）', async () => {
  await doWrites(sess({
    gate_b_draft_path: draft(SINGLE),
    created_issues: JSON.stringify([{ repo: 'example-admin', number: 1, url: 'http://x/1' }]),
  }), { dryRun: true });
  assert.equal(singleCalls, 1);
  assert.equal(approveCalls, 0);
});

// ── 失败不静默（复审 finding 1/2/3）──
test('finding1：approve 非零退出（{ok:false} 不 throw）→ doWrites 抛 → WRITE_FAILED；onCreated 已落库', async () => {
  approveOk = false;
  const created: unknown[] = [];
  await assert.rejects(() => doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), { onCreated: (iss) => created.push(...iss) }), /approve/);
  assert.equal(singleCalls, 1);
  assert.equal(created.length, 1); // 抛前已落库 → retry 不重建
});

test('finding2：多仓子 issue 部分创建失败（脚本退 0）→ 覆盖校验抛；已建出的留 created_issues', async () => {
  epicMissChild = true; // U 没建出
  const created: CreatedIssueT[] = [];
  await assert.rejects(
    () => doWrites(sess({ gate_b_draft_path: draft(MULTI) }), { onCreated: (iss) => { created.length = 0; created.push(...iss); } }),
    /子 issue 缺失/,
  );
  assert.equal(listChildrenCalls, 0); // fresh 路径不查 GitHub（靠 stdout 标记），直接挡
  assert.equal(approveCalls, 0); // 缺子 issue 不放行 status:3
  assert.deepEqual(created.map((c) => c.repo).sort(), ['demo', 'example-project']); // Epic + C 已落库（U 缺）
});

test('finding3：size 标签打失败 → 抛 → WRITE_FAILED（不静默漏 weekly-load 口径），不 approve', async () => {
  labelOk = false;
  await assert.rejects(() => doWrites(sess({ gate_b_draft_path: draft(SINGLE) }), {}), /size 标签打失败/);
  assert.equal(approveCalls, 0); // label 失败先于 approve，不放行
});

// ── 复审 finding：resume 路径也校验多仓覆盖（堵「首次挡住、重跑从侧门进 DONE」）──
test('多仓 retry：created_issues 仍缺子仓且 GitHub 也没补 → 仍抛 WRITE_FAILED，不 approve', async () => {
  // 上一轮部分失败留下 Epic + C；U 缺。GitHub 查 example-web 也没有（人工没补）。
  const s = sess({
    gate_b_draft_path: draft(MULTI),
    created_issues: JSON.stringify([{ repo: 'example-project', number: 10, url: 'http://x/10' }, { repo: 'demo', number: 11, url: 'http://x/11' }]),
  });
  await assert.rejects(() => doWrites(s, {}), /子 issue 缺失/);
  assert.equal(epicCalls, 0); // 不重建
  assert.equal(listChildrenCalls, 1); // 尝试从 GitHub 重新发现缺仓
  assert.equal(approveCalls, 0); // 缺子 issue 不放行 status:3
});

test('多仓 retry：人工 add-child 补建后 → 按 epic 标签重新发现、刷新 created_issues → approve→DONE', async () => {
  epicChildrenByRepo = { 'example-web': [{ number: 12, url: 'http://x/12' }] }; // 人工已补 U
  const created: CreatedIssueT[] = [];
  const s = sess({
    gate_b_draft_path: draft(MULTI),
    created_issues: JSON.stringify([{ repo: 'example-project', number: 10, url: 'http://x/10' }, { repo: 'demo', number: 11, url: 'http://x/11' }]),
  });
  const r = await doWrites(s, { onCreated: (iss) => { created.length = 0; created.push(...iss); } });
  assert.equal(epicCalls, 0); // 不重建
  assert.equal(listChildrenCalls, 1); // 查 example-web
  assert.equal(approveCalls, 1); // 覆盖齐了 → 放行
  assert.equal(r.issues.length, 3); // Epic + C + 补出来的 U
  assert.deepEqual(created.map((c) => c.repo).sort(), ['demo', 'example-project', 'example-web']); // 刷新落库
});

// 类型小助手（避免 any 散落）
interface CreatedIssueT { repo: string; number: number; url: string }
