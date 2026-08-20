import { feishuRead, feishuReadDocxRaw } from '../workspace.ts';

export type DocKind = 'wiki' | 'docx' | 'unknown';

// 从飞书链接解析 {token, kind}。支持 .../wiki/<t>、.../docx/<id>、.../docs/<id>，或裸 token。
export function parseDocRef(urlOrToken: string): { token: string; kind: DocKind } {
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

// 向后兼容旧调用。
export function extractDocToken(urlOrToken: string): string {
  return parseDocRef(urlOrToken).token;
}

export async function readPrd(
  urlOrToken: string,
): Promise<{ ok: boolean; text: string; token: string; error?: string }> {
  const { token, kind } = parseDocRef(urlOrToken);
  // /docx/ 直链：doc_id 直接走 docx raw_content（feishu-doc.js read 会把它误当 wiki 节点解析失败）。
  if (kind === 'docx') {
    const r = await feishuReadDocxRaw(token);
    if (r.ok) return { ok: true, text: r.text, token };
    // 兜底：万一其实是 wiki 节点伪装成 /docs/，再试一次 wiki 读法
    const w = await feishuRead(token);
    return { ok: w.ok, text: w.text, token, error: w.ok ? undefined : r.error || w.error };
  }
  // wiki / 裸 token：feishu-doc.js read（wiki 节点解析 → docx）。
  const r = await feishuRead(token);
  return { ok: r.ok, text: r.text, token, error: r.error };
}
