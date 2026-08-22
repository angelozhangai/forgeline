import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { store as sessions } from './store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { readDoc, formatRef, registeredIds, type DocRef } from './docs/index.ts';
import { sessionLogDir } from './util/render.ts';
import { deriveSlug, slugify, shortId } from './util/slug.ts';
import { runClaudeBare } from './llm/runClaude.ts';
import { project, projectForChat, defaultProjectId } from './projects.ts';
import { resolveTargetRepos } from './util/targetRepos.ts';
import { reqRef, stateLabel } from './util/display.ts';
import { log } from './util/log.ts';
import type { Session } from './types.ts';

// 标题/PRD 多为中文 → slugify 得空。best-effort 让 claude 起个英文 kebab slug（失败回退 req-<id>）。
async function proposeSlug(title: string, prdText: string): Promise<string | null> {
  const direct = slugify(title);
  if (direct) return direct; // 标题本就含可用 ASCII，免调用
  const out = await runClaudeBare(
    `为下面这个需求起一个 3-5 个英文单词的 kebab-case slug（全小写、连字符、只含 a-z0-9，` +
      `表达功能主题，如 finance-points-report）。**只输出 slug 本身，别的都不要。**\n\n标题：${title}\n\n摘要：${prdText.slice(0, 600)}`,
  ).catch(() => null);
  return out ? slugify(out) || null : null;
}

export interface AddOpts {
  // 需求文档引用（**已由文档源认领/解析过**）。调用方：listen/backfill 从 claimDocs 拿，CLI 从 parseAnyRef 拿。
  // 传 ref 而非 URL，是因为「这串东西属于哪个源、源内 id 是什么」只有源自己知道——
  // 让 intake 再猜一次，就等于把源的知识复制进核心。
  doc: DocRef;
  slug?: string;
  title?: string;
  projectId?: string; // 目标项目（缺省按 群→项目映射 / 默认项目 解析）
  branch?: 'prod' | 'dev';
  chatId?: string;
  posterId?: string; // 发 PRD 的产品在该 IM 里的 id（群里 @TA）
  intakeMsgId?: string; // PM 那条消息 id（bot 回复其下、发状态卡）
}

type AddResult = { ok: boolean; session?: Session; created?: boolean; duplicate?: boolean; msg: string };

// 重复 PRD 的统一回执（接线预检命中 / 并发竞态回退共用同一文案）。
function dupResult(existing: Session): AddResult {
  return {
    ok: true,
    session: existing,
    created: false,
    duplicate: true,
    msg: `这个需求已经评审过了（${reqRef(existing)}，当前：${stateLabel(existing.state)}），本次重复提交不会被再次评审，请知晓。`,
  };
}

// V1 入口：手动登记一个 PRD（读文档 → 建 session）。V2 由群消息/补拉调用同一函数。
export async function addPrd(o: AddOpts): Promise<AddResult> {
  const cfg = loadConfig();
  if (!o.doc?.token) return { ok: false, created: false, msg: '缺需求文档（--prd <链接>）' };
  if (!registeredIds().includes(o.doc.source)) {
    // 未注册的源绝不静默吞：登记进去也读不出正文，只会变成一条永远停泊的需求。
    return { ok: false, created: false, msg: `未注册的文档源「${o.doc.source}」（已注册：${registeredIds().join('/') || '无'}）` };
  }
  const ref = formatRef(o.doc);
  const url = o.doc.url ?? null;

  // PRD 级去重：一份 PRD 的语义唯一，从接线到 issue/PR 全链路不可重复。
  // 用 doc_ref（URL 各变体/查询参数都已由源归一到同一 token，再冠上源前缀）查；读文档前先挡，省一次网络读。
  // findByPrdUrl 是旧路径兜底（doc_ref 之前的精确-URL 去重时代残留）。
  const existing = (await sessions.findByDocRef(ref)) ?? (url ? await sessions.findByPrdUrl(url) : null);
  if (existing) return dupResult(existing);

  const prd = await readDoc(o.doc);
  if (!prd.ok) {
    return { ok: false, msg: `读需求文档失败（${o.doc.source}）：${prd.error}` };
  }

  const firstLine = prd.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const title = (o.title?.trim()) || firstLine.slice(0, 80) || o.slug || url || o.doc.token;
  // slug 优先级：--slug 显式 > claude 起的英文 slug（标题中文时）> req-<id> 回退
  let slug = o.slug ? deriveSlug(title, o.slug) : '';
  if (!slug) {
    const proposed = await proposeSlug(title, prd.text);
    if (proposed) log.info(`slug：claude 起名 → ${proposed}`);
    slug = proposed || deriveSlug(title);
  }
  // 目标项目绑定：显式 --project > 群→项目映射(projects.yaml chats) > 默认项目。入库即定、全程不变。
  const projectId = o.projectId ?? projectForChat(o.chatId) ?? defaultProjectId();
  const proj = project(projectId);
  const branchKind = o.branch ?? proj.defaultBranch;
  const branch = proj.branches[branchKind];
  const id = `${slug}-${shortId()}`;

  const dir = sessionLogDir(id);
  const prdPath = resolve(dir, 'prd.txt');
  writeFileSync(prdPath, prd.text);

  let s: Session;
  try {
    s = await sessions.create({
      id,
      slug,
      title,
      project_id: projectId, // 显式 flag / 群→项目映射 / 默认项目（见上）
      branch,
      prd_url: url,
      prd_text_path: prdPath,
      doc_ref: ref,
      chat_id: o.chatId ?? cfg.env.FEISHU_REVIEW_CHAT_ID ?? null,
      poster_id: o.posterId ?? null,
      intake_msg_id: o.intakeMsgId ?? null,
    });
  } catch (e) {
    // 并发竞态最后一道闸：另一条相同 doc_ref 的提交在本次读文档期间抢先插入 → 唯一索引拒绝本次。
    // 退回去重路径：复用抢先建好的那条，绝不重复建需求（落实「全链路不可重复」）。
    if (sessions.isDuplicateDocRefError(e)) {
      const winner = (await sessions.findByDocRef(ref)) ?? (url ? await sessions.findByPrdUrl(url) : null);
      if (winner) {
        log.info(`PRD 并发竞态：复用抢先建好的 ${winner.slug}（${winner.id}）`);
        return dupResult(winner);
      }
    }
    throw e; // 其他 DB 错照常抛（worker/CLI 据此报错）
  }
  return {
    ok: true,
    session: s,
    created: true,
    msg: `✓ 已建 session ${id}（slug=${slug}, branch=${branch}）。跑闸A：./forge tick`,
  };
}

// standalone 入口（裸 issue）：不走闸A/闸B，直接建任务进闸C（实现 + 本地CI）。
// 与链式（DONE→implement）共用闸C 引擎，只是无外环验收契约 → 目标判据回退「CI 绿 + issue 验收点」（较弱，事件标注）。
export interface ImplementTaskOpts {
  issueRef: string; // 去重键：owner/repo#n 或 issue URL
  title: string;
  body?: string; // issue 正文（CLI 可经 gh 预取；缺省仅标题）
  projectId?: string;
  repo?: string; // 多仓项目里指定改哪个仓（缺省项目首仓）
  branch?: 'prod' | 'dev';
  by: string;
}

export async function addImplementTask(o: ImplementTaskOpts): Promise<AddResult> {
  if (!o.issueRef) return { ok: false, created: false, msg: '缺 --issue <owner/repo#n 或 URL>' };
  if (!o.title?.trim()) return { ok: false, created: false, msg: '缺 --title（standalone 裸 issue 须给标题；可由 gh 预取）' };
  const existing = await sessions.findByIssueRef(o.issueRef);
  if (existing) {
    return {
      ok: true,
      session: existing,
      created: false,
      duplicate: true,
      msg: `这个 issue 已建过实现任务（${reqRef(existing)}，当前：${stateLabel(existing.state)}），不重复建。`,
    };
  }
  const projectId = o.projectId ?? defaultProjectId();
  const proj = project(projectId);
  // standalone --repo：经 repoMap 归一化（可传字母 C/U/A/E 或仓名），显式给了就必须是该项目有效仓（绝不在错仓建实现 worktree/PR）；
  // 没给→回退首仓（resolveTargetRepos 内兜底）。
  const repoNorm = o.repo ? (proj.repoMap[o.repo] ?? o.repo) : undefined;
  if (o.repo && (!repoNorm || !proj.repos.includes(repoNorm))) {
    return { ok: false, created: false, msg: `✗ --repo ${o.repo} 不在项目 ${projectId} 的 repos（${proj.repos.join('、')}）` };
  }
  const targetRepos = resolveTargetRepos(repoNorm ? [repoNorm] : [], proj.repos, proj.repoMap);
  const branch = proj.branches[o.branch ?? proj.defaultBranch];
  const title = o.title.trim();
  const slug = deriveSlug(title);
  const id = `${slug}-${shortId()}`;
  // 实现上下文落盘（闸C gateCContext 在无闸B 草稿时读它）。
  writeFileSync(resolve(sessionLogDir(id), 'gatec-input.md'), `# ${title}\n\n来源 issue：${o.issueRef}\n\n${o.body ?? '（无正文，按标题与既有代码实现）'}`);
  let s: Session;
  try {
    s = await sessions.create({
      id, slug, title, project_id: projectId, branch,
      state: 'GATE_C_REQUESTED', source_kind: 'issue', issue_ref: o.issueRef,
    });
  } catch (e) {
    // 并发竞态最后一道闸：另一条相同 issue_ref 在本次 findByIssueRef 之后抢先插入 → 唯一索引拒绝本次。
    // 退回去重：复用抢先建好的那条，绝不重复建实现任务（防重复 worktree/PR）。
    if (sessions.isDuplicateIssueRefError(e)) {
      const winner = await sessions.findByIssueRef(o.issueRef);
      if (winner) {
        log.info(`standalone 并发竞态：复用抢先建好的 ${winner.slug}（${winner.id}）`);
        return {
          ok: true,
          session: winner,
          created: false,
          duplicate: true,
          msg: `这个 issue 已建过实现任务（${reqRef(winner)}，当前：${stateLabel(winner.state)}），不重复建。`,
        };
      }
    }
    throw e; // 其他 DB 错照常抛
  }
  await sessions.patch(s.id, { gate_c_requested_by: o.by, target_repos: JSON.stringify(targetRepos) });
  log.info(`standalone 实现任务 ${reqRef(s)}（${o.issueRef}）→ 直接进闸C`);
  return {
    ok: true,
    session: (await sessions.get(s.id))!,
    created: true,
    msg: `✓ 已建实现任务 ${id}（${o.issueRef}）→ 直接进闸C。下次 ./forge tick 自动建 worktree + 实现 + 本地 CI。`,
  };
}
