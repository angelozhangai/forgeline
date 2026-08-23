// The transport layer's **selection point** (src/messaging/index.ts). This seam's number one failure
// mode is not "wired up wrongly" but "misconfigured yet apparently running" — typo slack as slak and
// every approval card keeps going to Feishu with no symptom at all, until someone notices Slack has been
// blank the whole time. Hence: an unrecognised value always throws.
// This is the same rule as ext/'s "present but unloadable -> hard error" (see the seam invariants in
// AGENTS.md).
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER, selectPort } from '../src/messaging/index.ts';
import type { MessagingPort } from '../src/messaging/port.ts';

const fake = (id: string): MessagingPort => ({ id }) as MessagingPort;
const PROVIDERS = { feishu: fake('feishu'), slack: fake('slack') };

test('default = Feishu (existing deployments see zero change); empty and whitespace-only also mean the default', () => {
  assert.equal(DEFAULT_PROVIDER, 'feishu');
  assert.equal(selectPort(undefined, PROVIDERS).id, 'feishu');
  assert.equal(selectPort('', PROVIDERS).id, 'feishu');
  assert.equal(selectPort('   ', PROVIDERS).id, 'feishu');
});

test('explicitly choosing slack -> slack; surrounding whitespace is tolerated (a very common slip in an env file)', () => {
  assert.equal(selectPort('slack', PROVIDERS).id, 'slack');
  assert.equal(selectPort(' slack ', PROVIDERS).id, 'slack');
});

test('an unrecognised provider **throws**, never silently falling back to the default — and the message lists the valid values', () => {
  assert.throws(() => selectPort('slak', PROVIDERS), (e: Error) => {
    assert.match(e.message, /slak/);
    assert.match(e.message, /feishu \/ slack/);
    assert.match(e.message, /silently falling back/);
    return true;
  });
  assert.throws(() => selectPort('teams', PROVIDERS), /is not a known IM provider/);
});

test('real wiring: the port that comes up by default is Feishu, and its id matches the provider name', async () => {
  const { port } = await import('../src/messaging/index.ts');
  assert.equal(port.id, 'feishu');
});

test('both feishu and slack are in the real registry (a new provider must be wired in here, or it can never be selected)', () => {
  for (const id of ['feishu', 'slack']) {
    assert.equal(selectPort(id).id, id);
  }
});
