// 评审锚定校验：claude 读活 checkout，若不在锚定 sha/脏树 → warn 披露给模型 / block 停泊。
// 守的是「绝不对非锚定代码下结论」这条评审正确性。mock util/proc 的 runSync 模拟各仓 HEAD/脏态。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

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

const { anchorCheck, reposOffRef } = await import('../src/gates/repoAnchor.ts');

const proj = { repoPath: (r: string) => `/tmp/${r}` };
const fresh = { branch: 'main', shas: { demo: 'abc123' } };

function reset(): void {
  headSha = 'abc123';
  dirty = false;
}

test('reposOffRef：HEAD==sha 且干净 → 对齐（空）；不符/脏 → 列出', () => {
  reset();
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), []);
  headSha = 'OTHER';
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']);
  reset();
  dirty = true;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']);
});

test('anchorCheck 对齐 → 空披露，不抛（warn / block 都照常）', () => {
  reset();
  assert.deepEqual(anchorCheck(proj, fresh, 'warn'), { off: [], disclosure: '' });
  assert.deepEqual(anchorCheck(proj, fresh, 'block'), { off: [], disclosure: '' });
});

test('anchorCheck warn + 偏移 → 返回披露文本（含仓名 + origin/branch + 不要当既有事实）', () => {
  reset();
  headSha = 'STALE'; // HEAD ≠ 锚定 sha
  const r = anchorCheck(proj, fresh, 'warn');
  assert.deepEqual(r.off, ['demo']);
  assert.match(r.disclosure, /checkout 未锚定/);
  assert.match(r.disclosure, /demo/);
  assert.match(r.disclosure, /origin\/main/);
  assert.match(r.disclosure, /不要把未上线/);
});

test('anchorCheck block + 偏移 → 抛（停泊，绝不对非锚定代码下结论）', () => {
  reset();
  dirty = true; // 脏树也算偏移
  assert.throws(() => anchorCheck(proj, fresh, 'block'), /未锚定 origin\/main/);
});

test('anchorCheck warn + 脏树 → 披露但不抛（保可用，告知模型）', () => {
  reset();
  dirty = true;
  const r = anchorCheck(proj, fresh, 'warn');
  assert.deepEqual(r.off, ['demo']);
  assert.notEqual(r.disclosure, '');
});
