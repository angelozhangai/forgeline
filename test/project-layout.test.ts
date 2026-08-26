// doctor's project-layout check is **adapter-aware**, and that is the whole contract here:
//
//   1. actions=demo delegates the mechanical actions to the target project's own scripts, so their absence is
//      a real, fixable fault -> red, with a note naming exactly what is missing;
//   2. actions=native calls gh directly and needs no scripts at all, so a project holding nothing but its
//      CLAUDE.md brief is **complete** -> green.
//
// Rule 2 is the one worth pinning. Checking for scripts regardless leaves every open-source target with a red
// row nobody can ever clear, and a permanently red row is worse than no row: it teaches you to skim past the
// whole list, which is the one thing doctor cannot afford.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { layoutCheck } from '../src/project.ts';

/** A throwaway project root: `brief` writes CLAUDE.md, `scripts` writes the two files the demo adapter calls. */
function makeRoot(o: { brief?: boolean; scripts?: boolean }): string {
  const root = mkdtempSync(resolve(tmpdir(), 'forge-layout-'));
  if (o.brief) writeFileSync(resolve(root, 'CLAUDE.md'), '# project brief\n');
  if (o.scripts) {
    mkdirSync(resolve(root, 'scripts'), { recursive: true });
    writeFileSync(resolve(root, 'scripts', 'review-req.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(resolve(root, 'scripts', 'feishu-doc.js'), '// stub\n');
  }
  return root;
}

describe('doctor project layout', () => {
  test('actions=demo: brief + both scripts is the complete layout', () => {
    const root = makeRoot({ brief: true, scripts: true });
    try {
      assert.equal(layoutCheck(root, 'demo').ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('actions=demo: a brief with no scripts is red, and the note names what to add', () => {
    const root = makeRoot({ brief: true });
    try {
      const r = layoutCheck(root, 'demo');
      assert.equal(r.ok, false);
      assert.match(r.note, /review-req\.sh/);
      assert.match(r.note, /actions:native/); // it also points at the other way out, rather than only stating the fault
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('actions=native: a brief and nothing else is complete — scripts are not its business', () => {
    const root = makeRoot({ brief: true });
    try {
      const r = layoutCheck(root, 'native');
      assert.equal(r.ok, true);
      assert.doesNotMatch(r.label, /scripts/); // the label must not ask for something this adapter never uses
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('actions=native: a missing CLAUDE.md is still red — the gates read it as the project brief', () => {
    const root = makeRoot({ scripts: true });
    try {
      const r = layoutCheck(root, 'native');
      assert.equal(r.ok, false);
      assert.match(r.note, /CLAUDE\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
