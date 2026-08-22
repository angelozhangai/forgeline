// 传输层**选择点**（src/messaging/index.ts）。这条缝的头号失效模式不是"接错"，而是
// "配错了但看起来在跑"——把 slack 拼成 slak 之后所有审批卡照发飞书，没有任何症状，
// 直到有人发现 Slack 那边一片空白。所以：认不出的值一律硬抛。
// 与 ext/ 的「present but unloadable → hard error」是同一条规矩（见 AGENTS.md 接缝不变量）。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER, selectPort } from '../src/messaging/index.ts';
import type { MessagingPort } from '../src/messaging/port.ts';

const fake = (id: string): MessagingPort => ({ id }) as MessagingPort;
const PROVIDERS = { feishu: fake('feishu'), slack: fake('slack') };

test('缺省 = 飞书（既有部署零变化）；空串/纯空格也按缺省处理', () => {
  assert.equal(DEFAULT_PROVIDER, 'feishu');
  assert.equal(selectPort(undefined, PROVIDERS).id, 'feishu');
  assert.equal(selectPort('', PROVIDERS).id, 'feishu');
  assert.equal(selectPort('   ', PROVIDERS).id, 'feishu');
});

test('显式选 slack → slack；前后空白容忍（env 文件里手滑很常见）', () => {
  assert.equal(selectPort('slack', PROVIDERS).id, 'slack');
  assert.equal(selectPort(' slack ', PROVIDERS).id, 'slack');
});

test('认不出的 provider **硬抛**，绝不静默回退默认——错误信息要列出可选值', () => {
  assert.throws(() => selectPort('slak', PROVIDERS), (e: Error) => {
    assert.match(e.message, /slak/);
    assert.match(e.message, /feishu \/ slack/);
    assert.match(e.message, /静默回退/);
    return true;
  });
  assert.throws(() => selectPort('teams', PROVIDERS), /不是已知的 IM provider/);
});

test('真实接线：默认起来的 port 是飞书，且 id 与 provider 名一致', async () => {
  const { port } = await import('../src/messaging/index.ts');
  assert.equal(port.id, 'feishu');
});

test('真实注册表里 feishu / slack 都在（新增 provider 必须在这里接线，否则永远选不到）', () => {
  for (const id of ['feishu', 'slack']) {
    assert.equal(selectPort(id).id, id);
  }
});
