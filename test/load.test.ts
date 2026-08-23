// Unit: aggregating the load currently in progress (scoreLoad, a pure function). ⚠️ The formula mirrors the
// main repo's weekly-load (size x cross-repo breadth); to change it, change the main repo first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLoad, crossStack, buildRepoCode, type LoadIssue } from '../src/util/load.ts';

const OPTS = { inProgressStatuses: [4, 5, 6] };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const iss = (repo: string, number: number, labels: string[]): LoadIssue => ({ repo, number, labels });

test('crossStack: one repo 1.0 / two 1.3 / three 1.5', () => {
  assert.equal(crossStack(1), 1.0);
  assert.equal(crossStack(2), 1.3);
  assert.equal(crossStack(3), 1.5);
});

test('an epic spanning two repos collapses into one requirement without double-counting; cross-repo x1.3, and size takes the highest tier', () => {
  const r = scoreLoad(
    [
      iss('demo', 1, ['epic:login', 'status:4-in-development', 'size:M']),
      iss('example-admin', 2, ['epic:login', 'status:5-review', 'size:L']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].size, 'L'); // the higher of M and L
  assert.equal(r.items[0].span, 2);
  close(r.loadPoints, 8 * 1.3); // L=8 x two repos 1.3
});

test('a single-repo issue counts as one requirement each', () => {
  const r = scoreLoad(
    [
      iss('demo', 3, ['status:4-in-development', 'size:M']),
      iss('example-web', 4, ['status:6-in-testing', 'size:S']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 2);
  close(r.loadPoints, 3 + 1); // M x1 + S x1
});

test('only what is in progress counts: shipped (7), early (3) and no status at all are all excluded', () => {
  const r = scoreLoad(
    [
      iss('demo', 5, ['status:7-shipped', 'size:XL']),
      iss('demo', 6, ['status:3-todo', 'size:L']),
      iss('demo', 7, ['size:M']), // no status
      iss('demo', 8, ['status:4-in-development', 'size:M']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1);
  close(r.loadPoints, 3);
});

// Source is English, input is not: these labels come from the target project's GitHub, and only the ordinal
// prefix is parsed. The label text itself is data and may be written in any language, so the fixture is built
// from code points rather than as literal characters (see test/english-only.test.ts).
test("a status label's wording is irrelevant — only the ordinal prefix is read, in any language", () => {
  const inDevelopment = String.fromCodePoint(0x5f00, 0x53d1, 0x4e2d); // "in development"
  const r = scoreLoad([iss('demo', 40, [`status:4-${inDevelopment}`, 'size:M'])], OPTS);
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].status, 4);
  close(r.loadPoints, 3);
});

test('size defaults to M', () => {
  const r = scoreLoad([iss('demo', 9, ['status:4-in-development'])], OPTS);
  assert.equal(r.items[0].size, 'M');
  close(r.loadPoints, 3);
});

test('an epic across three repos -> cross-repo 1.5; example-project (P) is the Epic itself and does not count towards span', () => {
  const r = scoreLoad(
    [
      iss('demo', 10, ['epic:big', 'status:4-in-development', 'size:M']),
      iss('example-web', 11, ['epic:big', 'status:4-in-development']),
      iss('example-admin', 12, ['epic:big', 'status:4-in-development']),
      iss('example-project', 13, ['epic:big', 'status:4-in-development']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].span, 3); // the three repos C/U/A; P does not count
  close(r.loadPoints, 3 * 1.5);
});

test('the Epic rollup lags: P is still 3 while the code sub-repos are already 4 -> judge by the sub-repos (a lagging P must not drag it out)', () => {
  const r = scoreLoad(
    [
      iss('example-project', 20, ['epic:lag', 'status:3-todo']), // the P Epic rollup has not run and still lags
      iss('demo', 21, ['epic:lag', 'status:4-in-development', 'size:M']),
      iss('example-admin', 22, ['epic:lag', 'status:4-in-development']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1); // an active cross-repo requirement must not be counted as idle
  assert.equal(r.items[0].status, 4); // it takes the code sub-repos' rollup, not P's 3
  assert.equal(r.items[0].span, 2);
  close(r.loadPoints, 3 * 1.3);
});

test('a pure-P requirement (no code sub-issue yet) -> judged in progress by P\'s own status', () => {
  const inProg = scoreLoad([iss('example-project', 30, ['epic:placeholder', 'status:4-in-development'])], OPTS);
  assert.equal(inProg.wip, 1);
  assert.equal(inProg.items[0].span, 1);
  const notYet = scoreLoad([iss('example-project', 31, ['epic:placeholder', 'status:3-todo'])], OPTS);
  assert.equal(notYet.wip, 0); // P is still to-do -> not in progress
});

test('empty input -> zero load', () => {
  const r = scoreLoad([], OPTS);
  assert.equal(r.wip, 0);
  assert.equal(r.loadPoints, 0);
});

// ── Deriving the cross-repo letters from the project (the deep water of phase 0: generalising REPO_CODE) ──
test('buildRepoCode: derived from demo\'s repo identity -> key for key identical to the hardcoded REPO_CODE (behaviour unchanged)', () => {
  const rc = buildRepoCode(
    { C: 'demo', U: 'example-web', A: 'example-admin', E: 'example-engine' },
    'example-project',
    {},
  );
  assert.deepEqual(rc, { demo: 'C', 'example-web': 'U', 'example-admin': 'A', 'example-engine': 'E', 'example-project': 'P' });
});

test('buildRepoCode: in a monorepo the umbrella is the code repo -> it keeps its code letter and is not wiped out by P (the slug goes through repoSlugs)', () => {
  const rc = buildRepoCode({ C: '.' }, '.', { '.': 'your-monorepo' });
  assert.deepEqual(rc, { 'your-monorepo': 'C' }, 'the umbrella . collides with the code repo . -> it keeps C and is not marked P');
});

test('buildRepoCode: an umbrella that is not a code repo -> marked P (not counted towards cross-repo breadth)', () => {
  const rc = buildRepoCode({ W: 'web', A: 'api' }, 'umbrella', {});
  assert.deepEqual(rc, { web: 'W', api: 'A', umbrella: 'P' });
});

test('scoreLoad: inject a non-demo repoCode -> cross-repo breadth is computed with that project\'s letters (two repos x1.3)', () => {
  const repoCode = buildRepoCode({ W: 'web', A: 'api' }, 'umbrella', {});
  const r = scoreLoad(
    [
      iss('web', 1, ['epic:f', 'status:4-in-development', 'size:M']),
      iss('api', 2, ['epic:f', 'status:4-in-development']),
      iss('umbrella', 3, ['epic:f', 'status:4-in-development']), // the umbrella is the Epic itself and does not count towards span
    ],
    { ...OPTS, repoCode },
  );
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].span, 2); // the two repos web/api; umbrella (P) does not count
  close(r.loadPoints, 3 * 1.3);
});
