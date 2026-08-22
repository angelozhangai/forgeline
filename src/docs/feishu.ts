// 文档源——**飞书文档**（DocSource 的第一个实现）。这里收敛「一份需求文档长什么样、怎么认出来、
// 怎么读、怎么回写」的全部飞书知识：链接正则、wiki/docx 的 token 解析、feishu-doc.js 的调用、
// docx raw_content 直读、批注回写、user_access_token。
//
// 迁自三处（Phase 1）：util/links.ts 的正则、feishu/doc.ts 的解析与读取、workspace.ts 的
// feishuRead/feishuCommentAdd/feishuUserToken/feishuReadDocxRaw。核心从此只见 DocRef。
import { resolve } from 'node:path';
import { run } from '../util/proc.ts';
import { SCRIPTS_DIR } from '../root.ts';
import type { DocClaimInput, DocRef, DocReadResult, DocSource } from './port.ts';

export const FEISHU_SOURCE = 'feishu';

// 消息里的飞书文档链接（wiki/docx/docs）。live 消息入口与离线补拉共用。
export function extractFeishuLinks(text: string): string[] {
  const re = /https?:\/\/[\w.-]*feishu\.[\w.-]+\/(?:wiki|docx|docs)\/[A-Za-z0-9]+/g;
  return Array.from(new Set(text.match(re) ?? []));
}

export type DocKind = 'wiki' | 'docx' | 'unknown';

// 从飞书链接解析 {token, kind}。支持 .../wiki/<t>、.../docx/<id>、.../docs/<id>，或裸 token。
// 同一份文档的 URL 变体（查询参数/锚点/末尾斜杠）必须落到同一 token——PRD 级去重全靠这条归一。
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

// ── feishu-doc.js（目标项目提供的脚本，「调用、不重写」）────────────────
function feishuEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // 飞书走国内，代理会断
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

// 取一枚你本人的 user_access_token（feishu-doc.js 自动续期）。
export async function feishuUserToken(): Promise<string | null> {
  const r = await run('node', [docScript(), 'token'], { env: feishuEnv(), timeoutMs: 30000 });
  if (r.code !== 0) return null;
  const t = r.stdout.trim();
  return t || null;
}

// 直接读 docx 文档纯文本（绕开 feishu-doc.js 的「<30 字当 wiki 节点」启发式——/docx/ 直链的 doc_id 常 <30 会被误判）。
export async function feishuReadDocxRaw(docId: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const token = await feishuUserToken();
  if (!token) return { ok: false, text: '', error: '取 user token 失败（feishu-doc.js token）' };
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

// ── DocSource 实现 ────────────────────────────────────────────
export const feishuDocs: DocSource = {
  id: FEISHU_SOURCE,

  claim(input: DocClaimInput): DocRef[] {
    // 正文优先；正文没有再逐个扫 adapter 挖出的兜底文本块（文档分享卡 / 富文本 post 的链接不在正文里），
    // 命中即停——与旧的 live 消息入口同序，避免两条路径漂移。
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
    // 只认飞书域的链接；裸 token（无 '/'）也收——CLI 允许直接贴 token，沿用旧行为。
    if (s.includes('/') && !/^https?:\/\/[\w.-]*feishu\.[\w.-]+\//.test(s)) return null;
    const { token } = parseFeishuDoc(s);
    if (!token) return null;
    return { source: FEISHU_SOURCE, token, url: s.includes('/') ? s : undefined };
  },

  async read(ref: DocRef): Promise<DocReadResult> {
    // kind 由链接决定；只有 token 时按 wiki 读法（feishu-doc.js 内部会解析 wiki 节点 → docx）。
    const { kind } = parseFeishuDoc(ref.url ?? ref.token);
    if (kind === 'docx') {
      // /docx/ 直链：doc_id 直接走 docx raw_content（feishu-doc.js read 会把它误当 wiki 节点解析失败）。
      const r = await feishuReadDocxRaw(ref.token);
      if (r.ok) return { ok: true, text: r.text };
      // 兜底：万一其实是 wiki 节点伪装成 /docs/，再试一次 wiki 读法
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
