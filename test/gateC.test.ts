// 集成：闸C 的人工动作（requestGateC 链式 / submitGateCAnswers / standalone addImplementTask）权限闸与状态流转，
// 外加 ciTextToVerdict 纯函数。真 permissions.yaml（gate_c_allowed=[M]）；mock 飞书/写动作/负载探针。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../src/notify.ts', { namedExports: { notify: async () => {}, syncGroupCard: async () => {} } });
mock.module('../src/writes.ts', { namedExports: { doWrites: async () => ({ ok: true, stdout: '', issues: [] }) } });
mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const actions = await import('../src/actions.ts');
const intake = await import('../src/intake.ts');
const { ciTextToVerdict, ciBase } = await import('../src/gates/gateCLoop.ts');
const gateC = await import('../src/gates/gateC.ts');

let n = 0;
// 顺合法边把一条 session 驱到目标态。
async function at(target: string): Promise<string> {
  const id = `c${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  const toDone = ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE'];
  const path: Record<string, string[]> = {
    DONE: toDone,
    GATE_C_REQUESTED: [...toDone, 'GATE_C_REQUESTED'],
    AWAITING_GATE_C_INPUT: [...toDone, 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_C_INPUT'],
    GATE_C_STALLED: [...toDone, 'GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'GATE_C_STALLED'],
    CONFIRMED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED'],
  };
  for (const st of path[target] ?? []) await sessions.transition(id, st as never);
  return id;
}

test('requestGateC：DONE + 有权限(M) → GATE_C_REQUESTED', async () => {
  const id = await at('DONE');
  const r = await actions.requestGateC(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_REQUESTED');
  assert.equal((await sessions.get(id))!.gate_c_requested_by, 'M');
});

test('requestGateC：非 DONE 态拒绝（提示用 implement --issue 单跑）', async () => {
  const id = await at('CONFIRMED');
  const r = await actions.requestGateC(id, 'M');
  assert.equal(r.ok, false);
  assert.match(r.msg, /it has to be DONE/);
  assert.equal((await sessions.get(id))!.state, 'CONFIRMED');
});

test('requestGateC：无权限者被拒、状态不变 + 记 permission_denied', async () => {
  const id = await at('DONE');
  const r = await actions.requestGateC(id, 'ZZ');
  assert.equal(r.ok, false);
  assert.equal((await sessions.get(id))!.state, 'DONE');
  assert.ok((await sessions.events(id)).some((e) => e.kind === 'permission_denied'));
});

test('requestGateC：已 GATE_C_REQUESTED 幂等 ok', async () => {
  const id = await at('GATE_C_REQUESTED');
  assert.ok((await actions.requestGateC(id, 'M')).ok);
});

test('requestGateC 链式：闸A repos_touched 字母 U → target_repos 锚正确仓 example-web（经 proj.repoMap；Codex Blocker 回归）', async () => {
  const id = await at('DONE');
  const dir = mkdtempSync(join(tmpdir(), 'forge-ga-'));
  const p = join(dir, 'gate-a.json');
  writeFileSync(p, JSON.stringify({ repos_touched: ['U'] })); // 闸A 信封产字母，绝非仓名
  await sessions.patch(id, { gate_a_output_path: p });
  assert.ok((await actions.requestGateC(id, 'M')).ok);
  assert.deepEqual(JSON.parse((await sessions.get(id))!.target_repos ?? '[]'), ['example-web']); // 字母 U 正确归一到仓名（不再静默回退 demo）
});

test('submitGateCAnswers：AWAITING_GATE_C_INPUT → GATE_C_REVISION_REQUESTED + 落 pending_input', async () => {
  const id = await at('AWAITING_GATE_C_INPUT');
  const r = await actions.submitGateCAnswers(id, 'M', '退到余额，加幂等');
  assert.ok(r.ok);
  const s = (await sessions.get(id))!;
  assert.equal(s.state, 'GATE_C_REVISION_REQUESTED');
  assert.equal(s.gate_c_pending_input, '退到余额，加幂等');
});

test('submitGateCAnswers：GATE_C_STALLED 裁决 → 续做；空答复也按再修一轮', async () => {
  const id = await at('GATE_C_STALLED');
  const r = await actions.submitGateCAnswers(id, 'M');
  assert.ok(r.ok);
  assert.equal((await sessions.get(id))!.state, 'GATE_C_REVISION_REQUESTED');
});

test('submitGateCAnswers：错误态/无权限拒绝', async () => {
  assert.equal((await actions.submitGateCAnswers(await at('DONE'), 'M')).ok, false);
  assert.equal((await actions.submitGateCAnswers(await at('AWAITING_GATE_C_INPUT'), 'ZZ')).ok, false);
});

test('addImplementTask：裸 issue → 直起 GATE_C_REQUESTED + source_kind=issue + 落 issue_ref；无 --repo → target_repos 回退首仓', async () => {
  const r = await intake.addImplementTask({ issueRef: 'your-org/x#42', title: '修登录态丢失', by: 'M' });
  assert.ok(r.ok && r.created);
  const s = r.session!;
  assert.equal(s.state, 'GATE_C_REQUESTED');
  assert.equal(s.source_kind, 'issue');
  assert.equal(s.issue_ref, 'your-org/x#42');
  assert.equal(s.gate_c_requested_by, 'M');
  assert.deepEqual(JSON.parse(s.target_repos ?? '[]'), ['demo']); // 没给 --repo → 回退 proj.repos[0]
});

test('addImplementTask：--repo 指定有效仓 → 落 target_repos；无效仓 → 报错不建（绝不在错仓建实现）', async () => {
  const ok = await intake.addImplementTask({ issueRef: 'your-org/x#43', title: '改前端', repo: 'example-web', by: 'M' });
  assert.ok(ok.ok && ok.created);
  assert.deepEqual(JSON.parse(ok.session!.target_repos ?? '[]'), ['example-web']);
  const byLetter = await intake.addImplementTask({ issueRef: 'your-org/x#45', title: '后台', repo: 'A', by: 'M' }); // 字母也接受（经 repoMap）
  assert.ok(byLetter.ok && byLetter.created);
  assert.deepEqual(JSON.parse(byLetter.session!.target_repos ?? '[]'), ['example-admin']);
  const bad = await intake.addImplementTask({ issueRef: 'your-org/x#44', title: 'x', repo: 'nope-repo', by: 'M' });
  assert.equal(bad.ok, false);
  assert.equal(bad.created, false);
  assert.match(bad.msg, /is not among the project/);
});

test('addImplementTask：同 issue_ref 去重（第二次复用，不重复建）', async () => {
  const a = await intake.addImplementTask({ issueRef: 'your-org/x#777', title: 'dup', by: 'M' });
  const b = await intake.addImplementTask({ issueRef: 'your-org/x#777', title: 'dup again', by: 'M' });
  assert.ok(a.created);
  assert.equal(b.created, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.session!.id, b.session!.id);
});

test('addImplementTask：缺 issue/title 拒绝', async () => {
  assert.equal((await intake.addImplementTask({ issueRef: '', title: 't', by: 'M' })).ok, false);
  assert.equal((await intake.addImplementTask({ issueRef: 'r#1', title: '', by: 'M' })).ok, false);
});

test('ciBase：优先 pin 住的 base_sha（非移动 ref base_ref）；都空→undefined（B2 防假绿，锁防一行回退）', () => {
  assert.equal(ciBase({ base_sha: 'SHA_PINNED', base_ref: 'origin/main' }), 'SHA_PINNED'); // pin sha 赢
  assert.equal(ciBase({ base_sha: '', base_ref: 'origin/main' }), 'origin/main'); // 缺 sha 才兜底 ref
  assert.equal(ciBase({ base_sha: '', base_ref: '' }), undefined);
});

test('implIdentity：git-ref/path 安全 + 同 id 恒等（孤儿前清/重跑能复现同一路径）', () => {
  const a = gateC.implIdentity('/ws/X', 'fix-login-aaaa1111');
  assert.match(a.implBranch, /^forge\/[a-z0-9][a-z0-9-]*$/); // 分支名仅安全字符
  assert.match(a.worktreePath, /^\/ws\/X\/\.forge\/worktrees\/[a-z0-9][a-z0-9-]*$/); // 落该仓隐藏目录 .forge/worktrees/<key>，仅安全字符
  assert.deepEqual(gateC.implIdentity('/ws/X', 'fix-login-aaaa1111'), a); // 确定性：同 id 恒等
});

test('implIdentity：同 slug 不同 session → 路径/分支必异（防前清误删活 worktree，Codex B1）', () => {
  const a = gateC.implIdentity('/ws/X', 'fix-login-aaaa1111');
  const b = gateC.implIdentity('/ws/X', 'fix-login-bbbb2222');
  assert.notEqual(a.worktreePath, b.worktreePath);
  assert.notEqual(a.implBranch, b.implBranch);
});

test('implIdentity：长 slug（触顶 slugify .slice(40)）仅尾部 shortId 不同 → key 仍不撞（哈希保唯一，不靠 shortId 存活，Codex 四审 B）', () => {
  const slug = 'a'.repeat(40); // 触顶 slugify 截断——slugify(id) 会切掉尾部 shortId
  const a = gateC.implIdentity('/ws/X', `${slug}-aaaa1111`);
  const b = gateC.implIdentity('/ws/X', `${slug}-bbbb2222`);
  assert.notEqual(a.implBranch, b.implBranch); // 截断切掉尾部时，全 id 哈希仍区分两者
  assert.notEqual(a.worktreePath, b.worktreePath);
});

test('implIdentity：非 ASCII / 不安全 id（--slug 中文覆盖）归一到 git-ref 安全 key 且仍唯一（Codex SF）', () => {
  const a = gateC.implIdentity('/ws/X', '中文 标题-a1b2c3'); // raw override 漏进 id（含 CJK/空格）
  const b = gateC.implIdentity('/ws/X', '中文 标题-d4e5f6');
  assert.match(a.implBranch, /^forge\/[a-z0-9][a-z0-9-]*$/); // 不炸分支名
  assert.match(a.worktreePath, /^\/ws\/X\/\.forge\/worktrees\/[a-z0-9][a-z0-9-]*$/);
  assert.notEqual(a.implBranch, b.implBranch); // 前缀被 CJK 塌缩时哈希仍区分
});

test('ciTextToVerdict：green→LGTM/0；unimplemented/ci_red→CHANGES/1', () => {
  assert.deepEqual(ciTextToVerdict(JSON.stringify({ state: 'green' })), { verdict: 'LGTM', findings: [] });
  const un = ciTextToVerdict(JSON.stringify({ state: 'unimplemented' }));
  assert.equal(un.verdict, 'CHANGES_REQUESTED');
  assert.equal(un.findings.length, 1);
  const red = ciTextToVerdict(JSON.stringify({ state: 'ci_red', summary: 'FAIL x' }));
  assert.equal(red.verdict, 'CHANGES_REQUESTED');
  assert.match((red.findings[0] as { issue: string }).issue, /FAIL x/);
  // 非 JSON（CI 驱动异常抛了裸文本）→ 兜底当 ci_red（绝不当绿放行），原文进 finding。
  const raw = ciTextToVerdict('panic: 脚本崩了\nstack...');
  assert.equal(raw.verdict, 'CHANGES_REQUESTED');
  assert.match((raw.findings[0] as { issue: string }).issue, /脚本崩了/);
});

// gateCContext：喂 claude 的「要做什么」上下文如何按来源组装（链式技术方案+验收 / standalone issue 正文 / 兜底）。
// 这是闸C 实现质量的源头——喂错/喂空会让 claude 跑偏，故须锁三条来源分支真实组装。
test('gateCContext：链式（有 gate-b.json）→ 技术方案 + 外环验收契约（Done 定义，须含场景）', async () => {
  const id = await at('DONE');
  const gb = join(mkdtempSync(join(tmpdir(), 'forge-gb-')), 'gate-b.json');
  writeFileSync(gb, JSON.stringify({
    tech_design_markdown: '## 方案\n用 refresh token 实现登录态持久化',
    acceptance: { contracts: [{ repo: 'C', surface: 'POST /login → 200' }], scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 已登录 When 刷新 Then 仍在线' }] },
  }));
  await sessions.patch(id, { gate_b_draft_path: gb });
  const ctx = gateC.gateCContext((await sessions.get(id))!);
  assert.match(ctx, /refresh token 实现登录态持久化/); // 技术方案 markdown
  assert.match(ctx, /Outer-loop acceptance contract/); // Done 定义标题
  assert.match(ctx, /AC1/); // 验收场景物化进上下文（实现要让它从红翻绿）
});

test('gateCContext：standalone（无 gate-b，有 gatec-input.md）→ 返回落盘的 issue 正文', async () => {
  const id = await at('DONE'); // 无 gate_b_draft_path
  const { input } = gateC.gateCPaths(id);
  mkdirSync(join(input, '..'), { recursive: true });
  writeFileSync(input, '# Issue\n修复登录态丢失：刷新后掉登录');
  const ctx = gateC.gateCContext((await sessions.get(id))!);
  assert.match(ctx, /修复登录态丢失/);
});

test('gateCContext：无方案 / 无 issue → 兜底提示（按标题+既有代码，遇不确定升级），绝不喂空壳', async () => {
  const id = await at('DONE');
  const ctx = gateC.gateCContext((await sessions.get(id))!);
  assert.ok(ctx.trim().length > 0); // 绝不喂空壳
  assert.match(ctx, /no tech design/); // 兜底分支的辨识标记（区别于链式技术方案 / standalone issue 正文；此为有意的引导文案）
  assert.match(ctx, /needs_human/); // 用稳定概念关键词锁「引导遇不确定就升级」，不耦合具体措辞（Codex Nit1）
});

test('gateCContext：gate-b.json 损坏 → 不崩，优雅降级到兜底（绝不因上游坏稿炸掉实现器）', async () => {
  const id = await at('DONE');
  const gb = join(mkdtempSync(join(tmpdir(), 'forge-gb-bad-')), 'gate-b.json');
  writeFileSync(gb, '这不是合法 JSON {{{'); // 上游草稿损坏
  await sessions.patch(id, { gate_b_draft_path: gb });
  const ctx = gateC.gateCContext((await sessions.get(id))!); // 解析抛 → catch 吞 → 落兜底（无 input 文件）
  assert.ok(ctx.trim().length > 0); // 与上面兜底断言同口径（Codex 二审 Nit3）
  assert.match(ctx, /no tech design/);
  assert.match(ctx, /needs_human/);
});
