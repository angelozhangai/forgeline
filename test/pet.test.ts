// 单元：需求宠物·成长进化（彩蛋层）。守两条线：① 纯确定性（同需求每次一致，可断言）；
// ② 台词绝不泄漏黑话（与 display 同纪律）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { petStage, treeLine, finalForm, feedLine, easterEgg, PET_TREE } from '../src/util/pet.ts';
import { STATES } from '../src/statemachine/states.ts';

test('petStage：每个状态都有宠物(sprite/tier 1-5/台词)，台词不泄漏黑话', () => {
  for (const s of STATES) {
    const p = petStage(s as never);
    assert.ok(p.sprite && p.stage && p.voice, `状态 ${s} 缺宠物定义`);
    assert.ok(p.tier >= 1 && p.tier <= PET_TREE.length, `状态 ${s} tier 越界：${p.tier}`);
    assert.doesNotMatch(p.voice, /闸A|闸B|GATE_|ADVERSARIAL|AWAITING|CONFIRM/, `状态 ${s} 台词泄漏黑话：${p.voice}`);
  }
});

test('treeLine：高亮当前阶，含全 5 阶', () => {
  const line = treeLine('AWAITING_PM_CONFIRM'); // tier 2
  assert.match(line, /【🐣】/); // 第 2 阶高亮
  for (const e of PET_TREE) assert.ok(line.includes(e), `进化树缺 ${e}`);
});

test('finalForm：确定性（同 id 恒定）+ 落在已知形态集', () => {
  const a = finalForm({ id: 'abc', slug: 'x' });
  const b = finalForm({ id: 'abc', slug: 'x' });
  assert.equal(a, b, '同一需求最终形态必须稳定');
  const known = ['🦄', '🐉', '🦅', '🦚', '🦖', '🦢', '🦩', '✨🦄✨'];
  assert.ok(known.includes(a), `最终形态 ${a} 不在已知集`);
});

test('feedLine：群卡藏 $（仅口数），私聊带真实 $', () => {
  const group = feedLine(0.19, { showDollar: false });
  assert.doesNotMatch(group, /\$/, '群卡投喂不该露金额');
  assert.match(group, /投喂.*口/);
  const dm = feedLine(0.19, { showDollar: true });
  assert.match(dm, /\$0\.19/, '私聊投喂要带真实 $');
});

test('easterEgg：里程碑(第10只)确定触发；普通需求确定性(可空)', () => {
  assert.match(easterEgg({ id: 'x', ref_num: 10, created_at: 0 }) ?? '', /里程碑/);
  assert.match(easterEgg({ id: 'x', ref_num: 20, created_at: 0 }) ?? '', /里程碑/);
  // 同一输入多次调用结果一致（确定性）
  const once = easterEgg({ id: 'plain-7', ref_num: 7, created_at: 0 });
  const twice = easterEgg({ id: 'plain-7', ref_num: 7, created_at: 0 });
  assert.equal(once, twice);
});
