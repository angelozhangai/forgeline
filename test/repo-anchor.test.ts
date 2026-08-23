// The review anchoring check: claude reads the live checkout, so if it is not on the anchored sha or the tree
// is dirty -> warn (disclose it to the model) or block (park).
// What this guards is the review-correctness rule "never draw conclusions against unanchored code". runSync
// from util/proc is mocked to simulate each repo's HEAD and dirtiness.
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

test('reposOffRef: HEAD == sha and clean -> aligned (empty); mismatched or dirty -> listed', () => {
  reset();
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), []);
  headSha = 'OTHER';
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']);
  reset();
  dirty = true;
  assert.deepEqual(reposOffRef(proj, { demo: 'abc123' }), ['demo']);
});

test('anchorCheck aligned -> empty disclosure, no throw (both warn and block behave normally)', () => {
  reset();
  assert.deepEqual(anchorCheck(proj, fresh, 'warn'), { off: [], disclosure: '' });
  assert.deepEqual(anchorCheck(proj, fresh, 'block'), { off: [], disclosure: '' });
});

test('anchorCheck warn + off-anchor -> returns the disclosure text (naming the repo, origin/branch, and "do not take it as existing fact")', () => {
  reset();
  headSha = 'STALE'; // HEAD differs from the anchored sha
  const r = anchorCheck(proj, fresh, 'warn');
  assert.deepEqual(r.off, ['demo']);
  assert.match(r.disclosure, /Checkout not anchored/);
  assert.match(r.disclosure, /demo/);
  assert.match(r.disclosure, /origin\/main/);
  assert.match(r.disclosure, /do not take unshipped or local changes as existing fact/);
});

test('anchorCheck block + off-anchor -> throws (park; never draw conclusions against unanchored code)', () => {
  reset();
  dirty = true; // a dirty tree also counts as off-anchor
  assert.throws(() => anchorCheck(proj, fresh, 'block'), /not anchored to origin\/main/);
});

test('anchorCheck warn + dirty tree -> discloses but does not throw (stay usable, and tell the model)', () => {
  reset();
  dirty = true;
  const r = anchorCheck(proj, fresh, 'warn');
  assert.deepEqual(r.off, ['demo']);
  assert.notEqual(r.disclosure, '');
});
