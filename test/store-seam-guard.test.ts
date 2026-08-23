// A guardrail for the SessionStore seam: no file under src/ - **except store/ itself** - may import
// store/sessions.ts directly; everything must go through `store` at the selection point in store/index.ts.
// Otherwise a future consumer importing sessions.ts directly would silently bypass the seam and be missed when
// the backend is switched to remoteApi (it would still hold the sqlite implementation). This test catches that
// regression on the spot.
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

test('seam discipline: no file under src/ outside store/ imports store/sessions.ts directly (everything goes through store/index.ts)', () => {
  const storeDir = resolve(SRC, 'store');
  const re = /from\s+['"][^'"]*store\/sessions\.ts['"]/;
  const offenders = walk(SRC)
    .filter((f) => !f.startsWith(storeDir)) // inside store/ (the index.ts selection point and friends) may reference the implementation directly
    .filter((f) => re.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `These files bypass the SessionStore seam and should import { store } from store/index.ts instead:\n${offenders.join('\n')}`);
});
