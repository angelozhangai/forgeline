// 单测：nativeGithub adapter（proj.actions='native'）——直调 gh + 生成交付文档，不依赖项目脚本。
// 覆盖单仓全链（scaffold 文档 + 建 issue + 标签 + 查 epic 子 + approve/publish no-op）
// 及多仓 Epic 端到端（Epic→伞仓 + 子 issue→各 code 仓，本地 key 命名空间；子建失败 ok=false 不静默）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ProjectFull } from '../src/projects.ts';

interface Call {
  bin: string;
  args: string[];
}
type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
const calls: Call[] = [];
let responder: (bin: string, args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return responder(bin, args);
    },
  },
});

const { projectActions } = await import('../src/project/index.ts');
const DELIV = mkdtempSync(resolve(tmpdir(), 'forge-native-deliv-'));
const pa = projectActions({ owner: 'acme', actions: 'native', repoMap: { C: 'your-monorepo' }, repoSlugs: {}, deliveryDir: DELIV } as unknown as ProjectFull);
// monorepo 风格：本地 key '.' → GitHub slug，验 createSingle 走 repoMap→repoSlugs 两跳。
const paMono = projectActions({ owner: 'acme', actions: 'native', repoMap: { C: '.' }, repoSlugs: { '.': 'your-monorepo' }, deliveryDir: DELIV } as unknown as ProjectFull);
// 多仓 native：伞仓 umb + 两 code 仓（C→web / U→api），验 createEpic 端到端。
const paEpic = projectActions({ owner: 'acme', actions: 'native', repoMap: { C: 'web', U: 'api' }, repoSlugs: {}, umbrella: 'umb', deliveryDir: DELIV } as unknown as ProjectFull);
const last = (): Call => calls[calls.length - 1];
const valOf = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
function reset(r?: () => RunResult): void {
  calls.length = 0;
  responder = r ?? (() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
}

test('createSingle：gh issue create -R owner/repo + label/assignee，解析建好的 URL', async () => {
  reset(() => ({ code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/42\n', stderr: '', timedOut: false }));
  const r = await pa.createSingle('your-monorepo', 't', { type: 'feat', assignee: 'alice', body: 'B' });
  assert.equal(last().bin, 'gh');
  assert.deepEqual(last().args.slice(0, 4), ['issue', 'create', '-R', 'acme/your-monorepo']);
  assert.equal(valOf(last().args, '--title'), 't');
  assert.equal(valOf(last().args, '--label'), 'feat');
  assert.equal(valOf(last().args, '--assignee'), 'alice');
  assert.deepEqual(r.issues, [{ repo: 'your-monorepo', number: 42, url: 'https://github.com/acme/your-monorepo/issues/42' }]);
});

test('createSingle：短码 C 经 repoMap 映射成真实仓名（gh -R owner/<name>，非 owner/C）', async () => {
  reset(() => ({ code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/8\n', stderr: '', timedOut: false }));
  await pa.createSingle('C', 't', {});
  assert.deepEqual(last().args.slice(0, 4), ['issue', 'create', '-R', 'acme/your-monorepo']);
});

test('createSingle monorepo：本地 key 经 repoMap→repoSlugs 两跳 → gh -R owner/your-monorepo（绝不 owner/.）', async () => {
  reset(() => ({ code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/9\n', stderr: '', timedOut: false }));
  await paMono.createSingle('C', 't', {});
  assert.deepEqual(last().args.slice(0, 4), ['issue', 'create', '-R', 'acme/your-monorepo']);
});

test('createSingle dryRun：不真建（零 gh 调用）', async () => {
  reset();
  const r = await pa.createSingle('your-monorepo', 't', { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('addLabel / listEpicChildren：复用通用 gh 封装并注入 owner', async () => {
  reset(() => ({ code: 0, stdout: '[]', stderr: '', timedOut: false }));
  await pa.addLabel('your-monorepo', 7, 'size:M');
  assert.deepEqual(last().args, ['issue', 'edit', '7', '-R', 'acme/your-monorepo', '--add-label', 'size:M']);

  await pa.listEpicChildren('your-monorepo', 'ep');
  assert.equal(valOf(last().args, '-R'), 'acme/your-monorepo');
  assert.equal(valOf(last().args, '-l'), 'epic:ep');
});

test('approve/publish：native 下无动作 → no-op 返 ok（非失败，单仓 GO 才能完成）', async () => {
  const ap = await pa.approveTechDesign('s');
  assert.equal(ap.ok, true);
  const pub = await pa.publishTechDesign('s', { base: 'main' });
  assert.equal(pub.ok, true);
  assert.equal(pub.published, false, 'native 未真发 PR → published:false（DONE 文案据此不谎称 PR 已合）');
});

test('scaffoldReview/scaffoldTechDesign：生成交付文档（含 status: draft，闸据此 append + 置 active）', async () => {
  const rr = await pa.scaffoldReview({ slug: 'feat-x', prd: 'http://prd', owner: 'alice', title: '标题' });
  assert.equal(rr.ok, true);
  const reqDoc = readFileSync(resolve(DELIV, 'feat-x', 'req-review.md'), 'utf8');
  assert.match(reqDoc, /^status: draft/m, 'markReviewActive 据此置 active');
  assert.match(reqDoc, /标题/);

  const td = await pa.scaffoldTechDesign({ slug: 'feat-x', title: '标题' });
  assert.equal(td.ok, true);
  assert.ok(existsSync(resolve(DELIV, 'feat-x', 'tech-design.md')));
});

test('scaffold 非破坏：已存在不覆盖（保留闸 append 段 / 已置 active）', async () => {
  await pa.scaffoldReview({ slug: 'keep', title: 'A' });
  const p = resolve(DELIV, 'keep', 'req-review.md');
  const before = readFileSync(p, 'utf8');
  await pa.scaffoldReview({ slug: 'keep', title: 'B' }); // 二次：不应覆盖
  assert.equal(readFileSync(p, 'utf8'), before, '已存在则跳过，内容不变');
});

// ── 多仓 Epic（createEpic 端到端）──
test('createEpic 多仓：Epic→伞仓 + 子 issue→各 code 仓，均带 epic:<slug>，issues 用本地 key 命名空间', async () => {
  reset((_bin, args) => {
    const i = args.indexOf('-R');
    const slug = i >= 0 ? String(args[i + 1]).split('/')[1] : 'x';
    return { code: 0, stdout: `https://github.com/acme/${slug}/issues/5\n`, stderr: '', timedOut: false };
  });
  const r = await paEpic.createEpic('feat-x', 'E', [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }], { type: 'feat', assignee: 'alice', body: 'BODY' });
  assert.equal(r.ok, true);
  // 三个 gh issue create：伞仓 umb + 两 code 仓（短码 C/U 经 repoMap → 本地 key web/api → slug）。
  const creates = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
  assert.deepEqual(creates.map((c) => valOf(c.args, '-R')).sort(), ['acme/api', 'acme/umb', 'acme/web']);
  // 均带 epic:<slug>（retry 时 listEpicChildren 据此重新发现）。
  for (const c of creates) assert.ok(c.args.includes('epic:feat-x'), '每个 issue 带 epic:feat-x 标签');
  // 返回**本地 key** 命名空间（doWrites 覆盖校验 / size 标签据此）：umb(伞) + web + api。
  assert.deepEqual(r.issues.map((i) => i.repo).sort(), ['api', 'umb', 'web']);
});

test('createEpic：任一子 issue 建失败 → ok=false + stderr 点名（失败不静默）', async () => {
  let nth = 0;
  reset((_bin, args) => {
    nth++;
    if (nth === 2) return { code: 1, stdout: '', stderr: 'gh boom', timedOut: false }; // 首个子 issue(web) 失败
    const i = args.indexOf('-R');
    const slug = i >= 0 ? String(args[i + 1]).split('/')[1] : 'x';
    return { code: 0, stdout: `https://github.com/acme/${slug}/issues/5\n`, stderr: '', timedOut: false };
  });
  const r = await paEpic.createEpic('feat-x', 'E', [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }], {});
  assert.equal(r.ok, false, '任一子 issue 失败 → 整体 ok=false（doWrites 据此 WRITE_FAILED）');
  assert.match(r.stderr, /child\(web\)/);
});

test('createEpic dryRun：零 gh 调用，预演伞仓+各子仓', async () => {
  reset();
  const r = await paEpic.createEpic('feat-x', 'E', [{ repo: 'C', title: 'c' }], { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.match(r.stdout, /\[Epic\]/);
});
