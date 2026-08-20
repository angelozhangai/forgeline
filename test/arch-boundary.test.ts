// 架构边界 fitness 测试（仿 ArchUnit）：核心层不得直连飞书 raw（feishu/* 目录）或 lark SDK——
// 所有 IM 传输细节必须收敛在 messaging/feishu.ts adapter 后，核心只依赖 provider 无关的 MessagingPort。
// 这是 README「接 Slack 核心一行不动」论断的机器守护：任何人再把 feishu/lark import 漏进核心 → CI 红。
//
// 关键：白名单按 **「文件 → 允许的 specifier」** 精确控制，而非整文件放行——否则 daemon/listen.ts 因合法
// import feishu/backfill 被整体放行后，未来在它里面直 import lark SDK 仍能过 CI（正是 P2 要堵的洞）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

// 每个文件允许直连的飞书/lark import specifier 子串。未列出的文件：一律不许出现 feishu/ 或 larksuiteoapi。
// 注意 daemon/listen.ts 只许 feishu/backfill——**不含** lark SDK：未来在它里面直 import lark 会被逮。
const ALLOW: Record<string, string[]> = {
  'messaging/feishu.ts': ['feishu/', 'larksuiteoapi'], // 唯一 adapter：lark 长连接 + feishu/* 收发渲染 + im 探针
  'intake.ts': ['feishu/doc'], // 读飞书文档（doc 层，README 明确豁免）
  'daemon/listen.ts': ['feishu/backfill'], // 离线补拉（auth/doc 豁免）——仅此一项，绝不含 larksuiteoapi
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

test('架构边界：listen 合法补拉不能掩护动态 import lark SDK 回流核心层', () => {
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
  assert.deepEqual(offenders, ['daemon/listen.ts → @larksuiteoapi/node-sdk']);
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

test('架构边界：doc 豁免只允许 intake 读 feishu/doc，不能扩散到 dm/group raw API', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'intake.ts',
      content: `
        import { readPrd } from './feishu/doc.ts';
        import { sendBotCard } from './feishu/dm.ts';
      `,
    },
  ]);
  assert.deepEqual(offenders, ['intake.ts → ./feishu/dm.ts']);
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
