// Committing the delivery documents automatically: limited to the document pathspec, idempotent, and it
// **never pushes and never switches branch**. This guards the safety concern the README raises.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const calls: string[][] = [];
let addCode = 0;
let diffCode = 1; // 1 = that path has staged changes, so commit; 0 = nothing changed, so skip
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

test('with changes: add, diff, commit -- each step limited to -C root and docs/delivery/<slug>, and it never pushes', async () => {
  reset({ diffCode: 1 });
  const r = await commitDeliveryDocs({ root: '/proj', slug: 'foo', refNum: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.committed, true);
  for (const c of calls) {
    assert.ok(c.includes('-C') && c.includes('/proj'), `every git call should be -C /proj: ${c.join(' ')}`);
    assert.ok(c.includes('docs/delivery/foo'), `every call should be limited to the pathspec: ${c.join(' ')}`);
  }
  assert.ok(calls.some((c) => c.includes('commit') && c.some((a) => a.includes('REQ-7'))));
  assert.ok(!calls.some((c) => c.includes('push')), 'it never pushes');
  assert.ok(!calls.some((c) => c.includes('checkout') || c.includes('switch')), 'it never switches branch or otherwise disturbs the checkout');
});

test('idempotent: nothing changed under that path (diff exits 0) -> the commit is skipped, giving committed:false with ok:true', async () => {
  reset({ diffCode: 0 });
  const r = await commitDeliveryDocs({ root: '/p', slug: 'bar' });
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
  assert.ok(!calls.some((c) => c.includes('commit')));
});

test('a failed add gives ok:false and never commits', async () => {
  reset({ addCode: 1 });
  const r = await commitDeliveryDocs({ root: '/p', slug: 'baz' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, false);
  assert.ok(!calls.some((c) => c.includes('commit')));
});
