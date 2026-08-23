// 文档源**注册表**的解析规则（src/docs/index.ts）。这是「加一个源=加一行」这句话的兑现处，
// 也是几条不能错的规则：非兜底源取并集、兜底源只在无人认领时上场且最多一条、
// 未注册的源如实报错而非静默、落库键带源前缀（跨源 token 撞车 = PRD 去重红线被击穿）。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocRef, DocSource } from '../src/docs/port.ts';

// 用假源替掉真飞书源：本用例测的是**注册表的规则**，不是某个源的正则。
function src(id: string, opts: { fallback?: boolean; claims?: string[]; parses?: string[]; canComment?: boolean; readText?: string } = {}): DocSource {
  const s: DocSource = {
    id,
    fallback: opts.fallback,
    claim: (input) => (opts.claims ?? []).filter((t) => `${input.text} ${(input.searchTexts ?? []).join(' ')}`.includes(t)).map((token) => ({ source: id, token })),
    parseRef: (u) => ((opts.parses ?? []).some((p) => u.includes(p)) ? { source: id, token: u } : null),
    read: async () => ({ ok: true, text: opts.readText ?? `${id} 正文` }),
  };
  if (opts.canComment) s.comment = async (_ref, text) => (text === 'boom' ? { ok: false, error: '写不进去' } : { ok: true });
  return s;
}

const A = src('alpha', { claims: ['A1', 'A2'], parses: ['alpha.example'], canComment: true });
const B = src('beta', { claims: ['B1'], parses: ['beta.example'] });
const F = src('fallback-src', { fallback: true, claims: ['A1', 'B1', 'anything'], parses: [''] });
const docs = await import('../src/docs/index.ts');

test('真实注册表：飞书是主源，plaintext 是兜底源', () => {
  assert.deepEqual(docs.registeredIds(), ['feishu', 'plaintext']);
  assert.equal(docs.sources().find((s) => s.id === 'feishu')?.fallback, undefined, '飞书绝不能被标成兜底源——否则它会吞掉别人的链接');
  assert.equal(docs.sources().find((s) => s.id === 'plaintext')?.fallback, true);
});

test('formatRef / parseStoredRef：落库键带源前缀，且按第一个冒号切（token 里可以再有冒号）', () => {
  assert.equal(docs.formatRef({ source: 'feishu', token: 'ABC' }), 'feishu:ABC');
  assert.deepEqual(docs.parseStoredRef('feishu:ABC'), { source: 'feishu', token: 'ABC' });
  assert.deepEqual(docs.parseStoredRef('slack:C123:1712.45'), { source: 'slack', token: 'C123:1712.45' });
});

test('parseStoredRef：无前缀 / 空 source / 空 token → null（绝不猜一个源出来）', () => {
  assert.equal(docs.parseStoredRef('ABC'), null); // 迁移前的裸 token 形态
  assert.equal(docs.parseStoredRef(':ABC'), null);
  assert.equal(docs.parseStoredRef('feishu:'), null);
  assert.equal(docs.parseStoredRef(null), null);
  assert.equal(docs.parseStoredRef(''), null);
});

test('readDoc：未注册的源 → 如实报错并列出已注册源（不静默当读失败）', async () => {
  const r = await docs.readDoc({ source: 'notion', token: 'p1' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /未注册的文档源/);
  assert.match(r.error ?? '', /feishu/);
});

test('commentDoc：没有文档来源 / 未注册的源 → 不抛（best-effort，绝不阻断闸）', async () => {
  await docs.commentDoc(null, '批注'); // 手动 add / standalone issue：本就无处可写
  await docs.commentDoc('notion:p1', '批注'); // 源没注册：记日志，不抛
  await docs.commentDoc('feishu:', '批注'); // 解析不出：不抛
});

// ── 注册表规则本身（多源）──────────────────────────────────────────────
// resolveClaims / resolveRef 是**规则**，claimDocs / parseAnyRef 只是把它接到真实注册表上。
// 分开正是为了这里：喂任意源列表，直接测规则本身，而不是对着唯一一个已注册源自说自话。
const registry = [A, B, F];
const claimWith = (list: DocSource[], input: { text: string; searchTexts?: string[] }): DocRef[] => docs.resolveClaims(list, input);

test('规则：一条消息里贴了两个源的链接 → 两个都认领（并集，不是先到先得）', () => {
  const got = claimWith(registry, { text: '这里有 A1 也有 B1' });
  assert.deepEqual(got.map(docs.formatRef), ['alpha:A1', 'beta:B1']);
});

test('规则：有主源认领时兜底源绝不上场（否则同一段话会被登记两遍）', () => {
  const got = claimWith(registry, { text: 'A1 anything' });
  assert.deepEqual(got.map(docs.formatRef), ['alpha:A1']);
});

test('规则：无人认领才轮到兜底源，且最多一条（不把一段话拆成好几个需求）', () => {
  const got = claimWith(registry, { text: 'anything 但没有主源链接' });
  assert.deepEqual(got.map(docs.formatRef), ['fallback-src:anything']);
});

test('规则：兜底是**标志位**不是数组位置——把兜底源排到最前，它依然不抢主源', () => {
  const reordered = [F, A, B];
  assert.deepEqual(claimWith(reordered, { text: 'A1 anything' }).map(docs.formatRef), ['alpha:A1']);
});

test('规则：同一源在正文与兜底块里认领同一份文档 → 只留一条', () => {
  const dup = src('dup', { claims: ['X'] });
  const got = claimWith([dup], { text: 'X', searchTexts: ['X again X'] });
  assert.deepEqual(got.map(docs.formatRef), ['dup:X']);
});

test('规则：谁都不认领 → 空（调用方据此明说「无法识别」，绝不猜）', () => {
  assert.deepEqual(claimWith([A, B], { text: '今天天气不错' }), []);
});

test('resolveRef：主源先问，都不认才问兜底源', () => {
  assert.deepEqual(docs.resolveRef(registry, 'https://beta.example/p1'), { source: 'beta', token: 'https://beta.example/p1' });
  // 主源都不认 → 兜底源接住（它的 parseRef 认一切）
  assert.equal(docs.resolveRef(registry, '随便一段话')?.source, 'fallback-src');
  // 没有兜底源时：谁都不认 → null
  assert.equal(docs.resolveRef([A, B], '随便一段话'), null);
});

test('resolveRef：兜底源排在最前也抢不到主源认得的链接', () => {
  assert.equal(docs.resolveRef([F, A, B], 'https://alpha.example/p1')?.source, 'alpha');
});

test('接线：claimDocs / parseAnyRef 就是规则跑在真实注册表上（飞书链接进得来）', () => {
  const url = 'https://x.feishu.cn/docx/REALTOK';
  assert.deepEqual(docs.claimDocs({ text: `看下 ${url}` }).map(docs.formatRef), ['feishu:REALTOK']);
  assert.deepEqual(docs.parseAnyRef(url), { source: 'feishu', token: 'REALTOK', url });
  assert.equal(docs.parseAnyRef('https://www.notion.so/page-1'), null, '主源不认、兜底源不收链接 → 认不出就是认不出');
});

// ── 合并规则：核心源 + 扩展包注册的源（src/ext/port.ts 的 docSources）──────────
// 这几条是「下游能加源、但加不坏核心」的全部保证，所以每一条都单独钉住。

test('合并：扩展源接在核心源后面（核心在前，兜底顺位由此确定）', () => {
  const merged = docs.mergeSources([A, F], [B]);
  assert.deepEqual(merged.map((s) => s.id), ['alpha', 'fallback-src', 'beta']);
});

test('合并：id 与核心撞车 → 忽略扩展那份（核心永远优先，下游换不掉飞书源）', () => {
  const impostor = src('alpha', { claims: ['A1'], readText: '冒牌正文' });
  const merged = docs.mergeSources([A, F], [impostor, B]);
  assert.deepEqual(merged.map((s) => s.id), ['alpha', 'fallback-src', 'beta']);
  assert.equal(merged[0], A, '留下的必须是核心那个对象本身，不是同名的扩展源');
});

test('合并：扩展源之间也去重（同一个 id 出现两次只留先来的）', () => {
  const merged = docs.mergeSources([A], [src('beta', { claims: ['B1'] }), src('beta', { claims: ['B2'] })]);
  assert.deepEqual(merged.map((s) => s.id), ['alpha', 'beta']);
});

test('合并：核心兜底源排在扩展兜底源前面 → 两个都活着时核心那个先认领', () => {
  const extraFallback = src('ext-fallback', { fallback: true, claims: ['anything'] });
  const merged = docs.mergeSources([A, F], [extraFallback]);
  const claimed = docs.resolveClaims(merged, { text: 'anything 别的源都不认' });
  assert.deepEqual(claimed, [{ source: 'fallback-src', token: 'anything' }]);
  assert.equal(claimed.length, 1, '兜底源最多一条——两个兜底源不该把一段话登记两遍');
});

test('合并：空扩展列表 → 结果与核心逐项相同（没装扩展时行为逐字节不变）', () => {
  assert.deepEqual(docs.mergeSources([A, F], []), [A, F]);
});
