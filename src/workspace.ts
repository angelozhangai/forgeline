// 对主仓现有脚本 + feishu-doc.js 的类型化封装。服务"调用、不重写"。
import { resolve } from 'node:path';
import { run } from './util/proc.ts';
import { SCRIPTS_DIR } from './root.ts';
import type { CreatedIssue } from './types.ts';

// 默认项目 GitHub org 兜底；生产路径由调用方按 project(s.project_id).owner 显式传入（见 writes.ts / reconcile.ts）。
const DEFAULT_OWNER = 'your-org';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// dir：目标项目的 scripts 目录（多项目：调用方传 project(s.project_id).scriptsDir）。
// 缺省回退默认项目 SCRIPTS_DIR——供共享基建脚本（feishu-doc.js）及未线程化的调用用。
function scriptPath(name: string, dir: string = SCRIPTS_DIR): string {
  return resolve(dir, name);
}

async function bash(script: string, args: string[], dir?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await run('bash', [scriptPath(script, dir), ...args], { timeoutMs: 120000 });
  return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr };
}

function flag(args: string[], name: string, val?: string | null): void {
  if (val != null && val !== '') {
    args.push(name, val);
  }
}

function parseIssues(stdout: string, owner: string = DEFAULT_OWNER): CreatedIssue[] {
  const re = new RegExp(`https://github\\.com/${escapeRe(owner)}/([\\w.-]+)/issues/(\\d+)`, 'g');
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of stdout.matchAll(re)) {
    const key = `${m[1]}#${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: m[1], number: Number(m[2]), url: m[0] });
  }
  return out;
}

// ── 闸A ──────────────────────────────────────────────
export interface ScaffoldOpts {
  slug: string;
  prd?: string | null;
  repos?: string | null; // "C,U,A"
  issues?: string | null;
  owner?: string | null;
  title?: string | null;
  force?: boolean;
  dryRun?: boolean;
  scriptsDir?: string; // 目标项目 scripts 目录（缺省默认项目）
}

export function reviewReqScaffold(o: ScaffoldOpts) {
  const a = ['scaffold', o.slug];
  flag(a, '--prd', o.prd);
  flag(a, '--repos', o.repos);
  flag(a, '--issues', o.issues);
  flag(a, '--owner', o.owner);
  flag(a, '--title', o.title);
  if (o.force) a.push('--force');
  if (o.dryRun) a.push('--dry-run');
  return bash('review-req.sh', a, o.scriptsDir);
}

// ── 闸B ──────────────────────────────────────────────
export function techDesignScaffold(o: ScaffoldOpts) {
  const a = ['scaffold', o.slug];
  flag(a, '--prd', o.prd);
  flag(a, '--repos', o.repos);
  flag(a, '--issues', o.issues);
  flag(a, '--owner', o.owner);
  flag(a, '--title', o.title);
  if (o.force) a.push('--force');
  if (o.dryRun) a.push('--dry-run');
  return bash('tech-design.sh', a, o.scriptsDir);
}

export function techDesignApprove(slug: string, issue?: string | null, rollup = false, scriptsDir?: string) {
  const a = ['approve', slug];
  flag(a, '--issue', issue);
  if (rollup) a.push('--rollup');
  return bash('tech-design.sh', a, scriptsDir);
}

// ── 建需求 ───────────────────────────────────────────
export interface IssueCommon {
  type?: string | null;
  prio?: string | null;
  area?: string | null;
  status?: number | null;
  assignee?: string | null; // 短码/login
  docUrl?: string | null;
  body?: string | null;
  dryRun?: boolean;
  scriptsDir?: string; // 目标项目 scripts 目录（缺省默认项目）
  owner?: string; // 该项目 GitHub org（解析建好的 issue URL）；缺省 DEFAULT_OWNER
}

function commonFlags(a: string[], o: IssueCommon): void {
  flag(a, '--type', o.type);
  flag(a, '--prio', o.prio);
  flag(a, '--area', o.area);
  flag(a, '--status', o.status != null ? String(o.status) : null);
  flag(a, '--assignee', o.assignee);
  flag(a, '--doc-url', o.docUrl);
  flag(a, '--body', o.body);
  if (o.dryRun) a.push('--dry-run');
}

export async function newReqSingle(
  repo: string,
  title: string,
  o: IssueCommon,
): Promise<{ ok: boolean; stdout: string; stderr: string; issues: CreatedIssue[] }> {
  const a = ['single', repo, '--title', title];
  commonFlags(a, o);
  const r = await bash('new-req.sh', a, o.scriptsDir);
  return { ...r, issues: parseIssues(r.stdout, o.owner) };
}

export interface EpicChild {
  repo: string; // C/U/A/E
  title: string;
}

export async function newReqEpic(
  slug: string,
  title: string,
  children: EpicChild[],
  o: IssueCommon,
): Promise<{ ok: boolean; stdout: string; stderr: string; issues: CreatedIssue[] }> {
  const a = ['epic', slug, '--title', title];
  commonFlags(a, o);
  for (const c of children) a.push('--child', `${c.repo}:${c.title}`);
  const r = await bash('new-req.sh', a, o.scriptsDir);
  return { ...r, issues: parseIssues(r.stdout, o.owner) };
}

// 发布技术方案 doc 到主仓（提交+PR+merge，见 scripts/publish-tech-design.sh）。幂等：已发布则脚本跳过退 0。
export async function publishTechDesign(
  slug: string,
  o: { base: string; dryRun?: boolean; scriptsDir?: string },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const a = [slug, '--base', o.base];
  if (o.dryRun) a.push('--dry-run');
  return bash('publish-tech-design.sh', a, o.scriptsDir);
}

// 按 epic:<slug> 标签查某仓已存在的子 issue（含人工 add-child 补建的）。多仓 retry 时据此刷新 created_issues：
// 主仓 epic 脚本子 issue 只打印 `✓ C#n`（无完整 URL），故部分失败后重跑只能从 GitHub 重新发现。
export async function listEpicChildren(repo: string, slug: string, owner: string = DEFAULT_OWNER): Promise<{ ok: boolean; issues: CreatedIssue[]; stderr: string }> {
  const r = await run('gh', ['issue', 'list', '-R', `${owner}/${repo}`, '-l', `epic:${slug}`, '--state', 'all', '--json', 'number,url'], { timeoutMs: 60000 });
  if (r.code !== 0 || r.timedOut) return { ok: false, issues: [], stderr: r.stderr || `exit ${r.code}` };
  try {
    const arr = JSON.parse(r.stdout || '[]') as { number?: number; url?: string }[];
    const issues = arr
      .filter((a) => typeof a.number === 'number' && typeof a.url === 'string')
      .map((a) => ({ repo, number: a.number as number, url: a.url as string }));
    return { ok: true, issues, stderr: '' };
  } catch {
    return { ok: false, issues: [], stderr: 'gh issue list --json 解析失败' };
  }
}

// 查 issue 开闭态 + 关闭原因（漂移闭环用）。逐条 gh issue view。
// state：OPEN/CLOSED/UNKNOWN（取不到=gh 失败/超时/坏 JSON → UNKNOWN，绝不把取不到当成「已合并」）。
// reason：CLOSED 的 stateReason（COMPLETED=正常完成 ≈ 已落地；NOT_PLANNED/DUPLICATE=废弃，不该当作落地对账）。
export interface IssueStateRow {
  repo: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  reason: string; // 原始 stateReason（COMPLETED/NOT_PLANNED/DUPLICATE/''），取不到=''
}
export async function issueStates(issues: CreatedIssue[], owner: string = DEFAULT_OWNER): Promise<IssueStateRow[]> {
  const out: IssueStateRow[] = [];
  for (const it of issues) {
    const r = await run('gh', ['issue', 'view', String(it.number), '-R', `${owner}/${it.repo}`, '--json', 'state,stateReason'], { timeoutMs: 60000 });
    let state: 'OPEN' | 'CLOSED' | 'UNKNOWN' = 'UNKNOWN';
    let reason = '';
    if (r.code === 0 && !r.timedOut) {
      try {
        const j = JSON.parse(r.stdout || '{}') as { state?: string; stateReason?: string };
        if (j.state === 'OPEN' || j.state === 'CLOSED') state = j.state;
        if (typeof j.stateReason === 'string') reason = j.stateReason;
      } catch {
        /* 坏 JSON → 维持 UNKNOWN */
      }
    }
    out.push({ repo: it.repo, number: it.number, state, reason });
  }
  return out;
}

// 查一个 PR 是否真的合并了（confirm-merge 不可逆清理前核验；取不到绝不当已合并）。
// 直接喂 PR URL 给 gh（无需拆 owner/repo）。state===MERGED 或有 mergedAt 即视为已合并。
export async function prMergeState(prUrl: string): Promise<{ ok: boolean; merged: boolean; state: string; error?: string }> {
  const r = await run('gh', ['pr', 'view', prUrl, '--json', 'state,mergedAt'], { timeoutMs: 60000 });
  if (r.code !== 0 || r.timedOut) return { ok: false, merged: false, state: 'UNKNOWN', error: r.stderr.slice(0, 300) || `exit ${r.code}` };
  try {
    const j = JSON.parse(r.stdout || '{}') as { state?: string; mergedAt?: string | null };
    return { ok: true, merged: j.state === 'MERGED' || !!j.mergedAt, state: j.state ?? 'UNKNOWN' };
  } catch {
    return { ok: false, merged: false, state: 'UNKNOWN', error: 'gh pr view --json 解析失败' };
  }
}

// ── 标签 ─────────────────────────────────────────────
// 给已建 issue 追加标签（size:* 等）。size 标签四仓已由 sync-labels 预置，直接 add。
export async function addLabel(repo: string, num: number, label: string, owner: string = DEFAULT_OWNER): Promise<{ ok: boolean; stderr: string }> {
  const r = await run('gh', ['issue', 'edit', String(num), '-R', `${owner}/${repo}`, '--add-label', label], { timeoutMs: 60000 });
  return { ok: r.code === 0 && !r.timedOut, stderr: r.stderr };
}

// ── 飞书文档（feishu-doc.js）──────────────────────────
function feishuEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // 飞书走国内，代理会断（见 CLAUDE.md / 记忆）
  delete env.https_proxy;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.HTTP_PROXY;
  return env;
}

export async function feishuRead(token: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const r = await run('node', [scriptPath('feishu-doc.js'), 'read', token], {
    env: feishuEnv(),
    timeoutMs: 60000,
  });
  if (r.code !== 0) return { ok: false, text: '', error: r.stderr.slice(0, 500) || `exit ${r.code}` };
  return { ok: true, text: r.stdout };
}

export async function feishuCommentAdd(token: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const r = await run('node', [scriptPath('feishu-doc.js'), 'comment-add', token, text], {
    env: feishuEnv(),
    timeoutMs: 60000,
  });
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 500) || `exit ${r.code}` };
  return { ok: true };
}

// 取一枚你本人的 user_access_token（feishu-doc.js 自动续期）。
export async function feishuUserToken(): Promise<string | null> {
  const r = await run('node', [scriptPath('feishu-doc.js'), 'token'], { env: feishuEnv(), timeoutMs: 30000 });
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

// ── 交付文档自动提交（config 门控、默认关、**绝不 push**）────────────────────
// 把目标项目里的 docs/delivery/<slug>/ 提交到**当前分支**。安全边界（与 README 顾虑对齐）：
//  · 仅 `-- docs/delivery/<slug>` pathspec：只动该 slug 的交付文档，绝不 sweep 其它已暂存改动；
//  · 不 git checkout/切分支——绝不扰动 gates 锚定所依赖的活 checkout；
//  · 绝不 git push（顶层铁律）；
//  · 幂等：无该路径变更则跳过 commit（committed:false, ok:true）。
export async function commitDeliveryDocs(opts: { root: string; slug: string; refNum?: number }): Promise<{ ok: boolean; committed: boolean; stderr: string }> {
  const pathspec = `docs/delivery/${opts.slug}`;
  const C = ['-C', opts.root];
  const add = await run('git', [...C, 'add', '--', pathspec], { timeoutMs: 30000 });
  if (add.code !== 0) return { ok: false, committed: false, stderr: add.stderr.slice(0, 300) };
  // diff --cached --quiet：exit 0=暂存区无该路径变更（跳过），1=有变更（提交）。
  const diff = await run('git', [...C, 'diff', '--cached', '--quiet', '--', pathspec], { timeoutMs: 30000 });
  if (diff.code === 0) return { ok: true, committed: false, stderr: '' };
  const msg = `docs(delivery): ${opts.refNum != null ? `REQ-${opts.refNum} ` : ''}${opts.slug} 评审/技术方案归档（forge 自动提交，未 push）`;
  const commit = await run('git', [...C, 'commit', '-m', msg, '--', pathspec], { timeoutMs: 30000 });
  if (commit.code !== 0) return { ok: false, committed: false, stderr: commit.stderr.slice(0, 300) };
  return { ok: true, committed: true, stderr: '' };
}
