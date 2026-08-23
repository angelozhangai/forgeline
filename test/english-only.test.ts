// English-only fitness test: every tracked byte of this repository is English.
//
// This repo is an open core whose whole premise is that downstream integrators build against
// src/ext/port.ts and src/messaging/port.ts without ever patching a core file. A contract they
// cannot read is not a contract. The rule therefore covers source, comments, docs, config
// comments and every string the service emits — see the "English is the only language" top rule
// in AGENTS.md.
//
// Scope is **tracked files** (`git ls-files`), and that boundary is the point, not an accident:
//  · Requirement documents arriving from Feishu/Slack are *input*. Forge must keep handling
//    non-English PRDs perfectly well — logs/ and state/ are full of them and are untracked.
//  · What must be English is what a contributor reads and what the service says back.
// Scanning the working tree instead of the index would conflate the two and start failing on a
// developer's own runtime data.
//
// The migration ran behind a PENDING ratchet, in the style of ALLOW in arch-boundary.test.ts. It is
// empty now, so the mechanism is gone: this is a plain zero-tolerance assertion, and there is no
// list to add a file back to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Non-Latin scripts that would defeat the rule. Deliberately *not* matched: emoji (U+1F300 and
// up) and symbols like the check mark, which the status labels in src/util/display.ts use on
// purpose.
const NON_ENGLISH = new RegExp(
  '[' +
    '\\u2e80-\\u2eff' + // CJK radicals supplement
    '\\u3000-\\u303f' + // CJK symbols and punctuation (fullwidth brackets, ideographic comma/stop)
    '\\u3040-\\u30ff' + // hiragana + katakana
    '\\u3400-\\u4dbf' + // CJK unified ideographs extension A
    '\\u4e00-\\u9fff' + // CJK unified ideographs
    '\\uac00-\\ud7af' + // hangul syllables
    '\\uf900-\\ufaff' + // CJK compatibility ideographs
    '\\uff00-\\uffef' + // halfwidth and fullwidth forms
    ']',
);

// Binary payloads have no language. Everything else is read as UTF-8 and scanned.
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|gz|db|sqlite)$/i;

function trackedFiles(): string[] {
  // A check that cannot check is not a check (see the --test-force-exit episode): if git is
  // unavailable this must fail loudly rather than quietly scanning nothing.
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const files = out.split('\0').filter(Boolean);
  assert.ok(files.length > 100, `git ls-files returned ${files.length} files — the scan cannot be trusted`);
  return files.filter((f) => !BINARY.test(f));
}

/** Tracked files containing non-English text, each with its first offending line. */
export function offenders(files: string[]): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue; // deleted-but-still-indexed; nothing to scan
    }
    if (!NON_ENGLISH.test(content)) continue;
    const lines = content.split('\n');
    const i = lines.findIndex((l) => NON_ENGLISH.test(l));
    found.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 80) });
  }
  return found;
}

test('English-only: no tracked file carries non-English text', () => {
  const bad = offenders(trackedFiles());
  assert.deepEqual(
    bad.map((o) => `${o.file}:${o.line}`),
    [],
    `These tracked files contain non-English text:\n  ${bad
      .map((o) => `${o.file}:${o.line}  ${o.text}`)
      .join('\n  ')}`,
  );
});

// Detection itself has to be pinned, or the assertion above passes for the wrong reason: a regex
// that matches nothing finds no offender either. Each case is a script the rule bans; the last
// three are what must NOT trip it.
//
// The fixtures are built from code points rather than written as literal characters on purpose:
// this file is itself a tracked file, and a guard that has to exempt itself from its own rule is
// not a guard.
test('English-only: the detector matches every banned script and no emoji', () => {
  const matched = (...cps: number[]) => NON_ENGLISH.test(String.fromCodePoint(...cps));
  assert.equal(matched(0x67, 0x61, 0x74, 0x65), false, 'plain ASCII');
  assert.equal(matched(0x95f8), true, 'CJK unified');
  assert.equal(matched(0x3400), true, 'CJK extension A');
  assert.equal(matched(0xff08), true, 'fullwidth punctuation');
  assert.equal(matched(0x300c), true, 'CJK punctuation');
  assert.equal(matched(0x3072), true, 'hiragana');
  assert.equal(matched(0x30ab), true, 'katakana');
  assert.equal(matched(0xd55c), true, 'hangul');
  assert.equal(matched(0xf900), true, 'CJK compatibility ideographs');
  assert.equal(matched(0x2e80), true, 'CJK radicals');
  assert.equal(matched(0x1f4e5), false, 'emoji are deliberately allowed');
  assert.equal(matched(0x2713), false, 'check mark is allowed');
  assert.equal(matched(0x2014), false, 'em dash is allowed');
});
