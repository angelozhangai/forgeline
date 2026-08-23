// Thin document-layer seam — **the registry and the single wiring point**. The core (intake / gates /
// actions / listen / backfill) imports only this file and never depends on a concrete document source.
//
// Why a registry rather than a "selection point" (contrast `port` in messaging/index.ts): a deployment
// can have only one IM (otherwise the approval trail forks), but one message may perfectly well carry
// both a Feishu document and a link from another source — document sources naturally **coexist**, and
// are resolved by content addressing (whoever recognises it owns it) rather than by picking one in
// config.
import { extDocSources } from '../ext/index.ts';
import { log } from '../util/log.ts';
import { feishuDocs } from './feishu.ts';
import { plaintextDocs } from './plaintext.ts';
import { formatRef, parseStoredRef, type DocClaimInput, type DocReadResult, type DocRef, type DocSource } from './port.ts';

export { formatRef, parseStoredRef };
export type { DocRef, DocReadResult, DocSource, DocClaimInput } from './port.ts';

// The document sources the **core ships**. Adding one = one line here (plus its own docs/<id>.ts);
// nothing else in the core changes.
// plaintext is the **fallback source** (fallback:true) and is off by default — its position last is
// only for readability, the flag is what actually determines precedence.
const CORE: DocSource[] = [feishuDocs, plaintextDocs];

// Downstream extension packs can register document sources too (ExtensionPack.docSources). This is
// possible here while it is not on the messaging side, and the difference is **timing**: the messaging
// selection point is evaluated synchronously at module load and cannot reach an asynchronously loaded
// extension pack, whereas this table is consulted on every call (claimDocs / sourceById / readDoc all
// read it when a message arrives), so appending is safe as long as the pack is loaded before the first
// message. See "Non-goals" in src/ext/port.ts.
//
// The merge rule itself is a pure function, so the rules below (core wins, fallback ordering) can
// actually be unit-tested.
export function mergeSources(core: DocSource[], extra: DocSource[]): DocSource[] {
  const out = [...core];
  const taken = new Set(core.map((s) => s.id));
  for (const s of extra) {
    // **Core sources always win** — the same rule as "core commands always win". Downstream cannot
    // replace the Feishu source; otherwise a single mistyped id in an extension could quietly take
    // over all document parsing, with no symptom beyond "the body it read is wrong".
    if (taken.has(s.id)) {
      log.warn(`Extension document source "${s.id}" collides with a core source -> ignoring the extension's copy (core always wins)`);
      continue;
    }
    taken.add(s.id);
    out.push(s);
  }
  // Fallback sources are ordered by **position**, with core first -> plaintext wins when it is on.
  // Two live fallback sources is a configuration conflict: say so (once), rather than leaving someone
  // to guess why their fallback source never got a turn.
  const fallbacks = out.filter((s) => s.fallback).map((s) => s.id);
  if (fallbacks.length > 1) {
    log.warn(`Multiple fallback document sources registered (${fallbacks.join(', ')}) -> the first one that claims wins, in registration order, core first`);
  }
  return out;
}

// The merged result is memoised against "the currently loaded extension pack": a pack loads once per
// process, so this is a one-off cost, and it also means the two warnings above are emitted once per
// load rather than on every incoming message.
let memoKey: DocSource[] | null = null;
let memo: DocSource[] = CORE;

export function sources(): DocSource[] {
  const extra = extDocSources();
  if (memoKey !== extra) {
    memo = mergeSources(CORE, extra);
    memoKey = extra;
  }
  return [...memo];
}

export function sourceById(id: string): DocSource | null {
  return sources().find((s) => s.id === id) ?? null;
}

// Claim the requirement documents in a message — **the rule itself** (a pure function, valid for any
// list of sources).
// Non-fallback sources contribute a **union** (a message carrying links from two sources should bring
// in both); only when nothing was claimed does a fallback source get a turn, and then **at most one
// entry** (a fallback source claims things like "the body itself is the requirement", and taking more
// would only split one paragraph into several requirements).
// `fallback` is a flag rather than an array position — position is too fragile, and one reorder would
// have the fallback source swallowing everyone else's links.
export function resolveClaims(list: DocSource[], input: DocClaimInput): DocRef[] {
  const primary: DocRef[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (s.fallback) continue;
    for (const ref of s.claim(input)) {
      const key = formatRef(ref);
      if (seen.has(key)) continue; // same document claimed twice by the same source (body + fallback block) -> keep one
      seen.add(key);
      primary.push(ref);
    }
  }
  if (primary.length) return primary;
  for (const s of list) {
    if (!s.fallback) continue;
    const [first] = s.claim(input);
    if (first) return [first];
  }
  return [];
}

// Parse a link or bare token into a DocRef — **the rule itself**. Non-fallback sources are asked
// first; only if none recognise it are the fallback sources asked.
// Nobody recognises it -> null, and the caller **reports that explicitly** (never guess a source: a
// wrong guess registers the requirement against a source whose body cannot be read).
export function resolveRef(list: DocSource[], urlOrToken: string): DocRef | null {
  for (const s of list) {
    if (s.fallback) continue;
    const ref = s.parseRef(urlOrToken);
    if (ref) return ref;
  }
  for (const s of list) {
    if (!s.fallback) continue;
    const ref = s.parseRef(urlOrToken);
    if (ref) return ref;
  }
  return null;
}

// The two rules above, **wired to the real registry**. Rules and wiring are separated so that "how
// multi-source resolution works" can genuinely be unit-tested — otherwise a test could only talk to
// itself against the single registered source, or would have to duplicate the rules (which tests the
// copy, not the implementation).
export function claimDocs(input: DocClaimInput): DocRef[] {
  return resolveClaims(sources(), input);
}

export function parseAnyRef(urlOrToken: string): DocRef | null {
  return resolveRef(sources(), urlOrToken);
}

// The ids of registered sources (used in error text: tell the reader which sources are recognised
// right now, rather than a bare "unrecognised").
export function registeredIds(): string[] {
  return sources().map((s) => s.id);
}

// Read the body. An unregistered source is **reported faithfully** and never silently turned into a
// read failure or an empty document (a stored ref that nobody claims usually means config was
// narrowed or a source was removed, and that has to be visible).
export async function readDoc(ref: DocRef): Promise<DocReadResult> {
  const s = sourceById(ref.source);
  if (!s) {
    return { ok: false, text: '', error: `Unregistered document source "${ref.source}" (registered: ${registeredIds().join('/') || 'none'})` };
  }
  return s.read(ref);
}

// Write a comment back (best-effort, never blocks a gate). The three outcomes are kept distinct:
//  · the source does not support write-back (no comment method) = a capability gap, silently skipped —
//    write-back was always a nice-to-have;
//  · the source supports it but this call failed = **logged** (a failure is never silent);
//  · the stored ref does not parse / the source is not registered = logged.
export async function commentDoc(storedRef: string | null | undefined, text: string): Promise<void> {
  const ref = parseStoredRef(storedRef);
  if (!ref) return; // no document origin (manual add / standalone issue) -> there was never anywhere to write
  const s = sourceById(ref.source);
  if (!s) {
    log.warn(`Document comment skipped: unregistered document source "${ref.source}"`);
    return;
  }
  if (!s.comment) return; // capability gap: this source does not support write-back
  try {
    const r = await s.comment(ref, text);
    if (!r.ok) log.warn(`Document comment failed (${ref.source}): ${(r.error ?? '').slice(0, 200)}`);
  } catch (e) {
    log.warn(`Document comment threw (${ref.source}): ${String(e).slice(0, 200)}`);
  }
}
