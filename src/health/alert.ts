// A health alert going out to IM (through the thin MessagingPort seam, so it is provider-agnostic). It is a
// bot direct-message card, and the error details go to the maintainer's direct message only.
// Debouncing is the caller's job (the daemon's sampler uses the health_sample flip; the watchdog uses
// watchdog.json) — this module only sends.
import { port } from '../messaging/index.ts';
import type { CardModel, CardColor } from '../messaging/index.ts';
import { log } from '../util/log.ts';

export type AlertSeverity = 'down' | 'degraded' | 'recovered';

const COLOR: Record<AlertSeverity, CardColor> = { down: 'red', degraded: 'orange', recovered: 'green' };
const EMOJI: Record<AlertSeverity, string> = { down: '🔴', degraded: '🟡', recovered: '🟢' };

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Send one health alert card. `title` carries no emoji (this function adds it); `lines` are the markdown
// lines of the body.
export async function sendHealthAlert(
  severity: AlertSeverity,
  title: string,
  lines: string[],
  now: number = Date.now(),
): Promise<void> {
  const card: CardModel = {
    color: COLOR[severity],
    title: `${EMOJI[severity]} ${title}`,
    subtitle: `Forge · ${stamp(now)}`,
    blocks: [
      { kind: 'text', md: lines.join('\n') },
      { kind: 'divider' },
      { kind: 'footnote', md: 'an automatic health alert · the local status page is at http://127.0.0.1, see deploy/README' },
    ],
  };
  try {
    // How errors are routed: a health or contract alert is the maintainer's private operational detail, so it
    // goes to the bot's direct message only.
    // Even if that fails it must **not** leak out to the channel webhook (the team's channel) — it is only
    // logged (the status page and the next flip will surface it again).
    const sent = await port.sendDmCard(card);
    if (!sent) log.warn(`the health alert was not delivered to the bot's direct message; by the routing rule it does not leak to the channel and is only logged: ${title} | ${lines.join(' | ').slice(0, 200)}`);
  } catch (e) {
    log.warn(`sending the health alert failed (logged; it does not affect the pipeline): ${String(e).slice(0, 160)}`);
  }
}
