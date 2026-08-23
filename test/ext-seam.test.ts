// The extension seam (src/ext/): how a downstream product stacks CLI commands and lifecycle hooks onto the
// core without forking it or editing a core file.
//
// The contract (scenarios first, implementation second -- this is not a mirror of the code):
//
//   -- Loading --
//   1. No pack configured (directory missing, or present but with no index.ts) -> an empty pack, silently,
//      and the pure open-source path behaves exactly as before;
//   2. The file is there but will not load (syntax error / no default export / wrong shape) -> **throw, never
//      silently degrade to an empty pack**. Silent fallback is this architecture's number one risk: a hook
//      that did not load has no symptom at all, until someone reconciles the data and finds it empty;
//   3. Shape validation must name **which command** is at fault (the index must stay right when the bad
//      element sits between good ones);
//   4. Loading is idempotent: repeated calls do not load twice, and a later directory argument cannot
//      replace the pack already loaded;
//   5. Before anything is loaded, extCommands()/hooks() return []/undefined -- callers never null-check.
//
//   -- Hooks notify, they never intercept --
//   6. No onTransition installed -> straight through, without even the read that fetches the previous state
//      (against a remote backend that is a real HTTP round trip, and nobody should pay for it unused);
//   7. Installed -> the event fires only **after** the transition succeeds; a failed transition fires nothing
//      (otherwise downstream is told about a transition that never happened);
//   8. A hook that throws / rejects / never returns -> the core still returns the right result and the gate
//      keeps moving;
//   9. Reading the previous state fails or finds nothing -> from = null, and it never blocks the transition.
//
//   -- Command precedence --
//  10. When an extension command collides with a core one **the core always wins**: downstream cannot quietly
//      replace a core action that carries permissions and red lines by reusing its name.
//
// The hook timeout comes from FORGE_EXT_HOOK_TIMEOUT_MS, read when ext/index.ts is evaluated -> it has to be
// set before the first import.
process.env.FORGE_EXT_HOOK_TIMEOUT_MS = '80';

import { test, describe, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const {
  loadExtensions,
  resetExtensionsForTest,
  extCommands,
  hooks,
  activePackName,
  fireTransition,
} = await import('../src/ext/index.ts');
const { withTransitionHook } = await import('../src/store/index.ts');
const docs = await import('../src/docs/index.ts');
type Store = import('../src/store/port.ts').SessionStore;

/** Wrap a fake store that implements only what the decorator touches. The casts are confined here so the
 * body of the tests never says `as`. */
function wrap(inner: object): {
  transition(id: string, to: string): Promise<{ id: string; state: string }>;
  countByState(): Promise<Record<string, number>>;
} {
  return withTransitionHook(inner as Store) as unknown as ReturnType<typeof wrap>;
}

let tmp: string;
let seq = 0;

before(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'forge-ext-seam-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => resetExtensionsForTest());

/** Build an extension-pack directory; source === undefined means create the directory with no index.ts. */
function packDir(source?: string): string {
  const dir = resolve(tmp, `pack-${seq++}`);
  mkdirSync(dir, { recursive: true });
  if (source !== undefined) writeFileSync(resolve(dir, 'index.ts'), source);
  return dir;
}

/** Build an extension pack whose whole body is `export default <expr>`. */
const packOf = (expr: string): string => packDir(`export default ${expr};\n`);

// ----------------- The public core has to stand on its own (the release gate) -----------------

describe('the public core stands on its own', () => {
  test('the test process itself has no extension loaded -- this repo\'s green must not be earned by a private pack on someone\'s machine', async () => {
    // A private deployment's entry script exports FORGE_HOME pointing at its own deployment root. If that
    // variable is left over in a developer's shell, running `npm run ci` inside forgeline **silently loads
    // the private pack** -- and from then on nobody is verifying that the public core runs on its own, until
    // someone outside clones it and finds it does not. This test turns that situation red on the spot.
    const { EXT_DIR } = await import('../src/root.ts');
    assert.equal(
      existsSync(resolve(EXT_DIR, 'index.ts')),
      false,
      `the public core's tests must run with no extension present, but EXT_DIR=${EXT_DIR} contains an ` +
        'index.ts -- run them from a clean shell (unset FORGE_HOME FORGE_EXT_DIR).',
    );
  });
});

// ------------------------- Loading -------------------------

describe('loading an extension pack', () => {
  test('the directory does not exist: an empty pack, no throw -- this is the pure open-source path', async () => {
    const pack = await loadExtensions(resolve(tmp, 'nope-does-not-exist'));
    assert.equal(pack.name, '(none)');
    assert.deepEqual(extCommands(), []);
    assert.equal(hooks(), undefined);
  });

  test('the directory exists but has no index.ts: still treated as no extension at all', async () => {
    await loadExtensions(packDir());
    assert.equal(activePackName(), '(none)');
    assert.deepEqual(extCommands(), []);
  });

  test('extCommands()/hooks() are already safe to call before anything is loaded', () => {
    assert.deepEqual(extCommands(), []);
    assert.equal(hooks(), undefined);
    assert.equal(activePackName(), '(none)');
  });

  test('a valid pack: the core can reach both its commands and its hooks', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'acme-bill', summary: 'settle up', run: () => {} }],
      hooks: { onTransition: () => {} },
    }`);
    await loadExtensions(dir);
    assert.equal(activePackName(), 'acme');
    assert.deepEqual(
      extCommands().map((c) => c.name),
      ['acme-bill'],
    );
    assert.equal(typeof hooks()?.onTransition, 'function');
  });

  test('commands as an empty array, or the field left out entirely: both read back as [], not undefined', async () => {
    await loadExtensions(packOf(`{ name: 'a', commands: [] }`));
    assert.deepEqual(extCommands(), []);
    resetExtensionsForTest();
    await loadExtensions(packOf(`{ name: 'b' }`));
    assert.deepEqual(extCommands(), []);
    assert.equal(hooks(), undefined);
  });

  test('loading is idempotent: a second call does not replace the loaded pack, even with a different directory', async () => {
    const first = packOf(`{ name: 'first' }`);
    const second = packOf(`{ name: 'second' }`);
    await loadExtensions(first);
    const again = await loadExtensions(second);
    assert.equal(again.name, 'first');
    assert.equal(activePackName(), 'first');
  });

  test('a failed load is not laundered into an empty pack by a later call (idempotence holds for failures too)', async () => {
    const broken = packDir('export default { name: 42 };\n');
    await assert.rejects(() => loadExtensions(broken));
    // The second call must not pretend nothing happened -- otherwise running doctor and then a command in
    // the same CLI would reach two different conclusions.
    const after = await loadExtensions(packOf(`{ name: 'ok' }`));
    assert.equal(after.name, '(none)');
  });
});

describe('a pack that will not load must throw (never a silent downgrade)', () => {
  const cases: [string, string][] = [
    ['a syntax error', 'export default { name: '],
    ['no default export', `export const pack = { name: 'x' };\n`],
    ['the default export is null', 'export default null;\n'],
    ['the default export is undefined', 'export default undefined;\n'],
    ['the default export is a string', `export default 'acme';\n`],
    ['the default export is an array', 'export default [];\n'],
    ['name is missing', 'export default {};\n'],
    ['name is an empty string', `export default { name: '' };\n`],
    ['name is only whitespace', `export default { name: '   ' };\n`],
    ['name is not a string', 'export default { name: 42 };\n'],
    ['commands is not an array', `export default { name: 'x', commands: {} };\n`],
    ['commands is a string', `export default { name: 'x', commands: 'a,b' };\n`],
    ['commands is null', `export default { name: 'x', commands: null };\n`],
    ['hooks is null', `export default { name: 'x', hooks: null };\n`],
    ['hooks is not an object', `export default { name: 'x', hooks: 'onTransition' };\n`],
    ['docSources is not an array', `export default { name: 'x', docSources: {} };\n`],
    ['docSources is null', `export default { name: 'x', docSources: null };\n`],
    ['docSources[0] has no id', `export default { name: 'x', docSources: [{ claim: () => [], parseRef: () => null, read: async () => ({}) }] };\n`],
    ['docSources[0].id is an empty string', `export default { name: 'x', docSources: [{ id: '  ', claim: () => [], parseRef: () => null, read: async () => ({}) }] };\n`],
    ['docSources[0].claim is not a function', `export default { name: 'x', docSources: [{ id: 'n', claim: [], parseRef: () => null, read: async () => ({}) }] };\n`],
    ['docSources[0].read is missing', `export default { name: 'x', docSources: [{ id: 'n', claim: () => [], parseRef: () => null }] };\n`],
    ['docSources[0].comment is present but not a function', `export default { name: 'x', docSources: [{ id: 'n', claim: () => [], parseRef: () => null, read: async () => ({}), comment: 'yes' }] };\n`],
  ];
  for (const [label, source] of cases) {
    test(`${label} -> throws`, async () => {
      await assert.rejects(() => loadExtensions(packDir(source)));
      // After the throw the core must still be in the clean no-extension state, with no half-loaded pack left behind.
      assert.equal(activePackName(), '(none)');
      assert.deepEqual(extCommands(), []);
    });
  }

  test('an object that is not an Array -- an array-like object is refused too', async () => {
    await assert.rejects(() => loadExtensions(packDir(`export default { name: 'x', commands: { 0: {}, length: 1 } };\n`)));
  });
});

describe('command shape validation: the bad one has to be named', () => {
  const bad: [string, string][] = [
    ['name missing', `{ summary: 's', run: () => {} }`],
    ['name is an empty string', `{ name: '', summary: 's', run: () => {} }`],
    ['name is only whitespace', `{ name: '  ', summary: 's', run: () => {} }`],
    ['summary is not a string', `{ name: 'n', summary: 1, run: () => {} }`],
    ['summary is missing', `{ name: 'n', run: () => {} }`],
    ['run is not a function', `{ name: 'n', summary: 's', run: 'go' }`],
    ['run is missing', `{ name: 'n', summary: 's' }`],
    ['the element is null', 'null'],
    ['the element is undefined', 'undefined'],
  ];
  const ok = `{ name: 'good', summary: 'ok', run: () => {} }`;

  for (const [label, entry] of bad) {
    test(`the bad element sits between two good ones (${label}) -> throws, naming index 1`, async () => {
      const dir = packOf(`{ name: 'acme', commands: [${ok}, ${entry}, ${ok}] }`);
      await assert.rejects(
        () => loadExtensions(dir),
        (e: Error) => {
          // The error has to pin down which command: of the three, the second one (index 1) is bad.
          assert.match(e.message, /commands\[1\]/);
          return true;
        },
      );
    });
  }

  test('all three commands are bad: still throws, and reports the first one', async () => {
    const dir = packOf(`{ name: 'acme', commands: [{}, {}, {}] }`);
    await assert.rejects(
      () => loadExtensions(dir),
      (e: Error) => {
        assert.match(e.message, /commands\[0\]/);
        return true;
      },
    );
  });

  test('the error carries the pack path -- with two checkouts around, not saying which file is as good as saying nothing', async () => {
    const dir = packDir('export default {};\n');
    await assert.rejects(
      () => loadExtensions(dir),
      (e: Error) => {
        assert.ok(e.message.includes(dir), `the error should carry the pack path, got: ${e.message}`);
        return true;
      },
    );
  });
});

// --------------------- Hooks notify, they never intercept ---------------------

/** The fake inner store used most often here: the previous state is always INTAKE and the transition always succeeds. */
const plainInner = {
  async get() {
    return { state: 'INTAKE' };
  },
  async transition(id: string, to: string) {
    return { id, state: to };
  },
};

/** Load a pack carrying nothing but onTransition, and collect the events it receives. */
async function withOnTransition(body: string): Promise<{ seen: unknown[] }> {
  const seen: unknown[] = [];
  (globalThis as unknown as { __extSeen: unknown[] }).__extSeen = seen;
  const dir = packOf(`{
    name: 'probe',
    hooks: { onTransition: ${body} },
  }`);
  await loadExtensions(dir);
  return { seen };
}

describe('the transition hook', () => {
  test('no hook installed: straight through, without a single read of the previous state (zero overhead)', async () => {
    let getCalls = 0;
    const inner = {
      async get() {
        getCalls++;
        return { state: 'INTAKE' };
      },
      async transition(id: string, to: string) {
        return { id, state: to };
      },
    };
    const r = await wrap(inner).transition('s1', 'CONFIRMED');
    assert.deepEqual(r, { id: 's1', state: 'CONFIRMED' });
    assert.equal(getCalls, 0, 'with no hook installed there should be no extra read just to obtain `from`');
  });

  test('the decorator passes every other method straight through', async () => {
    const s = wrap({
      async get() {
        return null;
      },
      async transition(id: string, to: string) {
        return { id, state: to };
      },
      async countByState() {
        return { INTAKE: 7 };
      },
    });
    assert.deepEqual(await s.countByState(), { INTAKE: 7 });
  });

  test('the event fires only after the transition succeeds, with from/to the real before and after', async () => {
    const { seen } = await withOnTransition(`(e) => { globalThis.__extSeen.push(e); }`);
    await wrap(plainInner).transition('s1', 'CONFIRMED');
    assert.equal(seen.length, 1);
    const e = seen[0] as { id: string; from: string; to: string; at: number };
    assert.equal(e.id, 's1');
    assert.equal(e.from, 'INTAKE');
    assert.equal(e.to, 'CONFIRMED');
    assert.equal(typeof e.at, 'number');
  });

  test('the transition fails: the error propagates as usual and not one event is sent', async () => {
    const { seen } = await withOnTransition(`(e) => { globalThis.__extSeen.push(e); }`);
    const s = wrap({
      async get() {
        return { state: 'INTAKE' };
      },
      async transition() {
        throw new Error('illegal transition: INTAKE -> SHIPPED');
      },
    });
    await assert.rejects(() => s.transition('s1', 'SHIPPED'), /illegal transition/);
    assert.deepEqual(seen, [], 'a transition that never happened must never reach downstream');
  });

  const transitionOk = {
    async transition(id: string, to: string) {
      return { id, state: to };
    },
  };
  for (const [label, get] of [
    [
      'reading the previous state throws',
      async () => {
        throw new Error('db down');
      },
    ],
    ['reading the previous state returns null', async () => null],
    ['reading the previous state returns a row with no state field', async () => ({})],
  ] as const) {
    test(`${label} -> from=null, and the transition itself still succeeds`, async () => {
      const { seen } = await withOnTransition(`(e) => { globalThis.__extSeen.push(e); }`);
      const r = await wrap({ get, ...transitionOk }).transition('s1', 'CONFIRMED');
      assert.deepEqual(r, { id: 's1', state: 'CONFIRMED' }, 'failing to read the previous state must not change the transition result');
      assert.equal((seen[0] as { from: string | null }).from, null);
    });
  }

  for (const [label, body] of [
    ['throwing synchronously', `() => { throw new Error('boom'); }`],
    ['returning a rejected promise', `async () => { throw new Error('boom-async'); }`],
    ['returning a non-promise junk value', `() => 42`],
  ] as const) {
    test(`a hook ${label} -> the core still returns the right result`, async () => {
      await withOnTransition(body);
      assert.deepEqual(await wrap(plainInner).transition('s1', 'CONFIRMED'), { id: 's1', state: 'CONFIRMED' });
    });
  }

  test('a hook that never returns -> the timeout calls it lost, and the core is not left hanging', async () => {
    // FORGE_EXT_HOOK_TIMEOUT_MS is set to 80ms at the top of this file; this hook never resolves.
    await withOnTransition(`() => new Promise(() => {})`);
    const t0 = Date.now();
    const r = await wrap(plainInner).transition('s1', 'CONFIRMED');
    const elapsed = Date.now() - t0;
    assert.deepEqual(r, { id: 's1', state: 'CONFIRMED' });
    assert.ok(elapsed < 1500, `it should return around the timeout, but waited ${elapsed}ms`);
  });

  test('calling fireTransition directly does not let a throwing hook escape either (a hook is only ever a notification)', async () => {
    await withOnTransition(`() => { throw new Error('nope'); }`);
    await assert.doesNotReject(() => fireTransition({ id: 's1', from: null, to: 'CONFIRMED', at: 1 }));
  });
});

// --------------------- Command precedence (running the real CLI) ---------------------

const exec = promisify(execFile);
const CLI = resolve(import.meta.dirname, '../src/index.ts');

/** Run the CLI for real with the extension pack pointed at the given directory. Returns stdout (the exit
 * code does not matter -- the collision tests only read the output). */
async function runCli(args: string[], extDir: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await exec(process.execPath, ['--no-warnings', CLI, ...args], {
      env: { ...process.env, FORGE_EXT_DIR: extDir },
      timeout: 60_000,
    });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

describe('precedence between extension commands and core commands', () => {
  test('an extension\'s own command: it is dispatched to and runs', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'acme-ping', summary: 'a private command', run: (ctx) => {
        process.stdout.write('ACME_RAN pos=' + JSON.stringify(ctx.pos) + ' flag=' + String(ctx.flags.x) + '\\n');
      } }],
    }`);
    const r = await runCli(['acme-ping', 'a', '--x', 'y'], dir);
    assert.match(r.stdout, /ACME_RAN pos=\["a"\] flag=y/);
  });

  test('a name collision with a core command: the core always wins and the extension\'s run never executes', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'help', summary: 'hijacked help', run: () => {
        process.stdout.write('HIJACKED\\n');
      } }],
    }`);
    const r = await runCli(['help'], dir);
    assert.doesNotMatch(r.stdout, /HIJACKED/, 'an extension must never take over a core command by reusing its name');
    assert.match(r.stdout, /Usage: \.\/forge/, 'what ran should be the core help');
  });

  test('help lists the extension commands and says which pack they came from', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'acme-bill', summary: 'bill by session', run: () => {} }],
    }`);
    const r = await runCli(['help'], dir);
    assert.match(r.stdout, /acme-bill/);
    assert.match(r.stdout, /bill by session/);
    assert.match(r.stdout, /acme/);
  });

  test('with no pack configured, help has no extension section -- the pure open-source output is unchanged', async () => {
    const r = await runCli(['help'], resolve(tmp, 'no-such-ext-dir'));
    assert.doesNotMatch(r.stdout, /Extension commands/);
  });

  test('the pack will not load: every command is refused with a non-zero exit, never quietly run as if there were no pack', async () => {
    const dir = packDir('export default { name: 42 };\n');
    const r = await runCli(['help'], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /the extension pack failed to load/);
    assert.doesNotMatch(r.stdout, /Usage: \.\/forge/, 'a failed load must not carry on as though everything were fine');
  });
});

// ----------------- Document-source registration (the L2 mount point) -----------------
// Wiring up a downstream document system (Notion / Confluence / an internal wiki) should not require editing
// the array in docs/index.ts. This group pins the boundary: you can add one, but you cannot break the core.

describe('an extension registering a document source', () => {
  const notionPack = `{
    name: 'acme-docs',
    docSources: [{
      id: 'notion',
      claim: (input) => (String(input.text ?? '').includes('notion.example/') ? [{ source: 'notion', token: 'pg1' }] : []),
      parseRef: (u) => (u.includes('notion.example/') ? { source: 'notion', token: 'pg1' } : null),
      read: async () => ({ ok: true, text: 'NOTION body' }),
    }],
  }`;

  test('no pack loaded: the registry is exactly the two core sources (the pure open-source behaviour, byte for byte)', () => {
    assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']);
  });

  test('once loaded: claim -> stored key -> read body, the whole chain knows the new source', async () => {
    await loadExtensions(packOf(notionPack));
    assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext', 'notion']);
    const claimed = docs.claimDocs({ text: 'the requirement is at https://notion.example/pg1' });
    assert.deepEqual(claimed, [{ source: 'notion', token: 'pg1' }]);
    assert.equal(docs.formatRef(claimed[0]), 'notion:pg1'); // the stored key carries the source prefix
    assert.deepEqual(docs.parseAnyRef('https://notion.example/pg1'), { source: 'notion', token: 'pg1' });
    assert.equal((await docs.readDoc(claimed[0])).text, 'NOTION body');
  });

  test('a link the extension source does not claim still goes to the core sources -- adding one never blocks the existing path', async () => {
    await loadExtensions(packOf(notionPack));
    assert.equal(docs.parseAnyRef('https://notion.example/pg1')?.source, 'notion');
    assert.equal(docs.parseAnyRef('https://example.feishu.cn/docx/abc123')?.source, 'feishu');
  });

  test('an id colliding with a core source: the extension\'s copy is dropped and the core source stays (downstream cannot replace the Feishu source)', async () => {
    await loadExtensions(
      packOf(`{
        name: 'impostor',
        docSources: [{ id: 'feishu', claim: () => [{ source: 'feishu', token: 'hijacked' }], parseRef: () => ({ source: 'feishu', token: 'hijacked' }), read: async () => ({ ok: true, text: 'impostor body' }) }],
      }`),
    );
    assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']); // no second source under the same id
    assert.equal(docs.parseAnyRef('just some string that is not a link'), null); // the impostor's parseRef never took effect
  });

  test('a stored ref outlives the pack: once the pack is removed readDoc says "unregistered source" plainly, never a silent read failure', async () => {
    await loadExtensions(packOf(notionPack));
    const ref = { source: 'notion', token: 'pg1' };
    assert.equal((await docs.readDoc(ref)).ok, true);
    resetExtensionsForTest(); // the deployment dropped the pack, but notion:pg1 is still in the database
    const after = await docs.readDoc(ref);
    assert.equal(after.ok, false);
    assert.match(after.error ?? '', /Unregistered document source "notion"/);
    assert.match(after.error ?? '', /feishu\/plaintext/); // and tells the reader which sources it does know
  });
});
