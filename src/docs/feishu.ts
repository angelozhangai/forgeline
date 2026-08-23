// Document source — **Feishu documents** (the first implementation of DocSource). Everything Feishu knows
// about "what a requirement document looks like, how to recognise it, how to read it and how to write back
// to it" is gathered here: the link pattern, parsing a wiki/docx token, calling feishu-doc.js, reading docx
// raw_content directly, adding a comment, and the user_access_token.
//
// Moved here from three places in phase 1: the pattern from util/links.ts, the parsing and reading from
// feishu/doc.ts, and feishuRead/feishuCommentAdd/feishuUserToken/feishuReadDocxRaw from workspace.ts. From
// here on the core sees nothing but a DocRef.
import { resolve } from 'node:path';
import { run } from '../util/proc.ts';
import { SCRIPTS_DIR } from '../root.ts';
import type { DocClaimInput, DocRef, DocReadResult, DocSource } from './port.ts';

export const FEISHU_SOURCE = 'feishu';

// The shape of a bare token: alphanumeric only, at least 10 characters (a real wiki/docx token is 24-27
// characters of base62).
// This gate exists only to tell "a sentence" apart from "a token" and does not aim to be exact — too loose
// and a requirement body gets taken for a token; too strict and someone simply has to paste the full link
// again.
const BARE_TOKEN_RE = /^[A-Za-z0-9]{10,}$/;

// The Feishu document links (wiki/docx/docs) in a message. Shared by the live message entry point and the
// offline backfill.
export function extractFeishuLinks(text: string): string[] {
  const re = /https?:\/\/[\w.-]*feishu\.[\w.-]+\/(?:wiki|docx|docs)\/[A-Za-z0-9]+/g;
  return Array.from(new Set(text.match(re) ?? []));
}

export type DocKind = 'wiki' | 'docx' | 'unknown';

// Parse {token, kind} out of a Feishu link. It accepts .../wiki/<t>, .../docx/<id>, .../docs/<id>, or a
// bare token.
// Every URL variant of the same document (query parameters, an anchor, a trailing slash) must land on the
// same token — PRD-level deduplication rests entirely on this normalisation.
export function parseFeishuDoc(urlOrToken: string): { token: string; kind: DocKind } {
  const s = urlOrToken.trim();
  if (!s.includes('/')) return { token: s, kind: 'unknown' };
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const markers = ['wiki', 'docx', 'docs', 'file', 'sheets', 'base'];
    const idx = parts.findIndex((p) => markers.includes(p));
    if (idx >= 0 && parts[idx + 1]) {
      const marker = parts[idx];
      const kind: DocKind = marker === 'wiki' ? 'wiki' : marker === 'docx' || marker === 'docs' ? 'docx' : 'unknown';
      return { token: parts[idx + 1], kind };
    }
    return { token: parts[parts.length - 1] ?? s, kind: 'unknown' };
  } catch {
    return { token: s, kind: 'unknown' };
  }
}

// ── feishu-doc.js (a script the target project provides: call it, never rewrite it) ────────────────
function feishuEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Feishu is reached domestically; going through a proxy breaks the connection
  delete env.https_proxy;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.HTTP_PROXY;
  return env;
}
const docScript = (): string => resolve(SCRIPTS_DIR, 'feishu-doc.js');

export async function feishuRead(token: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const r = await run('node', [docScript(), 'read', token], { env: feishuEnv(), timeoutMs: 60000 });
  if (r.code !== 0) return { ok: false, text: '', error: r.stderr.slice(0, 500) || `exit ${r.code}` };
  return { ok: true, text: r.stdout };
}

export async function feishuCommentAdd(token: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const r = await run('node', [docScript(), 'comment-add', token, text], { env: feishuEnv(), timeoutMs: 60000 });
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 500) || `exit ${r.code}` };
  return { ok: true };
}

// Fetch one of your own user_access_tokens (feishu-doc.js refreshes it automatically).
export async function feishuUserToken(): Promise<string | null> {
  const r = await run('node', [docScript(), 'token'], { env: feishuEnv(), timeoutMs: 30000 });
  if (r.code !== 0) return null;
  const t = r.stdout.trim();
  return t || null;
}

// Read a docx document's plain text directly, bypassing feishu-doc.js's "shorter than 30 characters means a
// wiki node" heuristic — the doc_id in a direct /docx/ link is often shorter than 30 and gets misjudged.
export async function feishuReadDocxRaw(docId: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const token = await feishuUserToken();
  if (!token) return { ok: false, text: '', error: 'could not fetch a user token (feishu-doc.js token)' };
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(docId)}/raw_content?lang=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = (await res.json()) as { code?: number; msg?: string; data?: { content?: string } };
    if (j.code !== 0) return { ok: false, text: '', error: `docx raw_content code=${j.code} ${j.msg ?? ''}` };
    return { ok: true, text: j.data?.content ?? '' };
  } catch (e) {
    return { ok: false, text: '', error: String(e).slice(0, 300) };
  }
}

// ── The DocSource implementation ──────────────────────────────
export const feishuDocs: DocSource = {
  id: FEISHU_SOURCE,

  claim(input: DocClaimInput): DocRef[] {
    // The body comes first; if there is nothing there, scan the fallback text blocks the adapter dug out
    // (a document share card's link, or a rich-text post's, is not in the body), stopping at the first hit —
    // the same order as the old live message entry point, so the two paths cannot drift apart.
    const scan = [input.text, ...(input.searchTexts ?? [])];
    for (const t of scan) {
      const urls = extractFeishuLinks(t ?? '');
      if (urls.length) return urls.map((url) => ({ source: FEISHU_SOURCE, token: parseFeishuDoc(url).token, url }));
    }
    return [];
  },

  parseRef(urlOrToken: string): DocRef | null {
    const s = (urlOrToken ?? '').trim();
    if (!s) return null;
    if (s.includes('/')) {
      // Only a link on a Feishu domain is recognised.
      if (!/^https?:\/\/[\w.-]*feishu\.[\w.-]+\//.test(s)) return null;
      const { token } = parseFeishuDoc(s);
      return token ? { source: FEISHU_SOURCE, token, url: s } : null;
    }
    // A bare token is accepted too (the CLI lets you paste one directly), but it **must look like a token**:
    // alphanumeric and long enough.
    // Being loose enough to accept "any string with no slash in it" is actively harmful — a whole sentence of
    // requirement would be taken as a Feishu token, registering a requirement whose body cannot be read, and
    // intercepting a message that should have gone to the fallback source.
    return BARE_TOKEN_RE.test(s) ? { source: FEISHU_SOURCE, token: s } : null;
  },

  async read(ref: DocRef): Promise<DocReadResult> {
    // The kind comes from the link; with only a token, read it as a wiki (feishu-doc.js resolves a wiki node
    // to a docx internally).
    const { kind } = parseFeishuDoc(ref.url ?? ref.token);
    if (kind === 'docx') {
      // A direct /docx/ link: take the doc_id straight to docx raw_content (feishu-doc.js read would
      // misread it as a wiki node and fail to resolve it).
      const r = await feishuReadDocxRaw(ref.token);
      if (r.ok) return { ok: true, text: r.text };
      // The fallback: in case it really is a wiki node dressed up as /docs/, try the wiki read once more
      const w = await feishuRead(ref.token);
      return { ok: w.ok, text: w.text, error: w.ok ? undefined : r.error || w.error };
    }
    const r = await feishuRead(ref.token);
    return { ok: r.ok, text: r.text, error: r.error };
  },

  async comment(ref: DocRef, text: string): Promise<{ ok: boolean; error?: string }> {
    return feishuCommentAdd(ref.token, text);
  },
};
