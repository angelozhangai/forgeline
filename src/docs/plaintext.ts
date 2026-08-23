// Document source — **plain text** (the fallback source): the requirement body is the IM message itself,
// with no remote document to go back to.
//
// Why it exists: adopting Slack should not first require a Notion or Google Docs adapter. Someone @s the bot
// in a channel and writes a paragraph of requirement, and that paragraph is enough to open the work — this is
// the lowest-configuration entry point, with no dependency on a document service at all.
//
// **Off by default.** Turning it on makes "@bot + a paragraph" into a requirement that really runs Gate A,
// which costs money, and for an existing Feishu deployment that is a behaviour change: today an @ message
// with no link is simply ignored. So it has to be switched on explicitly in runtime.yaml and never takes
// effect by default.
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import type { DocClaimInput, DocRef, DocReadResult, DocSource } from './port.ts';

export const PLAINTEXT_SOURCE = 'plaintext';

// The substance floor. This gate exists only to block pleasantries ("ok, thanks", "got it"). The person has
// already gone out of their way to @ the bot (the group-message gate is upstream), so their intent is not in
// doubt and there is no need to guess at semantics — length is the only signal that holds up here.
//
// It is measured in **weight**, not raw characters, because a character means very different things across
// scripts and a requirement can arrive in any language (source is English, input is not). One CJK character
// carries roughly what an English word does, so the same requirement runs to about 25 characters written in
// Chinese and about 95 in English. A single character count cannot serve both: the original floor of 20
// characters was calibrated for Chinese, where a real requirement clears it — but in English 20
// non-whitespace characters is "Sounds good, thank you!", so every pleasantry got through. Raising that
// count to suit English would instead reject real requirements in Chinese. Weighting the word-like scripts
// at CJK_WEIGHT is what lets one threshold hold either way.
//
// Calibration (see the fixtures in test/docs-plaintext.test.ts, which pin both bands): the longest
// pleasantry measured scores 34, and the tersest real one-line requirement scores 38 — in either script. 35
// sits in that gap with margin on both sides. Re-derive it the same way if the floor ever moves.
//
// Where the bands do overlap the cost is a **false negative** — an extremely terse real requirement is
// ignored. That is the acceptable side of the trade: someone who is missed can write a little more, whereas
// a false positive spends real money on a Gate A run.
export const CJK_WEIGHT = 3;
export const MIN_SUBSTANCE_WEIGHT = 35; // about 12 CJK characters, or about 7 English words

// The characters that carry roughly a word each rather than roughly a letter: CJK ideographs (including
// extension A and the compatibility block), kana, and hangul. Written as escapes rather than as literal
// characters, the same rule the guard holds itself to (see test/english-only.test.ts).
const WORDLIKE_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

// The IM @ markers. This is the **only** place an IM marker shape appears outside an adapter, and it has to
// be: these placeholders change with *who* was mentioned, so leaving them in the body would make the same
// paragraph hash differently depending on who was @'d, and deduplication would stop working outright.
// What it recognises is the **marker shape**, not any provider's API; a third shape gets added here.
const MENTION_PATTERNS: RegExp[] = [
  /@_user_\d+/g, // Feishu: the @ placeholder inside a message body
  /<@[A-Z0-9]+>/g, // Slack: <@U012ABC>
  /<![a-z]+>/g, // Slack: <!here> / <!channel>
];

// Normalise: strip the @ markers -> collapse all whitespace to a single space -> trim.
// Collapsing whitespace is deliberate: the same requirement wrapped differently (a copy-paste, a phone
// keyboard) must not count as two separate requirements.
export function normalizePlaintext(text: string): string {
  let s = text ?? '';
  for (const re of MENTION_PATTERNS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Content addressing: the sha256 of the normalised body (the first 32 hex characters). There is no document
// identity to speak of, so the content *is* the identity — pasting the same text again hits deduplication,
// and pasting it with a word changed honestly counts as a new requirement (there was never a version history
// to follow anyway).
export function contentToken(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}

// The weighted length of the normalised body, ignoring whitespace.
export function substanceWeight(normalized: string): number {
  let weight = 0;
  for (const ch of normalized.replace(/\s/g, '')) weight += WORDLIKE_RE.test(ch) ? CJK_WEIGHT : 1;
  return weight;
}

export function hasSubstance(normalized: string): boolean {
  return substanceWeight(normalized) >= MIN_SUBSTANCE_WEIGHT;
}

// Whether it is enabled (runtime.yaml `doc_sources.plaintext.enabled`, false by default).
// It reads config rather than an env var: this is the product decision of "does this deployment treat a
// paragraph as a requirement", and it belongs alongside the other switches that cost money.
function enabled(): boolean {
  try {
    return loadConfig().runtime.doc_sources?.plaintext?.enabled === true;
  } catch {
    return false; // if the config cannot be read, be conservative and treat it as off (a broken config must never cost more money)
  }
}

export const plaintextDocs: DocSource = {
  id: PLAINTEXT_SOURCE,
  fallback: true, // its turn comes only when nobody else claims; and resolveClaims takes at most one

  claim(input: DocClaimInput): DocRef[] {
    if (!enabled()) return [];
    // The body only: searchTexts is the adapter's fallback block of **serialised event** text, and treating
    // that lump of JSON as a requirement body would be a disaster.
    const norm = normalizePlaintext(input.text);
    if (!norm) return [];
    if (!hasSubstance(norm)) {
      // Not silent: someone reading the log should see "we saw it, and judged it too short" rather than
      // nothing happening at all.
      log.info(
        `plaintext: the normalised body scores ${substanceWeight(norm)}, below the substance floor of ${MIN_SUBSTANCE_WEIGHT}; not treating it as a requirement ("${norm.slice(0, 40)}")`,
      );
      return [];
    }
    return [{ source: PLAINTEXT_SOURCE, token: contentToken(norm), raw: norm }];
  },

  parseRef(urlOrToken: string): DocRef | null {
    if (!enabled()) return null;
    const s = (urlOrToken ?? '').trim();
    if (!s) return null;
    // Links are never accepted. A link no primary source recognises is most likely a document service **we
    // cannot read** — storing that URL itself as the requirement body would be far worse than saying plainly
    // that it is unrecognised.
    if (/^https?:\/\//i.test(s)) return null;
    const norm = normalizePlaintext(s);
    if (!norm || !hasSubstance(norm)) return null;
    return { source: PLAINTEXT_SOURCE, token: contentToken(norm), raw: norm };
  },

  async read(ref: DocRef): Promise<DocReadResult> {
    // `raw` exists only for the one trip from claim() to read() — it is not persisted. Asked to re-read a
    // **stored** plaintext ref, this says truthfully that it cannot, rather than returning an empty body and
    // pretending it read something: upstream parks on that, so a human can see what happened.
    if (typeof ref.raw === 'string' && ref.raw.length > 0) return { ok: true, text: ref.raw };
    return {
      ok: false,
      text: '',
      error:
        'the plaintext source cannot be re-read: the body exists only for the trip the message came in on (the requirement body was written to prd.txt when the session was created, and cannot be re-read here)',
    };
  },

  // No comment: there is nowhere to write an annotation back to on a piece of IM text. This is a **capability
  // gap**, and the core skips it silently (see commentDoc in docs/index.ts).
};
