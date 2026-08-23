// FORGE_HOME / FORGE_CONFIG_DIR / FORGE_STATE_DIR / FORGE_LOGS_DIR: the deployment seam that moves the
// service's own mutable state out of the checkout.
//
// The contract (not a mirror of the implementation):
//   1. None of them set -> everything lands inside the checkout, byte for byte as it was before this seam
//      existed (backward compatibility);
//   2. FORGE_HOME moves config, state and logs in one go;
//   3. An individual FORGE_* beats FORGE_HOME, and affects only its own directory;
//   4. An empty string or pure whitespace counts as unset (otherwise it silently anchors to the process cwd,
//      which is a very hard symptom to trace);
//   5. Config files fall back one file at a time: use the overlay's copy if it has one, the in-repo default
//      otherwise -- a private deployment overrides only the few it cares about and the rest keep upgrading
//      with the repo;
//   6. Pointing at a directory that does not exist throws nothing; it just means that file is not overridden;
//   7. EXT_DIR (the extension-pack directory) follows the same rules: FORGE_EXT_DIR > $FORGE_HOME/ext > the
//      checkout's own ext/ -- a downstream product's pack moves with the deployment root, so there is no new
//      convention to remember.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_TS = pathToFileURL(resolve(import.meta.dirname, '../src/root.ts')).href;

const VARS = ['FORGE_HOME', 'FORGE_CONFIG_DIR', 'FORGE_STATE_DIR', 'FORGE_LOGS_DIR', 'FORGE_EXT_DIR'] as const;

let bust = 0;
/** Use a query string on the URL to sidestep the ESM module cache, so root.ts is re-evaluated under the
 * given env. */
async function loadRoot(env: Partial<Record<(typeof VARS)[number], string>>) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await import(`${ROOT_TS}?deploy-dirs=${bust++}`);
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

let tmp: string;
let home: string;
let overlay: string;

before(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'forge-deploy-dirs-'));
  home = resolve(tmp, 'home');
  overlay = resolve(tmp, 'overlay-config');
  mkdirSync(home, { recursive: true });
  mkdirSync(overlay, { recursive: true });
  // The overlay holds routing.yaml only -- that is what proves "override the one you care about, fall back
  // for the rest".
  writeFileSync(resolve(overlay, 'routing.yaml'), 'reviewers: {}\n');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('the deployment-directory seam', () => {
  test('none of them set: everything lands inside the checkout (backward compatibility)', async () => {
    const r = await loadRoot({});
    assert.equal(r.CONFIG_DIR, resolve(r.SVC_DIR, 'config'));
    assert.equal(r.CONFIG_DIR, r.CONFIG_REPO_DIR);
    assert.equal(r.STATE_DIR, resolve(r.SVC_DIR, 'state'));
    assert.equal(r.LOGS_DIR, resolve(r.SVC_DIR, 'logs'));
    assert.equal(r.ENV_FILE, resolve(r.SVC_DIR, 'config', 'forge.env'));
  });

  test('FORGE_HOME moves config, state and logs in one go, while CONFIG_REPO_DIR stays put', async () => {
    const r = await loadRoot({ FORGE_HOME: home });
    assert.equal(r.CONFIG_DIR, resolve(home, 'config'));
    assert.equal(r.STATE_DIR, resolve(home, 'state'));
    assert.equal(r.LOGS_DIR, resolve(home, 'logs'));
    // The in-repo default directory has to keep pointing at the checkout, or the fallback has nowhere to land.
    assert.equal(r.CONFIG_REPO_DIR, resolve(r.SVC_DIR, 'config'));
    // Prompts go through FORGE_PROMPTS_DIR, resolved inside loadPrompt -- FORGE_HOME does not govern them.
    assert.equal(r.PROMPTS_DIR, resolve(r.SVC_DIR, 'prompts'));
  });

  test('an individual override beats FORGE_HOME and affects only its own directory', async () => {
    const solo = resolve(tmp, 'solo-state');
    const r = await loadRoot({ FORGE_HOME: home, FORGE_STATE_DIR: solo });
    assert.equal(r.STATE_DIR, solo);
    assert.equal(r.CONFIG_DIR, resolve(home, 'config'));
    assert.equal(r.LOGS_DIR, resolve(home, 'logs'));
  });

  test('the derived paths move too: the database, the heartbeat, the watchdog and the launchd log', async () => {
    const r = await loadRoot({ FORGE_HOME: home });
    assert.equal(r.DB_PATH, resolve(home, 'state', 'service.db'));
    assert.equal(r.HEARTBEAT_PATH, resolve(home, 'state', 'heartbeat.json'));
    assert.equal(r.WATCHDOG_STATE_PATH, resolve(home, 'state', 'watchdog.json'));
    assert.equal(r.LAUNCHD_LOG, resolve(home, 'logs', 'launchd.log'));
  });

  test('a relative path is expanded against cwd into an absolute one (everything downstream composes absolute paths)', async () => {
    const r = await loadRoot({ FORGE_HOME: '.' });
    assert.equal(r.CONFIG_DIR, resolve(process.cwd(), 'config'));
  });

  for (const [label, value] of [
    ['an empty string', ''],
    ['pure whitespace', '   '],
  ] as const) {
    test(`${label} counts as unset -- it must never silently anchor to cwd`, async () => {
      const r = await loadRoot({ FORGE_HOME: value, FORGE_CONFIG_DIR: value });
      assert.equal(r.CONFIG_DIR, resolve(r.SVC_DIR, 'config'));
      assert.equal(r.STATE_DIR, resolve(r.SVC_DIR, 'state'));
    });
  }

  // The extension-pack directory: contract 7. The core knows no downstream product, only this location.
  test('nothing set: EXT_DIR lands inside the checkout, and this repo ships no ext/ -- the default is no extension at all', async () => {
    const r = await loadRoot({});
    assert.equal(r.EXT_DIR, resolve(r.SVC_DIR, 'ext'));
    // The moment the public core ships an ext/, a pure open-source user loads a pack out of nowhere. This is
    // what keeps the open-source repo self-consistent.
    assert.equal(existsSync(r.EXT_DIR), false, 'the public core should not ship an ext/ directory');
  });

  test('FORGE_HOME moves the extension-pack directory along with everything else -- no new convention for downstream to remember', async () => {
    const r = await loadRoot({ FORGE_HOME: home });
    assert.equal(r.EXT_DIR, resolve(home, 'ext'));
  });

  test('FORGE_EXT_DIR beats FORGE_HOME without affecting config, state or logs', async () => {
    const solo = resolve(tmp, 'solo-ext');
    const r = await loadRoot({ FORGE_HOME: home, FORGE_EXT_DIR: solo });
    assert.equal(r.EXT_DIR, solo);
    assert.equal(r.CONFIG_DIR, resolve(home, 'config'));
    assert.equal(r.STATE_DIR, resolve(home, 'state'));
    assert.equal(r.LOGS_DIR, resolve(home, 'logs'));
  });

  for (const [label, value] of [
    ['an empty string', ''],
    ['pure whitespace', ' \t '],
  ] as const) {
    test(`FORGE_EXT_DIR set to ${label} counts as unset -- the pack directory must not anchor to cwd`, async () => {
      const r = await loadRoot({ FORGE_EXT_DIR: value });
      assert.equal(r.EXT_DIR, resolve(r.SVC_DIR, 'ext'));
    });
  }
});

describe('configFile falling back one file at a time', () => {
  test('no overlay set: everything comes from the in-repo default', async () => {
    const r = await loadRoot({});
    assert.equal(r.configFile('routing.yaml'), resolve(r.CONFIG_REPO_DIR, 'routing.yaml'));
  });

  test('what the overlay has comes from the overlay, what it lacks falls back to the repo -- override only the few you care about', async () => {
    const r = await loadRoot({ FORGE_CONFIG_DIR: overlay });
    assert.equal(r.configFile('routing.yaml'), resolve(overlay, 'routing.yaml'));
    // runtime.yaml is not in the overlay, so it comes from the repo -- and it has to be a file that really
    // exists, or loadYaml blows up with a read failure instead of quietly using the default.
    assert.equal(r.configFile('runtime.yaml'), resolve(r.CONFIG_REPO_DIR, 'runtime.yaml'));
  });

  test('the overlay directory does not exist: nothing throws, everything falls back', async () => {
    const r = await loadRoot({ FORGE_CONFIG_DIR: resolve(tmp, 'does-not-exist') });
    assert.doesNotThrow(() => r.configFile('routing.yaml'));
    assert.equal(r.configFile('routing.yaml'), resolve(r.CONFIG_REPO_DIR, 'routing.yaml'));
  });

  test('a filename the repo does not have either: return the in-repo path and leave the caller to report that it could not be read', async () => {
    // Optional files such as projects.yaml are decided by the caller's existsSync, so this has to return a
    // stable path rather than throw -- otherwise "there is no multi-project registry" turns into a crash.
    const r = await loadRoot({ FORGE_CONFIG_DIR: overlay });
    assert.equal(r.configFile('projects.yaml'), resolve(r.CONFIG_REPO_DIR, 'projects.yaml'));
  });

  test('a forge.env in the overlay is picked up by ENV_FILE', async () => {
    const withEnv = resolve(tmp, 'overlay-with-env');
    mkdirSync(withEnv, { recursive: true });
    writeFileSync(resolve(withEnv, 'forge.env'), 'FORGE_FUN=1\n');
    const r = await loadRoot({ FORGE_CONFIG_DIR: withEnv });
    assert.equal(r.ENV_FILE, resolve(withEnv, 'forge.env'));
  });
});

// FORGE_EVAL_FIXTURES_DIR: swap the golden samples wholesale for a private set outside the repo.
// Unlike config this **replaces** rather than overlays -- a pass rate computed across a mixture means nothing.
describe('the golden-fixtures directory seam', () => {
  const EXP_TS = pathToFileURL(resolve(import.meta.dirname, '../src/eval/expectations.ts')).href;
  let n = 0;
  async function loadExp(value?: string) {
    const saved = process.env.FORGE_EVAL_FIXTURES_DIR;
    if (value === undefined) delete process.env.FORGE_EVAL_FIXTURES_DIR;
    else process.env.FORGE_EVAL_FIXTURES_DIR = value;
    try {
      return await import(`${EXP_TS}?eval-dir=${n++}`);
    } finally {
      if (saved === undefined) delete process.env.FORGE_EVAL_FIXTURES_DIR;
      else process.env.FORGE_EVAL_FIXTURES_DIR = saved;
    }
  }

  test('unset: use the in-repo fixtures/eval, and those samples must really load', async () => {
    const m = await loadExp(undefined);
    assert.equal(m.EVAL_ROOT, resolve(import.meta.dirname, '../fixtures/eval'));
    // Asserting only that the path equals itself would be a mirror test; the real contract is that the
    // default path loads samples.
    assert.ok(m.loadFixtures().length > 0, 'the in-repo golden samples should not be empty');
  });

  test('once set it replaces them wholesale, bringing not one in-repo sample along', async () => {
    const priv = resolve(tmp, 'private-fixtures');
    mkdirSync(resolve(priv, 'only-mine'), { recursive: true });
    writeFileSync(resolve(priv, 'only-mine', 'prd.md'), '# private\n');
    writeFileSync(
      resolve(priv, 'only-mine', 'expect.yaml'),
      'gate: a\ndesc: private-only golden sample\nsize_in: [S, M]\n',
    );
    const m = await loadExp(priv);
    assert.equal(m.EVAL_ROOT, priv);
    const names = m.loadFixtures().map((f: { name: string }) => f.name);
    assert.deepEqual(names, ['only-mine']);
  });

  for (const [label, value] of [
    ['an empty string', ''],
    ['pure whitespace', '  '],
  ] as const) {
    test(`${label} counts as unset -- the golden set must not point at cwd`, async () => {
      const m = await loadExp(value);
      assert.equal(m.EVAL_ROOT, resolve(import.meta.dirname, '../fixtures/eval'));
    });
  }
});
