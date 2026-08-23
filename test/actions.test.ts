// 集成：人工动作(确认/触发闸B/GO/驳回/重跑)的权限闸与状态流转。
// mock 掉飞书通知与真实写动作；权限用真 permissions.yaml(gate_b_allowed=[M,BD], go_approvers=[M])。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const writeCalls: { slug: string; dryRun?: boolean }[] = [];
let writeMode: 'ok' | 'throw' = 'ok';
mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', {
  namedExports: {
    doWrites: async (s: { slug: string }, opts: { dryRun?: boolean } = {}) => {
      writeCalls.push({ slug: s.slug, dryRun: opts.dryRun });
      if (writeMode === 'throw') throw new Error('GitHub API 暂时不可用');
      return { ok: true, stdout: '(dry) 将创建 A: feat(x)', issues: [{ repo: 'example-admin', number: 99, url: 'https://x/99' }] };
    },
  },
});

// 自动指派的负载探针走真 gh——单测里 mock 成空池（forceGateBGo 进 AWAITING_GO 会算推荐）。
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');

let n = 0;
async function at(state: string) {
  const id = `a${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'dev' });
  const path: Record<string, string[]> = {
    AWAITING_PM_CONFIRM: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM'],
    GATE_A_REVISION_REQUESTED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'GATE_A_REVISION_REQUESTED'],
    GATE_A_STALLED: ['GATE_A_RUNNING', 'GATE_A_STALLED'],
    CONFIRMED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED'],
    AWAITING_GO: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO'],
    AWAITING_GATE_B_INPUT: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GATE_B_INPUT'],
    GATE_B_STALLED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'GATE_B_STALLED'],
    GATE_B_FAILED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'GATE_B_FAILED'],
    GATE_A_FAILED: ['GATE_A_RUNNING', 'GATE_A_FAILED'],
    GATE_C_FAILED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_FAILED'],
    GATE_D_FAILED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE', 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_FAILED'],
  };
  for (const s of path[state] ?? []) await sessions.transition(id, s as never);
  if (state === 'AWAITING_GO') await sessions.patch(id, { assignee: 'M' }); // 立项需 DRI（指派层闸）；测未指派分支的用例自行清空
  return id;
}

const tmp = mkdtempSync(resolve(tmpdir(), 'forge-actions-'));
function draftPath(name: string, env: Record<string, unknown>): string {
  const p = resolve(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(env));
  return p;
}

const validGateB = {
  summary: '退款方案',
  key_decisions: {},
  tech_design_markdown: '按既有退款链路扩展',
  acceptance: {
    contracts: [{ repo: 'A', surface: 'POST /admin/refund {order_id, idem_key} -> 200 {refund_id}' }],
    scenarios: [{ id: 'AC1', repo: 'A', gherkin: 'Given 已支付订单\nWhen 以幂等键发起退款\nThen 返回 refund_id 且订单进入退款态' }],
  },
  issue_specs: [{ repo: 'A', title: 'feat(pay): 支持退款', type: 'feat', prio: 'P1' }],
  confidence: 0.8,
};

const invalidGateB = {
  ...validGateB,
  acceptance: {
    contracts: [],
    scenarios: [{ id: 'AC1', repo: 'A', gherkin: 'Given 页面\nWhen 点击退款按钮\nThen 成功' }],
  },
};

test('confirm：M 在 AWAITING_PM_CONFIRM 强制结束 → CONFIRMED', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  const r = await actions.confirm(id, 'M', 'PM 决议');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'M');
  assert.equal(s.confirmed_notes, 'PM 决议');
});

test('confirm：M 在 GATE_A_STALLED 裁决 → CONFIRMED', async () => {
  const id = await at('GATE_A_STALLED');
  const r = await actions.confirm(id, 'M', '强制通过');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED');
});

test('confirm：保留多轮 PM 答复历史（不覆盖，闸B 要读）', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  await sessions.patch(id, { confirmed_notes: '[第1轮答复] Q1 恒0' });
  await actions.confirm(id, 'M', '强制通过：剩余问题线下敲定');
  const notes = (await sessions.get(id))!.confirmed_notes ?? '';
  assert.match(notes, /第1轮答复/);
  assert.match(notes, /强制通过/);
});

test('confirm：已 CONFIRMED 幂等返回 ok（重复点不报错）', async () => {
  const id = await at('CONFIRMED');
  assert.equal((await actions.confirm(id, 'M')).ok, true);
});

test('confirm：非确认态(AWAITING_GO)拒绝', async () => {
  const id = await at('AWAITING_GO');
  assert.equal((await actions.confirm(id, 'M')).ok, false);
});

test('confirm：陌生点击人(不在 go_approvers)被拒、状态不变 + 记 permission_denied', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  const r = await actions.confirm(id, 'ou_stranger', '想强制通过'); // resolveActor 对未知 open_id 返回原值，落不进 go_approvers
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_PM_CONFIRM'); // 没被陌生人推到 CONFIRMED
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('submitPmAnswers：AWAITING_PM_CONFIRM → GATE_A_REVISION_REQUESTED + 落 pending_input', async () => {
  const id = await at('AWAITING_PM_CONFIRM');
  const r = await actions.submitPmAnswers(id, 'PM', 'Q1 不做过期，恒0');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_A_REVISION_REQUESTED');
  assert.equal(s.gate_a_pending_input, 'Q1 不做过期，恒0');
  assert.match(s.confirmed_notes ?? '', /第1轮答复/);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'pm_answer'));
});

test('submitPmAnswers：已在复评态幂等 ok；非确认态拒绝', async () => {
  const id = await at('GATE_A_REVISION_REQUESTED');
  assert.equal((await actions.submitPmAnswers(id, 'PM', 'x')).ok, true);
  const id2 = await at('AWAITING_GO');
  assert.equal((await actions.submitPmAnswers(id2, 'PM', 'x')).ok, false);
});

test('gateb：无权限者被拒、状态不变；有权限者 → GATE_B_REQUESTED', async () => {
  const id = await at('CONFIRMED');
  const denied = await actions.requestGateB(id, 'CC'); // CC 不在 gate_b_allowed
  assert.equal(denied.ok, false);
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED');
  const ok = await actions.requestGateB(id, 'M');
  assert.ok(ok.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_REQUESTED');
});

test('go：无 GO 权限被拒', async () => {
  const id = await at('AWAITING_GO');
  const denied = await actions.go(id, 'CC'); // CC 不在 go_approvers
  assert.equal(denied.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
});

test('go --dry-run：预览不改状态、不建', async () => {
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  const r = await actions.go(id, 'M', { dryRun: true });
  assert.ok(r.ok);
  assert.match(r.msg, /dry-run/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO'); // 仍在原态
  assert.deepEqual(writeCalls.at(-1), { slug: id, dryRun: true });
});

test('go：真建 → WRITING→DONE + created_issues 落库', async () => {
  writeMode = 'ok';
  const id = await at('AWAITING_GO');
  const r = await actions.go(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'DONE');
  assert.match(s.created_issues ?? '', /example-admin/);
});

test('go：外环验收不达标 → 阻止真建 issue，停在 AWAITING_GO 并留审计事件', async () => {
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, invalidGateB) });
  const r = await actions.go(id, 'M');
  const s = (await sessions.get(id))!;
  assert.equal(r.ok, false);
  assert.match(r.msg, /外环验收未达标/);
  assert.equal(s.state, 'AWAITING_GO');
  assert.equal(writeCalls.length, 0);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'acceptance_lint_blocked'));
});

test('go --dry-run：外环验收不达标只预警，不改变状态', async () => {
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, invalidGateB) });
  const r = await actions.go(id, 'M', { dryRun: true });
  assert.ok(r.ok);
  assert.match(r.msg, /外环验收 lint 未过/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.deepEqual(writeCalls.at(-1), { slug: id, dryRun: true });
});

test('go --force：外环验收不达标可人工越过，但必须记录 forced 审计', async () => {
  writeMode = 'ok';
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, invalidGateB) });
  const r = await actions.go(id, 'M', { force: true });
  const s = (await sessions.get(id))!;
  assert.ok(r.ok);
  assert.equal(s.state, 'DONE');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'acceptance_lint_forced'));
  assert.deepEqual(writeCalls.at(-1), { slug: id, dryRun: undefined });
});

test('go：写入主仓/GitHub 失败 → WRITE_FAILED，不假装 DONE，保留错误供 retry', async () => {
  writeMode = 'throw';
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { gate_b_draft_path: draftPath(id, validGateB) });
  const r = await actions.go(id, 'M');
  const s = (await sessions.get(id))!;
  assert.equal(r.ok, false);
  assert.equal(s.state, 'WRITE_FAILED');
  assert.match(s.error ?? '', /GitHub API/);
  assert.equal(s.created_issues, null);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'error' && (e.detail ?? '').includes('writing')));
  writeMode = 'ok';
});

test('go：未指派 DRI → 阻止真建，停在 AWAITING_GO 并留审计（指派层闸）', async () => {
  writeMode = 'ok';
  writeCalls.length = 0;
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: null }); // 清掉 at() 的默认指派，模拟自动推荐失败/未指派
  const r = await actions.go(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /未指派 DRI/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
  assert.equal(writeCalls.length, 0);
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'go_blocked_no_assignee'));
});

test('go --dry-run：未指派也可预览（不挡 dry-run）', async () => {
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: null });
  const r = await actions.go(id, 'M', { dryRun: true });
  assert.ok(r.ok);
  assert.match(r.msg, /dry-run/);
});

test('go --assignee：覆盖会话指派 → 标 human 落库', async () => {
  writeMode = 'ok';
  const id = await at('AWAITING_GO'); // 默认 assignee M
  const r = await actions.go(id, 'M', { assignee: 'de' }); // 大小写不敏感
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, 'DE');
  assert.equal(s.assignee_source, 'human');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'assign' && (e.detail ?? '').includes('via')));
});

test('go --assignee：非池内短码 → 挡 GO', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.go(id, 'M', { assignee: 'BD' }); // BD 不在 pool
  assert.equal(r.ok, false);
  assert.match(r.msg, /非法指派/);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO');
});

// ── 指派 assign() ──（probeLoad mock=[] → 自动推荐恒 pick=null，正好覆盖「全探测失败」分支）
test('assign 手动：写 assignee + source=human + 事件', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.assign(id, 'M', { to: 'de' }); // 大小写不敏感
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, 'DE');
  assert.equal(s.assignee_source, 'human');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'assign'));
});

test('assign 手动：非池内短码被拒', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.assign(id, 'M', { to: 'BD' }); // BD 不在 pool
  assert.equal(r.ok, false);
  assert.match(r.msg, /非法指派/);
});

test('assign：无权限被拒', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.assign(id, 'CC', { to: 'DE' }); // CC 不在 go_approvers
  assert.equal(r.ok, false);
  assert.match(r.msg, /无指派权限/);
});

test('assign --auto：全探测失败 → 清掉上一条 auto 指派，强制人工（回归）', async () => {
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: 'EO', assignee_source: 'auto' }); // 模拟上一轮自动推荐 EO
  const r = await actions.assign(id, 'M', { auto: true }); // probeLoad mock=[] → pick=null
  assert.equal(r.ok, false);
  assert.match(r.msg, /已清除上一条自动指派/);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, null); // 陈旧 auto 已清，不再蒙混过 GO 闸
  assert.equal(s.assignee_source, null);
});

test('assign --auto：全探测失败但上一条是人工指派 → 保留不动', async () => {
  const id = await at('AWAITING_GO');
  await sessions.patch(id, { assignee: 'DE', assignee_source: 'human' });
  const r = await actions.assign(id, 'M', { auto: true });
  assert.equal(r.ok, false);
  const s = (await sessions.get(id))!;
  assert.equal(s.assignee, 'DE'); // M 的明确决定不被失败探针抹掉
  assert.equal(s.assignee_source, 'human');
});

test('confirmCommentText：PM 部分采纳 / 总监强制 / 空批注', () => {
  const partial = actions.confirmCommentText(2, { who: 'PM', verdict: 'partial', notes: 'Q3 不做过期' });
  assert.match(partial, /【PM确认 · 第2轮】/);
  assert.match(partial, /选择：部分采纳/);
  assert.match(partial, /批注：Q3 不做过期/);
  const force = actions.confirmCommentText(1, { who: 'M', verdict: 'force', notes: '' });
  assert.match(force, /技术总监确认/);
  assert.match(force, /强制通过/);
  assert.match(force, /批注：（无）/);
});

test('deny：AWAITING_GO → GO_DENIED', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.deny(id, 'M', '方案要改');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GO_DENIED');
});

test('deny：陌生点击人(不在 go_approvers)被拒、状态不变 + 记 permission_denied', async () => {
  const id = await at('AWAITING_GO');
  const r = await actions.deny(id, 'ou_stranger', '想打回'); // 未知 open_id 落不进 go_approvers
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GO'); // 仍待立项，未被陌生人打回
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('retry：GATE_A_FAILED(首轮) → INTAKE 并清 error', async () => {
  const id = await at('GATE_A_FAILED');
  await sessions.patch(id, { error: 'boom' });
  const r = await actions.retry(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'INTAKE');
});

test('retry：GATE_A_FAILED(复评,有 pending_input) → GATE_A_REVISION_REQUESTED 不丢轮次', async () => {
  const id = await at('GATE_A_FAILED');
  await sessions.patch(id, { error: 'boom', gate_a_pending_input: 'PM 答复', gate_a_round: 2 });
  const r = await actions.retry(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_A_REVISION_REQUESTED');
});

test('retry：无权限(GATE_C_FAILED 非 gate_c_allowed) 被拒、状态不变 + 记 permission_denied', async () => {
  const id = await at('GATE_C_FAILED');
  await sessions.patch(id, { error: 'boom', worktree_path: '/tmp/wt' });
  const r = await actions.retry(id, 'ou_stranger'); // 陌生点击人/面板缺省 actor 不在 gate_c_allowed=[M]
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_FAILED'); // 失败闸未被无权者重新点燃
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('retry：GATE_D_FAILED 须 pr_create_approvers——M 可、陌生人不可', async () => {
  const id = await at('GATE_D_FAILED');
  await sessions.patch(id, { error: 'boom', pr_url: 'https://x/pr/1' });
  assert.equal((await actions.retry(id, 'ou_stranger')).ok, false); // 不在 pr_create_approvers=[M]
  assert.equal((await sessions.get(id))!.state, 'GATE_D_FAILED');
  assert.ok((await actions.retry(id, 'M')).ok); // M 在名单 → 真重置
  assert.equal((await sessions.get(id))!.state, 'GATE_D_LOOP');
});

// ── 闸B 多轮人在环动作 ──
test('submitGateBAnswers：AWAITING_GATE_B_INPUT → GATE_B_REVISION_REQUESTED + 落 pending_input', async () => {
  const id = await at('AWAITING_GATE_B_INPUT');
  await sessions.patch(id, { gate_b_round: 2 });
  const r = await actions.submitGateBAnswers(id, 'M', '退到余额；接受该风险');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_REVISION_REQUESTED');
  assert.equal(s.gate_b_pending_input, '退到余额；接受该风险');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gateb_answer'));
});

test('submitGateBAnswers：已在续修态幂等 ok；无关态拒绝', async () => {
  const id = await at('AWAITING_GATE_B_INPUT');
  await actions.submitGateBAnswers(id, 'M', 'x');
  assert.equal((await actions.submitGateBAnswers(id, 'M', 'y')).ok, true); // 已 GATE_B_REVISION_REQUESTED → 幂等
  const id2 = await at('AWAITING_GO');
  assert.equal((await actions.submitGateBAnswers(id2, 'M', 'x')).ok, false);
});

test('submitGateBAnswers：GATE_B_STALLED 再修一轮 → 续修，保留残留（审计证据，到 resolved 才清）', async () => {
  const id = await at('GATE_B_STALLED');
  await sessions.patch(id, { gate_b_round: 3, adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'x' }] }) });
  const r = await actions.submitGateBAnswers(id, 'M', '再改改');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_REVISION_REQUESTED');
  assert.ok(s.adversarial_residual); // 保留：续修若失败转 GATE_B_FAILED，残留仍是审计证据
});

test('submitGateBAnswers：无 gate_b_allowed 权限被拒、状态不变', async () => {
  const id = await at('AWAITING_GATE_B_INPUT');
  const r = await actions.submitGateBAnswers(id, 'CC', '随便改'); // CC 不在 gate_b_allowed
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'AWAITING_GATE_B_INPUT');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('forceGateBGo：GATE_B_STALLED + 有权限 → AWAITING_GO，保留残留', async () => {
  const id = await at('GATE_B_STALLED');
  await sessions.patch(id, { adversarial_residual: JSON.stringify({ round: 3, findings: [{ issue: 'x' }] }) });
  const r = await actions.forceGateBGo(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'AWAITING_GO');
  assert.ok(s.adversarial_residual); // 强制立项保留残留供 GO 前裁决
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'gateb_force_go'));
});

test('forceGateBGo：无 GO 权限被拒、状态不变', async () => {
  const id = await at('GATE_B_STALLED');
  const r = await actions.forceGateBGo(id, 'CC'); // CC 不在 go_approvers
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'GATE_B_STALLED');
});

test('retry：GATE_B_FAILED(有初稿+已起轮) → ADVERSARIAL_LOOP 续跑；无初稿 → GATE_B_REQUESTED', async () => {
  const id = await at('GATE_B_FAILED');
  await sessions.patch(id, { error: 'boom', gate_b_draft_path: '/tmp/x.json', gate_b_round: 2 });
  assert.ok((await actions.retry(id, 'M')).ok);
  assert.equal((await sessions.get(id))!.state, 'ADVERSARIAL_LOOP');
  const id2 = await at('GATE_B_FAILED');
  await sessions.patch(id2, { error: 'boom' }); // 无 draft
  assert.ok((await actions.retry(id2, 'M')).ok);
  assert.equal((await sessions.get(id2))!.state, 'GATE_B_REQUESTED');
});

test('retry：GATE_B_FAILED 若仍有负责人答复待落实 → 回续修点且不丢答复/残留', async () => {
  const id = await at('GATE_B_FAILED');
  await sessions.patch(id, {
    error: '改方坏 JSON',
    gate_b_draft_path: '/tmp/x.json',
    gate_b_round: 2,
    gate_b_pending_input: 'M 决定：余额退款，补幂等验收',
    adversarial_residual: JSON.stringify({ round: 2, findings: [{ issue: '退款幂等未决' }] }),
  });
  const r = await actions.retry(id, 'M');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_B_REVISION_REQUESTED');
  assert.equal(s.gate_b_pending_input, 'M 决定：余额退款，补幂等验收');
  assert.match(s.adversarial_residual ?? '', /退款幂等未决/);
  assert.equal(s.error, null);
});

// ── 选择框答复拼装（飞书下拉 + 补充说明 → 结构化回喂 fixer）──
const ask = (id: string, q: string) => ({ id, question: q, options: ['a', 'b'], context: '', severity: 'med' });

test('composeHumanAnswer：按位置 H{n} 映射所选选项 + 补充说明', () => {
  const asks = [ask('H1', '退款去向？'), ask('H2', '接受风险？')];
  const out = actions.composeHumanAnswer(asks, { ask_H1: '退到余额', ask_H2: '接受', notes: '开发期加幂等单测' });
  assert.match(out, /H1 \(退款去向？\): 退到余额/);
  assert.match(out, /H2 \(接受风险？\): 接受/);
  assert.match(out, /Notes: 开发期加幂等单测/);
});

test('composeHumanAnswer：选「其他」或未选 → 跳过该项，靠补充说明', () => {
  const asks = [ask('H1', 'Q1'), ask('H2', 'Q2')];
  const out = actions.composeHumanAnswer(asks, { ask_H1: '__other__', notes: 'H1 走特殊处理' });
  assert.doesNotMatch(out, /H1 \(/); // 选了「其他」→ 不当作选项答复（答复格式已英化，见 envelopes.composeDecisionAnswer）
  assert.doesNotMatch(out, /H2/); // 没选 → 跳过
  assert.match(out, /Notes: H1 走特殊处理/);
});

test('composeHumanAnswer：缺 id 时按序 H{n}；全空 → 空串（交 submit 兜「再修一轮」）', () => {
  const asks = [{ id: '', question: 'Q1', options: ['x'], context: '', severity: 'med' }];
  assert.match(actions.composeHumanAnswer(asks, { ask_H1: 'x' }), /H1 \(Q1\): x/);
  assert.equal(actions.composeHumanAnswer(asks, {}), '');
});

test('composeHumanAnswer：LLM 给重复 id 也不串题（按位置 H1/H2 各管各的）', () => {
  // 两条升级点模型都标了 id:"H1"——位置 id 必须把它们区分成 H1/H2，各自对应各自的问题。
  const asks = [
    { id: 'H1', question: '退款去向？', options: ['原路', '余额'], context: '', severity: 'high' },
    { id: 'H1', question: '是否接受风险？', options: ['接受', '不接受'], context: '', severity: 'med' },
  ];
  const out = actions.composeHumanAnswer(asks, { ask_H1: '余额', ask_H2: '接受' });
  assert.match(out, /H1 \(退款去向？\): 余额/);
  assert.match(out, /H2 \(是否接受风险？\): 接受/); // 第二题用 H2，不被第一题的值串掉
});
