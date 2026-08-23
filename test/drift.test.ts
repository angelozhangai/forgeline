// 漂移闭环：纯函数（契约解析 / 全关判定 / 告警文案）+ reconcileDrift 全分支集成。
// 只 mock 边界（gh issueStates / claude / git fetch / 飞书 DM）；真实跑 session/events/config/prompt 渲染。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 边界 mock（可切换返回）──
let issueStatesResult: { repo: string; number: number; state: 'OPEN' | 'CLOSED' | 'UNKNOWN'; reason: string }[] = [];
mock.module('../src/workspace.ts', { namedExports: { issueStates: async () => issueStatesResult, commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }) } });

// reposOffRef 用 runSync 查各仓 HEAD/脏态——mock 成「对齐 origin/prod sha 且干净」（headSha 与 refresh 的 sha 一致）。
let headSha = 'abc123';
let dirty = false;
mock.module('../src/util/proc.ts', {
  namedExports: {
    runSync: (_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return `${headSha}\n`;
      if (args.includes('status')) return dirty ? ' M src/x.ts\n' : '';
      return '';
    },
  },
});

let claudeOk = true;
let claudeResult = JSON.stringify({ drifted: false, summary: '对齐', findings: [] });
let claudeCalls = 0;
let lastPrompt = '';
mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaude: async (prompt: string) => {
      claudeCalls++;
      lastPrompt = prompt;
      return { ok: claudeOk, result: claudeResult, raw: claudeResult, costUsd: 0.05, sessionId: 'c', error: claudeOk ? undefined : 'claude 超时' };
    },
  },
});

let refreshBranch = '';
mock.module('../src/gates/repoFreshness.ts', {
  namedExports: {
    refresh: (branch: string) => { refreshBranch = branch; return { branch, fetchedAt: '2026-06-17T00:00:00.000Z', shas: { demo: 'abc123' }, refsText: '- demo: `origin/main` @ `abc123`' }; },
    assertFresh: () => {},
  },
});

const dmCards: { title: string; lines: string[]; color: string }[] = [];
mock.module('../src/feishu/dm.ts', {
  namedExports: {
    // drift 现经 messaging/feishu(port) → 间接 import 全套 dm（feishu/group 还从 ./dm 取 base/token），
    // mock 必须补齐这些导出，否则 ESM 实例化时报「缺导出」。
    FEISHU_BASE: 'https://example.invalid',
    botTenantToken: async () => 'token',
    botOpenId: async () => null,
    botOpenIdCached: () => null,
    sendBotCard: async (title: string, lines: string[], color: string) => { dmCards.push({ title, lines, color }); return true; },
    sendBotCardObject: async () => true,
  },
});

const sessions = await import('../src/store/sessions.ts');
const { reconcileDrift, parseCreatedIssues, allClosed, isDropped, hasDrift, driftDm, DriftSchema } = await import('../src/drift/reconcile.ts');
const { reposOffRef } = await import('../src/gates/repoAnchor.ts'); // 已上移到 repoAnchor（仍用 util/proc 的 runSync mock）
const { strictParse } = await import('../src/llm/structured.ts');

const DRIFTED = JSON.stringify({ drifted: true, summary: '退款端点状态码变了', findings: [{ ac: 'AC1', status: 'drift', detail: 'POST /refund 返回 202 而非契约的 200', evidence: 'demo src/refund.ts:30' }] });
const CLEAN = JSON.stringify({ drifted: false, summary: '实现与契约对齐', findings: [{ ac: 'AC1', status: 'ok', detail: '满足', evidence: 'demo src/refund.ts:30' }] });
const INCONSISTENT_DRIFT = JSON.stringify({ drifted: false, summary: '顶层误写未漂移，但逐条发现退款端点不符', findings: [{ ac: 'AC1', status: 'drift', detail: 'POST /refund 返回 202 而非契约的 200', evidence: 'demo src/refund.ts:30' }] });

async function toDone(id: string): Promise<void> {
  for (const st of ['GATE_A_RUNNING', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO', 'WRITING', 'DONE']) {
    await sessions.transition(id, st as never);
  }
}
async function mkDone(id: string, opts: { issues?: boolean; acceptance?: boolean; branch?: string } = {}): Promise<void> {
  await sessions.create({ id, slug: id, title: '退款需求', branch: opts.branch ?? 'main' });
  await toDone(id);
  if (opts.issues !== false) await sessions.patch(id, { created_issues: JSON.stringify([{ repo: 'demo', number: 1, url: 'https://github.com/your-org/demo/issues/1' }]) });
  if (opts.acceptance !== false) {
    const p = join(mkdtempSync(join(tmpdir(), 'forge-drift-gateb-')), 'gate-b.json');
    writeFileSync(p, JSON.stringify({ summary: 'x', issue_specs: [], acceptance: { contracts: [{ repo: 'demo', surface: 'POST /refund -> 200 {refund_id}' }], scenarios: [{ id: 'AC1', repo: 'demo', gherkin: 'Given 已支付\nWhen 退款\nThen 200' }] } }));
    await sessions.patch(id, { gate_b_draft_path: p });
  }
}
async function kinds(id: string): Promise<string[]> {
  return (await sessions.events(id)).map((e) => e.kind);
}
function resetMocks(): void {
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' }];
  claudeOk = true; claudeResult = CLEAN; claudeCalls = 0; lastPrompt = ''; dmCards.length = 0;
  headSha = 'abc123'; dirty = false; refreshBranch = ''; // checkout 默认对齐 origin/main 且干净
}

// 设多仓 created_issues + 对应 issueStatesResult（漂移多仓废弃边）。
async function setIssues(id: string, rows: { repo: string; number: number; state: 'OPEN' | 'CLOSED' | 'UNKNOWN'; reason: string }[]): Promise<void> {
  await sessions.patch(id, { created_issues: JSON.stringify(rows.map((r) => ({ repo: r.repo, number: r.number, url: `https://github.com/your-org/${r.repo}/issues/${r.number}` }))) });
  issueStatesResult = rows;
}

// ── 纯函数 ──
test('DriftSchema/strictParse：合法漂移与对齐都过；坏 JSON 抛（不静默）', () => {
  assert.equal(strictParse(DriftSchema, DRIFTED).drifted, true);
  assert.equal(strictParse(DriftSchema, CLEAN).drifted, false);
  assert.throws(() => strictParse(DriftSchema, '不是 json'));
});

test('parseCreatedIssues：合法数组取出；null/坏 JSON/脏项 → 安全过滤', () => {
  assert.equal(parseCreatedIssues(JSON.stringify([{ repo: 'demo', number: 1, url: 'u' }])).length, 1);
  assert.deepEqual(parseCreatedIssues(null), []);
  assert.deepEqual(parseCreatedIssues('{坏'), []);
  assert.equal(parseCreatedIssues(JSON.stringify([{ repo: 'demo', number: 1 }, { repo: 'x' }])).length, 1); // 第二项缺 number → 滤掉
});

test('allClosed：空→false；全 CLOSED→true；任一 OPEN/UNKNOWN→false', () => {
  assert.equal(allClosed([]), false);
  assert.equal(allClosed([{ state: 'CLOSED' }, { state: 'CLOSED' }]), true);
  assert.equal(allClosed([{ state: 'CLOSED' }, { state: 'OPEN' }]), false);
  assert.equal(allClosed([{ state: 'CLOSED' }, { state: 'UNKNOWN' }]), false);
});

test('isDropped：NOT_PLANNED/DUPLICATE=废弃；COMPLETED/空=非废弃', () => {
  assert.equal(isDropped('NOT_PLANNED'), true);
  assert.equal(isDropped('DUPLICATE'), true);
  assert.equal(isDropped('COMPLETED'), false);
  assert.equal(isDropped(''), false);
});

test('hasDrift：逐条 findings 优先，防 LLM 顶层 drifted 误写导致假 clean', () => {
  assert.equal(hasDrift(strictParse(DriftSchema, CLEAN)), false);
  assert.equal(hasDrift(strictParse(DriftSchema, DRIFTED)), true);
  assert.equal(hasDrift(strictParse(DriftSchema, INCONSISTENT_DRIFT)), true);
});

test('reposOffRef：HEAD==sha 且干净→对齐(空)；sha 不符/脏树→列出未对齐仓', () => {
  const proj = { repoPath: () => '/x' };
  headSha = 'abc123'; dirty = false;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), []);
  headSha = 'OTHERSHA'; dirty = false;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']); // 落后/错分支 → 不对齐
  headSha = 'abc123'; dirty = true;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']); // 脏工作树 → 不对齐
});

test('driftDm：漂移告警含标题/逐条漂移/复核入口', () => {
  const s = { slug: 'refund', title: '退款', ref_num: null } as never;
  const dm = driftDm(s, strictParse(DriftSchema, DRIFTED));
  assert.match(dm.title, /the implementation has drifted/);
  assert.ok(dm.lines.some((l) => /POST \/refund 返回 202/.test(l)));
  assert.ok(dm.lines.some((l) => /forge show refund/.test(l)));
});

// ── reconcileDrift 全分支 ──
test('reconcileDrift：issue 未全关闭 → 只 poll、不审计、不记终态', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'OPEN', reason: '' }];
  await mkDone('drf-open');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.ok((await kinds('drf-open')).includes('drift_polled'));
  assert.equal((await kinds('drf-open')).includes('drift_reconciled'), false);
});

test('reconcileDrift：全关 + claude 判漂移 → drift_detected + 终态 + 私聊告警 M', async () => {
  resetMocks();
  claudeResult = DRIFTED;
  await mkDone('drf-drift');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1);
  const k = await kinds('drf-drift');
  assert.ok(k.includes('drift_detected'));
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 1);
  assert.match(dmCards[0].title, /the implementation has drifted/);
  assert.equal(dmCards[0].color, 'red');
});

test('生产链路：claude 顶层 drifted=false 但逐条验收发现漂移 → 告警，绝不记 clean 假绿', async () => {
  resetMocks();
  claudeResult = INCONSISTENT_DRIFT;
  await mkDone('drf-inconsistent');
  await reconcileDrift(Date.now());
  const k = await kinds('drf-inconsistent');
  assert.ok(k.includes('drift_detected'));
  assert.equal(k.includes('drift_clean'), false);
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 1);
  assert.match(dmCards[0].lines.join('\n'), /POST \/refund 返回 202/);
});

test('reconcileDrift：全关 + claude 判对齐 → drift_clean + 终态，不告警', async () => {
  resetMocks();
  claudeResult = CLEAN;
  await mkDone('drf-clean');
  await reconcileDrift(Date.now());
  const k = await kinds('drf-clean');
  assert.ok(k.includes('drift_clean'));
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 0);
});

test('reconcileDrift：已对账（drift_reconciled 在）→ 终态，不复跑', async () => {
  resetMocks();
  await mkDone('drf-done-once');
  await sessions.appendEvent('drf-done-once', 'drift_reconciled', { drifted: false });
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.equal((await kinds('drf-done-once')).filter((x) => x === 'drift_polled').length, 0); // 没再 poll
});

test('reconcileDrift：轮询去抖——窗口内不重复 poll，窗口过后才再 poll', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'OPEN', reason: '' }]; // 始终没合并 → 不会进终态，便于观察 poll 次数
  await mkDone('drf-throttle');
  const t0 = Date.now();
  await reconcileDrift(t0);
  await reconcileDrift(t0 + 3600 * 1000); // +1h < 24h → 去抖跳过
  assert.equal((await kinds('drf-throttle')).filter((x) => x === 'drift_polled').length, 1);
  await reconcileDrift(t0 + 25 * 3600 * 1000); // +25h > 24h → 再 poll
  assert.equal((await kinds('drf-throttle')).filter((x) => x === 'drift_polled').length, 2);
});

test('reconcileDrift：取不到 issue 态(UNKNOWN) → 不当已合并，不审计', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'UNKNOWN', reason: '' }];
  await mkDone('drf-unknown');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.equal((await kinds('drf-unknown')).includes('drift_reconciled'), false);
});

test('reconcileDrift：退避耗尽(max_polls) → 放弃记终态 + 橙色告警', async () => {
  resetMocks();
  issueStatesResult = [{ repo: 'demo', number: 1, state: 'OPEN', reason: '' }];
  await mkDone('drf-giveup');
  for (let i = 0; i < 8; i++) await sessions.appendEvent('drf-giveup', 'drift_polled', { attempt: i + 1 }); // 已达 max_polls=8
  await reconcileDrift(Date.now() + 100 * 3600 * 1000); // 越过去抖窗口
  const k = await kinds('drf-giveup');
  assert.ok(k.includes('drift_reconciled')); // 放弃也记终态
  assert.equal(claudeCalls, 0);
  assert.equal(dmCards.length, 1);
  assert.match(dmCards[0].title, /giving up/);
  assert.equal(dmCards[0].color, 'orange');
});

test('reconcileDrift：无验收契约 → 直接记终态跳过（不调 claude）', async () => {
  resetMocks();
  await mkDone('drf-noacc', { acceptance: false });
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.ok((await kinds('drf-noacc')).includes('drift_reconciled'));
});

test('reconcileDrift：claude 失败 → 本轮不记终态（留待下轮重试）', async () => {
  resetMocks();
  claudeOk = false;
  await mkDone('drf-claude-fail');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1);
  assert.equal((await kinds('drf-claude-fail')).includes('drift_reconciled'), false); // 失败不终态 → 下轮再试
});

test('reconcileDrift：claude 调用成功但输出坏 JSON（解析失败）→ 不记终态、不误报（与调用失败同纪律）', async () => {
  // 区别于上一条「调用失败」：这里 claude 正常返回，但产出无法解析为 DriftSchema。auditSession 抛 →
  // reconcileDrift 捕获 → 不写 drift_reconciled（绝不静默放过，下个窗口重试）；既不误记 clean 也不误报 drift。
  resetMocks();
  claudeOk = true;
  claudeResult = '这不是 JSON {{{';
  await mkDone('drf-parsefail');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1);
  const k = await kinds('drf-parsefail');
  assert.equal(k.includes('drift_reconciled'), false); // 解析失败不终态 → 下轮重试
  assert.equal(k.includes('drift_clean') || k.includes('drift_detected'), false); // 既不误报 clean 也不误报 drift
  assert.equal(dmCards.length, 0);
});

// ── P1：锚定 prod(main) ──
test('reconcileDrift：对账一律锚定 prod(main)，不用 session 分支(dev)', async () => {
  resetMocks();
  claudeResult = CLEAN;
  await mkDone('drf-dev', { branch: 'dev' }); // session 在 dev 上
  await reconcileDrift(Date.now());
  assert.equal(refreshBranch, 'main'); // refresh 用 prod=main，不是 session 的 dev
  assert.ok((await kinds('drf-dev')).includes('drift_reconciled'));
});

test('reconcileDrift：checkout 未对齐 origin/prod（脏/落后/错分支）→ 拒绝对账，不记终态（下轮重试）', async () => {
  resetMocks();
  headSha = 'STALE_OR_WRONG_BRANCH'; // reposOffRef 检出不对齐 → auditSession 在调 claude 前抛
  claudeResult = CLEAN;
  await mkDone('drf-offref');
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0); // 绝不对着非 main 代码下结论
  assert.equal((await kinds('drf-offref')).includes('drift_reconciled'), false);
  assert.equal(dmCards.length, 0); // 既没误报 clean 也没误报 drift
});

// ── P2：CLOSED 但废弃 ≠ 落地 ──
test('reconcileDrift：单 issue 废弃(NOT_PLANNED) = 全部废弃 → 记终态跳过、不对账', async () => {
  resetMocks();
  await mkDone('drf-notplanned', { issues: false });
  await setIssues('drf-notplanned', [{ repo: 'demo', number: 1, state: 'CLOSED', reason: 'NOT_PLANNED' }]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  const k = await kinds('drf-notplanned');
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(k.includes('drift_detected') || k.includes('drift_clean'), false); // 跳过，非漂移非对齐
});

test('reconcileDrift：全部子 issue 废弃(NOT_PLANNED+DUPLICATE) → 整条丢弃，跳过', async () => {
  resetMocks();
  await mkDone('drf-all-drop', { issues: false });
  await setIssues('drf-all-drop', [
    { repo: 'demo', number: 1, state: 'CLOSED', reason: 'NOT_PLANNED' },
    { repo: 'example-web', number: 2, state: 'CLOSED', reason: 'DUPLICATE' },
  ]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  assert.ok((await kinds('drf-all-drop')).includes('drift_reconciled'));
});

test('reconcileDrift：伞仓 Epic 废弃 → 整条丢弃，跳过（即便子 issue 完成）', async () => {
  resetMocks();
  await mkDone('drf-umbrella-drop', { issues: false });
  await setIssues('drf-umbrella-drop', [
    { repo: 'example-project', number: 99, state: 'CLOSED', reason: 'NOT_PLANNED' }, // 伞仓 Epic 本体废弃
    { repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' },
  ]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0); // 主体没了 → 不对账
  assert.ok((await kinds('drf-umbrella-drop')).includes('drift_reconciled'));
});

test('reconcileDrift：仅一个子 issue 去重(DUPLICATE)、主体仍交付 → 仍对账，废弃信息入 prompt', async () => {
  resetMocks();
  claudeResult = CLEAN;
  await mkDone('drf-partial', { issues: false });
  await setIssues('drf-partial', [
    { repo: 'example-project', number: 99, state: 'CLOSED', reason: 'COMPLETED' }, // Epic 完成
    { repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' },
    { repo: 'example-web', number: 2, state: 'CLOSED', reason: 'DUPLICATE' }, // 一个子被去重
  ]);
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 1); // 主体交付 → 仍对账，不因一个子去重丢掉整条保障
  assert.ok((await kinds('drf-partial')).includes('drift_reconciled'));
  assert.match(lastPrompt, /example-web#2/); // 废弃信息进了 prompt，供 claude 区分
  assert.match(lastPrompt, /do not report drift/);
});

// ── M4：漂移闭环接 SHIPPED（forge 自实现 PR 已人工合并）──
// SHIPPED = forge merged 人工确认合并 → 跳过 DONE 那套 issue 关闭判定，直接对账「已合并实现 vs 验收契约」。
async function mkShipped(id: string, opts: { acceptance?: boolean } = {}): Promise<void> {
  await mkDone(id, opts);
  for (const st of ['GATE_C_REQUESTED', 'GATE_C_RUNNING', 'GATE_C_LOOP', 'AWAITING_GATE_D', 'GATE_D_REQUESTED', 'GATE_D_LOOP', 'GATE_D_HARDENING', 'AWAITING_HUMAN_MERGE', 'SHIPPED']) {
    await sessions.transition(id, st as never);
  }
}

test('reconcileDrift(SHIPPED)：无验收契约（standalone）→ 直接记终态 skipped（不调 claude，不误报 drift）', async () => {
  resetMocks();
  await mkShipped('shp-noacc', { acceptance: false });
  await reconcileDrift(Date.now());
  assert.equal(claudeCalls, 0);
  const k = await kinds('shp-noacc');
  assert.ok(k.includes('drift_polled'));
  assert.ok(k.includes('drift_reconciled')); // 无契约可对账 → 记终态（如实，不假装对齐）
});

test('reconcileDrift(SHIPPED)：有契约 + checkout 未对齐 origin/prod → 不记终态、留待下轮重试', async () => {
  resetMocks();
  headSha = 'OTHERSHA'; // 本地 checkout 落后/错分支 → reposOffRef 命中 → auditSession 抛 → 本轮不终态
  await mkShipped('shp-offref');
  await reconcileDrift(Date.now());
  const k = await kinds('shp-offref');
  assert.ok(k.includes('drift_polled'));
  assert.equal(k.includes('drift_reconciled'), false); // 锚定失败不终态（绝不对着非 prod 代码下结论）
});

test('reconcileDrift(SHIPPED)：有契约 + 对齐 + claude 判漂移 → 告警 + 终态', async () => {
  resetMocks();
  claudeResult = DRIFTED;
  await mkShipped('shp-drift');
  await reconcileDrift(Date.now());
  const k = await kinds('shp-drift');
  assert.ok(k.includes('drift_detected'));
  assert.ok(k.includes('drift_reconciled'));
  assert.equal(dmCards.length, 1);
});
