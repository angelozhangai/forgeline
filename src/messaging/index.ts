// Thin transport seam — **the provider selection point (single wiring point)**.
// The core (notify/listen/worker/actions) only does `import { port } from './messaging/index.ts'` and
// never depends on a concrete IM adapter.
//
// Which one is chosen is decided by `FORGE_MESSAGING_PROVIDER` (defaulting to feishu, so existing
// deployments see no change).
// **An unrecognised value always throws; it never silently falls back to Feishu.** This seam's number
// one failure mode is "misconfigured but apparently running" — typo it as `slak` and every approval
// card keeps going to Feishu with no symptom at all, until someone notices Slack has been blank the
// whole time.
// This is the same rule as ext/'s "present but unloadable -> hard error": better to fail to start than
// to pretend to be fine.
//
// How it is read (design doc D2): process.env first, then forge.env directly. **Deliberately not via
// loadConfig()** — half the repo imports this module, and dragging the full yaml + zod validation into
// module-load time would make both the startup order and the tests fragile.
import { loadEnvFile } from '../root.ts';
import { feishuPort } from './feishu.ts';
import { slackPort } from './slack.ts';
import type { MessagingPort } from './port.ts';

const PROVIDERS: Record<string, MessagingPort> = {
  feishu: feishuPort,
  slack: slackPort,
};

export const DEFAULT_PROVIDER = 'feishu';

// Exported so unit tests can override it directly: the selection logic itself (including "throw on an
// unknown value") is more worth pinning down than the wiring result.
export function selectPort(id: string | undefined, providers: Record<string, MessagingPort> = PROVIDERS): MessagingPort {
  const key = (id ?? '').trim() || DEFAULT_PROVIDER;
  const chosen = providers[key];
  if (!chosen) {
    throw new Error(
      `FORGE_MESSAGING_PROVIDER="${key}" is not a known IM provider (available: ${Object.keys(providers).join(' / ')}). ` +
        'Refusing to start by silently falling back to the default provider — that would leave a configuration error with no symptom at all.',
    );
  }
  return chosen;
}

function configuredProvider(): string | undefined {
  return process.env.FORGE_MESSAGING_PROVIDER?.trim() || loadEnvFile().FORGE_MESSAGING_PROVIDER;
}

export const port: MessagingPort = selectPort(configuredProvider());

export { renderFeishuCard } from './feishu.ts';
export { renderSlackMessage } from './slack.ts';
export type { MessagingPort, InboundHandlers, InboundChannel, InboundProbe } from './port.ts';
export type { CardModel, CardBlock, CardColor, CardButton, FindingLine, InboundEvent, InboundCardAction, InboundMessage } from './model.ts';
