// Unit tests for the ProjectActions demo adapter: it injects that project's scriptsDir and owner and
// delegates to the script wrappers in workspace.ts.
// The contract it guards: callers no longer pass scriptsDir and owner by hand -- the adapter injects them in
// one place, which is a single source of truth and one fewer class of threading mistake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectFull } from '../src/projects.ts'; // type-only, so projects.ts is never loaded at runtime

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
    // What the demo epic script really prints: the Epic gets a full URL (which parseIssues picks up), and each
    // child issue is only `✓ C#n`, with no URL.
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

// The adapter reads only scriptsDir and owner, so a minimal ProjectFull is enough -- nothing else is touched
// here.
const proj = { scriptsDir: '/sd', owner: 'acme' } as unknown as ProjectFull;
const pa = projectActions(proj);
const last = (): Call => calls[calls.length - 1];
function reset(): void {
  calls.length = 0;
}

test('createSingle / createEpic: inject scriptsDir and owner into IssueCommon', async () => {
  reset();
  await pa.createSingle('your-monorepo', 't', { type: 'feat' });
  assert.equal(last().fn, 'newReqSingle');
  assert.deepEqual(last().args[2], { type: 'feat', scriptsDir: '/sd', owner: 'acme' });

  await pa.createEpic('ep', 'E', [{ repo: 'C', title: 'c' }], { prio: 'P1' });
  assert.equal(last().fn, 'newReqEpic');
  assert.deepEqual(last().args[3], { prio: 'P1', scriptsDir: '/sd', owner: 'acme' });
});

test('scaffold / approve / publish: inject scriptsDir, without an owner', async () => {
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
  assert.equal(pub.published, true, 'the demo path really does open a PR -> published:true');
});

test('listEpicChildren / addLabel: inject the owner', async () => {
  reset();
  await pa.listEpicChildren('your-monorepo', 'ep');
  assert.deepEqual(last().args, ['your-monorepo', 'ep', 'acme']);

  await pa.addLabel('your-monorepo', 7, 'size:M');
  assert.deepEqual(last().args, ['your-monorepo', 7, 'size:M', 'acme']);
});

// -- The port's contract: createEpic.issues covers the Epic and every child. The demo adapter parses the
// ✓C#n lines and folds them in, so doWrites no longer knows that format at all. --
test('createEpic: the ✓C#n children in stdout are parsed out and folded into issues (letter -> repoMap -> repo name)', async () => {
  reset();
  const demoProj = { scriptsDir: '/sd', owner: 'your-org', repoMap: { C: 'demo', U: 'example-web' } } as unknown as ProjectFull;
  const r = await projectActions(demoProj).createEpic('ep', 'E', [{ repo: 'C', title: 'c' }, { repo: 'U', title: 'u' }], {});
  // The Epic, with its full URL, plus two children parsed from ✓ C#11 and U#12, whose letters map through
  // repoMap to repo names.
  assert.deepEqual(
    r.issues.map((i) => i.repo).sort(),
    ['demo', 'example-project', 'example-web'],
  );
  assert.equal(r.issues.length, 3);
});

test('parseEpicChildren: parses ✓C#n, maps the letter through repoMap to a repo name, composes the owner URL, and deduplicates', () => {
  const out = parseEpicChildren('  ✓ C#11  c\n  ✓ U#12  u\n  ✓ C#11  dup', { C: 'demo', U: 'example-web' }, 'your-org');
  assert.deepEqual(out, [
    { repo: 'demo', number: 11, url: 'https://github.com/your-org/demo/issues/11' },
    { repo: 'example-web', number: 12, url: 'https://github.com/your-org/example-web/issues/12' },
  ]);
});
