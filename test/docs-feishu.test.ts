// 文档源——**飞书**（src/docs/feishu.ts）。两块内容：
//  1) 命令构造 + 输出解析（feishu-doc.js 调用、剥代理 env）——迁自 workspace.test.ts，行为逐字不变；
//  2) DocSource 契约本身：claim / parseRef / read 的分派与归一（PRD 级去重全靠 token 归一）。
// 靠 mock proc.run 捕获 (bin,args,opts) 直接断言，不真 shell-out、不真联网。
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

// ── 链接识别（迁自 util/links.ts + daemon.test.ts）────────────────────────
test('extractFeishuLinks：捞出 wiki/docx 链接', () => {
  const t = '帮我评审下 https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd 谢谢';
  assert.deepEqual(fs.extractFeishuLinks(t), ['https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd']);
});

test('extractFeishuLinks：多链接 + 去重', () => {
  const t = 'a https://x.feishu.cn/docx/AAA b https://x.feishu.cn/docx/AAA c https://x.feishu.cn/wiki/BBB';
  const r = fs.extractFeishuLinks(t);
  assert.equal(r.length, 2);
  assert.ok(r.includes('https://x.feishu.cn/docx/AAA'));
  assert.ok(r.includes('https://x.feishu.cn/wiki/BBB'));
});

test('extractFeishuLinks：无链接 → 空', () => {
  assert.deepEqual(fs.extractFeishuLinks('今天天气不错'), []);
  assert.deepEqual(fs.extractFeishuLinks('https://github.com/x/y'), []); // 非飞书不抓
});

// ── token / kind 解析（迁自 feishu/doc.ts + doc.test.ts）──────────────────
test('parseFeishuDoc：/wiki/ → kind=wiki', () => {
  const r = fs.parseFeishuDoc('https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd');
  assert.equal(r.kind, 'wiki');
  assert.equal(r.token, 'KRKfwhzDbiwncHk1QDvc2yFSnMd');
});

test('parseFeishuDoc：/docx/ → kind=docx（关键：不能误判 wiki）', () => {
  const r = fs.parseFeishuDoc('https://x.feishu.cn/docx/Tm9TdabcOEFxyz1234567890');
  assert.equal(r.kind, 'docx');
  assert.equal(r.token, 'Tm9TdabcOEFxyz1234567890');
});

test('parseFeishuDoc：/docs/ 旧链 → 归 docx 读法', () => {
  assert.equal(fs.parseFeishuDoc('https://x.feishu.cn/docs/abcDEF123').kind, 'docx');
});

test('parseFeishuDoc：带 query/锚点也能取对 token（PRD 去重的归一靠这条）', () => {
  const r = fs.parseFeishuDoc('https://x.feishu.cn/wiki/ABC123?from=share#heading');
  assert.equal(r.token, 'ABC123');
  assert.equal(r.kind, 'wiki');
});

test('parseFeishuDoc：裸 token → unknown，原样返回', () => {
  const r = fs.parseFeishuDoc('KRKfwhzDbiwncHk1QDvc2yFSnMd');
  assert.equal(r.kind, 'unknown');
  assert.equal(r.token, 'KRKfwhzDbiwncHk1QDvc2yFSnMd');
});

// ── DocSource 契约 ───────────────────────────────────────────────────────
test('claim：正文里的链接 → 带 source/token/url 的 ref', () => {
  const refs = fs.feishuDocs.claim({ text: '看下 https://x.feishu.cn/docx/AAA' });
  assert.deepEqual(refs, [{ source: 'feishu', token: 'AAA', url: 'https://x.feishu.cn/docx/AAA' }]);
});

test('claim：正文没有就扫兜底文本块，命中即停（分享卡/富文本的链接不在正文里）', () => {
  const refs = fs.feishuDocs.claim({ text: '[分享文档]', searchTexts: ['无', '{"url":"https://x.feishu.cn/wiki/BBB"}', 'https://x.feishu.cn/docx/CCC'] });
  assert.deepEqual(refs.map((r) => r.token), ['BBB']); // 第二块命中后不再看第三块
});

test('claim：谁都不贴链接 → 不认领（空数组，不是猜一个）', () => {
  assert.deepEqual(fs.feishuDocs.claim({ text: '今天天气不错' }), []);
});

test('parseRef：飞书链接认；非飞书链接不认（留给别的源/兜底源）', () => {
  assert.deepEqual(fs.feishuDocs.parseRef('https://x.feishu.cn/docx/AAA'), { source: 'feishu', token: 'AAA', url: 'https://x.feishu.cn/docx/AAA' });
  assert.equal(fs.feishuDocs.parseRef('https://www.notion.so/some-page-123'), null);
  assert.equal(fs.feishuDocs.parseRef('https://github.com/x/y'), null);
  assert.equal(fs.feishuDocs.parseRef(''), null);
});

test('parseRef：裸 token 也收（CLI 允许直接贴 token，沿用旧行为），无 url', () => {
  assert.deepEqual(fs.feishuDocs.parseRef('KRKfwhzDbiwnc'), { source: 'feishu', token: 'KRKfwhzDbiwnc', url: undefined });
});

test('read：/docx/ 直链走 docx raw_content，不走 feishu-doc.js read（旧坑：doc_id 会被当 wiki 节点解析失败）', async () => {
  reset(() => ({ code: 0, stdout: 'utok', stderr: '', timedOut: false })); // feishu-doc.js token
  const origFetch = globalThis.fetch;
  let hitUrl = '';
  globalThis.fetch = (async (u: string | URL) => {
    hitUrl = String(u);
    return { json: async () => ({ code: 0, data: { content: 'docx 正文' } }) } as never;
  }) as typeof fetch;
  try {
    const r = await fs.feishuDocs.read({ source: 'feishu', token: 'DOCID', url: 'https://x.feishu.cn/docx/DOCID' });
    assert.deepEqual(r, { ok: true, text: 'docx 正文' });
    assert.match(hitUrl, /docx\/v1\/documents\/DOCID\/raw_content/);
    assert.deepEqual(last().args.slice(1), ['token']); // 只取了 user token，没走 read 子命令
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('read：wiki / 裸 token 走 feishu-doc.js read', async () => {
  reset(() => ({ code: 0, stdout: 'wiki 正文', stderr: '', timedOut: false }));
  const r = await fs.feishuDocs.read({ source: 'feishu', token: 'WIKITOK', url: 'https://x.feishu.cn/wiki/WIKITOK' });
  assert.deepEqual(r, { ok: true, text: 'wiki 正文', error: undefined });
  assert.deepEqual(last().args.slice(1), ['read', 'WIKITOK']);
});

test('read：读不到就如实报错，绝不返回空正文装作读到了（上游据此停泊）', async () => {
  reset(() => ({ code: 2, stdout: '', stderr: '文档无权限', timedOut: false }));
  const r = await fs.feishuDocs.read({ source: 'feishu', token: 'NOPE' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /文档无权限/);
});

// ── feishu：剥代理 env ────────────────────────────────────────────────────────
test('feishuRead：node feishu-doc.js read <token>，并剥离 http(s) 代理 env（飞书走国内代理会断）', async () => {
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
    assert.equal(env[k], undefined, `${k} 应被剥离`);
  }
  // 还原本进程 env（只删本测试加的，避免污染其它用例）
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (!(k in saved)) delete process.env[k];
  }
});

test('feishuRead：feishu-doc.js 非零退出 → ok:false + error（不静默放过）', async () => {
  reset(() => ({ code: 2, stdout: '', stderr: 'token expired', timedOut: false }));
  const r = await fs.feishuRead('tok');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /token expired/);
});

test('feishuCommentAdd：node feishu-doc.js comment-add <token> <text>；非零 → ok:false', async () => {
  reset(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
  let r = await fs.feishuCommentAdd('tok', '评论内容');
  assert.equal(r.ok, true);
  assert.equal(last().bin, 'node');
  assert.match(last().args[0], /feishu-doc\.js$/);
  assert.deepEqual(last().args.slice(1), ['comment-add', 'tok', '评论内容']);

  reset(() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }));
  r = await fs.feishuCommentAdd('tok', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /boom/);
});

test('feishuUserToken：取 token（trim）；非零 → null；空输出 → null', async () => {
  reset(() => ({ code: 0, stdout: '  utok-123\n', stderr: '', timedOut: false }));
  assert.equal(await fs.feishuUserToken(), 'utok-123');
  assert.deepEqual(last().args.slice(1), ['token']);

  reset(() => ({ code: 1, stdout: 'utok', stderr: '', timedOut: false }));
  assert.equal(await fs.feishuUserToken(), null, 'gh/node 非零 → null');

  reset(() => ({ code: 0, stdout: '   \n', stderr: '', timedOut: false }));
  assert.equal(await fs.feishuUserToken(), null, '空白输出 → null');
});
