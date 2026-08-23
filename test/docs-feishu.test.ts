// The **Feishu** document source (src/docs/feishu.ts), in two parts:
//  1) building the command and parsing the output (calling feishu-doc.js, stripping the proxy env) -- moved
//     here from workspace.test.ts with the behaviour unchanged word for word;
//  2) the DocSource contract itself: how claim / parseRef / read dispatch and normalise (deduplicating at
//     the PRD level rests entirely on normalising the token).
// proc.run is mocked to capture (bin, args, opts) and asserted on directly -- nothing shells out and nothing
// goes over the network.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

interface Call {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}
type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
const calls: Call[] = [];
let responder: (bin: string, args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });

mock.module('../src/util/proc.ts', {
  namedExports: {
    run: async (bin: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ bin, args, opts });
      return responder(bin, args);
    },
  },
});
const fs = await import('../src/docs/feishu.ts');

function reset(r?: (bin: string, args: string[]) => RunResult): void {
  calls.length = 0;
  responder = r ?? (() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
}
const last = (): Call => calls[calls.length - 1];

// -- Recognising links (moved here from util/links.ts and daemon.test.ts) ------------------
test('extractFeishuLinks: picks wiki and docx links out of a message', () => {
  const t = 'please review this https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd thanks';
  assert.deepEqual(fs.extractFeishuLinks(t), ['https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd']);
});

test('extractFeishuLinks: several links, deduplicated', () => {
  const t = 'a https://x.feishu.cn/docx/AAA b https://x.feishu.cn/docx/AAA c https://x.feishu.cn/wiki/BBB';
  const r = fs.extractFeishuLinks(t);
  assert.equal(r.length, 2);
  assert.ok(r.includes('https://x.feishu.cn/docx/AAA'));
  assert.ok(r.includes('https://x.feishu.cn/wiki/BBB'));
});

test('extractFeishuLinks: no link -> empty', () => {
  assert.deepEqual(fs.extractFeishuLinks('nice weather today'), []);
  assert.deepEqual(fs.extractFeishuLinks('https://github.com/x/y'), []); // anything that is not Feishu is left alone
});

// -- Parsing the token and the kind (moved here from feishu/doc.ts and doc.test.ts) --------
test('parseFeishuDoc: /wiki/ -> kind=wiki', () => {
  const r = fs.parseFeishuDoc('https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd');
  assert.equal(r.kind, 'wiki');
  assert.equal(r.token, 'KRKfwhzDbiwncHk1QDvc2yFSnMd');
});

test('parseFeishuDoc: /docx/ -> kind=docx (crucially, it must not be mistaken for a wiki)', () => {
  const r = fs.parseFeishuDoc('https://x.feishu.cn/docx/Tm9TdabcOEFxyz1234567890');
  assert.equal(r.kind, 'docx');
  assert.equal(r.token, 'Tm9TdabcOEFxyz1234567890');
});

test('parseFeishuDoc: an old /docs/ link reads the docx way', () => {
  assert.equal(fs.parseFeishuDoc('https://x.feishu.cn/docs/abcDEF123').kind, 'docx');
});

test('parseFeishuDoc: the token still comes out right with a query string or a fragment (this is what PRD deduplication normalises on)', () => {
  const r = fs.parseFeishuDoc('https://x.feishu.cn/wiki/ABC123?from=share#heading');
  assert.equal(r.token, 'ABC123');
  assert.equal(r.kind, 'wiki');
});

test('parseFeishuDoc: a bare token -> unknown, returned as it came in', () => {
  const r = fs.parseFeishuDoc('KRKfwhzDbiwncHk1QDvc2yFSnMd');
  assert.equal(r.kind, 'unknown');
  assert.equal(r.token, 'KRKfwhzDbiwncHk1QDvc2yFSnMd');
});

// -- The DocSource contract -----------------------------------------------
test('claim: a link in the body -> a ref carrying source, token and url', () => {
  const refs = fs.feishuDocs.claim({ text: 'have a look at https://x.feishu.cn/docx/AAA' });
  assert.deepEqual(refs, [{ source: 'feishu', token: 'AAA', url: 'https://x.feishu.cn/docx/AAA' }]);
});

test('claim: with nothing in the body it scans the fallback text blocks and stops at the first hit (a share card or rich text keeps its link outside the body)', () => {
  const refs = fs.feishuDocs.claim({ text: '[a shared document]', searchTexts: ['nothing', '{"url":"https://x.feishu.cn/wiki/BBB"}', 'https://x.feishu.cn/docx/CCC'] });
  assert.deepEqual(refs.map((r) => r.token), ['BBB']); // once the second block hits, the third is never read
});

test('claim: nobody posted a link -> it claims nothing (an empty array, not a guess)', () => {
  assert.deepEqual(fs.feishuDocs.claim({ text: 'nice weather today' }), []);
});

test('parseRef: it claims a Feishu link and refuses anything else, leaving that to the other sources', () => {
  assert.deepEqual(fs.feishuDocs.parseRef('https://x.feishu.cn/docx/AAA'), { source: 'feishu', token: 'AAA', url: 'https://x.feishu.cn/docx/AAA' });
  assert.equal(fs.feishuDocs.parseRef('https://www.notion.so/some-page-123'), null);
  assert.equal(fs.feishuDocs.parseRef('https://github.com/x/y'), null);
  assert.equal(fs.feishuDocs.parseRef(''), null);
});

test('parseRef: a bare token is accepted too (the CLI lets you paste one, as it always has), with no url', () => {
  assert.deepEqual(fs.feishuDocs.parseRef('KRKfwhzDbiwnc'), { source: 'feishu', token: 'KRKfwhzDbiwnc' });
});

// "Anything without a / is a bare token" used to swallow a whole requirement sentence as a Feishu document:
// it registered a requirement whose body could never be read, and it intercepted a message that should have
// gone to the fallback source (plaintext). A bare token has to look like a token.
//
// The first case is written as escapes on purpose. A CJK sentence carries no spaces, so it is exactly the
// input that slips past a naive "no spaces, long enough" check -- the repo's source is English, the input it
// handles is not, and this is the case that has to stay non-English to mean anything.
test('parseRef: a sentence is not a bare token -- refused, and left to the fallback source', () => {
  assert.equal(fs.feishuDocs.parseRef('\u628a\u9000\u6b3e\u6309\u94ae\u632a\u5230\u8ba2\u5355\u8be6\u60c5\u9875\u9876\u90e8'), null);
  assert.equal(fs.feishuDocs.parseRef('help me review this'), null, 'anything with a space is never a token');
  assert.equal(fs.feishuDocs.parseRef('ABC123'), null, 'too short to be a real token');
  assert.equal(fs.feishuDocs.parseRef('tok_with_underscore_x'), null, 'not alphanumeric');
});

test('read: a direct /docx/ link goes to docx raw_content rather than feishu-doc.js read (the old trap: the doc_id was parsed as a wiki node and failed)', async () => {
  reset(() => ({ code: 0, stdout: 'utok', stderr: '', timedOut: false })); // the feishu-doc.js token
  const origFetch = globalThis.fetch;
  let hitUrl = '';
  globalThis.fetch = (async (u: string | URL) => {
    hitUrl = String(u);
    return { json: async () => ({ code: 0, data: { content: 'the docx body' } }) } as never;
  }) as typeof fetch;
  try {
    const r = await fs.feishuDocs.read({ source: 'feishu', token: 'DOCID', url: 'https://x.feishu.cn/docx/DOCID' });
    assert.deepEqual(r, { ok: true, text: 'the docx body' });
    assert.match(hitUrl, /docx\/v1\/documents\/DOCID\/raw_content/);
    assert.deepEqual(last().args.slice(1), ['token']); // it only fetched the user token, and never ran the read subcommand
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('read: a wiki link or a bare token goes through feishu-doc.js read', async () => {
  reset(() => ({ code: 0, stdout: 'the wiki body', stderr: '', timedOut: false }));
  const r = await fs.feishuDocs.read({ source: 'feishu', token: 'WIKITOK', url: 'https://x.feishu.cn/wiki/WIKITOK' });
  assert.deepEqual(r, { ok: true, text: 'the wiki body', error: undefined });
  assert.deepEqual(last().args.slice(1), ['read', 'WIKITOK']);
});

test('read: a failed read says so plainly and never returns an empty body pretending it worked (upstream parks on this)', async () => {
  reset(() => ({ code: 2, stdout: '', stderr: 'no permission for this document', timedOut: false }));
  const r = await fs.feishuDocs.read({ source: 'feishu', token: 'NOPE' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /no permission for this document/);
});

// -- Feishu: stripping the proxy env --------------------------------------------------
test('feishuRead: runs node feishu-doc.js read <token> and strips the http(s) proxy env (Feishu breaks when it goes through one)', async () => {
  const saved = { ...process.env };
  process.env.HTTPS_PROXY = 'http://p:1';
  process.env.https_proxy = 'http://p:1';
  process.env.HTTP_PROXY = 'http://p:1';
  process.env.http_proxy = 'http://p:1';
  reset(() => ({ code: 0, stdout: 'doc text', stderr: '', timedOut: false }));
  const r = await fs.feishuRead('tok');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'doc text');
  assert.equal(last().bin, 'node');
  assert.match(last().args[0], /feishu-doc\.js$/);
  assert.deepEqual(last().args.slice(1), ['read', 'tok']);
  const env = last().opts.env as NodeJS.ProcessEnv;
  for (const k of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) {
    assert.equal(env[k], undefined, `${k} should have been stripped`);
  }
  // Restore the process env, removing only what this test added so the other tests are unaffected.
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (!(k in saved)) delete process.env[k];
  }
});

test('feishuRead: feishu-doc.js exits non-zero -> ok:false with the error (never silently let through)', async () => {
  reset(() => ({ code: 2, stdout: '', stderr: 'token expired', timedOut: false }));
  const r = await fs.feishuRead('tok');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /token expired/);
});

test('feishuCommentAdd: runs node feishu-doc.js comment-add <token> <text>; a non-zero exit gives ok:false', async () => {
  reset(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
  let r = await fs.feishuCommentAdd('tok', 'the comment text');
  assert.equal(r.ok, true);
  assert.equal(last().bin, 'node');
  assert.match(last().args[0], /feishu-doc\.js$/);
  assert.deepEqual(last().args.slice(1), ['comment-add', 'tok', 'the comment text']);

  reset(() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }));
  r = await fs.feishuCommentAdd('tok', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /boom/);
});

test('feishuUserToken: reads the token (trimmed); a non-zero exit gives null, and so does empty output', async () => {
  reset(() => ({ code: 0, stdout: '  utok-123\n', stderr: '', timedOut: false }));
  assert.equal(await fs.feishuUserToken(), 'utok-123');
  assert.deepEqual(last().args.slice(1), ['token']);

  reset(() => ({ code: 1, stdout: 'utok', stderr: '', timedOut: false }));
  assert.equal(await fs.feishuUserToken(), null, 'a non-zero exit -> null');

  reset(() => ({ code: 0, stdout: '   \n', stderr: '', timedOut: false }));
  assert.equal(await fs.feishuUserToken(), null, 'whitespace-only output -> null');
});
