// 交付文档自动提交：仅 doc pathspec、幂等、**绝不 push、不切分支**。守 README 的安全顾虑。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const calls: string[][] = [];
let addCode = 0;
let diffCode = 1; // 1=暂存区有该路径变更 → 提交；0=无变更 → 跳过
let commitCode = 0;
mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (_bin: string, args: string[]) => {
      calls.push(args);
      const code = args.includes('add') ? addCode : args.includes('diff') ? diffCode : args.includes('commit') ? commitCode : 0;
      return { code, stdout: '', stderr: code ? 'err' : '', timedOut: false };
    },
  },
});
const { commitDeliveryDocs } = await import('../src/workspace.ts');

function reset(o: { addCode?: number; diffCode?: number; commitCode?: number } = {}): void {
  calls.length = 0;
  addCode = o.addCode ?? 0;
  diffCode = o.diffCode ?? 1;
  commitCode = o.commitCode ?? 0;
}

test('有变更：add→diff→commit，每步限定 -C root + docs/delivery/<slug>，绝不 push', async () => {
  reset({ diffCode: 1 });
  const r = await commitDeliveryDocs({ root: '/proj', slug: 'foo', refNum: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.committed, true);
  for (const c of calls) {
    assert.ok(c.includes('-C') && c.includes('/proj'), `每条 git 都应 -C /proj：${c.join(' ')}`);
    assert.ok(c.includes('docs/delivery/foo'), `每条都应限定 pathspec：${c.join(' ')}`);
  }
  assert.ok(calls.some((c) => c.includes('commit') && c.some((a) => a.includes('REQ-7'))));
  assert.ok(!calls.some((c) => c.includes('push')), '绝不 push');
  assert.ok(!calls.some((c) => c.includes('checkout') || c.includes('switch')), '绝不切分支/扰动 checkout');
});

test('幂等：无该路径变更（diff exit 0）→ 跳过 commit（committed:false, ok:true）', async () => {
  reset({ diffCode: 0 });
  const r = await commitDeliveryDocs({ root: '/p', slug: 'bar' });
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
  assert.ok(!calls.some((c) => c.includes('commit')));
});

test('add 失败 → ok:false，绝不 commit', async () => {
  reset({ addCode: 1 });
  const r = await commitDeliveryDocs({ root: '/p', slug: 'baz' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, false);
  assert.ok(!calls.some((c) => c.includes('commit')));
});
