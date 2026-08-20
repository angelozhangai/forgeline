// FORGE_PROMPTS_DIR overlay: private prompt sets override built-in templates without forking.
// Resolution order (first hit wins):
//   overlay/<project>/<rel> → overlay/<rel> → prompts/<project>/<rel> → prompts/<rel>
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompt } from '../src/util/render.ts';

let overlay: string;
const saved = process.env.FORGE_PROMPTS_DIR;

beforeEach(() => {
  overlay = mkdtempSync(join(tmpdir(), 'forge-prompts-'));
});
afterEach(() => {
  rmSync(overlay, { recursive: true, force: true });
  if (saved === undefined) delete process.env.FORGE_PROMPTS_DIR;
  else process.env.FORGE_PROMPTS_DIR = saved;
});

test('unset FORGE_PROMPTS_DIR → built-in template, unchanged behavior', () => {
  delete process.env.FORGE_PROMPTS_DIR;
  const builtIn = loadPrompt('gate-a.md');
  assert.ok(builtIn.trim().length > 0);
});

test('overlay global file beats built-in default', () => {
  writeFileSync(join(overlay, 'gate-a.md'), 'OVERLAY-GLOBAL');
  process.env.FORGE_PROMPTS_DIR = overlay;
  assert.equal(loadPrompt('gate-a.md'), 'OVERLAY-GLOBAL');
});

test('overlay project variant beats overlay global', () => {
  writeFileSync(join(overlay, 'gate-a.md'), 'OVERLAY-GLOBAL');
  mkdirSync(join(overlay, 'proj-x'), { recursive: true });
  writeFileSync(join(overlay, 'proj-x', 'gate-a.md'), 'OVERLAY-PROJ');
  process.env.FORGE_PROMPTS_DIR = overlay;
  assert.equal(loadPrompt('gate-a.md', 'proj-x'), 'OVERLAY-PROJ');
  // Other projects fall back to the overlay's global file.
  assert.equal(loadPrompt('gate-a.md', 'proj-y'), 'OVERLAY-GLOBAL');
});

test('overlay set but file absent → falls back to built-in (never throws)', () => {
  process.env.FORGE_PROMPTS_DIR = overlay; // empty dir
  const builtIn = loadPrompt('gate-a.md', 'proj-x');
  assert.ok(builtIn.trim().length > 0);
  assert.notEqual(builtIn, 'OVERLAY-GLOBAL');
});

test('overlay pointing at a nonexistent dir → falls back cleanly', () => {
  process.env.FORGE_PROMPTS_DIR = join(overlay, 'does-not-exist');
  const builtIn = loadPrompt('gate-a.md');
  assert.ok(builtIn.trim().length > 0);
});

test('partials resolve through the overlay too (nested rel paths)', () => {
  mkdirSync(join(overlay, 'partials'), { recursive: true });
  writeFileSync(join(overlay, 'partials', 'output-contract.md'), 'OVERLAY-PARTIAL');
  process.env.FORGE_PROMPTS_DIR = overlay;
  assert.equal(loadPrompt('partials/output-contract.md'), 'OVERLAY-PARTIAL');
});
