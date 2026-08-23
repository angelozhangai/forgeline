// Unit: choosing the target code repo (a pure function). The top rule — the implementation anchors to the
// repo the requirement really changes; it takes only the valid repos within proj.repos, deduplicating while
// preserving order, and an empty result falls back to the first repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetRepos, targetReposOf, primaryTargetRepo } from '../src/util/targetRepos.ts';

const PROJ = ['demo', 'example-web', 'example-admin', 'example-engine'];
// The production repoMap (DEFAULT_REPO_MAP in projects.ts): Gate A's repos_touched emits **letters** C/U/A/E.
const MAP = { C: 'demo', U: 'example-web', A: 'example-admin', E: 'example-engine' };

// ── The production path: Gate A gives letters, which must be normalised into repo names through repoMap
// (the blocker Codex raised: with no repoMap, ["U"]/["A"] match nothing and fall back to the first repo) ──
test('resolveTargetRepos: the Gate A letters C/U/A/E -> their repo names (the real chained path)', () => {
  assert.deepEqual(resolveTargetRepos(['U'], PROJ, MAP), ['example-web']);
  assert.deepEqual(resolveTargetRepos(['A'], PROJ, MAP), ['example-admin']);
  assert.deepEqual(resolveTargetRepos(['E'], PROJ, MAP), ['example-engine']);
  assert.deepEqual(resolveTargetRepos(['C', 'U'], PROJ, MAP), ['demo', 'example-web']);
});

test('resolveTargetRepos: with no repoMap a letter has nothing to map to -> it matches nothing and falls back to the first repo (the mis-anchoring behaviour that was fixed, kept as a regression anchor)', () => {
  assert.deepEqual(resolveTargetRepos(['U'], PROJ), ['demo']); // no repoMap: U does not match a repo name -> falls back to demo (wrong)
  assert.deepEqual(resolveTargetRepos(['U'], PROJ, MAP), ['example-web']); // with repoMap: correct
});

test('resolveTargetRepos: an unknown letter Z maps to nothing -> falls back to the first repo (it never invents one); a repo name also works (what standalone passes)', () => {
  assert.deepEqual(resolveTargetRepos(['Z'], PROJ, MAP), ['demo']);
  assert.deepEqual(resolveTargetRepos(['example-web'], PROJ, MAP), ['example-web']); // already a repo name -> passed through
});

test('resolveTargetRepos: touched ∩ proj.repos, deduplicated in order', () => {
  assert.deepEqual(resolveTargetRepos(['example-web', 'demo', 'example-web'], PROJ), ['example-web', 'demo']);
});

test('resolveTargetRepos: drops a repo that is not in proj.repos (a tree is never created in the wrong repo)', () => {
  assert.deepEqual(resolveTargetRepos(['demo', 'unknown-repo'], PROJ), ['demo']);
});

test('resolveTargetRepos: empty / entirely invalid -> falls back to the first repo (the implementation is never left with nowhere to land)', () => {
  assert.deepEqual(resolveTargetRepos([], PROJ), ['demo']);
  assert.deepEqual(resolveTargetRepos(['nope'], PROJ), ['demo']);
  assert.deepEqual(resolveTargetRepos([], []), []); // a project with no repos -> empty (nothing is invented)
});

test('targetReposOf: reads session.target_repos json; malformed or empty falls back to the first repo', () => {
  assert.deepEqual(targetReposOf({ target_repos: '["example-web"]' }, PROJ), ['example-web']);
  assert.deepEqual(targetReposOf({ target_repos: null }, PROJ), ['demo']); // missing -> the first repo
  assert.deepEqual(targetReposOf({ target_repos: '{broken json' }, PROJ), ['demo']); // broken json -> the first repo, no throw
  assert.deepEqual(targetReposOf({ target_repos: '"not an array"' }, PROJ), ['demo']); // not an array -> the first repo
});

test('primaryTargetRepo: takes target_repos[0]; missing -> proj.repos[0] -> .', () => {
  assert.equal(primaryTargetRepo({ target_repos: '["example-admin","demo"]' }, PROJ), 'example-admin');
  assert.equal(primaryTargetRepo({ target_repos: null }, PROJ), 'demo');
  assert.equal(primaryTargetRepo({ target_repos: null }, []), '.'); // a project with no repos -> '.' (the monorepo fallback)
});
