// workspace.ts 是「调目标项目脚本、不重写」的类型化封装层——它的真实逻辑是**命令构造 + 输出解析**：
// 参数拼装(flag/commonFlags)、parseIssues 去重/多仓抽取、issueStates/listEpicChildren 的 JSON 解析与
// UNKNOWN 兜底。这些靠 mock proc.run 捕获 (bin,args,opts) 直接断言，不真 shell-out。
// （飞书文档那几支已迁到 src/docs/feishu.ts，用例随之搬到 docs-feishu.test.ts。）
// （commitDeliveryDocs 另有 commit-delivery-docs.test.ts 覆盖，此处不重复。）
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

interface Call {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}
type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
const calls: Call[] = [];
let responder: (bin: string, args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ bin, args, opts });
      return responder(bin, args);
    },
  },
});
const ws = await import('../src/workspace.ts');

function reset(r?: (bin: string, args: string[]) => RunResult): void {
  calls.length = 0;
  responder = r ?? (() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
}
const last = (): Call => calls[calls.length - 1];
// 取 flag 的值（--name value 形式）；不存在返回 undefined。
const valOf = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// ── 参数构造 + flag 省略 + scriptsDir 路由 ───────────────────────────────────
test('reviewReqScaffold：scaffold 参数构造，空/null flag 省略，force/dryRun 追加，scriptsDir 路由', async () => {
  reset();
  await ws.reviewReqScaffold({ slug: 's1', prd: 'P', repos: 'C,U', issues: '', owner: null, title: 'T', force: true, dryRun: true, scriptsDir: '/sd' });
  const c = last();
  assert.equal(c.bin, 'bash');
  assert.equal(c.args[0], '/sd/review-req.sh'); // scriptsDir 路由 + 脚本名
  const rest = c.args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['scaffold', 's1']);
  assert.equal(valOf(rest, '--prd'), 'P');
  assert.equal(valOf(rest, '--repos'), 'C,U');
  assert.equal(valOf(rest, '--title'), 'T');
  assert.ok(!rest.includes('--issues'), 'issues 空串应被省略');
  assert.ok(!rest.includes('--owner'), 'owner null 应被省略');
  assert.ok(rest.includes('--force') && rest.includes('--dry-run'));
});

test('reviewReqScaffold：缺 scriptsDir → 回退默认项目 SCRIPTS_DIR（脚本名仍对）', async () => {
  reset();
  await ws.reviewReqScaffold({ slug: 's' });
  assert.match(last().args[0], /[/\\]review-req\.sh$/);
  assert.ok(last().args[0].includes('/'), '是解析后的绝对路径');
  const rest = last().args.slice(1);
  assert.ok(!rest.includes('--force') && !rest.includes('--dry-run')); // 缺省不追加
});

test('techDesignScaffold：走 tech-design.sh（与 reviewReq 同构，仅脚本名不同）', async () => {
  reset();
  await ws.techDesignScaffold({ slug: 's', dryRun: true, scriptsDir: '/sd' });
  assert.equal(last().args[0], '/sd/tech-design.sh');
  assert.deepEqual(last().args.slice(1, 3), ['scaffold', 's']);
  assert.ok(last().args.includes('--dry-run'));
});

test('techDesignApprove：approve <slug> + --issue + --rollup；rollup=false/issue 空则省略', async () => {
  reset();
  await ws.techDesignApprove('sl', '42', true, '/sd');
  let rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['approve', 'sl']);
  assert.equal(valOf(rest, '--issue'), '42');
  assert.ok(rest.includes('--rollup'));

  reset();
  await ws.techDesignApprove('sl');
  rest = last().args.slice(1);
  assert.ok(!rest.includes('--rollup'), 'rollup=false 不加 --rollup');
  assert.ok(!rest.includes('--issue'), 'issue 空省略');
});

test('publishTechDesign：<slug> --base + dryRun，走 publish-tech-design.sh', async () => {
  reset();
  await ws.publishTechDesign('sl', { base: 'main', dryRun: true, scriptsDir: '/sd' });
  assert.match(last().args[0], /publish-tech-design\.sh$/);
  const rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 1), ['sl']);
  assert.equal(valOf(rest, '--base'), 'main');
  assert.ok(rest.includes('--dry-run'));
});

// ── commonFlags + parseIssues ────────────────────────────────────────────────
test('newReqSingle：single <repo> --title + commonFlags(status 数字→串, 省略 null) + 解析建好的 issue', async () => {
  reset(() => ({ code: 0, stdout: '已建 https://github.com/your-org/demo/issues/12\n', stderr: '', timedOut: false }));
  const r = await ws.newReqSingle('demo', '标题', { type: 'feature', prio: null, status: 31, assignee: 'az', scriptsDir: '/sd' });
  const rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['single', 'demo']);
  assert.equal(valOf(rest, '--title'), '标题');
  assert.equal(valOf(rest, '--type'), 'feature');
  assert.equal(valOf(rest, '--status'), '31', 'status 数字转字符串');
  assert.equal(valOf(rest, '--assignee'), 'az');
  assert.ok(!rest.includes('--prio'), 'prio null 省略');
  assert.deepEqual(r.issues, [{ repo: 'demo', number: 12, url: 'https://github.com/your-org/demo/issues/12' }]);
});

test('newReqEpic：epic <slug> + 每个 child 一个 --child repo:title；parseIssues 去重 + 仅抓 your-org 多仓', async () => {
  const stdout = [
    'https://github.com/your-org/demo/issues/1',
    'https://github.com/your-org/demo/issues/1', // 重复 → 去重
    'https://github.com/your-org/example-admin/issues/9',
    'https://github.com/other/repo/issues/5', // 非 your-org owner → 不抓
  ].join('\n');
  reset(() => ({ code: 0, stdout, stderr: '', timedOut: false }));
  const r = await ws.newReqEpic('ep', 'Epic 标题', [{ repo: 'C', title: 'a' }, { repo: 'U', title: 'b' }], {});
  const rest = last().args.slice(1);
  assert.deepEqual(rest.slice(0, 2), ['epic', 'ep']);
  const childVals: string[] = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--child') childVals.push(rest[i + 1]);
  assert.deepEqual(childVals, ['C:a', 'U:b']);
  assert.deepEqual(r.issues, [
    { repo: 'demo', number: 1, url: 'https://github.com/your-org/demo/issues/1' },
    { repo: 'example-admin', number: 9, url: 'https://github.com/your-org/example-admin/issues/9' },
  ]);
});

// ── gh 包装：addLabel / listEpicChildren / issueStates ────────────────────────
test('addLabel：gh issue edit <n> -R your-org/<repo> --add-label；失败 → ok:false + stderr', async () => {
  reset(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
  let r = await ws.addLabel('demo', 7, 'size:M');
  assert.equal(last().bin, 'gh');
  assert.deepEqual(last().args, ['issue', 'edit', '7', '-R', 'your-org/demo', '--add-label', 'size:M']);
  assert.equal(r.ok, true);

  reset(() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }));
  r = await ws.addLabel('demo', 7, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.stderr, 'boom');
});

test('listEpicChildren：gh --json 解析为 issues（按 epic:<slug> 标签查）；坏 JSON → ok:false', async () => {
  reset(() => ({ code: 0, stdout: '[{"number":3,"url":"https://github.com/your-org/demo/issues/3"}]', stderr: '', timedOut: false }));
  let r = await ws.listEpicChildren('demo', 'ep');
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, [{ repo: 'demo', number: 3, url: 'https://github.com/your-org/demo/issues/3' }]);
  assert.equal(valOf(last().args, '-l'), 'epic:ep');
  assert.equal(valOf(last().args, '-R'), 'your-org/demo');

  reset(() => ({ code: 0, stdout: 'not json', stderr: '', timedOut: false }));
  r = await ws.listEpicChildren('demo', 'ep');
  assert.equal(r.ok, false, '坏 JSON 不当成空成功，明确 ok:false');
});

test('issueStates：映射 state/reason；坏 JSON / 非零 → UNKNOWN + reason 空（取不到绝不当已合并）', async () => {
  let i = 0;
  reset(() => {
    i++;
    if (i === 1) return { code: 0, stdout: '{"state":"CLOSED","stateReason":"COMPLETED"}', stderr: '', timedOut: false };
    return { code: 0, stdout: 'broken', stderr: '', timedOut: false }; // 第二条坏 JSON
  });
  const rows = await ws.issueStates([{ repo: 'demo', number: 1, url: 'u' }, { repo: 'demo', number: 2, url: 'u' }]);
  assert.deepEqual(rows[0], { repo: 'demo', number: 1, state: 'CLOSED', reason: 'COMPLETED' });
  assert.deepEqual(rows[1], { repo: 'demo', number: 2, state: 'UNKNOWN', reason: '' });

  reset(() => ({ code: 1, stdout: '', stderr: 'x', timedOut: false })); // gh 非零
  const r2 = await ws.issueStates([{ repo: 'c', number: 9, url: 'u' }]);
  assert.equal(r2[0].state, 'UNKNOWN');
  assert.equal(r2[0].reason, '');
});

// ── owner 配置化（非默认项目，如 your-monorepo 在别的 GitHub org）────────────────
test('owner 贯穿：newReqEpic/addLabel/listEpicChildren 按传入 owner 解析，不再写死 your-org', async () => {
  // parseIssues 用传入 owner 的正则：只抓该 org，your-org 反而被排除。
  const stdout = ['https://github.com/acme/your-monorepo/issues/7', 'https://github.com/your-org/demo/issues/1'].join('\n');
  reset(() => ({ code: 0, stdout, stderr: '', timedOut: false }));
  const r = await ws.newReqEpic('ep', 'T', [{ repo: 'C', title: 'a' }], { owner: 'acme' });
  assert.deepEqual(r.issues, [{ repo: 'your-monorepo', number: 7, url: 'https://github.com/acme/your-monorepo/issues/7' }]);

  reset(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
  await ws.addLabel('your-monorepo', 7, 'size:M', 'acme');
  assert.deepEqual(last().args, ['issue', 'edit', '7', '-R', 'acme/your-monorepo', '--add-label', 'size:M']);

  reset(() => ({ code: 0, stdout: '[]', stderr: '', timedOut: false }));
  await ws.listEpicChildren('your-monorepo', 'ep', 'acme');
  assert.equal(valOf(last().args, '-R'), 'acme/your-monorepo');
});
