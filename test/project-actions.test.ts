// 单测：ProjectActions demo adapter——按「该项目」注入 scriptsDir/owner 并委托 workspace.ts 脚本封装。
// 守的契约：调用方不再手传 scriptsDir/owner，adapter 统一注入（单一真源，少一类穿线错）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectFull } from '../src/projects.ts'; // type-only：不触发 projects.ts 运行时加载

interface Call {
  fn: string;
  args: unknown[];
}
const calls: Call[] = [];
const rec =
  (fn: string) =>
  (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve({ ok: true, stdout: '', stderr: '', issues: [] });
  };

mock.module('../src/workspace.ts', {
  namedExports: {
    reviewReqScaffold: rec('reviewReqScaffold'),
    techDesignScaffold: rec('techDesignScaffold'),
    techDesignApprove: rec('techDesignApprove'),
    newReqSingle: rec('newReqSingle'),
    // demo 脚本 epic 真实输出：Epic 打完整 URL（parseIssues 抓到），子 issue 只打 `✓ C#n`（无 URL）。
    newReqEpic: (...args: unknown[]) => {
      calls.push({ fn: 'newReqEpic', args });
      return Promise.resolve({
        ok: true,
        stdout: '  ✓ Epic P#10\n  ✓ C#11  c\n  ✓ U#12  u\n  → Epic: https://github.com/your-org/example-project/issues/10',
        stderr: '',
        issues: [{ repo: 'example-project', number: 10, url: 'https://github.com/your-org/example-project/issues/10' }],
      });
    },
    publishTechDesign: rec('publishTechDesign'),
    listEpicChildren: rec('listEpicChildren'),
    addLabel: rec('addLabel'),
  },
});

const { projectActions } = await import('../src/project/index.ts');
const { parseEpicChildren } = await import('../src/project/actions.ts');

// adapter 只读 scriptsDir/owner 两字段 → 用最小 ProjectFull（其余字段本测试不触及）。
const proj = { scriptsDir: '/sd', owner: 'acme' } as unknown as ProjectFull;
const pa = projectActions(proj);
const last = (): Call => calls[calls.length - 1];
function reset(): void {
  calls.length = 0;
}

test('createSingle / createEpic：把 scriptsDir + owner 注入 IssueCommon', async () => {
  reset();
  await pa.createSingle('your-monorepo', 't', { type: 'feat' });
  assert.equal(last().fn, 'newReqSingle');
  assert.deepEqual(last().args[2], { type: 'feat', scriptsDir: '/sd', owner: 'acme' });

  await pa.createEpic('ep', 'E', [{ repo: 'C', title: 'c' }], { prio: 'P1' });
  assert.equal(last().fn, 'newReqEpic');
  assert.deepEqual(last().args[3], { prio: 'P1', scriptsDir: '/sd', owner: 'acme' });
});

test('scaffold / approve / publish：注入 scriptsDir（不带 owner）', async () => {
  reset();
  await pa.scaffoldReview({ slug: 's' });
  assert.equal(last().fn, 'reviewReqScaffold');
  assert.deepEqual(last().args[0], { slug: 's', scriptsDir: '/sd' });

  await pa.scaffoldTechDesign({ slug: 's' });
  assert.equal(last().fn, 'techDesignScaffold');
  assert.deepEqual(last().args[0], { slug: 's', scriptsDir: '/sd' });

  await pa.approveTechDesign('s', '42', true);
  assert.deepEqual(last().args, ['s', '42', true, '/sd']);

  const pub = await pa.publishTechDesign('s', { base: 'main' });
  assert.deepEqual(last().args[1], { base: 'main', scriptsDir: '/sd' });
  assert.equal(pub.published, true, 'demo 真发 PR → published:true');
});

test('listEpicChildren / addLabel：注入 owner', async () => {
  reset();
  await pa.listEpicChildren('your-monorepo', 'ep');
  assert.deepEqual(last().args, ['your-monorepo', 'ep', 'acme']);

  await pa.addLabel('your-monorepo', 7, 'size:M');
  assert.deepEqual(last().args, ['your-monorepo', 7, 'size:M', 'acme']);
});

// ── 端口契约：createEpic.issues = Epic + 全部子 issue（demo adapter 解 ✓C#n 并入，doWrites 不再 know 此格式）──
test('createEpic：把 stdout 的 ✓C#n 子 issue 解出并入 issues（letter→repoMap→仓名）', async () => {
  reset();
  const demoProj = { scriptsDir: '/sd', owner: 'your-org', repoMap: { C: 'demo', U: 'example-web' } } as unknown as ProjectFull;
  const r = await projectActions(demoProj).createEpic('ep', 'E', [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }], {});
  // Epic（完整 URL）+ 两子 issue（从 ✓ C#11 / U#12 解析、letter 经 repoMap 映射成仓名）。
  assert.deepEqual(
    r.issues.map((i) => i.repo).sort(),
    ['demo', 'example-project', 'example-web'],
  );
  assert.equal(r.issues.length, 3);
});

test('parseEpicChildren：解 ✓C#n（letter→repoMap→仓名，拼 owner URL，去重）', () => {
  const out = parseEpicChildren('  ✓ C#11  c\n  ✓ U#12  u\n  ✓ C#11  dup', { C: 'demo', U: 'example-web' }, 'your-org');
  assert.deepEqual(out, [
    { repo: 'demo', number: 11, url: 'https://github.com/your-org/demo/issues/11' },
    { repo: 'example-web', number: 12, url: 'https://github.com/your-org/example-web/issues/12' },
  ]);
});
