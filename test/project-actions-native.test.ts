// Unit tests for the nativeGithub adapter (proj.actions='native'): it calls gh directly and generates the
// delivery documents itself, depending on no project script. Covered here: the whole single-repo chain
// (scaffolding the documents, creating the issue, the labels, listing the epic's children, and approve and
// publish as no-ops), plus the multi-repo Epic end to end -- the Epic into the umbrella repo and each child
// into its own code repo, in the local-key namespace, with a failed child giving ok=false rather than silence.
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
// The monorepo shape: the local key '.' maps to a GitHub slug, proving createSingle takes both hops,
// repoMap then repoSlugs.
const paMono = projectActions({ owner: 'acme', actions: 'native', repoMap: { C: '.' }, repoSlugs: { '.': 'your-monorepo' }, deliveryDir: DELIV } as unknown as ProjectFull);
// Native across several repos: the umbrella repo umb plus two code repos (C -> web, U -> api), proving
// createEpic end to end.
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

test('createSingle: gh issue create -R owner/repo with the label and assignee, parsing the URL it created', async () => {
  reset(() => ({ code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/42\n', stderr: '', timedOut: false }));
  const r = await pa.createSingle('your-monorepo', 't', { type: 'feat', assignee: 'alice', body: 'B' });
  assert.equal(last().bin, 'gh');
  assert.deepEqual(last().args.slice(0, 4), ['issue', 'create', '-R', 'acme/your-monorepo']);
  assert.equal(valOf(last().args, '--title'), 't');
  assert.equal(valOf(last().args, '--label'), 'feat');
  assert.equal(valOf(last().args, '--assignee'), 'alice');
  assert.deepEqual(r.issues, [{ repo: 'your-monorepo', number: 42, url: 'https://github.com/acme/your-monorepo/issues/42' }]);
});

test('createSingle: the short code C is mapped through repoMap to the real repo name, so gh gets -R owner/<name> rather than owner/C', async () => {
  reset(() => ({ code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/8\n', stderr: '', timedOut: false }));
  await pa.createSingle('C', 't', {});
  assert.deepEqual(last().args.slice(0, 4), ['issue', 'create', '-R', 'acme/your-monorepo']);
});

test('createSingle in a monorepo: the local key takes both hops, repoMap then repoSlugs, so gh gets -R owner/your-monorepo and never owner/.', async () => {
  reset(() => ({ code: 0, stdout: 'https://github.com/acme/your-monorepo/issues/9\n', stderr: '', timedOut: false }));
  await paMono.createSingle('C', 't', {});
  assert.deepEqual(last().args.slice(0, 4), ['issue', 'create', '-R', 'acme/your-monorepo']);
});

test('createSingle dryRun: nothing is really created, and gh is never called', async () => {
  reset();
  const r = await pa.createSingle('your-monorepo', 't', { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('addLabel / listEpicChildren: reuse the shared gh wrappers with the owner injected', async () => {
  reset(() => ({ code: 0, stdout: '[]', stderr: '', timedOut: false }));
  await pa.addLabel('your-monorepo', 7, 'size:M');
  assert.deepEqual(last().args, ['issue', 'edit', '7', '-R', 'acme/your-monorepo', '--add-label', 'size:M']);

  await pa.listEpicChildren('your-monorepo', 'ep');
  assert.equal(valOf(last().args, '-R'), 'acme/your-monorepo');
  assert.equal(valOf(last().args, '-l'), 'epic:ep');
});

test('approve and publish: there is nothing to do natively, so they are no-ops returning ok -- not failures, or a single-repo go could never complete', async () => {
  const ap = await pa.approveTechDesign('s');
  assert.equal(ap.ok, true);
  const pub = await pa.publishTechDesign('s', { base: 'main' });
  assert.equal(pub.ok, true);
  assert.equal(pub.published, false, 'nothing was really published natively -> published:false, which is how the DONE copy avoids claiming a PR was merged');
});

test('scaffoldReview / scaffoldTechDesign: generate the delivery documents carrying status: draft, which is what the gates append to and later set active', async () => {
  const rr = await pa.scaffoldReview({ slug: 'feat-x', prd: 'http://prd', owner: 'alice', title: 'a title' });
  assert.equal(rr.ok, true);
  const reqDoc = readFileSync(resolve(DELIV, 'feat-x', 'req-review.md'), 'utf8');
  assert.match(reqDoc, /^status: draft/m, 'this is what markReviewActive flips to active');
  assert.match(reqDoc, /a title/);

  const td = await pa.scaffoldTechDesign({ slug: 'feat-x', title: 'a title' });
  assert.equal(td.ok, true);
  assert.ok(existsSync(resolve(DELIV, 'feat-x', 'tech-design.md')));
});

test('scaffolding is non-destructive: an existing document is not overwritten, keeping whatever the gates appended and any active status', async () => {
  await pa.scaffoldReview({ slug: 'keep', title: 'A' });
  const p = resolve(DELIV, 'keep', 'req-review.md');
  const before = readFileSync(p, 'utf8');
  await pa.scaffoldReview({ slug: 'keep', title: 'B' }); // the second call should not overwrite
  assert.equal(readFileSync(p, 'utf8'), before, 'an existing file is skipped and its content is unchanged');
});

// -- The multi-repo Epic (createEpic end to end) --
test('createEpic across repos: the Epic goes to the umbrella repo and each child to its own code repo, all labelled epic:<slug>, with the issues in the local-key namespace', async () => {
  reset((_bin, args) => {
    const i = args.indexOf('-R');
    const slug = i >= 0 ? String(args[i + 1]).split('/')[1] : 'x';
    return { code: 0, stdout: `https://github.com/acme/${slug}/issues/5\n`, stderr: '', timedOut: false };
  });
  const r = await paEpic.createEpic('feat-x', 'E', [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }], { type: 'feat', assignee: 'alice', body: 'BODY' });
  assert.equal(r.ok, true);
  // Three gh issue create calls: the umbrella repo umb plus two code repos (the short codes C and U go
  // through repoMap to the local keys web and api, and then to slugs).
  const creates = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
  assert.deepEqual(creates.map((c) => valOf(c.args, '-R')).sort(), ['acme/api', 'acme/umb', 'acme/web']);
  // All carry epic:<slug>, which is what listEpicChildren rediscovers them by on a retry.
  for (const c of creates) assert.ok(c.args.includes('epic:feat-x'), 'every issue carries the epic:feat-x label');
  // What comes back is in the **local key** namespace -- doWrites' coverage check and the size labels both
  // rely on it: umb (the umbrella) plus web and api.
  assert.deepEqual(r.issues.map((i) => i.repo).sort(), ['api', 'umb', 'web']);
});

test('createEpic: any child that fails to create gives ok=false with the stderr naming it -- a failure is never silent', async () => {
  let nth = 0;
  reset((_bin, args) => {
    nth++;
    if (nth === 2) return { code: 1, stdout: '', stderr: 'gh boom', timedOut: false }; // the first child (web) fails
    const i = args.indexOf('-R');
    const slug = i >= 0 ? String(args[i + 1]).split('/')[1] : 'x';
    return { code: 0, stdout: `https://github.com/acme/${slug}/issues/5\n`, stderr: '', timedOut: false };
  });
  const r = await paEpic.createEpic('feat-x', 'E', [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }], {});
  assert.equal(r.ok, false, 'any failed child makes the whole thing ok=false, which is what doWrites parks as WRITE_FAILED');
  assert.match(r.stderr, /child\(web\)/);
});

test('createEpic dryRun: gh is never called, and it rehearses the umbrella repo plus each child repo', async () => {
  reset();
  const r = await paEpic.createEpic('feat-x', 'E', [{ repo: 'C', title: 'c' }], { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.match(r.stdout, /\[Epic\]/);
});
