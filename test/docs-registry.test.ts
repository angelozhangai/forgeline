// The resolution rules of the document-source **registry** (src/docs/index.ts). This is where "adding a
// source is adding one line" is actually made good, and it holds a few rules that must not be got wrong:
// non-fallback sources take the union, a fallback source only steps in when nobody claimed and contributes
// at most one ref, an unregistered source reports the fact rather than failing silently, and the stored key
// carries a source prefix -- a token collision across sources would breach the PRD-deduplication red line.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocRef, DocSource } from '../src/docs/port.ts';

// Fake sources stand in for the real Feishu one: what these tests cover is the **registry's rules**, not any
// individual source's regular expressions.
function src(id: string, opts: { fallback?: boolean; claims?: string[]; parses?: string[]; canComment?: boolean; readText?: string } = {}): DocSource {
  const s: DocSource = {
    id,
    fallback: opts.fallback,
    claim: (input) => (opts.claims ?? []).filter((t) => `${input.text} ${(input.searchTexts ?? []).join(' ')}`.includes(t)).map((token) => ({ source: id, token })),
    parseRef: (u) => ((opts.parses ?? []).some((p) => u.includes(p)) ? { source: id, token: u } : null),
    read: async () => ({ ok: true, text: opts.readText ?? `${id} body` }),
  };
  if (opts.canComment) s.comment = async (_ref, text) => (text === 'boom' ? { ok: false, error: 'could not write it' } : { ok: true });
  return s;
}

const A = src('alpha', { claims: ['A1', 'A2'], parses: ['alpha.example'], canComment: true });
const B = src('beta', { claims: ['B1'], parses: ['beta.example'] });
const F = src('fallback-src', { fallback: true, claims: ['A1', 'B1', 'anything'], parses: [''] });
const docs = await import('../src/docs/index.ts');

test('the real registry: Feishu is a primary source and plaintext is the fallback', () => {
  assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']);
  assert.equal(docs.sources().find((s) => s.id === 'feishu')?.fallback, undefined, 'Feishu must never be marked as a fallback -- it would swallow other sources\' links');
  assert.equal(docs.sources().find((s) => s.id === 'plaintext')?.fallback, true);
});

test('formatRef / parseStoredRef: the stored key carries the source prefix and splits on the first colon, so a token may contain more of them', () => {
  assert.equal(docs.formatRef({ source: 'feishu', token: 'ABC' }), 'feishu:ABC');
  assert.deepEqual(docs.parseStoredRef('feishu:ABC'), { source: 'feishu', token: 'ABC' });
  assert.deepEqual(docs.parseStoredRef('slack:C123:1712.45'), { source: 'slack', token: 'C123:1712.45' });
});

test('parseStoredRef: no prefix, an empty source or an empty token all give null (never guess a source)', () => {
  assert.equal(docs.parseStoredRef('ABC'), null); // the bare-token shape from before the migration
  assert.equal(docs.parseStoredRef(':ABC'), null);
  assert.equal(docs.parseStoredRef('feishu:'), null);
  assert.equal(docs.parseStoredRef(null), null);
  assert.equal(docs.parseStoredRef(''), null);
});

test('readDoc: an unregistered source says so plainly and lists the registered ones (never a silent read failure)', async () => {
  const r = await docs.readDoc({ source: 'notion', token: 'p1' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Unregistered document source/);
  assert.match(r.error ?? '', /feishu/);
});

test('commentDoc: no document source, or an unregistered one, never throws (best effort -- it must not block a gate)', async () => {
  await docs.commentDoc(null, 'a comment'); // added by hand, or a standalone issue: there was never anywhere to write
  await docs.commentDoc('notion:p1', 'a comment'); // the source is not registered: log it, do not throw
  await docs.commentDoc('feishu:', 'a comment'); // unparseable: do not throw
});

// -- The registry's rules themselves, across several sources ------------------------------------------
// resolveClaims / resolveRef are the **rules**; claimDocs / parseAnyRef merely wire them to the real
// registry. They are separate exactly for this: feed in any list of sources and test the rules directly,
// rather than talking to yourself about the single source that happens to be registered.
const registry = [A, B, F];
const claimWith = (list: DocSource[], input: { text: string; searchTexts?: string[] }): DocRef[] => docs.resolveClaims(list, input);

test('rule: one message carrying links from two sources claims both (the union, not first past the post)', () => {
  const got = claimWith(registry, { text: 'there is an A1 here and a B1 too' });
  assert.deepEqual(got.map(docs.formatRef), ['alpha:A1', 'beta:B1']);
});

test('rule: when a primary source claims, the fallback never steps in (otherwise the same passage is registered twice)', () => {
  const got = claimWith(registry, { text: 'A1 anything' });
  assert.deepEqual(got.map(docs.formatRef), ['alpha:A1']);
});

test('rule: only when nobody claims does the fallback get its turn, and it contributes at most one (never splitting a passage into several requirements)', () => {
  const got = claimWith(registry, { text: 'anything, but no primary-source link' });
  assert.deepEqual(got.map(docs.formatRef), ['fallback-src:anything']);
});

test('rule: fallback is a **flag**, not a position in the array -- put the fallback first and it still does not outrank a primary source', () => {
  const reordered = [F, A, B];
  assert.deepEqual(claimWith(reordered, { text: 'A1 anything' }).map(docs.formatRef), ['alpha:A1']);
});

test('rule: one source claiming the same document from both the body and a fallback block leaves a single ref', () => {
  const dup = src('dup', { claims: ['X'] });
  const got = claimWith([dup], { text: 'X', searchTexts: ['X again X'] });
  assert.deepEqual(got.map(docs.formatRef), ['dup:X']);
});

test('rule: nobody claims -> empty, which is how the caller says plainly that it could not identify one rather than guessing', () => {
  assert.deepEqual(claimWith([A, B], { text: 'nice weather today' }), []);
});

test('resolveRef: the primary sources are asked first, and only if none of them claim is the fallback asked', () => {
  assert.deepEqual(docs.resolveRef(registry, 'https://beta.example/p1'), { source: 'beta', token: 'https://beta.example/p1' });
  // No primary source claims -> the fallback catches it (its parseRef accepts anything).
  assert.equal(docs.resolveRef(registry, 'just some passage of text')?.source, 'fallback-src');
  // With no fallback present, nobody claims -> null.
  assert.equal(docs.resolveRef([A, B], 'just some passage of text'), null);
});

test('resolveRef: even placed first, the fallback cannot take a link a primary source recognises', () => {
  assert.equal(docs.resolveRef([F, A, B], 'https://alpha.example/p1')?.source, 'alpha');
});

test('the wiring: claimDocs / parseAnyRef are those same rules running against the real registry, and a Feishu link gets through', () => {
  const url = 'https://x.feishu.cn/docx/REALTOK';
  assert.deepEqual(docs.claimDocs({ text: `have a look at ${url}` }).map(docs.formatRef), ['feishu:REALTOK']);
  assert.deepEqual(docs.parseAnyRef(url), { source: 'feishu', token: 'REALTOK', url });
  assert.equal(docs.parseAnyRef('https://www.notion.so/page-1'), null, 'no primary source claims it and the fallback does not take links -- unrecognised means unrecognised');
});

// -- The merge rules: core sources plus the ones an extension pack registers (docSources in
// src/ext/port.ts) --
// These are the whole of the guarantee that downstream can add a source without breaking the core, so each
// one is pinned separately.

test('merge: extension sources follow the core ones (the core comes first, which is what settles the fallback order)', () => {
  const merged = docs.mergeSources([A, F], [B]);
  assert.deepEqual(merged.map((s) => s.id), ['alpha', 'fallback-src', 'beta']);
});

test('merge: an id colliding with a core source drops the extension\'s copy (the core always wins, and downstream cannot replace the Feishu source)', () => {
  const impostor = src('alpha', { claims: ['A1'], readText: 'impostor body' });
  const merged = docs.mergeSources([A, F], [impostor, B]);
  assert.deepEqual(merged.map((s) => s.id), ['alpha', 'fallback-src', 'beta']);
  assert.equal(merged[0], A, 'what survives must be the core object itself, not the extension source of the same name');
});

test('merge: extension sources are deduplicated against each other too (the same id twice keeps the first)', () => {
  const merged = docs.mergeSources([A], [src('beta', { claims: ['B1'] }), src('beta', { claims: ['B2'] })]);
  assert.deepEqual(merged.map((s) => s.id), ['alpha', 'beta']);
});

test('merge: the core fallback comes before an extension fallback, so with both alive the core one claims first', () => {
  const extraFallback = src('ext-fallback', { fallback: true, claims: ['anything'] });
  const merged = docs.mergeSources([A, F], [extraFallback]);
  const claimed = docs.resolveClaims(merged, { text: 'anything no other source claims' });
  assert.deepEqual(claimed, [{ source: 'fallback-src', token: 'anything' }]);
  assert.equal(claimed.length, 1, 'a fallback contributes at most one -- two of them must not register the same passage twice');
});

test('merge: an empty extension list gives back the core list item for item (with no pack installed the behaviour is unchanged, byte for byte)', () => {
  assert.deepEqual(docs.mergeSources([A, F], []), [A, F]);
});
