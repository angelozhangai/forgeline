// 扩展接缝（src/ext/）：下游产品在不 fork、不改核心文件的前提下往核心上叠 CLI 命令与生命周期钩子。
//
// 合约（先列场景再看实现；不是实现的镜像）：
//
//   ── 装载 ──
//   1. 没配扩展（目录不存在 / 目录在但没有 index.ts）→ 空包，静默，纯 OSS 路径行为不变；
//   2. 文件存在却装不起来（语法错 / 没有默认导出 / 形状不对）→ **抛错，绝不静默降级成空包**。
//      本架构的头号风险就是静默回落：一个没装上的钩子不会有任何症状，直到对账时发现数据是空的；
//   3. 形状校验必须报出**是哪一条命令**出的问题（坏元素混在好元素中间时下标不能错）；
//   4. 装载幂等：调多次不重复装，也不会被后来的目录参数改掉已装的包；
//   5. 未装载时 extCommands()/hooks() 返回 []/undefined —— 调用方不必判空。
//
//   ── 钩子只通知、不拦截 ──
//   6. 没装 onTransition → 直通，连查旧态那次读都不发生（远端后端下那是一次真实 HTTP 往返，不能白付）；
//   7. 装了 → transition **成功之后**才发事件；失败的转移不发（否则下游收到从未发生过的流转）；
//   8. 钩子抛错 / reject / 卡住不返回 → 核心照常返回正确结果，绝不打断 gate 推进；
//   9. 查旧态失败或查不到 → from = null，绝不因此挡住转移本身。
//
//   ── 命令优先级 ──
//  10. 扩展命令与核心命令重名时**核心永远赢**：下游不能靠重名悄悄改掉带权限与红线的核心动作。
//
// 钩子超时阈值取自 FORGE_EXT_HOOK_TIMEOUT_MS，在 ext/index.ts 模块求值时读取 → 必须在首次 import 之前设。
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

/** 把一个「只实现了装饰器会碰到的方法」的假 store 包上钩子。转型收敛在这里，测试正文不出现 as。 */
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

/** 造一个扩展包目录；source 为 undefined 表示只建目录不放 index.ts。 */
function packDir(source?: string): string {
  const dir = resolve(tmp, `pack-${seq++}`);
  mkdirSync(dir, { recursive: true });
  if (source !== undefined) writeFileSync(resolve(dir, 'index.ts'), source);
  return dir;
}

/** 造一个只导出 `export default <expr>` 的扩展包。 */
const packOf = (expr: string): string => packDir(`export default ${expr};\n`);

// ─────────────────── 公开核心必须自洽（发布闸）───────────────────

describe('公开核心自洽', () => {
  test('测试进程自身没有装任何扩展 —— 本仓的绿灯不能是靠某人机器上的私有包挣来的', async () => {
    // 私有部署的入口脚本会 export FORGE_HOME 指向它自己的部署根。开发者的 shell 里若残留这个变量，
    // 在 forgeline 里跑 `npm run ci` 就会**静默装上私有扩展**，于是「公开核心能独立跑通」这件事从此
    // 无人验证——直到外面的人 clone 下来发现跑不起来。这条把那种情况当场变成红灯。
    const { EXT_DIR } = await import('../src/root.ts');
    assert.equal(
      existsSync(resolve(EXT_DIR, 'index.ts')),
      false,
      `公开核心的测试必须在无扩展环境下跑。当前 EXT_DIR=${EXT_DIR} 里有 index.ts —— ` +
        '请在干净 shell 里跑（unset FORGE_HOME FORGE_EXT_DIR）。',
    );
  });
});

// ───────────────────────── 装载 ─────────────────────────

describe('扩展包装载', () => {
  test('目录不存在：空包，不抛 —— 纯 OSS 就是这条路径', async () => {
    const pack = await loadExtensions(resolve(tmp, 'nope-does-not-exist'));
    assert.equal(pack.name, '(none)');
    assert.deepEqual(extCommands(), []);
    assert.equal(hooks(), undefined);
  });

  test('目录存在但没有 index.ts：同样按「没有扩展」处理', async () => {
    await loadExtensions(packDir());
    assert.equal(activePackName(), '(none)');
    assert.deepEqual(extCommands(), []);
  });

  test('未调用装载时 extCommands()/hooks() 已可安全调用', () => {
    assert.deepEqual(extCommands(), []);
    assert.equal(hooks(), undefined);
    assert.equal(activePackName(), '(none)');
  });

  test('合法包：命令与钩子都能被核心取到', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'acme-bill', summary: '结算', run: () => {} }],
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

  test('commands 为空数组 / 整个字段缺省：都取到 []，不是 undefined', async () => {
    await loadExtensions(packOf(`{ name: 'a', commands: [] }`));
    assert.deepEqual(extCommands(), []);
    resetExtensionsForTest();
    await loadExtensions(packOf(`{ name: 'b' }`));
    assert.deepEqual(extCommands(), []);
    assert.equal(hooks(), undefined);
  });

  test('装载幂等：第二次调用不改已装的包，即使换了目录', async () => {
    const first = packOf(`{ name: 'first' }`);
    const second = packOf(`{ name: 'second' }`);
    await loadExtensions(first);
    const again = await loadExtensions(second);
    assert.equal(again.name, 'first');
    assert.equal(activePackName(), 'first');
  });

  test('装载失败之后不会被后续调用「洗成」空包（幂等对失败同样成立）', async () => {
    const broken = packDir('export default { name: 42 };\n');
    await assert.rejects(() => loadExtensions(broken));
    // 第二次调用不该假装什么都没发生——否则 CLI 里「先 doctor 后跑命令」会得到两种结论。
    const after = await loadExtensions(packOf(`{ name: 'ok' }`));
    assert.equal(after.name, '(none)');
  });
});

describe('装不起来必须抛错（绝不静默降级）', () => {
  const cases: [string, string][] = [
    ['语法错', 'export default { name: '],
    ['没有默认导出', `export const pack = { name: 'x' };\n`],
    ['默认导出是 null', 'export default null;\n'],
    ['默认导出是 undefined', 'export default undefined;\n'],
    ['默认导出是字符串', `export default 'acme';\n`],
    ['默认导出是数组', 'export default [];\n'],
    ['name 缺失', 'export default {};\n'],
    ['name 是空串', `export default { name: '' };\n`],
    ['name 是纯空格', `export default { name: '   ' };\n`],
    ['name 不是字符串', 'export default { name: 42 };\n'],
    ['commands 不是数组', `export default { name: 'x', commands: {} };\n`],
    ['commands 是字符串', `export default { name: 'x', commands: 'a,b' };\n`],
    ['commands 是 null', `export default { name: 'x', commands: null };\n`],
    ['hooks 是 null', `export default { name: 'x', hooks: null };\n`],
    ['hooks 不是对象', `export default { name: 'x', hooks: 'onTransition' };\n`],
    ['docSources 不是数组', `export default { name: 'x', docSources: {} };\n`],
    ['docSources 是 null', `export default { name: 'x', docSources: null };\n`],
    ['docSources[0] 缺 id', `export default { name: 'x', docSources: [{ claim: () => [], parseRef: () => null, read: async () => ({}) }] };\n`],
    ['docSources[0].id 是空串', `export default { name: 'x', docSources: [{ id: '  ', claim: () => [], parseRef: () => null, read: async () => ({}) }] };\n`],
    ['docSources[0].claim 不是函数', `export default { name: 'x', docSources: [{ id: 'n', claim: [], parseRef: () => null, read: async () => ({}) }] };\n`],
    ['docSources[0].read 缺失', `export default { name: 'x', docSources: [{ id: 'n', claim: () => [], parseRef: () => null }] };\n`],
    ['docSources[0].comment 存在但不是函数', `export default { name: 'x', docSources: [{ id: 'n', claim: () => [], parseRef: () => null, read: async () => ({}), comment: 'yes' }] };\n`],
  ];
  for (const [label, source] of cases) {
    test(`${label} → 抛错`, async () => {
      await assert.rejects(() => loadExtensions(packDir(source)));
      // 抛完之后核心必须仍处在「没有扩展」的干净状态，不能留半个装了一半的包。
      assert.equal(activePackName(), '(none)');
      assert.deepEqual(extCommands(), []);
    });
  }

  test('数组是对象但不是 Array —— 类数组对象也要被拒', async () => {
    await assert.rejects(() => loadExtensions(packDir(`export default { name: 'x', commands: { 0: {}, length: 1 } };\n`)));
  });
});

describe('命令形状校验：坏的那条必须被指名道姓', () => {
  const bad: [string, string][] = [
    ['缺 name', `{ summary: 's', run: () => {} }`],
    ['name 是空串', `{ name: '', summary: 's', run: () => {} }`],
    ['name 是纯空格', `{ name: '  ', summary: 's', run: () => {} }`],
    ['summary 不是字符串', `{ name: 'n', summary: 1, run: () => {} }`],
    ['summary 缺失', `{ name: 'n', run: () => {} }`],
    ['run 不是函数', `{ name: 'n', summary: 's', run: 'go' }`],
    ['run 缺失', `{ name: 'n', summary: 's' }`],
    ['元素是 null', 'null'],
    ['元素是 undefined', 'undefined'],
  ];
  const ok = `{ name: 'good', summary: 'ok', run: () => {} }`;

  for (const [label, entry] of bad) {
    test(`坏元素夹在两个好元素中间（${label}）→ 抛错且报下标 1`, async () => {
      const dir = packOf(`{ name: 'acme', commands: [${ok}, ${entry}, ${ok}] }`);
      await assert.rejects(
        () => loadExtensions(dir),
        (e: Error) => {
          // 报错必须能定位到具体是第几条命令：三条里坏的是第 2 条（下标 1）。
          assert.match(e.message, /commands\[1\]/);
          return true;
        },
      );
    });
  }

  test('三条命令全是坏的：照样抛，且从第一条报起', async () => {
    const dir = packOf(`{ name: 'acme', commands: [{}, {}, {}] }`);
    await assert.rejects(
      () => loadExtensions(dir),
      (e: Error) => {
        assert.match(e.message, /commands\[0\]/);
        return true;
      },
    );
  });

  test('报错里带上扩展包路径 —— 两个仓时不说清是哪个文件等于没报', async () => {
    const dir = packDir('export default {};\n');
    await assert.rejects(
      () => loadExtensions(dir),
      (e: Error) => {
        assert.ok(e.message.includes(dir), `报错应含扩展包路径，实际：${e.message}`);
        return true;
      },
    );
  });
});

// ───────────────────── 钩子只通知、不拦截 ─────────────────────

/** 最常用的那个假 inner：旧态永远是 INTAKE，转移永远成功。 */
const plainInner = {
  async get() {
    return { state: 'INTAKE' };
  },
  async transition(id: string, to: string) {
    return { id, state: to };
  },
};

/** 装一个只有 onTransition 的包，并把收到的事件收集起来。 */
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

describe('transition 钩子', () => {
  test('没装钩子：直通，且一次旧态都不查（零开销）', async () => {
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
    assert.equal(getCalls, 0, '没装钩子时不该为了拿 from 多查一次');
  });

  test('装饰器把其余方法原样透传', async () => {
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

  test('转移成功后才发事件，from/to 是真实的前后态', async () => {
    const { seen } = await withOnTransition(`(e) => { globalThis.__extSeen.push(e); }`);
    await wrap(plainInner).transition('s1', 'CONFIRMED');
    assert.equal(seen.length, 1);
    const e = seen[0] as { id: string; from: string; to: string; at: number };
    assert.equal(e.id, 's1');
    assert.equal(e.from, 'INTAKE');
    assert.equal(e.to, 'CONFIRMED');
    assert.equal(typeof e.at, 'number');
  });

  test('转移失败：错误照常抛出，且一个事件都不发', async () => {
    const { seen } = await withOnTransition(`(e) => { globalThis.__extSeen.push(e); }`);
    const s = wrap({
      async get() {
        return { state: 'INTAKE' };
      },
      async transition() {
        throw new Error('非法转移：INTAKE → SHIPPED');
      },
    });
    await assert.rejects(() => s.transition('s1', 'SHIPPED'), /非法转移/);
    assert.deepEqual(seen, [], '从未发生的流转绝不能发给下游');
  });

  const transitionOk = {
    async transition(id: string, to: string) {
      return { id, state: to };
    },
  };
  for (const [label, get] of [
    [
      '查旧态抛错',
      async () => {
        throw new Error('db down');
      },
    ],
    ['查旧态返回 null', async () => null],
    ['查旧态返回无 state 字段的行', async () => ({})],
  ] as const) {
    test(`${label} → from=null，且转移本身照常成功`, async () => {
      const { seen } = await withOnTransition(`(e) => { globalThis.__extSeen.push(e); }`);
      const r = await wrap({ get, ...transitionOk }).transition('s1', 'CONFIRMED');
      assert.deepEqual(r, { id: 's1', state: 'CONFIRMED' }, '拿不到旧态不该影响转移结果');
      assert.equal((seen[0] as { from: string | null }).from, null);
    });
  }

  for (const [label, body] of [
    ['同步抛错', `() => { throw new Error('boom'); }`],
    ['返回 rejected promise', `async () => { throw new Error('boom-async'); }`],
    ['返回非 promise 的垃圾值', `() => 42`],
  ] as const) {
    test(`钩子${label} → 核心照常返回正确结果`, async () => {
      await withOnTransition(body);
      assert.deepEqual(await wrap(plainInner).transition('s1', 'CONFIRMED'), { id: 's1', state: 'CONFIRMED' });
    });
  }

  test('钩子卡住不返回 → 超时判负，核心不被吊死', async () => {
    // FORGE_EXT_HOOK_TIMEOUT_MS 在本文件顶部设为 80ms；这个钩子永远不 resolve。
    await withOnTransition(`() => new Promise(() => {})`);
    const t0 = Date.now();
    const r = await wrap(plainInner).transition('s1', 'CONFIRMED');
    const elapsed = Date.now() - t0;
    assert.deepEqual(r, { id: 's1', state: 'CONFIRMED' });
    assert.ok(elapsed < 1500, `应在超时阈值附近返回，实际等了 ${elapsed}ms`);
  });

  test('fireTransition 单独调用时钩子抛错也不外溢（钩子永远只是通知）', async () => {
    await withOnTransition(`() => { throw new Error('nope'); }`);
    await assert.doesNotReject(() => fireTransition({ id: 's1', from: null, to: 'CONFIRMED', at: 1 }));
  });
});

// ───────────────────── 命令优先级（真跑 CLI）─────────────────────

const exec = promisify(execFile);
const CLI = resolve(import.meta.dirname, '../src/index.ts');

/** 真跑一次 CLI，扩展包指向给定目录。返回 stdout（不关心退出码，冲突测试只看输出）。 */
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

describe('扩展命令与核心命令的优先级', () => {
  test('扩展自定义命令：能被分派到并跑起来', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'acme-ping', summary: '私有命令', run: (ctx) => {
        process.stdout.write('ACME_RAN pos=' + JSON.stringify(ctx.pos) + ' flag=' + String(ctx.flags.x) + '\\n');
      } }],
    }`);
    const r = await runCli(['acme-ping', 'a', '--x', 'y'], dir);
    assert.match(r.stdout, /ACME_RAN pos=\["a"\] flag=y/);
  });

  test('与核心命令重名：核心永远赢，扩展的 run 一次都不执行', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'help', summary: '劫持 help', run: () => {
        process.stdout.write('HIJACKED\\n');
      } }],
    }`);
    const r = await runCli(['help'], dir);
    assert.doesNotMatch(r.stdout, /HIJACKED/, '扩展绝不能靠重名接管核心命令');
    assert.match(r.stdout, /用法：\.\/forge/, '跑的应当是核心 help');
  });

  test('help 会列出扩展命令，并标明来自哪个包', async () => {
    const dir = packOf(`{
      name: 'acme',
      commands: [{ name: 'acme-bill', summary: '按会话结算', run: () => {} }],
    }`);
    const r = await runCli(['help'], dir);
    assert.match(r.stdout, /acme-bill/);
    assert.match(r.stdout, /按会话结算/);
    assert.match(r.stdout, /acme/);
  });

  test('没配扩展时 help 里不出现「扩展命令」段 —— 纯 OSS 输出不变', async () => {
    const r = await runCli(['help'], resolve(tmp, 'no-such-ext-dir'));
    assert.doesNotMatch(r.stdout, /扩展命令/);
  });

  test('扩展装不起来：任何命令都拒绝执行并退非零，不静默按无扩展跑', async () => {
    const dir = packDir('export default { name: 42 };\n');
    const r = await runCli(['help'], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /扩展包装载失败/);
    assert.doesNotMatch(r.stdout, /用法：\.\/forge/, '装载失败时不该假装一切正常地跑下去');
  });
});

// ─────────────────── 文档源注册（L2 挂载点）───────────────────
// 下游接自家文档系统（Notion / Confluence / 内部 wiki）不该需要改 docs/index.ts 那个数组。
// 这一组钉的是「能加、但加不坏核心」的边界。

describe('扩展注册文档源', () => {
  const notionPack = `{
    name: 'acme-docs',
    docSources: [{
      id: 'notion',
      claim: (input) => (String(input.text ?? '').includes('notion.example/') ? [{ source: 'notion', token: 'pg1' }] : []),
      parseRef: (u) => (u.includes('notion.example/') ? { source: 'notion', token: 'pg1' } : null),
      read: async () => ({ ok: true, text: 'NOTION 正文' }),
    }],
  }`;

  test('未装扩展：注册表就是核心那两个源（纯 OSS 行为逐字节不变）', () => {
    assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']);
  });

  test('装上之后：认领 → 落库键 → 读正文，整条链都认得这个新源', async () => {
    await loadExtensions(packOf(notionPack));
    assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext', 'notion']);
    const claimed = docs.claimDocs({ text: '这份需求见 https://notion.example/pg1' });
    assert.deepEqual(claimed, [{ source: 'notion', token: 'pg1' }]);
    assert.equal(docs.formatRef(claimed[0]), 'notion:pg1'); // 落库键带源前缀
    assert.deepEqual(docs.parseAnyRef('https://notion.example/pg1'), { source: 'notion', token: 'pg1' });
    assert.equal((await docs.readDoc(claimed[0])).text, 'NOTION 正文');
  });

  test('扩展源认不出的链接照旧交给核心源——加一个源不会挡住原来的路', async () => {
    await loadExtensions(packOf(notionPack));
    assert.equal(docs.parseAnyRef('https://notion.example/pg1')?.source, 'notion');
    assert.equal(docs.parseAnyRef('https://example.feishu.cn/docx/abc123')?.source, 'feishu');
  });

  test('id 与核心撞车：忽略扩展那份，核心源仍是原来那个（下游换不掉飞书源）', async () => {
    await loadExtensions(
      packOf(`{
        name: 'impostor',
        docSources: [{ id: 'feishu', claim: () => [{ source: 'feishu', token: 'hijacked' }], parseRef: () => ({ source: 'feishu', token: 'hijacked' }), read: async () => ({ ok: true, text: '冒牌正文' }) }],
      }`),
    );
    assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']); // 没多出一个同名源
    assert.equal(docs.parseAnyRef('随便一个不是链接的字符串'), null); // 冒牌源的 parseRef 没有生效
  });

  test('落库的 ref 活得比扩展包久：包摘掉之后 readDoc 如实报「未注册的源」，绝不静默当读失败', async () => {
    await loadExtensions(packOf(notionPack));
    const ref = { source: 'notion', token: 'pg1' };
    assert.equal((await docs.readDoc(ref)).ok, true);
    resetExtensionsForTest(); // = 部署里把扩展包摘掉了，但库里还存着 notion:pg1
    const after = await docs.readDoc(ref);
    assert.equal(after.ok, false);
    assert.match(after.error ?? '', /未注册的文档源「notion」/);
    assert.match(after.error ?? '', /feishu\/plaintext/); // 告诉人现在认得哪些
  });
});
