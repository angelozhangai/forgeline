// Integration: the production entry point, turning a requirement document into a session. What matters here
// is deduplication, the channel-message metadata, and persisting the slug and branch. It does not mirror
// addPrd's internal steps -- it asserts against the shipping goal that a repeated message must never create
// two requirements.
//
// Only **reading the body** is stubbed out (that needs the network and a subprocess). Normalising the link,
// the source prefix and resolving through the registry all run for real: deduplicating at the PRD level is a
// red line, and testing it against a fake normaliser would be testing nothing.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DocRef } from '../src/docs/port.ts';

let readCalls = 0;
// The requirement document is deliberately non-English, written as escapes. This repo's source is English;
// the PRDs it ingests are not, and intake is exactly where that has to keep working.
const prdText = '# \u9000\u6b3e\u51b3\u7b56\n\nPM \u5e0c\u671b\u8865\u9f50\u9000\u6b3e\u6d41\u3002';
let prdOk = true;
let slugProposal: string | null = 'refund-decision';
// The racer that gets in first while the document is being read: when this is not null, read() inserts a
// session with the same doc_ref before returning, simulating a concurrent race.
let raceInsert: (() => Promise<void>) | null = null;

// The real claim/parseRef are kept -- normalising the token is what deduplication actually rests on -- and
// only read is replaced with a stub that does not touch the network.
const realFeishu = await import('../src/docs/feishu.ts');
mock.module('../src/docs/feishu.ts', {
  namedExports: {
    ...realFeishu,
    feishuDocs: {
      ...realFeishu.feishuDocs,
      read: async () => {
        readCalls++;
        if (raceInsert) {
          const r = raceInsert;
          raceInsert = null;
          await r();
        }
        return prdOk ? { ok: true, text: prdText } : { ok: false, text: '', error: 'no permission for this document' };
      },
    },
  },
});

// With no originating chat given, the fallback goes through port.watchedChats() -- Phase 4 stopped hard-coding
// FEISHU_REVIEW_CHAT_ID.
mock.module('../src/messaging/index.ts', { namedExports: { port: { id: 'fake', watchedChats: () => ['oc_default'] } } });

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaudeBare: async () => slugProposal,
  },
});

const sessions = await import('../src/store/sessions.ts');
const { addPrd } = await import('../src/intake.ts');
const { parseAnyRef } = await import('../src/docs/index.ts');

// Every test starts from a link and resolves it through the registry exactly as production does -- a DocRef
// is never hand-built here.
const ref = (url: string): DocRef => parseAnyRef(url)!;

test('addPrd: the same Feishu PRD delivered twice reuses the existing session, reading the document once and creating one requirement', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'refund-decision';
  const first = await addPrd({
    doc: ref('https://x.feishu.cn/docx/ABC'),
    chatId: 'oc_group',
    posterId: 'ou_pm',
    intakeMsgId: 'om_msg',
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(readCalls, 1);
  assert.equal(first.session?.slug, 'refund-decision');
  assert.equal(first.session?.branch, 'main'); // anchored to main by default (runtime.yaml has default_branch: prod)
  assert.equal(first.session?.chat_id, 'oc_group');
  assert.equal(first.session?.poster_id, 'ou_pm');
  assert.equal(first.session?.intake_msg_id, 'om_msg');

  const second = await addPrd({ doc: ref('https://x.feishu.cn/docx/ABC'), chatId: 'oc_group_2' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.session?.id, first.session?.id);
  assert.equal(readCalls, 1);
  assert.match(second.msg, /already been reviewed|will not start another review/); // product is told plainly that this one will not be reviewed again
  assert.equal((await sessions.listAll()).filter((s) => s.prd_url === 'https://x.feishu.cn/docx/ABC').length, 1);
});

test('addPrd: URL variants of the same PRD (a query string, a trailing slash) deduplicate by doc_ref and create no second session', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'points-expiry';
  const a = await addPrd({ doc: ref('https://x.feishu.cn/docx/XYZ') });
  assert.equal(a.created, true);
  assert.equal(readCalls, 1);

  // Different link shapes for the same document (a share link's ?from=, a trailing /) normalise to the same
  // doc_ref, so the duplicate is caught before the document is read and readCalls does not go up.
  for (const variant of ['https://x.feishu.cn/docx/XYZ?from=share_copy_link', 'https://x.feishu.cn/docx/XYZ/']) {
    const dup = await addPrd({ doc: ref(variant) });
    assert.equal(dup.created, false, variant);
    assert.equal(dup.duplicate, true, variant);
    assert.equal(dup.session?.id, a.session?.id, variant);
  }
  assert.equal(readCalls, 1); // no variant triggered a second read
  assert.equal((await sessions.listAll()).filter((s) => s.doc_ref === 'feishu:XYZ').length, 1); // exactly one, and it carries the source prefix
});

test('addPrd: an explicit slug and branch win, and a failed document read creates no session', async () => {
  readCalls = 0;
  prdOk = true;
  const r = await addPrd({ doc: ref('https://x.feishu.cn/wiki/DEF'), slug: 'manual-refund', title: '\u4e2d\u6587\u6807\u9898', branch: 'prod' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.session?.slug, 'manual-refund');
  assert.equal(r.session?.branch, 'main');

  prdOk = false;
  const before = (await sessions.listAll()).length;
  const fail = await addPrd({ doc: ref('https://x.feishu.cn/docx/NOACCESS') });
  assert.equal(fail.ok, false);
  assert.match(fail.msg, /could not read the requirement document/);
  assert.match(fail.msg, /no permission for this document/); // the original cause is passed through, unhedged
  assert.equal((await sessions.listAll()).length, before);
});

test('addPrd: with no originating chat it falls back to the current provider\'s first watched chat, rather than one vendor\'s hard-coded env var', async () => {
  prdOk = true;
  slugProposal = 'chat-fallback';
  const r = await addPrd({ doc: ref('https://x.feishu.cn/docx/CHATFALLBACK') });
  assert.equal(r.session?.chat_id, 'oc_default');
});

test('addPrd: an unregistered document source is refused outright (registering it would produce a requirement whose body can never be read -- one parked forever)', async () => {
  prdOk = true;
  const before = (await sessions.listAll()).length;
  const r = await addPrd({ doc: { source: 'notion', token: 'p1' } });
  assert.equal(r.ok, false);
  assert.match(r.msg, /unregistered document source/);
  assert.equal((await sessions.listAll()).length, before);
});

// -- Filing a requirement with no document service at all (the plaintext fallback source, Phase 2's DoD) --
// This uses the **real** plaintext source's read(): it takes the body from ref.raw, without the network and
// without any document service configured.
// (Whether the claim step is switched on at all is decided by runtime.yaml -- see docs-plaintext.test.ts.
// Filing it, the step covered here, is independent of that switch.)
test('addPrd: a passage of IM text is enough to file a requirement -- the body reaches prd.txt through raw, and prd_url is empty', async () => {
  slugProposal = 'refund-button-top';
  const body = '\u628a\u9000\u6b3e\u6309\u94ae\u632a\u5230\u8ba2\u5355\u8be6\u60c5\u9875\u9876\u90e8\uff0c\u5e76\u52a0\u4e00\u6b21\u4e8c\u6b21\u786e\u8ba4\u5f39\u7a97'; // non-English again, as escapes -- see the note on prdText above
  const r = await addPrd({ doc: { source: 'plaintext', token: 'hash-abc', raw: body } });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.session?.doc_ref, 'plaintext:hash-abc');
  assert.equal(r.session?.prd_url, null, 'a passage of text has no link to open');
  assert.equal(r.session?.title, body.slice(0, 80), 'the title comes from the first line of the body');
  assert.equal(readFileSync(r.session!.prd_text_path!, 'utf8'), body, 'the body has to reach disk -- every downstream gate reads prd_text_path and nothing else');
});

test('addPrd: pasting the same passage again is caught as a duplicate (the content is the identity)', async () => {
  const doc = { source: 'plaintext', token: 'hash-abc', raw: '\u628a\u9000\u6b3e\u6309\u94ae\u632a\u5230\u8ba2\u5355\u8be6\u60c5\u9875\u9876\u90e8\uff0c\u5e76\u52a0\u4e00\u6b21\u4e8c\u6b21\u786e\u8ba4\u5f39\u7a97' };
  const again = await addPrd({ doc });
  assert.equal(again.created, false);
  assert.equal(again.duplicate, true);
  assert.match(again.msg, /already been reviewed|will not start another review/);
});

test('addPrd: an existing plaintext ref with no raw says plainly that it cannot be read, and creates no session', async () => {
  const before = (await sessions.listAll()).length;
  const r = await addPrd({ doc: { source: 'plaintext', token: 'hash-stale' } });
  assert.equal(r.ok, false);
  assert.match(r.msg, /cannot be re-read/);
  assert.equal((await sessions.listAll()).length, before);
});

// -- The last gate against a concurrent race: the unique index on doc_ref --
test('sessions: a second insert with the same doc_ref is refused by the unique index, and isDuplicateDocRefError recognises it', async () => {
  await sessions.create({ id: 'race-a', slug: 'race-a', title: 'T', branch: 'dev', doc_ref: 'feishu:TOKDUP' });
  let err: unknown;
  try {
    await sessions.create({ id: 'race-b', slug: 'race-b', title: 'T', branch: 'dev', doc_ref: 'feishu:TOKDUP' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the second insert should throw');
  assert.equal(sessions.isDuplicateDocRefError(err), true);
  assert.equal((await sessions.listAll()).filter((s) => s.doc_ref === 'feishu:TOKDUP').length, 1);
});

test('addPrd: the race -- somebody gets in first while the document is being read, the insert hits the unique index, and it falls back to reusing that session rather than creating a second', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'race-win';
  const url = 'https://x.feishu.cn/docx/COLLIDE';

  // At the pre-check the database has nothing, so it proceeds into readDoc; while that read is in flight
  // another delivery of the same PRD inserts first, and create hits the unique index.
  raceInsert = async () => {
    await sessions.create({ id: 'race-winner', slug: 'race-winner', title: 'T', branch: 'dev', doc_ref: 'feishu:COLLIDE' });
  };
  const dup = await addPrd({ doc: ref(url) });

  assert.equal(dup.created, false); // no second session was created
  assert.equal(dup.duplicate, true);
  assert.equal(dup.session?.id, 'race-winner'); // it reuses the one that got in first
  assert.match(dup.msg, /already been reviewed|will not start another review/);
  assert.equal((await sessions.listAll()).filter((s) => s.doc_ref === 'feishu:COLLIDE').length, 1); // still exactly one
});
