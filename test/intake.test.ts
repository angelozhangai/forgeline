// 集成：生产入口（需求文档 → session）。重点守住去重、群消息元数据、slug/branch 落库；
// 不镜像 addPrd 内部步骤，只从"重复消息不能建两条需求"这个上线目标断言结果。
//
// 只 stub 掉**读正文**那一步（它要联网/起子进程）；链接归一、源前缀、注册表解析全都跑真的——
// PRD 级去重是红线，用假的归一去测等于没测。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { DocRef } from '../src/docs/port.ts';

let readCalls = 0;
const prdText = '# 退款决策\n\nPM 希望补齐退款流。';
let prdOk = true;
let slugProposal: string | null = 'refund-decision';
// 读文档期间的抢跑者：非 null 时，read() 里先插一条同 doc_ref 的 session（模拟并发竞态）。
let raceInsert: (() => Promise<void>) | null = null;

// 保留真实的 claim/parseRef（token 归一 = 去重真源），只把 read 换成不联网的桩。
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
        return prdOk ? { ok: true, text: prdText } : { ok: false, text: '', error: '文档无权限' };
      },
    },
  },
});

mock.module('../src/llm/runClaude.ts', {
  namedExports: {
    runClaudeBare: async () => slugProposal,
  },
});

const sessions = await import('../src/store/sessions.ts');
const { addPrd } = await import('../src/intake.ts');
const { parseAnyRef } = await import('../src/docs/index.ts');

// 测试里都从链接出发：跟生产一样先过注册表解析，绝不手搓 DocRef。
const ref = (url: string): DocRef => parseAnyRef(url)!;

test('addPrd：同一飞书 PRD 重复投递只复用已有 session，不重复读文档/建需求', async () => {
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
  assert.equal(first.session?.branch, 'main'); // 缺省锚 main（runtime.yaml default_branch: prod）
  assert.equal(first.session?.chat_id, 'oc_group');
  assert.equal(first.session?.poster_id, 'ou_pm');
  assert.equal(first.session?.intake_msg_id, 'om_msg');

  const second = await addPrd({ doc: ref('https://x.feishu.cn/docx/ABC'), chatId: 'oc_group_2' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.session?.id, first.session?.id);
  assert.equal(readCalls, 1);
  assert.match(second.msg, /已经评审过|不会被再次评审/); // 明确回复 PM「本次不再评审」
  assert.equal((await sessions.listAll()).filter((s) => s.prd_url === 'https://x.feishu.cn/docx/ABC').length, 1);
});

test('addPrd：同一 PRD 的 URL 变体（查询参数/末尾斜杠）按 doc_ref 去重，不建第二条', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'points-expiry';
  const a = await addPrd({ doc: ref('https://x.feishu.cn/docx/XYZ') });
  assert.equal(a.created, true);
  assert.equal(readCalls, 1);

  // 同一 doc 的不同链接形态（分享带 ?from=、末尾 /）→ 归一到同一 doc_ref → 命中去重，读文档前就挡（readCalls 不增）。
  for (const variant of ['https://x.feishu.cn/docx/XYZ?from=share_copy_link', 'https://x.feishu.cn/docx/XYZ/']) {
    const dup = await addPrd({ doc: ref(variant) });
    assert.equal(dup.created, false, variant);
    assert.equal(dup.duplicate, true, variant);
    assert.equal(dup.session?.id, a.session?.id, variant);
  }
  assert.equal(readCalls, 1); // 变体都没触发二次读文档
  assert.equal((await sessions.listAll()).filter((s) => s.doc_ref === 'feishu:XYZ').length, 1); // 只一条，且带源前缀
});

test('addPrd：显式 slug/branch 优先，文档读取失败不创建 session', async () => {
  readCalls = 0;
  prdOk = true;
  const r = await addPrd({ doc: ref('https://x.feishu.cn/wiki/DEF'), slug: 'manual-refund', title: '中文标题', branch: 'prod' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.session?.slug, 'manual-refund');
  assert.equal(r.session?.branch, 'main');

  prdOk = false;
  const before = (await sessions.listAll()).length;
  const fail = await addPrd({ doc: ref('https://x.feishu.cn/docx/NOACCESS') });
  assert.equal(fail.ok, false);
  assert.match(fail.msg, /读需求文档失败/);
  assert.match(fail.msg, /文档无权限/); // 原始错因透传，不含糊
  assert.equal((await sessions.listAll()).length, before);
});

test('addPrd：未注册的文档源直接拒收（登记进去也读不出正文，只会变成一条永远停泊的需求）', async () => {
  prdOk = true;
  const before = (await sessions.listAll()).length;
  const r = await addPrd({ doc: { source: 'notion', token: 'p1' } });
  assert.equal(r.ok, false);
  assert.match(r.msg, /未注册的文档源/);
  assert.equal((await sessions.listAll()).length, before);
});

// ── 并发竞态最后一道闸：doc_ref 唯一索引 ──
test('sessions：同一 doc_ref 第二次插入被唯一索引拒绝（isDuplicateDocRefError 命中）', async () => {
  await sessions.create({ id: 'race-a', slug: 'race-a', title: 'T', branch: 'dev', doc_ref: 'feishu:TOKDUP' });
  let err: unknown;
  try {
    await sessions.create({ id: 'race-b', slug: 'race-b', title: 'T', branch: 'dev', doc_ref: 'feishu:TOKDUP' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '第二次插入应抛');
  assert.equal(sessions.isDuplicateDocRefError(err), true);
  assert.equal((await sessions.listAll()).filter((s) => s.doc_ref === 'feishu:TOKDUP').length, 1);
});

test('addPrd：竞态——读文档期间被抢跑，建库撞唯一索引 → 回退复用，不建第二条', async () => {
  readCalls = 0;
  prdOk = true;
  slugProposal = 'race-win';
  const url = 'https://x.feishu.cn/docx/COLLIDE';

  // 预检时库里还没有 → 放行进 readDoc；读的过程中另一条同 PRD 抢先插入 → create 撞唯一索引。
  raceInsert = async () => {
    await sessions.create({ id: 'race-winner', slug: 'race-winner', title: 'T', branch: 'dev', doc_ref: 'feishu:COLLIDE' });
  };
  const dup = await addPrd({ doc: ref(url) });

  assert.equal(dup.created, false); // 没建第二条
  assert.equal(dup.duplicate, true);
  assert.equal(dup.session?.id, 'race-winner'); // 复用抢先建好的那条
  assert.match(dup.msg, /已经评审过|不会被再次评审/);
  assert.equal((await sessions.listAll()).filter((s) => s.doc_ref === 'feishu:COLLIDE').length, 1); // 仍只一条
});
