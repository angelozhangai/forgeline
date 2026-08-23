// Document source — the **plain-text fallback source** (src/docs/plaintext.ts): the body is the IM message
// itself.
// Three things have to be nailed down: (1) it is off by default (turning it on starts spending money
// automatically); (2) content addressing after normalisation — the same paragraph pasted any which way is
// the same requirement; (3) the substance floor blocks pleasantries, and **not silently** (you can see that
// we judged it too short).
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let plaintextEnabled = false;
// Only loadConfig is replaced: within this file's module graph only plaintext.ts uses it (neither
// docs/index.ts nor docs/feishu.ts does), so the switch can be flipped per test — the real config is cached
// process-wide and cannot be moved.
// That the switch really is off in the repo's own runtime.yaml is asserted against the real file by
// config.test.ts.
mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: () => ({ runtime: { doc_sources: { plaintext: { enabled: plaintextEnabled } } } }),
  },
});
const pt = await import('../src/docs/plaintext.ts');
const docs = await import('../src/docs/index.ts');

// Source is English, input is not. A requirement arrives in whatever language it was written in, and the
// substance floor has to hold for each of them — so the fixtures come in pairs, and the non-English ones are
// built from code points rather than written as literal characters (see test/english-only.test.ts).
const REQ = 'Move the refund button to the top of the order detail page and add a second confirmation dialog';
const REQ_TERSE = 'Add a CSV export button to the orders list page';
const REQ_CN = String.fromCodePoint(0x628a, 0x9000, 0x6b3e, 0x6309, 0x94ae, 0x632a, 0x5230, 0x8ba2, 0x5355, 0x8be6, 0x60c5, 0x9875, 0x9876, 0x90e8, 0xff0c, 0x5e76, 0x52a0, 0x4e00, 0x6b21, 0x4e8c, 0x6b21, 0x786e, 0x8ba4, 0x5f39, 0x7a97);
const REQ_CN_TERSE = String.fromCodePoint(0x8ba2, 0x5355, 0x5217, 0x8868, 0x9875, 0x52a0, 0x4e2a, 0x5bfc, 0x51fa, 0x0020, 0x0043, 0x0053, 0x0056, 0x0020, 0x7684, 0x6309, 0x94ae);

test('normalizePlaintext: strips a Feishu @_user_N, a Slack <@U...> and <!here>, and collapses whitespace', () => {
  assert.equal(pt.normalizePlaintext('@_user_1  review this\n\n  requirement '), 'review this requirement');
  assert.equal(pt.normalizePlaintext('<@U012ABC> build a thing'), 'build a thing');
  assert.equal(pt.normalizePlaintext('<!here> everyone look at <@U9> the requirement'), 'everyone look at the requirement');
});

test('contentToken: who was @-ed and how the lines wrap make no difference — it is the same requirement (otherwise deduplication breaks outright)', () => {
  const a = pt.contentToken(pt.normalizePlaintext(`@_user_1 ${REQ}`));
  const b = pt.contentToken(pt.normalizePlaintext(`@_user_7 ${REQ}`)); // a different person @-ed
  const c = pt.contentToken(pt.normalizePlaintext(`  ${REQ}\n\n `)); // blank lines and indentation around it
  assert.equal(a, b);
  assert.equal(a, c);
});

test('contentToken: change a word and it is a different requirement (there is no document identity to follow, so the content is the identity)', () => {
  assert.notEqual(pt.contentToken(REQ), pt.contentToken(`${REQ}, and add analytics`));
});

// ── The substance floor ──────────────────────────────────────────────────
// It is weighted rather than counted, because the two bands sit at completely different character counts in
// different scripts. These two tests are the calibration the floor in plaintext.ts refers to: keep them
// together, and re-derive the floor from them if it ever moves.
test('substanceWeight: a word-like character weighs CJK_WEIGHT, everything else weighs 1', () => {
  assert.equal(pt.substanceWeight('abcd'), 4);
  assert.equal(pt.substanceWeight(String.fromCodePoint(0x597d, 0x7684)), 2 * pt.CJK_WEIGHT);
  assert.equal(pt.substanceWeight(' a b '), 2, 'whitespace must not count');
  // Punctuation is not word-like even when it is fullwidth: it carries no more meaning than a comma does.
  assert.equal(pt.substanceWeight(String.fromCodePoint(0x6536, 0x5230, 0xff0c, 0x8c22, 0x8c22)), 4 * pt.CJK_WEIGHT + 1);
});

test('hasSubstance: pleasantries do not get through and a real requirement does — in either script', () => {
  for (const ack of ['ok thanks', 'Got it, will do.', 'Sounds good, thank you!', 'Thanks a lot, that all sounds right to me!', String.fromCodePoint(0x597d, 0x7684), String.fromCodePoint(0x6536, 0x5230, 0xff0c, 0x8c22, 0x8c22), String.fromCodePoint(0x6536, 0x5230, 0xff0c, 0x8c22, 0x8c22, 0xff0c, 0x8f9b, 0x82e6, 0x4e86), '\u{1f44d}']) {
    assert.equal(pt.hasSubstance(pt.normalizePlaintext(ack)), false, ack);
  }
  for (const req of [REQ, REQ_TERSE, REQ_CN, REQ_CN_TERSE]) {
    assert.equal(pt.hasSubstance(pt.normalizePlaintext(req)), true, req);
  }
});

test('hasSubstance: the boundary is exactly MIN_SUBSTANCE_WEIGHT, and whitespace does not count towards it', () => {
  assert.equal(pt.hasSubstance('x'.repeat(pt.MIN_SUBSTANCE_WEIGHT - 1)), false);
  assert.equal(pt.hasSubstance('x'.repeat(pt.MIN_SUBSTANCE_WEIGHT)), true);
  assert.equal(pt.hasSubstance(' x '.repeat(pt.MIN_SUBSTANCE_WEIGHT)), true, 'whitespace should not count towards the length');
});

test('off by default: with the switch off it claims nothing (zero change for an existing deployment — a message with no link is ignored as before)', () => {
  plaintextEnabled = false;
  assert.deepEqual(pt.plaintextDocs.claim({ text: REQ }), []);
  assert.equal(pt.plaintextDocs.parseRef(REQ), null);
});

test('once on: a paragraph with substance -> one ref, with the body riding along in raw (not persisted)', () => {
  plaintextEnabled = true;
  const refs = pt.plaintextDocs.claim({ text: `@_user_1 ${REQ}` });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].source, 'plaintext');
  assert.equal(refs[0].raw, REQ, 'the normalised body travels with the ref — there is no remote to go back to');
  assert.equal(refs[0].url, undefined, 'a paragraph has no link to open');
  assert.equal(refs[0].token, pt.contentToken(REQ));
});

test('once on: a requirement written in another language claims exactly the same way (source is English, input is not)', () => {
  plaintextEnabled = true;
  const refs = pt.plaintextDocs.claim({ text: `@_user_1 ${REQ_CN}` });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].raw, REQ_CN, 'the body must be carried through verbatim');
  assert.equal(refs[0].token, pt.contentToken(REQ_CN));
});

test('once on: a pleasantry is still not claimed', () => {
  plaintextEnabled = true;
  assert.deepEqual(pt.plaintextDocs.claim({ text: `@_user_1 ${String.fromCodePoint(0x6536, 0x5230, 0xff0c, 0x8c22, 0x8c22)}` }), []);
  assert.deepEqual(pt.plaintextDocs.claim({ text: '   ' }), []);
});

test('the body only, never searchTexts — that is the whole serialised event, and taking it for a requirement body would be a disaster', () => {
  plaintextEnabled = true;
  const eventJson = JSON.stringify({ message_id: 'om_1', body: { content: `{"text":"${REQ}"}` } });
  assert.deepEqual(pt.plaintextDocs.claim({ text: 'ok thanks', searchTexts: [eventJson] }), []);
});

test('parseRef: a link is never accepted — storing an unrecognised URL as the body is far worse than saying plainly that it is unrecognised', () => {
  plaintextEnabled = true;
  assert.equal(pt.plaintextDocs.parseRef('https://www.notion.so/a-very-long-page-title-123456'), null);
  assert.equal(pt.plaintextDocs.parseRef('http://internal.wiki/some/really/long/path/page'), null);
  assert.equal(pt.plaintextDocs.parseRef(REQ)?.token, pt.contentToken(REQ)); // only a paragraph is accepted
});

test('read: with raw present that is the body; without it, it says truthfully that it cannot be read (never an empty body pretending it read something)', async () => {
  assert.deepEqual(await pt.plaintextDocs.read({ source: 'plaintext', token: 't', raw: REQ }), { ok: true, text: REQ });
  const stale = await pt.plaintextDocs.read({ source: 'plaintext', token: 't' }); // a stored ref, with no raw
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? '', /cannot be re-read/);
});

test('no comment capability: there is nowhere to write an annotation back to on a piece of IM text (the core skips it silently)', () => {
  assert.equal(pt.plaintextDocs.comment, undefined);
});

// ── Its standing once wired into the registry ─────────────────────────────────────────────
test('the registry: plaintext is the fallback source, Feishu is a primary one', () => {
  assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']);
  assert.equal(docs.sources().find((s) => s.id === 'plaintext')?.fallback, true);
  assert.equal(docs.sources().find((s) => s.id === 'feishu')?.fallback, undefined);
});

test('the registry: when the message has a Feishu link, plaintext never takes the stage (or the same message would be registered twice)', () => {
  plaintextEnabled = true;
  const got = docs.claimDocs({ text: `${REQ} https://x.feishu.cn/docx/TOKA` });
  assert.deepEqual(got.map(docs.formatRef), ['feishu:TOKA']);
});

test('the registry: plaintext only gets its turn when there is no link at all, and it takes just one', () => {
  plaintextEnabled = true;
  const got = docs.claimDocs({ text: REQ });
  assert.equal(got.length, 1);
  assert.equal(got[0].source, 'plaintext');
});

test('the registry: with the switch off nobody claims a message that has no link (back to the phase 1 behaviour)', () => {
  plaintextEnabled = false;
  assert.deepEqual(docs.claimDocs({ text: REQ }), []);
  assert.equal(docs.parseAnyRef(REQ), null);
});
