// 架构边界 fitness 测试（仿 ArchUnit）：核心层不得直连飞书 raw（feishu/* 目录）或 lark SDK——
// 所有 IM 传输细节必须收敛在 messaging/feishu.ts adapter 后，核心只依赖 provider 无关的 MessagingPort。
// 这是 README「接 Slack 核心一行不动」论断的机器守护：任何人再把 feishu/lark import 漏进核心 → CI 红。
//
// 关键：白名单按 **「文件 → 允许的 specifier」** 精确控制，而非整文件放行——否则一个文件因某一条合法
// import 被整体放行后，未来在它里面直 import lark SDK 仍能过 CI。
//
// 白名单是**棘轮，只许变短**：daemon/listen.ts 那条（离线补拉直连 feishu/backfill）在 Phase 0 拿掉，
// intake.ts 那条（直读 feishu/doc）在 Phase 1 拿掉——读文档收进 docs/feishu.ts，核心只见 DocRef。
// 现在只剩 messaging/feishu.ts 这一个 IM adapter。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

// 每个文件允许直连的飞书/lark import specifier 子串。未列出的文件：一律不许出现 feishu/ 或 larksuiteoapi。
const ALLOW: Record<string, string[]> = {
  'messaging/feishu.ts': ['feishu/', 'larksuiteoapi'], // 唯一 IM adapter：lark 长连接 + feishu/* 收发渲染 + 群历史 + im 探针
};
// feishu/* 目录本就是飞书 provider 层：内部互相 import + 可用 lark SDK。
function allowedFor(rel: string): string[] {
  if (rel.startsWith('feishu/')) return ['feishu/', 'larksuiteoapi'];
  return ALLOW[rel] ?? [];
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r));
    else if (e.name.endsWith('.ts')) out.push(r);
  }
  return out;
}

// 摘出「直连飞书 raw / lark SDK」（specifier 含 'feishu/' 目录 或 'larksuiteoapi' SDK）的 import。
// 覆盖全部导入形态——绝不只看 `from '...'`：动态 import() 在本仓真实存在（index.ts await import 'eval/*'），
// 故 `await import('@larksuiteoapi/...')` 这类绕过必须也逮到；连同副作用 import 与 require 一并覆盖。
//  · 静态/再导出：import X from '...' / export ... from '...'
//  · 动态：import('...')（含 await/空白）
//  · 副作用：import '...'（无 from）
//  · CJS：require('...')
// 只匹配真正的 import 字符串字面量，不误伤散落字符串（如 index.ts doctor 探测 node_modules 路径的字面量）。
// 注意：'messaging/feishu.ts'（子串 'feishu.'，非 'feishu/'）= adapter 自身路径，不算直连。
const SPEC_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import X from '...' / export ... from '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import('...')
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import '...'
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // cjs require('...')
];
function feishuImports(content: string): string[] {
  const specs = new Set<string>();
  for (const re of SPEC_RES) {
    for (const m of content.matchAll(re)) {
      const spec = m[1];
      if (spec.includes('feishu/') || spec.includes('larksuiteoapi')) specs.add(spec);
    }
  }
  return [...specs];
}

function boundaryOffenders(files: { rel: string; content: string }[]): string[] {
  const offenders: string[] = [];
  for (const { rel, content } of files) {
    const allowed = allowedFor(rel);
    for (const spec of feishuImports(content)) {
      if (!allowed.some((a) => spec.includes(a))) offenders.push(`${rel} → ${spec}`);
    }
  }
  return offenders;
}

function srcFiles(): { rel: string; content: string }[] {
  const files: { rel: string; content: string }[] = [];
  for (const rel of walk(SRC)) {
    files.push({ rel, content: readFileSync(join(SRC, rel), 'utf8') });
  }
  return files;
}

test('架构边界：真实 src 上线闸不允许核心层直连 feishu/* 或 lark SDK', () => {
  const offenders = boundaryOffenders(srcFiles());
  assert.deepEqual(
    offenders,
    [],
    `这些直连飞书 raw / lark SDK 的 import 不在该文件白名单内，应改走 MessagingPort（startInbound/probe/出站卡）：\n  ${offenders.join('\n  ')}`,
  );
});

// Phase 0 关缝：listen 连「离线补拉」这条唯一合法豁免都不再有了。补拉循环走 messaging/backfill.ts，
// 群历史那一次 API 往返收在 adapter 里（port.listHistorySince）。这条用例钉死缝已合上——
// 谁再把 feishu/* 拉回 listen（哪怕是当年那条合法的 backfill），闸就红。
test('架构边界：Phase 0 后 listen 连合法补拉都不许直连 feishu/*', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'daemon/listen.ts',
      content: `
        import { backfillAll } from '../feishu/backfill.ts';
        export async function listen() {
          await backfillAll();
          await import('@larksuiteoapi/node-sdk');
        }
      `,
    },
  ]);
  assert.deepEqual(offenders, ['daemon/listen.ts → ../feishu/backfill.ts', 'daemon/listen.ts → @larksuiteoapi/node-sdk']);
});

// 白名单是棘轮：加一条豁免 = 往缝里开一个洞，必须是有意的（改这个断言）而非顺手加一行。
test('架构边界：飞书豁免白名单只剩 IM adapter 一条（只许变短）', () => {
  assert.deepEqual(Object.keys(ALLOW).sort(), ['messaging/feishu.ts']);
});

test('架构边界：核心层用副作用 import 或 require 偷接 lark SDK 时发布闸必须红', () => {
  const offenders = boundaryOffenders([
    { rel: 'orchestrator/worker.ts', content: `import '@larksuiteoapi/node-sdk';` },
    { rel: 'notify.ts', content: `const lark = require('@larksuiteoapi/node-sdk');` },
  ]);
  assert.deepEqual(offenders, [
    'orchestrator/worker.ts → @larksuiteoapi/node-sdk',
    'notify.ts → @larksuiteoapi/node-sdk',
  ]);
});

// Phase 1 关缝：intake 连「读飞书文档」这条豁免也没了——读文档走 docs 注册表（DocSource.read）。
test('架构边界：Phase 1 后 intake 连读飞书文档都不许直连 feishu/*', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'intake.ts',
      content: `
        import { readPrd } from './feishu/doc.ts';
        import { sendBotCard } from './feishu/dm.ts';
      `,
    },
  ]);
  assert.deepEqual(offenders, ['intake.ts → ./feishu/doc.ts', 'intake.ts → ./feishu/dm.ts']);
});

// ── 第二条边界（Phase 1 新增）：文档源也只能经注册表用 ───────────────────
// docs/<source>.ts 是**实现**，docs/index.ts 是**接线处**。核心一旦直接 import 某个源，
// 「加一个源=加一行注册」就不成立了：那份直连会跟着源一起腐烂，而且绕过 fallback/去重的解析规则。
// 例外只有两类：docs/ 目录内部（index 注册 + 源之间共用）、以及测试。
function docSourceOffenders(files: { rel: string; content: string }[]): string[] {
  const offenders: string[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith('docs/')) continue; // 注册表自己 + 源内部
    for (const re of SPEC_RES) {
      for (const m of content.matchAll(re)) {
        const spec = m[1];
        if (/(^|\/)docs\/[A-Za-z0-9_-]+\.ts$/.test(spec) && !spec.endsWith('/docs/index.ts')) {
          offenders.push(`${rel} → ${spec}`);
        }
      }
    }
  }
  return offenders;
}

test('架构边界：真实 src 里核心层只经 docs/index.ts 用文档源，不直连某个具体源', () => {
  const offenders = docSourceOffenders(srcFiles());
  assert.deepEqual(offenders, [], `这些直连具体文档源的 import 应改走 docs/index.ts：\n  ${offenders.join('\n  ')}`);
});

test('架构边界：直连 docs/feishu.ts 会被逮；走 docs/index.ts 放行', () => {
  assert.deepEqual(
    docSourceOffenders([
      { rel: 'intake.ts', content: `import { feishuDocs } from './docs/feishu.ts';` },
      { rel: 'gates/gateA.ts', content: `import { commentDoc } from '../docs/index.ts';` },
    ]),
    ['intake.ts → ./docs/feishu.ts'],
  );
});

test('架构边界：非 import 字符串只作 doctor/文档文本时不误伤', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'index.ts',
      content: `
        const sdkPath = 'node_modules/@larksuiteoapi/node-sdk';
        const note = 'feishu/backfill.ts is documented in README';
      `,
    },
  ]);
  assert.deepEqual(offenders, []);
});
