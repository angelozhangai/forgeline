// 护栏：SessionStore 接缝纪律——src 里**除 store/ 自身**，任何文件都不得直连 store/sessions.ts，
// 必须经选择点 store/index.ts 的 `store`。否则未来新增消费方直 import sessions.ts 会静默绕过接缝，
// 将来换 remoteApi 后端时漏掉它（拿到的是 sqlite 实现）。这条把这类回归当场逮住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('接缝纪律：src 里除 store/ 外无文件直连 store/sessions.ts（一律经 store/index.ts）', () => {
  const storeDir = resolve(SRC, 'store');
  const re = /from\s+['"][^'"]*store\/sessions\.ts['"]/;
  const offenders = walk(SRC)
    .filter((f) => !f.startsWith(storeDir)) // store/ 内部（index.ts 选择点等）可直连实现
    .filter((f) => re.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `这些文件绕过了 SessionStore 接缝，应改 import { store } from store/index.ts：\n${offenders.join('\n')}`);
});
