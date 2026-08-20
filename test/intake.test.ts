// 集成：生产入口（飞书 PRD → session）。重点守住去重、群消息元数据、slug/branch 落库；
// 不镜像 addPrd 内部步骤，只从“重复消息不能建两条需求”这个上线目标断言结果。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let readCalls = 0;
const prdText = '# 退款决策\n\nPM 希望补齐退款流。';
let prdOk = true;
let slugProposal: string | null = 'refund-decision';
// 模拟「预检 token 与 readPrd 解析出的底层 token 不一致」的竞态：返回非 null 则用它当 readPrd 的 token。
let readTokenOverride: ((url: string) => string | null) | null = null;

// 归一到 doc token（取 path 末段、剥查询参数）——镜像真实 parseDocRef 的关键行为，
// 使「同一 doc 的 URL 变体」归到同一 token（PRD 级去重的真源）。
const canon = (url: string): string => {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean);
    return p[p.length - 1] ?? url;
  } catch {
    return url;
  }
};

mock.module('../src/feishu/doc.ts', {
  namedExports: {
    readPrd: async (url: string) => {
      readCalls++;
      const tok = readTokenOverride?.(url) ?? canon(url);
      return prdOk
        ? { ok: true, text: prdText, token: tok } // 落库 feishu_doc_token = 解析 token
        : { ok: false, text: '', token: '', error: '文档无权限' };
    },
    extractDocToken: (url: string) => canon(url), // addPrd 读文档前用它去重
  },
});

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaudeBare: async () => slugProposal,
  },
});

const sessions = await import('../src/store/sessions.ts');
const { addPrd } = await import('../src/intake.ts');

test('addPrd：同一飞书 PRD 重复投递只复用已有 session，不重复读文档/建需求', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'refund-decision';
  const first = await addPrd({
    prdUrl: 'https://x.feishu.cn/docx/ABC',
    chatId: 'oc_group',
    posterOpenId: 'ou_pm',
    intakeMsgId: 'om_msg',
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(readCalls, 1);
  assert.equal(first.session?.slug, 'refund-decision');
  assert.equal(first.session?.branch, 'main'); // 缺省锚 main（runtime.yaml default_branch: prod）
  assert.equal(first.session?.feishu_chat_id, 'oc_group');
  assert.equal(first.session?.poster_open_id, 'ou_pm');
  assert.equal(first.session?.intake_msg_id, 'om_msg');

  const second = await addPrd({ prdUrl: 'https://x.feishu.cn/docx/ABC', chatId: 'oc_group_2' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.session?.id, first.session?.id);
  assert.equal(readCalls, 1);
  assert.match(second.msg, /已经评审过|不会被再次评审/); // 明确回复 PM「本次不再评审」
  assert.equal((await sessions.listAll()).filter((s) => s.prd_url === 'https://x.feishu.cn/docx/ABC').length, 1);
});

test('addPrd：同一 PRD 的 URL 变体（查询参数/末尾斜杠）按 doc token 去重，不建第二条', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'points-expiry';
  const a = await addPrd({ prdUrl: 'https://x.feishu.cn/docx/XYZ' });
  assert.equal(a.created, true);
  assert.equal(readCalls, 1);

  // 同一 doc 的不同链接形态（分享带 ?from=、末尾 /）→ 归一到同一 token → 命中去重，读文档前就挡（readCalls 不增）。
  for (const variant of ['https://x.feishu.cn/docx/XYZ?from=share_copy_link', 'https://x.feishu.cn/docx/XYZ/']) {
    const dup = await addPrd({ prdUrl: variant });
    assert.equal(dup.created, false, variant);
    assert.equal(dup.duplicate, true, variant);
    assert.equal(dup.session?.id, a.session?.id, variant);
  }
  assert.equal(readCalls, 1); // 变体都没触发二次读文档
  assert.equal((await sessions.listAll()).filter((s) => s.feishu_doc_token === 'XYZ').length, 1); // 只一条
});

test('addPrd：显式 slug/branch 优先，文档读取失败不创建 session', async () => {
  readCalls = 0;
  prdOk = true;
  const r = await addPrd({ prdUrl: 'https://x.feishu.cn/wiki/DEF', slug: 'manual-refund', title: '中文标题', branch: 'prod' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.session?.slug, 'manual-refund');
  assert.equal(r.session?.branch, 'main');

  prdOk = false;
  const before = (await sessions.listAll()).length;
  const fail = await addPrd({ prdUrl: 'https://x.feishu.cn/docx/NOACCESS' });
  assert.equal(fail.ok, false);
  assert.match(fail.msg, /读 PRD 失败/);
  assert.equal((await sessions.listAll()).length, before);
  readTokenOverride = null;
});

// ── 并发竞态最后一道闸：doc token 唯一索引 ──
test('sessions：同一 doc token 第二次插入被唯一索引拒绝（isDuplicateTokenError 命中）', async () => {
  await sessions.create({ id: 'race-a', slug: 'race-a', title: 'T', branch: 'dev', feishu_doc_token: 'TOKDUP' });
  let err: unknown;
  try {
    await sessions.create({ id: 'race-b', slug: 'race-b', title: 'T', branch: 'dev', feishu_doc_token: 'TOKDUP' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '第二次插入应抛');
  assert.equal(sessions.isDuplicateTokenError(err), true);
  assert.equal((await sessions.listAll()).filter((s) => s.feishu_doc_token === 'TOKDUP').length, 1);
});

test('addPrd：竞态——预检 token 未命中但建库撞唯一索引 → 回退复用，不建第二条', async () => {
  readCalls = 0; prdOk = true; readTokenOverride = null;
  slugProposal = 'race-win';
  const a = await addPrd({ prdUrl: 'https://x.feishu.cn/docx/COLLIDE' });
  assert.equal(a.created, true);
  assert.equal(a.session?.feishu_doc_token, 'COLLIDE');

  // 另一个链接：预检 token=WIKIDUP（漏，库里没有）→ 进 readPrd；但解析出底层 token=COLLIDE → create 撞唯一索引。
  readTokenOverride = (url) => (url.includes('WIKIDUP') ? 'COLLIDE' : null);
  const dup = await addPrd({ prdUrl: 'https://x.feishu.cn/wiki/WIKIDUP' });
  readTokenOverride = null;

  assert.equal(dup.created, false); // 没建第二条
  assert.equal(dup.duplicate, true);
  assert.equal(dup.session?.id, a.session?.id); // 复用抢先建好的那条
  assert.match(dup.msg, /已经评审过|不会被再次评审/);
  assert.equal((await sessions.listAll()).filter((s) => s.feishu_doc_token === 'COLLIDE').length, 1); // 仍只一条
});
