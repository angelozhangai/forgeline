// FORGE_HOME / FORGE_CONFIG_DIR / FORGE_STATE_DIR / FORGE_LOGS_DIR：把服务自身的
// 可变状态搬出检出目录的部署接缝。
//
// 合约（不是实现的镜像）：
//   1. 全都不设 → 一切落在检出目录内，与引入本接缝之前逐字节一致（向后兼容）；
//   2. FORGE_HOME 一次搬走 config/state/logs 三者；
//   3. 单项 FORGE_* 优先级高于 FORGE_HOME，且只影响自己那一项；
//   4. 空串 / 纯空格 == 没设（否则会静默锚到进程 cwd，症状极难追）；
//   5. 配置文件逐个回落：叠加目录有就用叠加的，没有就用仓内默认 —— 私有部署
//      只覆盖它在乎的那几个，其余跟着仓库升级；
//   6. 指向不存在的目录不抛异常，按「该文件没被覆盖」处理。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_TS = pathToFileURL(resolve(import.meta.dirname, '../src/root.ts')).href;

const VARS = ['FORGE_HOME', 'FORGE_CONFIG_DIR', 'FORGE_STATE_DIR', 'FORGE_LOGS_DIR'] as const;

let bust = 0;
/** 用带 query 的 URL 绕开 ESM 模块缓存，让 root.ts 在给定 env 下重新求值。 */
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
  // 叠加目录里只放 routing.yaml —— 用来验证「只覆盖在乎的那个，其余回落」。
  writeFileSync(resolve(overlay, 'routing.yaml'), 'reviewers: {}\n');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('部署目录接缝', () => {
  test('全都不设：一切落在检出目录内（向后兼容）', async () => {
    const r = await loadRoot({});
    assert.equal(r.CONFIG_DIR, resolve(r.SVC_DIR, 'config'));
    assert.equal(r.CONFIG_DIR, r.CONFIG_REPO_DIR);
    assert.equal(r.STATE_DIR, resolve(r.SVC_DIR, 'state'));
    assert.equal(r.LOGS_DIR, resolve(r.SVC_DIR, 'logs'));
    assert.equal(r.ENV_FILE, resolve(r.SVC_DIR, 'config', 'forge.env'));
  });

  test('FORGE_HOME 一次搬走 config/state/logs 三者，但 CONFIG_REPO_DIR 不动', async () => {
    const r = await loadRoot({ FORGE_HOME: home });
    assert.equal(r.CONFIG_DIR, resolve(home, 'config'));
    assert.equal(r.STATE_DIR, resolve(home, 'state'));
    assert.equal(r.LOGS_DIR, resolve(home, 'logs'));
    // 仓内默认目录必须仍然指向检出，否则回落就没有落点了。
    assert.equal(r.CONFIG_REPO_DIR, resolve(r.SVC_DIR, 'config'));
    // prompts 走的是 FORGE_PROMPTS_DIR（loadPrompt 内解析），不归 FORGE_HOME 管。
    assert.equal(r.PROMPTS_DIR, resolve(r.SVC_DIR, 'prompts'));
  });

  test('单项覆盖优先于 FORGE_HOME，且只影响自己那一项', async () => {
    const solo = resolve(tmp, 'solo-state');
    const r = await loadRoot({ FORGE_HOME: home, FORGE_STATE_DIR: solo });
    assert.equal(r.STATE_DIR, solo);
    assert.equal(r.CONFIG_DIR, resolve(home, 'config'));
    assert.equal(r.LOGS_DIR, resolve(home, 'logs'));
  });

  test('派生路径跟着搬：DB / 心跳 / 看门狗 / launchd 日志', async () => {
    const r = await loadRoot({ FORGE_HOME: home });
    assert.equal(r.DB_PATH, resolve(home, 'state', 'service.db'));
    assert.equal(r.HEARTBEAT_PATH, resolve(home, 'state', 'heartbeat.json'));
    assert.equal(r.WATCHDOG_STATE_PATH, resolve(home, 'state', 'watchdog.json'));
    assert.equal(r.LAUNCHD_LOG, resolve(home, 'logs', 'launchd.log'));
  });

  test('相对路径按 cwd 展开成绝对路径（下游全都按绝对路径拼接）', async () => {
    const r = await loadRoot({ FORGE_HOME: '.' });
    assert.equal(r.CONFIG_DIR, resolve(process.cwd(), 'config'));
  });

  for (const [label, value] of [
    ['空串', ''],
    ['纯空格', '   '],
  ] as const) {
    test(`${label}视同未设置 —— 绝不能静默锚到 cwd`, async () => {
      const r = await loadRoot({ FORGE_HOME: value, FORGE_CONFIG_DIR: value });
      assert.equal(r.CONFIG_DIR, resolve(r.SVC_DIR, 'config'));
      assert.equal(r.STATE_DIR, resolve(r.SVC_DIR, 'state'));
    });
  }
});

describe('configFile 的逐文件回落', () => {
  test('未设叠加：一律走仓内默认', async () => {
    const r = await loadRoot({});
    assert.equal(r.configFile('routing.yaml'), resolve(r.CONFIG_REPO_DIR, 'routing.yaml'));
  });

  test('叠加目录里有的用叠加的，没有的回落仓内 —— 只覆盖在乎的那几个', async () => {
    const r = await loadRoot({ FORGE_CONFIG_DIR: overlay });
    assert.equal(r.configFile('routing.yaml'), resolve(overlay, 'routing.yaml'));
    // runtime.yaml 不在叠加目录里 → 用仓内默认，且必须是真实存在的文件，
    // 否则 loadYaml 会以「读取失败」炸掉，而不是安静地用默认值。
    assert.equal(r.configFile('runtime.yaml'), resolve(r.CONFIG_REPO_DIR, 'runtime.yaml'));
  });

  test('叠加目录不存在：不抛异常，全部回落', async () => {
    const r = await loadRoot({ FORGE_CONFIG_DIR: resolve(tmp, 'does-not-exist') });
    assert.doesNotThrow(() => r.configFile('routing.yaml'));
    assert.equal(r.configFile('routing.yaml'), resolve(r.CONFIG_REPO_DIR, 'routing.yaml'));
  });

  test('仓内也没有的文件名：返回仓内路径,交给调用方报「读不到」', async () => {
    // 可选文件（projects.yaml）靠调用方 existsSync 判断，所以这里必须返回一个
    // 稳定的路径而不是抛异常 —— 否则「没有多项目注册表」会变成崩溃。
    const r = await loadRoot({ FORGE_CONFIG_DIR: overlay });
    assert.equal(r.configFile('projects.yaml'), resolve(r.CONFIG_REPO_DIR, 'projects.yaml'));
  });

  test('叠加目录里的 forge.env 会被 ENV_FILE 采纳', async () => {
    const withEnv = resolve(tmp, 'overlay-with-env');
    mkdirSync(withEnv, { recursive: true });
    writeFileSync(resolve(withEnv, 'forge.env'), 'FORGE_FUN=1\n');
    const r = await loadRoot({ FORGE_CONFIG_DIR: withEnv });
    assert.equal(r.ENV_FILE, resolve(withEnv, 'forge.env'));
  });
});

// FORGE_EVAL_FIXTURES_DIR：把 golden 样本整体换成仓外的私有集。
// 与 config 不同,这里是**替换**不是叠加 —— 混算通过率没有意义。
describe('golden fixtures 目录接缝', () => {
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

  test('未设置：用仓内 fixtures/eval,且那批样本必须真的加载得出来', async () => {
    const m = await loadExp(undefined);
    assert.equal(m.EVAL_ROOT, resolve(import.meta.dirname, '../fixtures/eval'));
    // 仅断言路径等于自己会变成镜像测试;真正的合约是「默认路径能加载出样本」。
    assert.ok(m.loadFixtures().length > 0, '仓内 golden 样本应当非空');
  });

  test('设置后整体替换,仓内样本一个都不带进来', async () => {
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
    ['空串', ''],
    ['纯空格', '  '],
  ] as const) {
    test(`${label}视同未设置 —— 不能把 golden 集指到 cwd`, async () => {
      const m = await loadExp(value);
      assert.equal(m.EVAL_ROOT, resolve(import.meta.dirname, '../fixtures/eval'));
    });
  }
});
