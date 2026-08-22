// 文档源——**纯文本兜底源**（src/docs/plaintext.ts）：正文就是那条 IM 消息本身。
// 三件必须钉死的事：① 默认关（开了就是自动花钱）；② 归一后内容寻址——同一段话怎么贴都算同一份需求；
// ③ 实质性下限挡寒暄，且**不静默**（看得见我们判它太短）。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let plaintextEnabled = false;
// 只替 loadConfig：本文件的模块图里只有 plaintext.ts 用它（docs/index.ts、docs/feishu.ts 都不用），
// 这样开关能按用例切换——真配置是全进程缓存的，切不动。
// 「仓内真实 runtime.yaml 里这个开关确实是关的」由 config.test.ts 对着真文件断言。
mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: () => ({ runtime: { doc_sources: { plaintext: { enabled: plaintextEnabled } } } }),
  },
});
const pt = await import('../src/docs/plaintext.ts');
const docs = await import('../src/docs/index.ts');

const REQ = '把退款按钮挪到订单详情页顶部，并加一次二次确认弹窗';

test('normalizePlaintext：剥飞书 @_user_N / Slack <@U…>、<!here>，折叠空白', () => {
  assert.equal(pt.normalizePlaintext('@_user_1  帮我评审\n\n  这个需求 '), '帮我评审 这个需求');
  assert.equal(pt.normalizePlaintext('<@U012ABC> 做个东西'), '做个东西');
  assert.equal(pt.normalizePlaintext('<!here> 大家看下 <@U9> 的需求'), '大家看下 的需求');
});

test('contentToken：@ 了谁 / 换行方式不同，都算同一份需求（否则去重当场失效）', () => {
  const a = pt.contentToken(pt.normalizePlaintext(`@_user_1 ${REQ}`));
  const b = pt.contentToken(pt.normalizePlaintext(`@_user_7 ${REQ}`)); // @ 了别人
  const c = pt.contentToken(pt.normalizePlaintext(`  ${REQ}\n\n `)); // 前后空行/缩进
  assert.equal(a, b);
  assert.equal(a, c);
});

test('contentToken：改了字就是另一份需求（没有文档身份可追，内容即身份）', () => {
  assert.notEqual(pt.contentToken(REQ), pt.contentToken(`${REQ}。另外加个埋点`));
});

test('hasSubstance：寒暄过不去，一句真需求过得去', () => {
  for (const ack of ['好的', '收到，谢谢', 'ok thanks', '👍']) {
    assert.equal(pt.hasSubstance(pt.normalizePlaintext(ack)), false, ack);
  }
  assert.equal(pt.hasSubstance(REQ), true);
  // 边界就是 MIN_SUBSTANCE_CHARS 个非空白字符
  assert.equal(pt.hasSubstance('x'.repeat(pt.MIN_SUBSTANCE_CHARS - 1)), false);
  assert.equal(pt.hasSubstance('x'.repeat(pt.MIN_SUBSTANCE_CHARS)), true);
  assert.equal(pt.hasSubstance(' x '.repeat(pt.MIN_SUBSTANCE_CHARS)), true, '空白不该算进字数');
});

test('默认关：没开就一条都不认领（既有部署行为零变化——没链接的消息照旧被忽略）', () => {
  plaintextEnabled = false;
  assert.deepEqual(pt.plaintextDocs.claim({ text: REQ }), []);
  assert.equal(pt.plaintextDocs.parseRef(REQ), null);
});

test('开了之后：一段够分量的话 → 一条 ref，正文经 raw 随行（不落库）', () => {
  plaintextEnabled = true;
  const refs = pt.plaintextDocs.claim({ text: `@_user_1 ${REQ}` });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].source, 'plaintext');
  assert.equal(refs[0].raw, REQ, '归一后的正文随 ref 走——它没有可回源的远端');
  assert.equal(refs[0].url, undefined, '一段话没有可点开的链接');
  assert.equal(refs[0].token, pt.contentToken(REQ));
});

test('开了之后：寒暄仍不认领', () => {
  plaintextEnabled = true;
  assert.deepEqual(pt.plaintextDocs.claim({ text: '@_user_1 收到，谢谢' }), []);
  assert.deepEqual(pt.plaintextDocs.claim({ text: '   ' }), []);
});

test('只看正文，绝不扫 searchTexts——那是序列化过的整条事件，当需求正文是灾难', () => {
  plaintextEnabled = true;
  const eventJson = JSON.stringify({ message_id: 'om_1', body: { content: `{"text":"${REQ}"}` } });
  assert.deepEqual(pt.plaintextDocs.claim({ text: '好的', searchTexts: [eventJson] }), []);
});

test('parseRef：链接一律不收——把认不出的 URL 当正文存下来，比直说认不出糟糕得多', () => {
  plaintextEnabled = true;
  assert.equal(pt.plaintextDocs.parseRef('https://www.notion.so/a-very-long-page-title-123456'), null);
  assert.equal(pt.plaintextDocs.parseRef('http://internal.wiki/some/really/long/path/page'), null);
  assert.equal(pt.plaintextDocs.parseRef(REQ)?.token, pt.contentToken(REQ)); // 一段话才收
});

test('read：raw 在就是正文；不在就如实说读不了（绝不返回空正文装作读到了）', async () => {
  assert.deepEqual(await pt.plaintextDocs.read({ source: 'plaintext', token: 't', raw: REQ }), { ok: true, text: REQ });
  const stale = await pt.plaintextDocs.read({ source: 'plaintext', token: 't' }); // 存量 ref，没有 raw
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? '', /不可回源/);
});

test('没有 comment 能力：一段 IM 文本无处回写批注（核心据此静默跳过）', () => {
  assert.equal(pt.plaintextDocs.comment, undefined);
});

// ── 接进注册表之后的名次 ─────────────────────────────────────────────
test('注册表：plaintext 是兜底源，飞书是主源', () => {
  assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']);
  assert.equal(docs.sources().find((s) => s.id === 'plaintext')?.fallback, true);
  assert.equal(docs.sources().find((s) => s.id === 'feishu')?.fallback, undefined);
});

test('注册表：消息里有飞书链接时，plaintext 绝不上场（否则同一条消息登记两遍）', () => {
  plaintextEnabled = true;
  const got = docs.claimDocs({ text: `${REQ} https://x.feishu.cn/docx/TOKA` });
  assert.deepEqual(got.map(docs.formatRef), ['feishu:TOKA']);
});

test('注册表：没有任何链接时才轮到 plaintext，且只取一条', () => {
  plaintextEnabled = true;
  const got = docs.claimDocs({ text: REQ });
  assert.equal(got.length, 1);
  assert.equal(got[0].source, 'plaintext');
});

test('注册表：关着的时候，没链接的消息谁都不认领（回到 Phase 1 的行为）', () => {
  plaintextEnabled = false;
  assert.deepEqual(docs.claimDocs({ text: REQ }), []);
  assert.equal(docs.parseAnyRef(REQ), null);
});
